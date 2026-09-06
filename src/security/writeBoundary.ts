import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FsBoundary} from "./fsBoundary.js";
import { SymlinkEscapeError } from "./fsBoundary.js";
import { PathEscapeError } from "../persistence/paths.js";
import { classifySensitivity } from "./sensitive.js";
import { type InspectionLimits, DEFAULT_LIMITS } from "./limits.js";
import type { DenialReason } from "../domain/denial.js";

/**
 * THE WRITE BOUNDARY
 *
 * The counterpart to SafeFs. It performs the only repository mutations the
 * orchestrator can perform, and it reuses `FsBoundary` for containment - there
 * is deliberately NO second path-security implementation. Two would drift, and
 * the drift would be the vulnerability.
 *
 * What that buys, unchanged from Phase 3: `..` traversal, absolute paths,
 * Windows drive and UNC escapes, prefix collisions, symlinks, junctions,
 * intermediate links and dangling links are all rejected, lexically AND after
 * physical resolution.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CLASS CANNOT DO
 * ---------------------------------------------------------------------------
 * There is no method to move, chmod, chown, create a symlink, or write outside
 * the boundary, and no method that takes a command. The surface is: write a
 * file, delete a file. Adding to it is a phase decision.
 *
 * ---------------------------------------------------------------------------
 * TOCTOU - STATED HONESTLY
 * ---------------------------------------------------------------------------
 * This is NOT TOCTOU-proof, and this file will not claim to be. What it does:
 *
 *   - resolves and re-validates the path IMMEDIATELY before mutating, not once
 *     at the start of a session;
 *   - operates on the PHYSICALLY RESOLVED path, so a symlink swapped in at the
 *     original path after validation is not followed - the write lands where
 *     containment was actually proven;
 *   - creates its temporary file with `wx` (exclusive create), so it can never
 *     clobber or follow something that appeared underneath it;
 *   - keeps the temporary file in the SAME DIRECTORY as the target, so it is
 *     inside the boundary and the final replace is a same-filesystem rename;
 *   - fails explicitly rather than degrading to an unsafe write.
 *
 * What remains: a directory component can in principle be replaced between
 * `resolve()` and the final `rename()`. Closing that needs `openat`-style
 * directory-relative syscalls, which Node does not expose. On Windows there is
 * additionally no `O_NOFOLLOW`. Documented in docs/PHASE-4A.md; not solved here.
 */

/**
 * Refusal codes, drawn from the shared vocabulary in domain/denial.ts.
 *
 * They are the SAME set the activity journal records and the grant checks use.
 * When these were a private enum, four of them - `symlink_escape` among them -
 * were unknown to the journal's schema, so the most security-relevant refusals
 * would have failed validation instead of being recorded.
 */
export const WriteDenialCode = {
  PATH_ESCAPE: "path_escape",
  SYMLINK_ESCAPE: "symlink_escape",
  SENSITIVE_PATH: "sensitive_path",
  TOO_LARGE: "file_too_large",
  NOT_A_FILE: "not_a_file",
  MISSING: "missing",
  IO_ERROR: "io_error",
} as const satisfies Record<string, DenialReason>;
export type WriteDenialCode = (typeof WriteDenialCode)[keyof typeof WriteDenialCode];

export class WriteRefused extends Error {
  constructor(
    readonly code: WriteDenialCode,
    message: string,
  ) {
    super(message);
    this.name = "WriteRefused";
  }
}

export interface WriteOutcome {
  /** Forward-slash path relative to the boundary root. */
  path: string;
  bytes: number;
  /** True when the file did not exist before. */
  created: boolean;
  /** False when the platform forced a non-atomic replacement. */
  atomic: boolean;
  /** SHA-256 of what was written. Null for a sensitive path - see below. */
  contentHash: string | null;
}

export class SafeWriteFs {
  constructor(
    private readonly boundary: FsBoundary,
    private readonly limits: InspectionLimits = DEFAULT_LIMITS,
  ) {}

  get root(): string {
    return this.boundary.root;
  }

