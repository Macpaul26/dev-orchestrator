import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

/**
 * PROJECT-LEVEL IMPLEMENTATION LOCK
 *
 * One project, one mutating run at a time. Two runs writing the same working
 * tree would make attribution meaningless - Phase 3 decides what a run changed
 * by comparing two snapshots, and a concurrent writer poisons that comparison.
 * So the lock protects the integrity of the evidence, not just the files.
 *
 * ---------------------------------------------------------------------------
 * ACQUISITION IS ATOMIC
 * ---------------------------------------------------------------------------
 * `open(..., "wx")` creates the lock file exclusively. Two processes racing
 * cannot both succeed: one gets EEXIST. There is no read-then-write window.
 *
 * ---------------------------------------------------------------------------
 * STALE LOCKS FAIL CLOSED - A DELIBERATE CHOICE
 * ---------------------------------------------------------------------------
 * If a process dies holding the lock, this class does NOT reclaim it
 * automatically, even when the recorded pid is clearly gone.
 *
 * Automatic reclaim would need "is that pid alive?" to be trustworthy, and it
 * is not: pids are reused, and on a shared filesystem the pid belongs to
 * another machine entirely. Guessing wrong means two writers in one working
 * tree - the exact thing the lock exists to prevent.
 *
 * So a stale lock BLOCKS, and reports everything a human needs to clear it
 * deliberately (`dev-agent implementation:unlock`). Liveness is *reported* as a
 * hint, never acted on. The cost is that a crash needs one human command; the
 * benefit is that no crash can ever produce concurrent mutation. For a system
 * whose entire thesis is human control, that is the right trade, and the
 * limitation is stated in docs/PHASE-4A.md rather than hidden.
 */

export const LockRecord = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  grantId: z.string().nullable().default(null),
  pid: z.number().int().nonnegative(),
  hostname: z.string(),
  acquiredAt: z.string().datetime(),
});
export type LockRecord = z.infer<typeof LockRecord>;

export const LockDenialReason = z.enum([
  "held_by_another_run",
  "held_by_this_run",
  "stale_requires_human",
  "unreadable",
]);
export type LockDenialReason = z.infer<typeof LockDenialReason>;

export class LockDenied extends Error {
  constructor(
    readonly reason: LockDenialReason,
    readonly holder: LockRecord | null,
    message: string,
  ) {
    super(message);
    this.name = "LockDenied";
  }
}

/** Best-effort liveness. Reported to a human, never used to reclaim. */
function looksAlive(record: LockRecord): boolean | null {
  if (record.hostname !== os.hostname()) return null; // cannot know
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists, owned by someone else
    return null;
  }
}

export class ImplementationLock {
  constructor(private readonly lockFile: string) {}

  static forProject(projectDir: string): ImplementationLock {
    return new ImplementationLock(path.join(projectDir, "implementation.lock"));
  }

  read(): LockRecord | null {
    if (!fs.existsSync(this.lockFile)) return null;
    try {
      return LockRecord.parse(JSON.parse(fs.readFileSync(this.lockFile, "utf8")));
    } catch {
      return null; // present but unparseable - treated as held, see acquire()
    }
  }

  isHeld(): boolean {
    return fs.existsSync(this.lockFile);
  }

  /**
   * Take the lock, or refuse. Never blocks, never waits, never steals.
   */
  acquire(input: { projectId: string; runId: string; grantId?: string | null }): LockRecord {
    const record = LockRecord.parse({
      projectId: input.projectId,
      runId: input.runId,
      grantId: input.grantId ?? null,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    });

    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });

    let handle: number;
    try {
      // Atomic: exactly one racing process can create this.
      handle = fs.openSync(this.lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const holder = this.read();
      if (!holder) {
        throw new LockDenied(
          "unreadable",
          null,
          `An implementation lock exists at "${this.lockFile}" but cannot be read. ` +
            "Refusing to proceed. A human must inspect and remove it.",
        );
      }
      const alive = looksAlive(holder);
      const liveness =
        alive === true ? "its process appears to be running"
        : alive === false ? "its process is NOT running, so the lock is probably stale"
        : "liveness cannot be determined (different host)";

      throw new LockDenied(
        alive === false ? "stale_requires_human"
        : holder.runId === input.runId ? "held_by_this_run"
        : "held_by_another_run",
        holder,
        `Project "${input.projectId}" is already locked for implementation by run ` +
          `${holder.runId} (pid ${holder.pid} on ${holder.hostname}, since ` +
          `${holder.acquiredAt}); ${liveness}. Concurrent mutation is refused. ` +
          "Clear it deliberately with: dev-agent implementation:unlock --project " +
          `${input.projectId}`,
      );
    }

    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    return record;
  }

  /**
   * Release, but only the holder may.
   *
   * Guards against a late failure path in one run deleting the lock another run
   * has since legitimately taken.
   */
  release(runId: string): boolean {
    const holder = this.read();
    if (!holder) return false;
    if (holder.runId !== runId) return false;
    fs.rmSync(this.lockFile, { force: true });
    return true;
  }

  /**
   * Remove the lock regardless of holder. FOR HUMAN USE ONLY.
   *
   * Exposed through an explicit CLI command, never called on a failure path -
   * that would be automatic reclaim wearing a different name.
   */
  forceRelease(): LockRecord | null {
    const holder = this.read();
    fs.rmSync(this.lockFile, { force: true });
    return holder;
  }

  /** Liveness of the current holder, for a human deciding whether to unlock. */
  describe(): { holder: LockRecord | null; alive: boolean | null } {
    const holder = this.read();
    return { holder, alive: holder ? looksAlive(holder) : null };
  }
}
