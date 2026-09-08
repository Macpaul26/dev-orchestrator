import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EXPERIENCE_STORAGE_LIMITS, LockOwner,
  type LockOwner as TLockOwner,
} from "../domain/experienceStorage.js";

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

/** Where a project keeps its write locks. Not a record; never listed as one. */
const LOCK_DIR = "_locks";
/** The transient acquisition gate inside it. */
const GATE_NAME = "_gate";
/** Owner metadata inside a lock directory. */
const OWNER_FILE = "owner.json";

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

/** UUID v4, as `crypto.randomUUID` produces and as a lock directory is named. */
const NONCE_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * This process's start time, in epoch milliseconds.
 *
 * Computed once. `process.uptime()` keeps advancing, so recomputing it later
 * would yield the same answer only to within the clock's drift, and the
 * comparison it feeds needs to be stable.
 */
const OWN_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

/** Two start times this far apart cannot belong to the same process instance. */
const START_TIME_TOLERANCE_MS = 5_000;

/**
 * IS THE PROCESS THAT WROTE THIS LOCK STILL RUNNING?
 *
 * ---------------------------------------------------------------------------
 * WHY THE KERNEL IS ASKED, AND NOT THE CLOCK
 * ---------------------------------------------------------------------------
 * The previous implementation decided a lock was abandoned when it got old.
 * That is not a liveness test, it is a guess, and independent review was right
 * that it made the lock stealable from an owner that was merely slow. A paused
 * VM, a suspended process or a filesystem that hangs for half a minute would
 * have had its lock taken out from under it while it was still inside the
 * critical section.
 *
 * `process.kill(pid, 0)` sends no signal; it asks the kernel whether that
 * process exists. Crucially it answers correctly for a process that is ALIVE
 * BUT BLOCKED, which no heartbeat scheme can do - a heartbeat needs the owner
 * to run in order to prove it is alive, and a blocked owner cannot run. That is
 * the whole reason this is a kernel question rather than an application one.
 *
 * ---------------------------------------------------------------------------
 * PROCESS IDS ARE NOT IDENTITIES
 * ---------------------------------------------------------------------------
 * A pid can be reused after its process dies. So a pid is used here for exactly
 * one thing - asking whether SOMETHING with that number is running - and never
 * to decide whose lock this is. Ownership is the nonce in the directory name.
 *
 * Two forms of reuse are detected outright:
 *
 *   EPERM          something holds that pid but we may not signal it, so it is
 *                  not one of our writers - they run as this user.
 *   our own pid,   a lock claiming THIS process's pid but a different start
 *   wrong start    time was written by an earlier process that held the number.
 *
 * What is NOT detected: reuse by another process of the same user. That case
 * reads as "alive", the lock is never broken, and writes to that ONE project
 * return `storage_busy`. It costs availability, never correctness - and it is
 * recorded as the residual limitation in docs/PHASE-009.md rather than papered
 * over with a timeout that would bring the original defect straight back.
 */
function ownerIsAlive(owner: TLockOwner): boolean {
  if (owner.pid === process.pid
    && Math.abs(owner.startedAt - OWN_STARTED_AT) > START_TIME_TOLERANCE_MS) {
    return false; // Our pid, not our process: it was reused after that one died.
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists, but is not one of ours.
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
      && (error as NodeJS.ErrnoException).code !== "EPERM"
      // Anything unexpected is treated as alive: refusing to break a lock is
      // always the safe direction, and the cost is bounded contention.
      ? true
      : false;
  }
}

