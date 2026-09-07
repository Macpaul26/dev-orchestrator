import {
  VerificationOutcome, AgentClaim, RepositoryObservation, CheckObservation,
  type VerificationOutcome as TVerificationOutcome,
  type VerificationVerdict,
} from "../domain/verification.js";
import type { ReviewEvidence } from "../domain/evidence.js";
import type { AgentProcessResult } from "../domain/agentProcess.js";
import type { AgentReport } from "../domain/implementation.js";
import { VerificationCheckRun, summariseChecks,
  type VerificationCheckRun as TVerificationCheckRun } from "../domain/verificationCheck.js";

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
 *   3. unauthorised git mutation  -> git_mutation
 *   4. changes outside scope      -> scope_drift
 *   5. otherwise                  -> verified
 *
 * Order is precedence, not exclusivity: every condition that holds is recorded
 * in the observation and raised as a finding. A run that commits a credential
 * reports BOTH, and the verdict names the one a human should read first.
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
  /**
   * The capabilities a human actually granted.
   *
   * Used for one question: was git mutation authorised? Passed in rather than
   * inferred, because "what was permitted" is a property of the human decision
   * and must never be reconstructed from what the agent managed to do.
   */
  grantedCapabilities?: readonly string[];
  /** What the controlled check phase did. A process observation, not a claim. */
  checkRun?: TVerificationCheckRun | null;
}

export function buildVerificationOutcome(input: BuildOutcomeInput): TVerificationOutcome {
  const { evidence, report } = input;
  const notes: string[] = [];
  const disagreements: string[] = [];

  /**
   * Git mutation is judged against the GRANT, not against the outcome.
   *
   * `git.mutate` is not among the capabilities Phase 4B issues, so in practice
   * this is always false and any observed mutation is unauthorised. It is still
   * written as a capability check rather than a constant: the day a grant can
   * carry `git.mutate`, this stays correct instead of silently blocking it.
   */
  const gitMutationAuthorised = (input.grantedCapabilities ?? []).includes("git.mutate");
  const gitMutation = evidence.gitMutation;
  const unauthorisedGitMutation = gitMutation.detected && !gitMutationAuthorised;

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
    gitMutation,
    gitMutationAuthorised,
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
  } else if (unauthorisedGitMutation) {
    verdict = "git_mutation";
    notes.push(
      "git itself was used during this attempt and no granted capability " +
      "authorised that; the commit is an independently observed mutation, and " +
      "it stands whatever the agent reported and whether or not the working " +
      "tree ended clean. Nothing has been reverted.",
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

  if (unauthorisedGitMutation) {
    for (const reason of gitMutation.reasons) notes.push(`unauthorised git mutation: ${reason}`);
    disagreements.push(
      "git state moved during this attempt, and no granted capability authorised " +
      "git mutation",
    );
  }

  /**
   * CHECKS: A PROCESS OBSERVATION, KEPT APART FROM THE REPOSITORY ONE.
   *
   * `allPassed` comes from `summariseChecks`, which returns false for an empty
   * run. That is the guard against the one mistake that matters here - an
   * unchecked project reading as a checked one.
   */
  const run = input.checkRun ?? VerificationCheckRun.parse({});
  const summary = summariseChecks(run.results);
  const checks = CheckObservation.parse({
    declared: input.checksDeclared ?? evidence.checksDeclared,
    executed: run.executed,
    available: run.attempted,
    unavailableReason: run.attempted ? null : run.notRunReason,
    run,
    allPassed: summary.allPassed,
  });

  if (!run.attempted && checks.declared > 0) {
    notes.push(
      `${checks.declared} verification check(s) were configured and NONE ran ` +
      `(${run.notRunReason ?? "no reason recorded"}); this is not a pass`,
    );
  } else if (!run.attempted) {
    notes.push(
      "no verification check ran, so nothing here establishes that the software " +
      "works - only that the repository changes were what a human authorised",
    );
  } else if (!summary.allPassed) {
    const failing = run.results.filter((r) => r.status !== "passed");
    notes.push(
      `${failing.length} of ${run.results.length} verification check(s) did not ` +
      `pass: ${failing.map((r) => `${r.checkId}=${r.status}`).join(", ")}`,
    );
  }

  /**
   * A CHECK THAT CHANGED THE REPOSITORY IS ITS OWN FINDING.
   *
   * Verification commands are executable code. One that writes to the working
   * tree has done something nobody asked it to, and the change is attributed to
   * the checks rather than to the agent.
   */
  if (run.repositoryChangedByChecks) {
    notes.push(
      `verification checks themselves changed ${run.filesChangedByChecks.length} ` +
      `file(s): ${run.filesChangedByChecks.slice(0, 10).join(", ")}`,
    );
    disagreements.push(
      "the verification checks modified the repository; a check is executable " +
      "code and this one did not leave the working tree as it found it",
    );
  }

  // The agent asserting success while a check says otherwise is the central
  // disagreement this whole system exists to surface.
  if (report.claimsSuccess && run.attempted && !summary.allPassed) {
    disagreements.push(
      "agent reported success, but an independently executed verification check " +
      "did not pass",
    );
  }
  if (!report.claimsSuccess && run.attempted && summary.allPassed && run.results.length > 0) {
    disagreements.push(
      "agent did not report success, but every independently executed check passed",
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
