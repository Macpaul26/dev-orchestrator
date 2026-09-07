import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  VerificationCheck, CHECK_CEILINGS, VerificationExecutableIdentity,
  type VerificationCheck as TVerificationCheck,
  type VerificationExecutableIdentity as TIdentity,
  type CheckBlockReason,
} from "../domain/verificationCheck.js";

/**
 * THE TRUSTED CHECK POLICY
 *
 * What the orchestrator is allowed to execute, decided BEFORE the untrusted
 * implementation starts.
 *
 * ---------------------------------------------------------------------------
 * THE ATTACK THIS EXISTS TO STOP
 * ---------------------------------------------------------------------------
 * The agent can write files. `project.json` is a file. So without this module
 * the sequence is:
 *
 *   1. agent rewrites the project's check definitions
 *   2. orchestrator loads them
 *   3. orchestrator executes the agent's chosen program, as trusted verification
 *
 * That turns verification into arbitrary execution with extra steps, and it
 * does so through a path that is otherwise entirely legitimate.
 *
 * The fix is not to make the config file unwritable - the agent may have a
 * perfectly good reason to touch files near it, and a boundary that depends on
 * one filename is a boundary waiting to be walked around. Instead the policy is
 * CAPTURED and FINGERPRINTED before the agent runs, and the fingerprint is
 * recomputed immediately before execution. A mismatch does not run the old
 * version and does not run the new one - it blocks, and says why.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION IS PART OF CAPTURE
 * ---------------------------------------------------------------------------
 * A definition that fails validation becomes a BLOCKED result carrying a
 * reason, never a silently-dropped entry. A check that vanishes from a report
 * is indistinguishable from a check that passed.
 */

export interface CheckPolicy {
  /** Definitions that survived validation, in declaration order. */
  checks: readonly TVerificationCheck[];
  /** Definitions refused at capture, with the reason. Reported, never dropped. */
  rejected: readonly { id: string; reason: CheckBlockReason; detail: string }[];
  /** SHA-256 over the canonical form of the DEFINITIONS. Not the executables. */
  fingerprint: string;
  /**
   * What each executable WAS, by content, keyed by check id.
   *
   * Captured at the same trusted moment as the definitions and compared again
   * immediately before launch. Absent for a check whose executable could not be
   * hashed - which blocks that check rather than running it.
   */
  identities: Readonly<Record<string, TIdentity>>;
  capturedAt: string;
}

/**
 * Establish which file a configured executable currently is.
 *
 * Streamed in fixed-size chunks rather than read whole: this exists to detect
 * change, not to read the program, so it must not be able to pull a large
 * binary into memory. Same reasoning as the fingerprinting in
 * security/safeFs.ts, which is not reused here because that one is scoped to
 * paths inside the project boundary - and a verification executable is normally
 * OUTSIDE it, since a language runtime lives wherever it was installed.
 *
 * Fails closed. Anything that prevents establishing the identity - missing,
 * unreadable, a directory, too large - returns a reason, and the caller must
 * refuse to run rather than launch something it cannot identify.
 */
export function captureExecutableIdentity(
  executable: string,
  now: () => Date = () => new Date(),
): { ok: true; identity: TIdentity } | { ok: false; reason: CheckBlockReason; detail: string } {
  let resolvedPath: string;
  try {
    // Resolve links FIRST, so the identity describes the file that will really
    // be executed rather than whatever the path pointed at when it was written.
    resolvedPath = fs.realpathSync(executable);
  } catch {
    return {
      ok: false,
      reason: "executable_missing",
      detail: "the configured executable does not exist or could not be resolved",
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    return {
      ok: false, reason: "executable_missing",
      detail: "the configured executable could not be inspected",
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false, reason: "executable_missing",
      detail: "the configured executable is not a file",
    };
  }
  if (stats.size > CHECK_CEILINGS.maxExecutableHashBytes) {
    return {
      ok: false,
      reason: "executable_identity_unavailable",
      detail: "the executable is larger than the hashing ceiling, so its identity " +
        "cannot be established; it will not be run",
    };
  }

  const digest = crypto.createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let handle: number;
  try {
    handle = fs.openSync(resolvedPath, "r");
  } catch {
    return {
      ok: false, reason: "executable_identity_unavailable",
      detail: "the executable could not be opened for hashing; it will not be run",
    };
  }
  try {
    let position = 0;
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
      position += read;
    }
  } catch {
    return {
      ok: false, reason: "executable_identity_unavailable",
      detail: "the executable could not be read for hashing; it will not be run",
    };
  } finally {
    fs.closeSync(handle);
  }

  return {
    ok: true,
    identity: VerificationExecutableIdentity.parse({
      path: executable,
      resolvedPath,
      sha256: digest.digest("hex"),
      sizeBytes: stats.size,
      capturedAt: now().toISOString(),
    }),
  };
}

