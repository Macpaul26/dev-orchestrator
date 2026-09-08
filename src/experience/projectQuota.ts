import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EXPERIENCE_STORAGE_LIMITS } from "../domain/experienceStorage.js";

/**
 * THE PROJECT QUOTA GATE
 *
 * `maxRecordsPerProject` is documented as a hard ceiling. This file is what
 * makes that true rather than aspirational.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG BEFORE
 * ---------------------------------------------------------------------------
 * The first Task 009 implementation did:
 *
 *     count the records  ->  is the count below the ceiling?  ->  write
 *
 * with nothing between the three steps. Two processes could both read 4,999,
 * both conclude there was room, and both write. The ceiling was really a
 * suggestion that happened to hold whenever exactly one writer existed.
 * Independent review found it before anything relied on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO - AND THIS MATTERS MOST
 * ---------------------------------------------------------------------------
 * This module has NO IDEA what an experience is. It never sees a record, a
 * project id, a summary, or a digest. It is handed a directory, a filename, and
 * two predicates over filenames, and it decides one thing: whether a slot may
 * be consumed. Everything it could leak, it never receives.
 *
 * It also grants nothing. No capability, no tool, no model reachability, no
 * approval, no bypass. A lock is not authority; it is a queue.
 *
 *     MODEL  ->  EXPERIENCE STORE      still impossible
 *     MODEL  ->  EXPERIENCE AUTHORITY  still impossible
 */

/** The project write lock. Not a record; never listed as one. */
const LOCK_FILE = "_lock";

/** Shared word used only to park the thread. Never read for its value. */
const PARK = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block this thread for `ms`.
 *
 * The store's API is synchronous, so waiting for a lock has to be synchronous
 * too. `Atomics.wait` on a word that is never signalled is the way to do that
 * without spinning a CPU. The wait is bounded by `lockAcquireTimeoutMs` in
 * total, so the worst case is a five-second block on a store that is already
 * being written by somebody else.
 */
function park(ms: number): void {
  Atomics.wait(PARK, 0, 0, ms);
}

/** Backoff with jitter, so two waiters do not retry in lockstep forever. */
function pollDelay(attempt: number): number {
  const base = Math.min(EXPERIENCE_STORAGE_LIMITS.lockPollMaxMs, 2 ** Math.min(attempt, 5));
  // crypto.randomInt, not Math.random: this store bans Math.random outright so
  // that no future edit can quietly reach for it where identity is decided.
  return base + crypto.randomInt(0, 4);
}

export interface DirectoryScan {
  /** Entry names actually read, in whatever order the filesystem gave them. */
  readonly names: string[];
  /** False when `maxDirectoryEntries` stopped the scan short of the end. */
  readonly complete: boolean;
}

/**
 * Read a directory with a REAL bound.
 *
 * `readdirSync(dir).slice(0, n)` is not a bound: it materialises every entry
 * first and only then throws most of them away, so a hostile directory still
 * costs what it costs. `opendirSync` plus `readSync` streams entries and stops
 * when told to, which is what "bounded" was supposed to mean.
 *
 * The distinction that matters to callers is `complete`. A scan that stopped
 * early has seen an ARBITRARY subset - directory order is a filesystem
 * property, not an ordering anyone may rely on - so no count taken from it is
 * authoritative, and callers must treat it as a lower bound or refuse.
 */
export function scanDirectoryBounded(
  dir: string,
  limit: number = EXPERIENCE_STORAGE_LIMITS.maxDirectoryEntries,
): DirectoryScan {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch (error) {
    // A project with no directory yet has no entries. Anything else is a real
    // storage problem and must not be disguised as an empty project.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { names: [], complete: true };
    }
    throw error;
  }

  const names: string[] = [];
  let complete = true;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (names.length >= limit) {
        complete = false;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    try { handle.closeSync(); } catch { /* already closed */ }
  }
  return { names, complete };
}

/** A lock this process currently believes it holds. */
export interface HeldLock {
  readonly nonce: string;
}