/**
 * A cross-process mutual exclusion lock for one project directory.
 *
 * ---------------------------------------------------------------------------
 * WHY A LOCK ON DISK AND NOT AN IN-MEMORY MUTEX
 * ---------------------------------------------------------------------------
 * A JavaScript mutex protects one process from itself. This store is written
 * from separate OS processes - the durability test proves it - so a mutex would
 * have protected nothing that needed protecting while making a single-process
 * test go green.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT, AND WHY THE NONCE IS IN THE NAME
 * ---------------------------------------------------------------------------
 *     <project>/_locks/_gate                transient, held for microseconds
 *     <project>/_locks/<nonce>/owner.json   the lock; its NAME is its identity
 *
 * Putting the identity in the DIRECTORY NAME rather than inside the file is the
 * whole trick, and it is what closes the release race independent review found.
 * The previous protocol did:
 *
 *     read the lock -> is the nonce mine? -> delete the lock
 *
 * which is three operations, not one. An owner whose lock had been broken could
 * pass the check, be descheduled, and then delete a lock a DIFFERENT process had
 * since acquired. Re-reading before the unlink narrowed that window; nothing
 * could close it, because there is no compare-and-unlink on a filesystem.
 *
 * With the nonce in the name there is nothing to compare. `release` removes
 * `_locks/<my nonce>` and no other path exists for it to remove. A newer owner's
 * lock has a DIFFERENT NAME, so an older owner cannot reach it - not rarely, not
 * with a narrow window, but never. Stale recovery is the same shape: it removes
 * `_locks/<the nonce it observed>`, so if that owner released and someone else
 * acquired in between, the removal finds nothing and the new owner is untouched.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A GATE
 * ---------------------------------------------------------------------------
 * Nonce-named directories are not mutually exclusive on their own: two writers
 * would simply create two different names. So acquisition funnels through one
 * fixed name, `_gate`, created with `mkdir`, which is atomic and admits exactly
 * one winner. The winner checks that no owner exists, writes its metadata, and
 * RENAMES the gate to its own nonce. Only the gate holder can produce an owner
 * directory, and only after finding none - so at most one exists at a time.
 *
 * A gate can be orphaned by a crash between the create and the rename. Clearing
 * one is harmless BY CONSTRUCTION rather than by timing: if a live holder's gate
 * is cleared, its rename fails with ENOENT and it retries. A cleared gate can
 * therefore never become a second owner. The post-check below covers the
 * remaining ordering: a holder that resumes late and renames a gate that is by
 * then somebody else's yields unless it holds the lowest nonce.
 *
 * ---------------------------------------------------------------------------
 * AGE NO LONGER DECIDES ANYTHING
 * ---------------------------------------------------------------------------
 * There is no `lockStaleMs`. A lock with readable owner metadata is reclaimed
 * when its owner is PROVED DEAD - see `ownerIsAlive` - and never because it is
 * old, however old it gets. A live owner stalled for an hour keeps its lock.
 * `lockAbandonMs` applies only to a lock whose metadata cannot be read at all,
 * where there is no owner left to ask about.
 */
export class ProjectLock {
  readonly #dir: string;

  constructor(projectDir: string) {
    this.#dir = path.join(projectDir, LOCK_DIR);
  }

  /** The lock directory's name, so callers can prove it is never a record. */
  static directoryName(): string {
    return LOCK_DIR;
  }

