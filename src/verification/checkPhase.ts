import {
  VerificationCheckRun, CHECK_CEILINGS, summariseChecks,
  type VerificationCheckResult as TVerificationCheckResult,
  type VerificationCheckRun as TVerificationCheckRun,
} from "../domain/verificationCheck.js";
import type { Capability } from "../domain/capability.js";
import { ControlledCheckRunner } from "./checkRunner.js";
import { capturePolicy, type CheckPolicy } from "./checkPolicy.js";

/**
 * THE CHECK PHASE
 *
 * Runs the trusted policy's checks, in order, inside one aggregate budget, and
 * returns a single durable record of what happened.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT SHAPES EVERYTHING HERE
 * ---------------------------------------------------------------------------
 *   > "not run" must never be reachable from "passed", in either direction.
 *
 * That sounds obvious and is easy to violate by accident. `allPassed` computed
 * as `results.every(passed)` is TRUE for an empty list; a summary that counts
 * failures reports zero when nothing ran; a UI that hides empty sections shows
 * a clean report for a project that was never checked. Each of those turns
 * "we did not look" into "it is fine".
 *
 * So an unattempted phase is represented explicitly - `attempted: false` with a
 * stated reason - and every derived count comes from `summariseChecks`, which
 * returns `allPassed: false` for an empty run.
 */

export interface CheckPhaseOptions {
  workingDir: string;
  /** Capabilities a human granted. Checks run only with `verification.execute`. */
  grantedCapabilities: readonly Capability[];
  /** The policy captured BEFORE the untrusted implementation ran. */
  policy: CheckPolicy;
  /**
   * The policy as it stands NOW, re-read from project configuration.
   *
   * Compared by fingerprint against `policy`. A difference means the check
   * definitions changed while the agent had write access - so neither version
   * is trusted and nothing is executed.
   */
  currentChecks?: readonly unknown[];
  signal?: AbortSignal;
  now?: () => Date;
}

/** A phase that did not run, carrying the reason it did not. */
function notAttempted(
  policy: CheckPolicy,
  reason: string,
  extra: Partial<TVerificationCheckRun> = {},
): TVerificationCheckRun {
  return VerificationCheckRun.parse({
    attempted: false,
    declared: policy.checks.length,
    policyFingerprint: policy.fingerprint,
    notRunReason: reason,
    // Definitions refused at capture are still reported. A check that silently
    // disappears from a report is indistinguishable from one that passed.
    results: policy.rejected.map((r) => ({
      checkId: r.id, name: r.id, status: "blocked" as const,
      blockedReason: r.reason, detail: r.detail,
      expectedSha256: null, observedSha256: null,
    })),
    ...extra,
  });
}

export class VerificationCheckPhase {
  constructor(private readonly runner = new ControlledCheckRunner()) {}

  async run(options: CheckPhaseOptions): Promise<TVerificationCheckRun> {
    const { policy } = options;
    const authorised = options.grantedCapabilities.includes("verification.execute");

    if (!authorised) {
      return notAttempted(
        policy,
        "no granted capability authorised verification execution; the checks were " +
        "recorded but not run, which is not the same as passing",
      );
    }

    /**
     * THE POLICY MUST NOT HAVE MOVED.
     *
     * The agent can write files, and the check configuration is a file. If it
     * changed since capture, executing it would run the agent's chosen program
     * as trusted verification. Neither version is executed - the old one is no
     * longer what the project says, and the new one is not trusted.
     */
    if (options.currentChecks !== undefined) {
      // Re-capture from scratch and compare fingerprints. Recomputing the whole
      // policy - rather than diffing fields - means a change of ANY kind shows
      // up, including one that adds a definition or removes one.
      const current = capturePolicy(options.currentChecks, options.now);
      if (current.fingerprint !== policy.fingerprint) {
        return notAttempted(
          policy,
          "the check definitions changed during this run; the captured policy no " +
          "longer matches project configuration, so neither version was executed",
          { authorised: true, policyChangedDuringRun: true },
        );
      }
    }

    if (policy.checks.length === 0) {
      return notAttempted(
        policy,
        policy.rejected.length > 0
          ? "every declared check was refused at capture; nothing was executed"
          : "no verification checks are configured for this project, so the " +
            "software was NOT independently checked",
        { authorised: true },
      );
    }

    const results: TVerificationCheckResult[] = [];
    const phaseStarted = Date.now();

    for (const check of policy.checks) {
      const spent = Date.now() - phaseStarted;
      const remaining = CHECK_CEILINGS.maxTotalDurationMs - spent;
      results.push(await this.runner.run(check, {
        workingDir: options.workingDir,
        signal: options.signal,
        remainingBudgetMs: remaining,
        now: options.now,
        // The identity captured BEFORE implementation. Absent means the runner
        // blocks rather than runs - it will not launch what it cannot identify.
        expectedIdentity: options.policy.identities[check.id],
      }));
    }

    // Definitions refused at capture appear alongside the ones that ran.
    for (const rejected of policy.rejected) {
      results.push({
        checkId: rejected.id, name: rejected.id, status: "blocked",
        blockedReason: rejected.reason, detail: rejected.detail,
        exitCode: null, signal: null, durationMs: 0, timedOut: false,
        cancelled: false, stdoutBytes: 0, stderrBytes: 0,
        outputTruncated: false, outputExcerpt: "",
        expectedSha256: null, observedSha256: null,
        startedAt: null, endedAt: null,
      });
    }

    const summary = summariseChecks(results);
    return VerificationCheckRun.parse({
      attempted: true,
      authorised: true,
      results,
      declared: policy.checks.length + policy.rejected.length,
      executed: summary.executed,
      passed: summary.passed,
      totalDurationMs: summary.totalDurationMs,
      policyFingerprint: policy.fingerprint,
      notes: summary.allPassed
        ? ["every configured check ran and passed"]
        : ["at least one check did not pass; this is not evidence the implementation works"],
    });
  }
}