/**
 * A cross-process mutual exclusion lock for one project directory.
 *
 * ---------------------------------------------------------------------------
 * WHY A LOCKFILE AND NOT AN IN-MEMORY MUTEX
 * ---------------------------------------------------------------------------
 * A JavaScript mutex protects one process from itself. The durability test in
 * this suite writes from a genuinely separate OS process, and real runs are
 * separate processes too, so an in-memory mutex would protect nothing that
 * needed protecting. Exclusive create - `open(..., "wx")` - is atomic on both
 * POSIX and Windows and is the primitive this is built on.
 *
 * ---------------------------------------------------------------------------
 * WHAT BREAKING A STALE LOCK CAN AND CANNOT GUARANTEE
 * ---------------------------------------------------------------------------
 * A process that dies holding the lock would otherwise block its project
 * forever, so a lock untouched for longer than `lockStaleMs` may be broken by
 * whoever finds it. That is a HEURISTIC and it is stated as one:
 *
 *   - It is safe against the case it exists for - a dead holder - because a
 *     dead process cannot be in the critical section.
 *   - It is NOT safe against a live holder stalled longer than the stale
 *     window: a paused VM, a suspended process, a filesystem that hangs for
 *     half a minute. Two writers could then both believe they hold the lock.
 *
 * That residual case is covered separately, by re-checking the ceiling AFTER
 * publishing and undoing an over-ceiling write (`ProjectQuota`). Neither
 * mechanism is claimed to be airtight on its own, and the combination is
 * described honestly in docs/PHASE-009.md rather than rounded up to "safe".
 *
 * There is no compare-and-unlink on a filesystem, so both breaking and
 * releasing re-check ownership immediately before removing the file. That
 * NARROWS the window between the check and the unlink. It does not close it.
 */
export class ProjectLock {
  readonly #file: string;

  constructor(dir: string) {
    this.#file = path.join(dir, LOCK_FILE);
  }

  /** The lock file's path, so callers can prove it is never read as a record. */
  static fileName(): string {
    return LOCK_FILE;
  }

