import {
  VerificationOutcome, AgentClaim, RepositoryObservation, CheckObservation,
  type VerificationOutcome as TVerificationOutcome,
  type VerificationVerdict,
} from "../domain/verification.js";
import type { ReviewEvidence } from "../domain/evidence.js";
import type { AgentProcessResult } from "../domain/agentProcess.js";
import type { AgentReport } from "../domain/implementation.js";

/**
 * BUILD THE VERIFICATION OUTCOME
 *
 * Assembles the four compartments and derives the verdict.
 *
 * ---------------------------------------------------------------------------
 * THE VERDICT IS DERIVED FROM OBSERVATION ONLY
 * ---------------------------------------------------------------------------
 * Not from the exit code, and not from what the agent said. Those are recorded
 * beside the verdict so a human can see the disagreement, but they contribute
 * nothing to it. The rule, in order:
 *
 *   1. inspection failed          -> blocked   (we could not look; nothing is known)
 *   2. sensitive file changed     -> sensitive_change
 *   3. changes outside scope      -> scope_drift
 *   4. otherwise                  -> verified
 *
 * `verified` says one thing only: we inspected the repository ourselves, and
 * what we found was inside what a human authorised. It does NOT say the task was
 * accomplished - nobody but a human can say that, which is why review is next.
 */

export interface BuildOutcomeInput {
  runId: string;
  evidence: ReviewEvidence;
  /** UNTRUSTED. What the agent said. */
  report: AgentReport;
  /** TRUSTED. What the OS reported, when a process was involved. */
  process?: AgentProcessResult | null;
  /** Orchestrator-counted: did any tool actually serve this agent? */
  toolRequestsHandled?: number;
  checksDeclared?: number;
}

export function buildVerificationOutcome(input: BuildOutcomeInput): TVerificationOutcome {
  const { evidence, report } = input;
  const notes: string[] = [];
  const disagreements: string[] = [];

  const observation = RepositoryObservation.parse({
    inspected: evidence.inspectionSucceeded,
    failure: evidence.failure,
    headCommit: evidence.headCommitAfter,
    clean: evidence.workingTreeClean,
    changedFiles: evidence.claims.observedFiles,
    attributableFiles: evidence.attributableFiles,
    preExistingChanges: evidence.preExistingChanges,
    attribution: evidence.attribution,
    scope: evidence.scope,
    sensitiveFilesChanged: evidence.sensitiveFilesChanged,
    newCommits: evidence.newCommits.map((c) => c.sha),
  });

  // ---- where the two accounts disagree ----------------------------------
  for (const file of evidence.claims.claimedButNotObserved) {
    disagreements.push(`agent claimed "${file}" changed; the repository shows no change to it`);
  }
  for (const file of evidence.claims.observedButNotClaimed) {
    disagreements.push(`"${file}" changed but the agent did not mention it`);
  }
  if (report.claimsSuccess && evidence.inspectionSucceeded
      && evidence.attributableFiles.length === 0) {
    disagreements.push(
      "agent reported success, but inspection attributes no repository change to this run",
    );
  }
  if (input.process && input.process.exitCode !== 0 && report.claimsSuccess) {
    disagreements.push(
      `agent reported success but its process exited ${String(input.process.exitCode)}`,
    );
  }

  // ---- the verdict, from observation alone -------------------------------
  let verdict: VerificationVerdict;
  if (!evidence.inspectionSucceeded) {
    verdict = "blocked";
    notes.push(
      "the repository could not be inspected, so nothing about this attempt is " +
      "established - including whether anything changed",
    );
  } else if (evidence.sensitiveFilesChanged.length > 0) {
    verdict = "sensitive_change";
    notes.push(
      `${evidence.sensitiveFilesChanged.length} file(s) covered by the sensitive-file ` +
      "policy were modified; names are recorded, contents deliberately are not",
    );
  } else if (evidence.scope.drift.length > 0) {
    verdict = "scope_drift";
    notes.push(
      `${evidence.scope.drift.length} change(s) landed outside the approved scope; ` +
      "they have been left exactly as found - nothing was reverted",
    );
  } else {
    verdict = "verified";
    notes.push(
      "inspection completed and every attributable change was inside the approved " +
      "scope; whether the task was actually accomplished is a human judgement",
    );
  }

  const checks = CheckObservation.parse({
    declared: input.checksDeclared ?? evidence.checksDeclared,
    executed: evidence.checksExecuted,
    available: false,
    unavailableReason:
      "project checks are not executed: running one means executing a command " +
      "string, which is the arbitrary process execution the capability model refuses",
  });
  if (checks.declared > 0) {
    notes.push(
      `${checks.declared} project check(s) are declared and NONE were run; any ` +
      "claim about tests passing is the agent's alone",
    );
  }

  return VerificationOutcome.parse({
    runId: input.runId,
    verdict,
    process: input.process ?? null,
    claim: AgentClaim.parse({
      summary: report.summary,
      files: report.files,
      claimsSuccess: report.claimsSuccess,
      usedTools: (input.toolRequestsHandled ?? 0) > 0,
    }),
    observation,
    checks,
    independentlyVerified: evidence.inspectionSucceeded,
    disagreements,
    notes: [...notes, ...evidence.notes],
    createdAt: new Date().toISOString(),
  });
}
