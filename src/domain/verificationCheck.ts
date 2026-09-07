import { z } from "zod";

/**
 * CONTROLLED VERIFICATION CHECKS
 *
 * A check is a program the orchestrator runs ITSELF to answer one question:
 *
 *   > Did the resulting software pass the checks we were authorised to run?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A COMMAND STRING
 * ---------------------------------------------------------------------------
 * The obvious shape is `{ command: "npm test" }`. It is the wrong shape, and
 * the reason is not style.
 *
 * A command string has to be turned into an argv array before anything can run
 * it. There are exactly two ways to do that: hand it to a shell, which is the
 * arbitrary execution this whole system exists to refuse; or write a parser,
 * whose bugs are then security bugs - `npm test; rm -rf .` has to be wrong in
 * the parser before it is wrong anywhere else.
 *
 * So a check carries an EXECUTABLE and an ARGV ARRAY, and nothing anywhere
 * splits a string. `;`, `&&`, `|`, `$(...)` and `>` are ordinary characters in
 * an argument - they reach the program as literal text because no shell is
 * involved, and a test asserts exactly that.
 *
 * `.strict()` is doing real work here: a definition carrying `command` is
 * REJECTED rather than ignored, so the unsafe shape cannot survive in a config
 * file while quietly doing nothing.
 *
 * ---------------------------------------------------------------------------
 * WHERE A DEFINITION COMES FROM
 * ---------------------------------------------------------------------------
 * Trusted project configuration, captured BEFORE the untrusted implementation
 * runs. No part of it is model-supplied, request-supplied, or editable by the
 * agent during a run. See verification/checkPolicy.ts, which fingerprints the
 * captured policy so a mid-run rewrite is detected rather than executed.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const CHECK_CEILINGS = {
  /** Longest any single check may run, whatever the project asks for. */
  maxTimeoutMs: 15 * 60 * 1000,
  /** Wall-clock budget for ALL checks in one run, together. */
  maxTotalDurationMs: 30 * 60 * 1000,
  /** Most checks one run will execute. */
  maxChecksPerRun: 20,
  /** Captured bytes per stream. Beyond this, bytes are counted and discarded. */
  maxOutputBytesPerStream: 64 * 1024,
  /** Bounded excerpt retained in durable evidence. */
  maxExcerptBytes: 2 * 1024,
  /** Longest argv a definition may carry. */
  maxArgs: 64,
  maxArgLength: 4 * 1024,
} as const;

export const VerificationCheck = z.object({
  /** Stable identifier, used to match results to definitions across a restart. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/,
    "check id must be lower-case kebab/dot/underscore"),
  name: z.string().min(1).max(200),
  /**
   * ABSOLUTE path to the program.
   *
   * A bare name would be resolved through PATH, which makes whatever happens to
   * be earliest on PATH the verification tool. Same reasoning as the Claude Code
   * executable, and the same rule.
   */
  executable: z.string().min(1),
  /** Fixed arguments. Never appended to, never templated, never agent-supplied. */
  args: z.array(z.string().max(CHECK_CEILINGS.maxArgLength))
    .max(CHECK_CEILINGS.maxArgs).default([]),
  /**
   * Working directory, RELATIVE to the project working directory.
   *
   * Relative by construction: an absolute path here would be a way to point a
   * check at somewhere outside the project, so the type does not allow the
   * question to be asked. Resolution goes through the same FsBoundary as every
   * other path, which is what rejects `..` and link escapes.
   */
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().max(CHECK_CEILINGS.maxTimeoutMs)
    .default(5 * 60 * 1000),
  /** A disabled check is reported as `not_run`, never as passing. */
  enabled: z.boolean().default(true),
}).strict();
export type VerificationCheck = z.infer<typeof VerificationCheck>;

/**
 * WHAT HAPPENED TO ONE CHECK.
 *
 * Seven outcomes, not two, because "did not pass" covers wildly different
 * facts and collapsing them would let an infrastructure problem read as a code
 * problem - or worse, let "we never ran it" read as "it was fine".
 */
export const CheckStatus = z.enum([
  /** The process exited 0. The only status that means the check passed. */
  "passed",
  /** The process exited non-zero. The code or its tests are at fault. */
  "failed",
  /** Killed at the deadline. Says nothing about whether the code is correct. */
  "timed_out",
  /** Stopped because the run was cancelled. Not a verdict on the code. */
  "cancelled",
  /** The process could not run at all - missing executable, spawn refused. */
  "error",
  /** Refused before launch: not authorised, invalid definition, over ceiling. */
  "blocked",
  /** Never attempted. NOT a pass, and never to be treated as one. */
  "not_run",
]);
export type CheckStatus = z.infer<typeof CheckStatus>;

/** Statuses that do NOT establish that the software is in good shape. */
export const NON_PASSING_STATUSES: readonly CheckStatus[] = [
  "failed", "timed_out", "cancelled", "error", "blocked", "not_run",
] as const;