/** Short, safe form of a digest for a human-facing report. */
export function shortDigest(sha256: string): string {
  return sha256.slice(0, 12);
}

/**
 * Canonical JSON: field order fixed by construction, not by object insertion.
 *
 * A fingerprint that changes when a config file is merely reformatted would
 * block honest runs and train everyone to ignore the signal.
 */
function canonical(check: TVerificationCheck): string {
  return JSON.stringify([
    check.id, check.name, check.executable, check.args,
    check.cwd, check.timeoutMs, check.enabled,
  ]);
}

export function fingerprintPolicy(checks: readonly TVerificationCheck[]): string {
  const hash = crypto.createHash("sha256");
  // Sorted by id so declaration order cannot change the fingerprint, while the
  // ORDER OF EXECUTION still follows the file. Reordering is not tampering.
  for (const check of [...checks].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(canonical(check));
    // NUL as the field separator, written as an escape so the source stays
    // plain text. A raw NUL byte here makes git treat the whole file as
    // binary, which silently costs every future diff and review of it.
    // NUL is the right delimiter regardless: it cannot occur in any of the
    // values above, so two different policies cannot hash the same.
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * Validate one definition against the hard ceilings.
 *
 * Returns a reason rather than throwing: one bad check must not stop the others
 * from running, and the bad one must still appear in the report.
 */
export function validateCheck(
  input: unknown,
): { ok: true; check: TVerificationCheck } | { ok: false; reason: CheckBlockReason; detail: string } {
  let check: TVerificationCheck;
  try {
    // `.strict()` refuses unknown keys, so a legacy `{ command: "npm test" }`
    // is REJECTED here rather than parsed into something that looks valid.
    check = VerificationCheck.parse(input);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_definition",
      detail: error instanceof Error ? error.name : "definition did not validate",
    };
  }

  if (!path.isAbsolute(check.executable)) {
    return {
      ok: false,
      reason: "executable_not_absolute",
      detail:
        "the executable must be an absolute path; a bare name would be resolved " +
        "through PATH, making whatever is earliest on PATH the verification tool",
    };
  }

  // Clamped, not rejected: a project asking for longer than the ceiling gets the
  // ceiling. Refusing outright would tempt someone to raise the ceiling instead.
  if (check.timeoutMs > CHECK_CEILINGS.maxTimeoutMs) {
    return {
      ok: false,
      reason: "invalid_definition",
      detail: `timeout exceeds the hard ceiling of ${CHECK_CEILINGS.maxTimeoutMs}ms`,
    };
  }

  return { ok: true, check };
}

/**
 * Capture the effective policy from trusted project configuration.
 *
 * Called BEFORE the implementation phase. Nothing here reads a request, a plan,
 * a model output, or anything an agent can influence.
 */
export function capturePolicy(
  declared: readonly unknown[],
  now: () => Date = () => new Date(),
): CheckPolicy {
  const checks: TVerificationCheck[] = [];
  const rejected: { id: string; reason: CheckBlockReason; detail: string }[] = [];

  for (const [index, entry] of declared.entries()) {
    // Over the ceiling: recorded as blocked, so the report still accounts for it.
    if (checks.length >= CHECK_CEILINGS.maxChecksPerRun) {
      rejected.push({
        id: identify(entry, index),
        reason: "check_limit_exceeded",
        detail: `only ${CHECK_CEILINGS.maxChecksPerRun} checks may run in one attempt`,
      });
      continue;
    }
    const result = validateCheck(entry);
    if (result.ok) checks.push(result.check);
    else rejected.push({ id: identify(entry, index), reason: result.reason, detail: result.detail });
  }

  /**
   * Identities are captured HERE, at the same trusted moment as the
   * definitions - before planning, approval or implementation.
   *
   * Hashing after the agent had finished would hash whatever the agent left
   * behind, which is precisely the file that cannot be trusted.
   */
  const identities: Record<string, TIdentity> = {};
  for (const check of checks) {
    const identity = captureExecutableIdentity(check.executable, now);
    // A failure here is NOT a rejection of the definition - the definition is
    // fine. It means this check has no trusted identity, so the execution-time
    // comparison will find none and refuse to run it.
    if (identity.ok) identities[check.id] = identity.identity;
  }

  return {
    checks,
    rejected,
    fingerprint: fingerprintPolicy(checks),
    identities,
    capturedAt: now().toISOString(),
  };
}

/** A usable label for a definition too malformed to have a valid id. */
function identify(entry: unknown, index: number): string {
  if (entry && typeof entry === "object") {
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0 && id.length <= 64) return id;
    const name = (entry as Record<string, unknown>)["name"];
    if (typeof name === "string" && name.length > 0 && name.length <= 64) return name;
  }
  return `check-${index}`;
}