  /**
   * Take the lock, or return null if it could not be taken in time.
   *
   * Null is CONTENTION, not failure and not quota exhaustion. Nothing has been
   * written and nothing has been consumed.
   */
  acquire(): HeldLock | null {
    const deadline = Date.now() + EXPERIENCE_STORAGE_LIMITS.lockAcquireTimeoutMs;
    let breaks = 0;

    for (let attempt = 0; ; attempt += 1) {
      const nonce = crypto.randomUUID();
      try {
        // Exclusive create: exactly one caller can win this, ever.
        const handle = fs.openSync(this.#file, "wx", 0o600);
        try {
          fs.writeFileSync(handle, JSON.stringify({
            pid: process.pid,
            nonce,
            acquiredAt: new Date().toISOString(),
          }), "utf8");
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
        return { nonce };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (this.#breakIfStale()) {
        breaks += 1;
        // Bounded: if something keeps planting pre-aged locks, give up rather
        // than loop. That is a local attacker with write access to the store,
        // which this store never claimed to defend against.
        if (breaks > 8) return null;
        continue;
      }

      if (Date.now() >= deadline) return null;
      park(pollDelay(attempt));
    }
  }

  /**
   * Release a lock this process took.
   *
   * The nonce check is the point: if our lock was broken as stale and someone
   * else now holds it, removing the file would hand a third writer a lock that
   * is still in use. When the nonce does not match, we leave it alone - our
   * lock is already gone.
   */
  release(held: HeldLock): void {
    try {
      const owner = JSON.parse(fs.readFileSync(this.#file, "utf8")) as { nonce?: unknown };
      if (owner.nonce !== held.nonce) return;
    } catch {
      return; // Unreadable or already gone; nothing of ours to remove.
    }
    try { fs.rmSync(this.#file, { force: true }); } catch { /* best effort */ }
  }

  /** True only when a lock older than the stale window was actually removed. */
  #breakIfStale(): boolean {
    let before: fs.Stats;
    try {
      before = fs.statSync(this.#file);
    } catch {
      return false; // Released while we looked; the next attempt will take it.
    }
    if (Date.now() - before.mtimeMs <= EXPERIENCE_STORAGE_LIMITS.lockStaleMs) return false;

    try {
      // Re-stat immediately before removing: a lock released and re-taken since
      // the age check has a different mtime and must not be broken.
      const after = fs.statSync(this.#file);
      if (after.mtimeMs !== before.mtimeMs) return false;
      fs.rmSync(this.#file, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * What one write asks of the quota gate.
 *
 * Filenames and callbacks only. The gate cannot read a record even by mistake,
 * because it is never given one.
 */
export interface QuotaRequest<T> {
  /** The exact filename this write will publish. */
  readonly fileName: string;
  /** Whether an entry name is a record, and so occupies a slot. */
  readonly isRecordName: (name: string) => boolean;
  /** Whether an entry name is an abandoned temporary file. */
  readonly isTemporaryName: (name: string) => boolean;
  /** Publish the record. Called only once a slot is available. */
  readonly publish: () => T;
  /** Undo a publish. Called only to reverse a write that broke the ceiling. */
  readonly unpublish: () => void;
}

export type QuotaDecision<T> =
  | { ok: true; value: T; slotConsumed: boolean; records: number }
  | { ok: false; reason: "quota_exceeded"; records: number }
  | { ok: false; reason: "indeterminate" }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "failed"; error: unknown };

/**
 * Serialised, bounded, self-derived project quota accounting.
 *
 * ---------------------------------------------------------------------------
 * THE COUNT IS DERIVED, NEVER CACHED
 * ---------------------------------------------------------------------------
 * The reviewer suggested a counter file maintained transactionally alongside
 * writes. This does something simpler that proves the same invariant: it counts
 * the records themselves, inside the lock, on every write.
 *
 * The reason is that a cached counter is a second source of truth, and a second
 * source of truth can disagree with the first. It has to survive a crash
 * between "counter incremented" and "record published" - in EITHER order, one
 * of which loses capacity and the other of which oversubscribes it - which
 * needs a pending marker, and reconciliation, and a rule for whose answer wins.
 * Every one of those is a place for the ceiling to quietly stop holding.
 *
 * Deriving the count from the records makes those states unrepresentable:
 *
 *   A FAILED WRITE CANNOT CONSUME CAPACITY   nothing is reserved except the
 *                                            lock, and the lock expires.
 *   A PUBLISHED RECORD IS ALWAYS COUNTED     it IS the accounting.
 *
 * The price is one bounded directory scan per write. Writes happen about once
 * per workflow run and the scan stops at `maxDirectoryEntries`, so the price is
 * small, fixed, and worth paying for an invariant that cannot drift.
 *
 * ---------------------------------------------------------------------------
 * THE SCAN MUST BE COMPLETE OR THE WRITE IS REFUSED
 * ---------------------------------------------------------------------------
 * If the directory holds more than `maxDirectoryEntries`, the count is a lower
 * bound and the ceiling cannot be proved. The write is refused as
 * `indeterminate`. A legitimate project cannot reach that state - 5,000 records
 * plus a handful of temporary files is nowhere near 20,000 - so it means
 * something outside the store filled the directory, and refusing is right.
 */
export class ProjectQuota {
  readonly #dir: string;
  readonly #lock: ProjectLock;

  constructor(dir: string) {
    this.#dir = dir;
    this.#lock = new ProjectLock(dir);
  }

  /**
   * Publish a record if and only if the project has room for it.
   *
   * The transaction, in order, and why the order is what it is:
   *
   *   1. acquire the lock          nothing below is safe concurrently
   *   2. scan, bounded             the count and "is this record new?" both
   *                                come from ONE scan, so there is no second
   *                                window between deciding and acting
   *   3. refuse if incomplete      an unprovable ceiling is not a ceiling
   *   4. refuse if full and new    an overwrite is not growth and never refused
   *   5. publish                   atomically, by the caller
   *   6. re-count if new           the only cover for a wrongly broken lock
   *   7. undo if over              a failed write leaves nothing behind
   *   8. release the lock          in a finally, including on a thrown publish
   */
  reserveAndPublish<T>(request: QuotaRequest<T>): QuotaDecision<T> {
    const held = this.#lock.acquire();
    if (held === null) return { ok: false, reason: "busy" };

    try {
      let scan: DirectoryScan;
      try {
        scan = scanDirectoryBounded(this.#dir);
      } catch (error) {
        return { ok: false, reason: "failed", error };
      }
      if (!scan.complete) return { ok: false, reason: "indeterminate" };

      const records = scan.names.filter(request.isRecordName);

      /**
       * Re-persisting the same experience is an overwrite, not growth. The
       * check is against the SAME scan the count came from, so a project at its
       * ceiling can still correct or re-write a record it already holds.
       */
      const slotConsumed = !records.includes(request.fileName);
      if (slotConsumed && records.length >= EXPERIENCE_STORAGE_LIMITS.maxRecordsPerProject) {
        return { ok: false, reason: "quota_exceeded", records: records.length };
      }

      let value: T;
      try {
        value = request.publish();
      } catch (error) {
        return { ok: false, reason: "failed", error };
      }

      if (slotConsumed) {
        const settled = this.#verifyCeiling(request);
        if (settled !== null) {
          // Over the ceiling despite the lock, so the lock was not respected:
          // most plausibly ours was broken as stale while we were stalled. Undo
          // our own publish rather than leave the project oversubscribed.
          try { request.unpublish(); } catch { /* best effort */ }
          return { ok: false, reason: "quota_exceeded", records: settled };
        }
      }

      this.#cleanTemporaries(scan.names, request.isTemporaryName);
      return {
        ok: true,
        value,
        slotConsumed,
        records: records.length + (slotConsumed ? 1 : 0),
      };
    } finally {
      this.#lock.release(held);
    }
  }

  /**
   * Re-count after publishing. Returns the count only if it broke the ceiling.
   *
   * This is the bounded self-correction for the one case mutual exclusion
   * cannot cover: a holder stalled past `lockStaleMs`, whose lock was broken
   * while it was still live. It is not instant - the extra record exists for
   * the microseconds between the rename and the undo - and a process killed in
   * exactly that gap leaves the project one over its ceiling. That state is
   * stable and safe rather than progressive: the next new write sees a count at
   * or above the ceiling and refuses, so it cannot grow. Recorded as a known
   * limitation in docs/PHASE-009.md, not smoothed over.
   *
   * An incomplete re-scan proves nothing, so it is not treated as a breach.
   */
  #verifyCeiling<T>(request: QuotaRequest<T>): number | null {
    let after: DirectoryScan;
    try {
      after = scanDirectoryBounded(this.#dir);
    } catch {
      return null;
    }
    if (!after.complete) return null;
    const count = after.names.filter(request.isRecordName).length;
    return count > EXPERIENCE_STORAGE_LIMITS.maxRecordsPerProject ? count : null;
  }

  /**
   * Remove temporary files abandoned by a process that died mid-write.
   *
   * Safe to do here and nowhere else: we hold the lock, so no other writer is
   * publishing, and the age filter means a file this old cannot belong to a
   * write still in flight. Bounded per write so a directory full of stale
   * temporaries is cleared over several writes rather than one long stall.
   *
   * Temporary files never occupied a quota slot - they do not match the record
   * name shape - so this reclaims disk, not capacity.
   */
  #cleanTemporaries(names: string[], isTemporary: (name: string) => boolean): void {
    let removed = 0;
    for (const name of names) {
      if (removed >= EXPERIENCE_STORAGE_LIMITS.maxTemporaryCleanupsPerWrite) break;
      if (!isTemporary(name)) continue;
      const file = path.join(this.#dir, name);
      try {
        const stats = fs.statSync(file);
        if (Date.now() - stats.mtimeMs <= EXPERIENCE_STORAGE_LIMITS.lockStaleMs) continue;
        fs.rmSync(file, { force: true });
        removed += 1;
      } catch { /* someone else cleared it, or it is not ours to remove */ }
    }
  }
}