export function isPassing(status: CheckStatus): boolean {
  return status === "passed";
}

/**
 * Why a check could not be attempted. Distinct from why one FAILED.
 *
 * The distinction matters at review: "your tests are broken" and "we could not
 * run your tests" call for different responses from a human.
 */
export const CheckBlockReason = z.enum([
  "not_authorised",
  "no_checks_configured",
  "check_disabled",
  "invalid_definition",
  "executable_not_absolute",
  "executable_missing",
  "working_directory_escape",
  "policy_changed_during_run",
  "run_budget_exhausted",
  "check_limit_exceeded",
  "cancelled_before_start",
]);
export type CheckBlockReason = z.infer<typeof CheckBlockReason>;

/**
 * ONE CHECK'S RESULT - AN OBSERVATION, NOT A CLAIM.
 *
 * Every field here comes from the operating system or from the orchestrator's
 * own clock. Nothing an agent said contributes to any of it. `passed` does not
 * appear as an independent boolean on purpose: it would be a second source of
 * truth able to disagree with `status`, so passing is derived from the status
 * and the exit code alone.
 */
export const VerificationCheckResult = z.object({
  checkId: z.string().min(1),
  name: z.string().default(""),
  status: CheckStatus,

  /** Null when the process never started or was killed before exiting. */
  exitCode: z.number().int().nullable().default(null),
  signal: z.string().nullable().default(null),
  durationMs: z.number().nonnegative().default(0),
  timedOut: z.boolean().default(false),
  cancelled: z.boolean().default(false),

  /** Byte counts, always - even when no output is retained. */
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
  /** True when output exceeded the cap and bytes were discarded. */
  outputTruncated: z.boolean().default(false),
  /**
   * A bounded tail of output, for a human at the review gate.
   *
   * Bounded rather than complete, and never the whole stream: check output is
   * project-controlled text that can contain anything the project prints,
   * including things it should not. A short excerpt plus byte counts describes
   * a failure without turning the audit trail into a content store.
   */
  outputExcerpt: z.string().default(""),

  /** Set only when the check could not be attempted. */
  blockedReason: CheckBlockReason.nullable().default(null),
  /** Short, non-disclosing. Never a buffer, never file content. */
  detail: z.string().nullable().default(null),

  startedAt: z.string().datetime().nullable().default(null),
  endedAt: z.string().datetime().nullable().default(null),
});
export type VerificationCheckResult = z.infer<typeof VerificationCheckResult>;

/**
 * THE WHOLE CHECK PHASE FOR ONE RUN.
 *
 * `attempted: false` with an empty result list is the honest representation of
 * "nothing was checked". It is deliberately NOT the same value as a run where
 * everything passed, and `allPassed` is false in both - see `summarise`.
 */
export const VerificationCheckRun = z.object({
  /** Whether the check phase ran at all. */
  attempted: z.boolean().default(false),
  /** Whether a human authorised check execution for this run. */
  authorised: z.boolean().default(false),
  results: z.array(VerificationCheckResult).default([]),

  /** Count of definitions the trusted policy carried. */
  declared: z.number().int().nonnegative().default(0),
  executed: z.number().int().nonnegative().default(0),
  passed: z.number().int().nonnegative().default(0),
  totalDurationMs: z.number().nonnegative().default(0),

  /**
   * SHA-256 over the effective check policy.
   *
   * Captured before the untrusted implementation runs and compared again
   * before execution. A mismatch means the policy changed mid-run - which is
   * the agent rewriting the verification rules - and blocks execution rather
   * than running the rewritten version.
   */
  policyFingerprint: z.string().nullable().default(null),
  policyChangedDuringRun: z.boolean().default(false),

  /**
   * Files the CHECKS themselves changed.
   *
   * Attributed against a snapshot taken after the agent finished and before the
   * first check started, so a change here belongs to a check rather than to the
   * agent. A verification command is executable code; assuming it cannot write
   * is how a "test" quietly edits a repository.
   */
  filesChangedByChecks: z.array(z.string()).default([]),
  repositoryChangedByChecks: z.boolean().default(false),

  notRunReason: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
});
export type VerificationCheckRun = z.infer<typeof VerificationCheckRun>;

/**
 * Derive the run summary from results.
 *
 * `allPassed` is FALSE when nothing ran. That is the whole point: an empty
 * check list must never read as success, and a caller asking "did the checks
 * pass?" of a run with no checks has to get "no".
 */
export function summariseChecks(
  results: readonly VerificationCheckResult[],
): { executed: number; passed: number; allPassed: boolean; totalDurationMs: number } {
  const executed = results.filter(
    (r) => r.status !== "not_run" && r.status !== "blocked",
  ).length;
  const passed = results.filter((r) => isPassing(r.status)).length;
  return {
    executed,
    passed,
    // Every declared check ran AND every one of them passed. Zero checks is not
    // a pass, however tempting the vacuous truth is.
    allPassed: results.length > 0 && passed === results.length,
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  };
}