/**
 * SUPERSEDED by `verifyExecutableIdentity`, and kept only as its first step.
 *
 * On its own this establishes that SOMETHING exists at the path - which was
 * exactly the gap: the policy could stay identical while the file it named was
 * replaced. Existence is necessary and nowhere near sufficient, so no caller
 * relies on this alone any more.
 */
export function executableUsable(
  executable: string,
): { ok: true } | { ok: false; reason: CheckBlockReason; detail: string } {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(executable);
  } catch {
    return {
      ok: false,
      reason: "executable_missing",
      detail: "the configured executable does not exist",
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      reason: "executable_missing",
      detail: "the configured executable is not a file",
    };
  }
  return { ok: true };
}

/**
 * THE GUARD: is this the same executable that was trusted before implementation?
 *
 * Called immediately before launch, after the untrusted run has finished. It is
 * the difference between "a file is there" and "the file we agreed to run is
 * there", and it is the only thing standing between an agent with write
 * authority and its own program executing under the orchestrator hand.
 *
 * Fails closed in every direction: no captured identity, unreadable file,
 * different digest, different resolved target - all refuse.
 */
export function verifyExecutableIdentity(
  executable: string,
  expected: TIdentity | undefined,
  now: () => Date = () => new Date(),
):
  | { ok: true; identity: TIdentity }
  | {
      ok: false; reason: CheckBlockReason; detail: string;
      expected: string | null; observed: string | null;
    } {
  if (!expected) {
    return {
      ok: false,
      reason: "executable_identity_unavailable",
      detail:
        "no trusted identity was captured for this executable before the " +
        "implementation ran, so it cannot be confirmed as the program that was " +
        "trusted; it will not be run",
      expected: null, observed: null,
    };
  }

  const current = captureExecutableIdentity(executable, now);
  if (!current.ok) {
    return {
      ok: false, reason: current.reason, detail: current.detail,
      expected: shortDigest(expected.sha256), observed: null,
    };
  }

  if (current.identity.sha256 !== expected.sha256) {
    return {
      ok: false,
      reason: "executable_integrity_changed",
      detail:
        "the verification executable changed after the trusted baseline was " +
        "captured; execution was not started",
      expected: shortDigest(expected.sha256),
      observed: shortDigest(current.identity.sha256),
    };
  }

  // Same bytes but a different file on disk: the path was repointed. Treated as
  // a change too, because what would execute is not what was inspected.
  if (current.identity.resolvedPath !== expected.resolvedPath) {
    return {
      ok: false,
      reason: "executable_integrity_changed",
      detail:
        "the verification executable path now resolves to a different file; " +
        "execution was not started",
      expected: shortDigest(expected.sha256),
      observed: shortDigest(current.identity.sha256),
    };
  }

  return { ok: true, identity: current.identity };
}