  /**
   * Take the lock, or return null if it could not be taken in time.
   *
   * Null is CONTENTION - not failure, and not quota exhaustion. Nothing has been
   * written and nothing has been consumed, so the caller may simply retry.
   */
  acquire(): HeldLock | null {
    const deadline = Date.now() + EXPERIENCE_STORAGE_LIMITS.lockAcquireTimeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      const held = this.#attempt();
      if (held !== null) return held;
      if (Date.now() >= deadline) return null;
      park(pollDelay(attempt));
    }
  }

  /**
   * Release a lock this process took.
   *
   * Names ONLY this holder's own nonce. There is no read, no comparison and no
   * window: a lock acquired by anybody else has a different name and is not
   * addressable from here.
   */
  release(held: HeldLock): void {
    if (!NONCE_SHAPE.test(held.nonce)) return;
    try {
      fs.rmSync(path.join(this.#dir, held.nonce), { recursive: true, force: true });
    } catch { /* best effort; a lock already gone is the desired state */ }
  }

  /** One acquisition attempt. Null means "not this time", never an error. */
  #attempt(): HeldLock | null {
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
    } catch {
      return null;
    }

    // Clear out owners whose processes are gone. Each removal names one nonce.
    this.#reclaimDeadOwners();

    // A live owner is never disturbed, however old its lock is.
    if (this.#owners().length > 0) return null;

    const gate = path.join(this.#dir, GATE_NAME);
    try {
      // Atomic, and admits exactly one winner.
      fs.mkdirSync(gate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") this.#clearAbandonedGate();
      return null;
    }

    const nonce = crypto.randomUUID();
    try {
      // Re-check under the gate: an owner may have appeared while we queued.
      if (this.#owners().length > 0) {
        fs.rmSync(gate, { recursive: true, force: true });
        return null;
      }
      const owner: TLockOwner = LockOwner.parse({
        version: 1,
        nonce,
        pid: process.pid,
        startedAt: OWN_STARTED_AT,
        acquiredAt: new Date().toISOString(),
      });
      fs.writeFileSync(path.join(gate, OWNER_FILE), JSON.stringify(owner), {
        encoding: "utf8", mode: 0o600,
      });
      // The gate BECOMES the lock. Nothing else can produce an owner directory.
      fs.renameSync(gate, path.join(this.#dir, nonce));
    } catch {
      // Including ENOENT, which means our gate was cleared while we held it.
      // That is the benign case: we never became an owner.
      try { fs.rmSync(gate, { recursive: true, force: true }); } catch { /* gone */ }
      return null;
    }

    /**
     * Post-check for the one ordering the gate cannot rule out: a holder that
     * stalls between taking the gate and renaming it can rename a gate that has
     * since been cleared and re-created by somebody else, leaving two owners.
     * The lowest nonce keeps the lock and everyone else yields - a total order,
     * so this terminates rather than ping-ponging.
     */
    const owners = this.#owners();
    if (owners.length > 1 && [...owners].sort()[0] !== nonce) {
      this.release({ nonce });
      return null;
    }
    return { nonce };
  }

  /** Nonce-named lock directories, bounded. Locks are few by construction. */
  #owners(): string[] {
    try {
      return scanDirectoryBounded(this.#dir, EXPERIENCE_STORAGE_LIMITS.maxLockEntries)
        .names.filter((name) => NONCE_SHAPE.test(name));
    } catch {
      return [];
    }
  }

  /**
   * Remove locks whose owning process is gone.
   *
   * Every removal names one specific nonce, so a lock acquired after the
   * observation is a different name and cannot be caught by it.
   */
  #reclaimDeadOwners(): void {
    for (const nonce of this.#owners()) {
      const lock = path.join(this.#dir, nonce);
      const owner = readOwner(path.join(lock, OWNER_FILE));

      if (owner === null) {
        // No owner to ask about. This is the ONLY place age decides anything,
        // and it is bounded so a corrupt lock cannot wedge a project forever.
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > EXPERIENCE_STORAGE_LIMITS.lockAbandonMs) {
            fs.rmSync(lock, { recursive: true, force: true });
          }
        } catch { /* already gone, or not ours to remove */ }
        continue;
      }

      // A lock whose recorded nonce disagrees with its directory name was not
      // written by this protocol. Treated as unreadable rather than trusted.
      if (owner.nonce !== nonce || ownerIsAlive(owner)) continue;

      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* another writer reclaimed it first */ }
    }
  }

  /**
   * Clear a gate nobody finished with.
   *
   * Safe whether or not its holder is alive: a holder whose gate is gone fails
   * its rename and retries, so clearing one can never produce a second owner.
   */
  #clearAbandonedGate(): void {
    const gate = path.join(this.#dir, GATE_NAME);
    try {
      if (Date.now() - fs.statSync(gate).mtimeMs <= EXPERIENCE_STORAGE_LIMITS.gateAbandonMs) {
        return;
      }
      fs.rmSync(gate, { recursive: true, force: true });
    } catch { /* already cleared */ }
  }
}

/** Read and validate lock owner metadata. Null if it is missing or not ours. */
function readOwner(file: string): TLockOwner | null {
  try {
    if (fs.statSync(file).size > EXPERIENCE_STORAGE_LIMITS.maxLockOwnerBytes) return null;
    const parsed = LockOwner.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
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
   *   6. re-count if new           defence in depth, never the invariant
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
          // Over the ceiling despite holding the lock, which should be
          // unreachable: it would mean two writers were admitted at once. Undo
          // our own publish rather than leave the project oversubscribed, and
          // report the refusal so the condition is visible rather than silent.
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
   * ---------------------------------------------------------------------------
   * DEFENCE IN DEPTH. NOT THE INVARIANT.
   * ---------------------------------------------------------------------------
   * The hard bound comes from mutual exclusion - one owner at a time, decided
   * before anything is published. This runs afterwards, so by the time it could
   * detect a breach the protected operation has already happened. That makes it
   * a safety net, and a safety net is not a lock. It is kept because it costs
   * one bounded scan and would catch a defect in the lock protocol that testing
   * missed, which is exactly what a second layer is for.
   *
   * It must never be read as the reason the ceiling holds. When the lock is
   * disabled and only this remains, the mutual-exclusion test fails while the
   * quota test still passes - the suite is arranged to show that difference
   * rather than let one mechanism stand in for the other.
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
        if (Date.now() - stats.mtimeMs <= EXPERIENCE_STORAGE_LIMITS.temporaryAbandonMs) continue;
        fs.rmSync(file, { force: true });
        removed += 1;
      } catch { /* someone else cleared it, or it is not ours to remove */ }
    }
  }
}