  /**
   * Create or replace a file, atomically where the platform allows.
   *
   *   1. resolve and prove containment (immediately before mutating)
   *   2. refuse sensitive paths outright
   *   3. write a temporary file INSIDE the target's directory, exclusively
   *   4. fsync, close
   *   5. rename over the target
   *
   * Step 3 keeps the temporary inside the project boundary - never in the
   * system temp directory, where it would sit outside every guarantee this
   * class makes and could outlive a crash holding repository content.
   */
  writeFile(relativePath: string, contents: string | Buffer): WriteOutcome {
    const target = this.resolveForMutation(relativePath);
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");

    if (buffer.byteLength > this.limits.maxFileBytes) {
      throw new WriteRefused(
        WriteDenialCode.TOO_LARGE,
        `Refusing to write ${buffer.byteLength} bytes to "${target.relative}"; ` +
          `the limit is ${this.limits.maxFileBytes}.`,
      );
    }

    const created = !fs.existsSync(target.absolute);
    const directory = path.dirname(target.absolute);

    // Parent directories are created only INSIDE the boundary: `directory` is
    // derived from the already-resolved absolute path, so it cannot be outside.
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new WriteRefused(
        WriteDenialCode.IO_ERROR,
        `Could not create the containing directory for "${target.relative}": ` +
          `${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
      );
    }

    const temporary = path.join(
      directory,
      `.orchestrator-tmp-${crypto.randomBytes(8).toString("hex")}`,
    );

    let atomic = true;
    try {
      // "wx" = create exclusively. If anything already exists at this name -
      // including a symlink someone just planted - the open fails rather than
      // being followed.
      const handle = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(handle, buffer);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }

      try {
        fs.renameSync(temporary, target.absolute);
      } catch (error) {
        // Windows can refuse to rename over a file another process holds open.
        // Fall back, but report that the replacement was NOT atomic rather than
        // letting the caller assume it was.
        if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
          fs.rmSync(target.absolute, { force: true });
          fs.renameSync(temporary, target.absolute);
          atomic = false;
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof WriteRefused) throw error;
      throw new WriteRefused(
        WriteDenialCode.IO_ERROR,
        `Write to "${target.relative}" failed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
      );
    } finally {
      // A temporary holding repository content must never be left behind.
      try {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      } catch {
        // Best effort; the write outcome above is what matters.
      }
    }

    return {
      path: target.relative,
      bytes: buffer.byteLength,
      created,
      atomic,
      contentHash: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  }

  /** Delete one regular file. Directories are not removable through this class. */
  deleteFile(relativePath: string): { path: string; existed: boolean } {
    const target = this.resolveForMutation(relativePath);

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(target.absolute);
    } catch {
      return { path: target.relative, existed: false };
    }
    if (!stats.isFile()) {
      throw new WriteRefused(
        WriteDenialCode.NOT_A_FILE,
        `"${target.relative}" is not a regular file; only files can be deleted.`,
      );
    }

    try {
      fs.unlinkSync(target.absolute);
    } catch (error) {
      throw new WriteRefused(
        WriteDenialCode.IO_ERROR,
        `Delete of "${target.relative}" failed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
      );
    }
    return { path: target.relative, existed: true };
  }

  /**
   * Containment check performed immediately before every mutation.
   *
   * Also the single place the sensitive-file rule is applied to writes.
   * ANY path the policy covers is refused outright in this phase - the
   * implementation substrate has no business creating or replacing a `.env` or
   * a private key, and refusing is the only version of that rule with no
   * bypass. Reading them is already refused by SafeFs.
   */
  private resolveForMutation(relativePath: string): { absolute: string; relative: string } {
    let resolved: { absolute: string; relative: string };
    try {
      resolved = this.boundary.resolve(relativePath);
    } catch (error) {
      if (error instanceof SymlinkEscapeError) {
        throw new WriteRefused(WriteDenialCode.SYMLINK_ESCAPE, error.message);
      }
      if (error instanceof PathEscapeError) {
        throw new WriteRefused(WriteDenialCode.PATH_ESCAPE, error.message);
      }
      throw error;
    }

    if (resolved.relative === "") {
      throw new WriteRefused(
        WriteDenialCode.NOT_A_FILE,
        "The project root itself is not a writable path.",
      );
    }

    const verdict = classifySensitivity(resolved.relative);
    if (verdict.sensitive) {
      throw new WriteRefused(
        WriteDenialCode.SENSITIVE_PATH,
        `"${resolved.relative}" is covered by the sensitive-file policy ` +
          `(${verdict.detail}); the implementation substrate may not write it.`,
      );
    }

    return resolved;
  }
}
