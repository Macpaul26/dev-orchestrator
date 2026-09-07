import type { ApprovalRequest } from "../domain/approval.js";
import type { WorkflowRun } from "../domain/workflow.js";
import type { RunResult } from "../graph/runner.js";
import type { InspectionOutcome } from "../domain/repository.js";

/** Single write point, so output is easy to redirect or silence in tests. */
export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function renderRun(result: RunResult): void {
  const { run } = result;
  line(`run      ${run.id}`);
  line(`project  ${run.projectId}`);
  line(`status   ${run.status}`);
  line(`phase    ${run.phase}`);
  if (run.outcome) line(`outcome  ${run.outcome}`);
}

export function renderApproval(request: ApprovalRequest): void {
  line("");
  line("APPROVAL REQUIRED");
  line(`  approvalId  ${request.approvalId}`);
  line(`  kind        ${request.kind}`);
  line(`  risk        ${request.risk}`);
  line(`  summary     ${request.summary}`);
  if (request.proposedPlan) {
    line("  plan:");
    for (const step of request.proposedPlan.steps) {
      line(`    ${step.order}. [${step.risk}] ${step.description}`);
    }
    const scope = request.proposedPlan.allowedScope;
    line(`    allowedScope: ${scope.length ? scope.join(", ") : "(none)"}`);
  }
  const repo = request.payload["repository"] as Record<string, unknown> | undefined;
  if (repo) {
    line("  repository:");
    if (repo["inspected"] === true) {
      line(`    branch ${String(repo["branch"] ?? "(detached)")}  head ${String(repo["headCommit"] ?? "(none)")}`);
      const tree = repo["clean"] === true
        ? "clean"
        : `${String(repo["changedFileCount"])} changed file(s)`;
      line(`    working tree ${tree}`);
      if (repo["repositoryRootWithinBoundary"] === false) {
        line("    NOTE: the repository extends above the project boundary; only part was inspected");
      }
      if (Number(repo["sensitiveFilesExcludedFromDiff"] ?? 0) > 0) {
        line(`    ${String(repo["sensitiveFilesExcludedFromDiff"])} sensitive file(s) excluded from the diff`);
      }
    } else {
      line(`    NOT INSPECTED (${String(repo["failureCode"] ?? "unknown")}): ${String(repo["failure"] ?? "")}`);
    }
  }

  const verification = request.payload["verification"] as Record<string, unknown> | undefined;
  if (verification) {
    line("  verification:");
    /**
     * THE VERDICT FIRST, AND THE DISAGREEMENT NEXT TO IT.
     *
     * This is the screen a human approves from, so the ordering is not
     * cosmetic. A reader who sees "the agent says it worked" before seeing what
     * the repository shows has already been anchored. The orchestrator verdict
     * comes first; the agent claim appears beside it, labelled as a claim.
     */
    const verdict = String(verification["verdict"] ?? "unknown");
    line(`    VERDICT: ${verdict.toUpperCase()}`);
    if (verdict === "blocked") {
      line("    the repository could not be inspected - NOTHING below is established");
    }
    line(
      `    agent claimed success: ${String(verification["agentClaimedSuccess"] ?? false)} ` +
      "(a claim, not evidence)",
    );
    const processStatus = verification["processStatus"];
    if (processStatus !== undefined && processStatus !== null) {
      line(
        `    agent process: ${String(processStatus)}, exit ${String(verification["processExitCode"])} ` +
        "(a fact about a program, not about the repository)",
      );
    }
    if (verification["gitMutationDetected"] === true) {
      const authorised = verification["gitMutationAuthorised"] === true;
      line(
        `    GIT MUTATION DETECTED - ${authorised ? "authorised" : "NOT AUTHORISED BY ANY GRANT"}`,
      );
      for (const reason of (verification["gitMutationReasons"] as string[] | undefined) ?? []) {
        line(`      - ${reason}`);
      }
      const commits = (verification["unauthorisedCommits"] as string[] | undefined) ?? [];
      if (commits.length > 0 && !authorised) {
        line(`      unauthorised commit(s): ${commits.join(", ")}`);
      }
      if (!authorised) line("      nothing was reverted or reset - this is a report");
    }
    const disagreements = (verification["disagreements"] as string[] | undefined) ?? [];
    if (disagreements.length > 0) {
      line(`    DISAGREEMENTS (${disagreements.length}) between the agent account and the repository:`);
      for (const item of disagreements) line(`      - ${item}`);
    }
    /**
     * CHECKS RENDER AS THEIR OWN SECTION, BELOW THE VERDICT.
     *
     * An independently executed check outranks anything the agent said, and the
     * layout has to make that obvious - the agent's claim is labelled a claim,
     * and these carry exit codes.
     */
    const results = (verification["checkResults"] as {
      checkId: string; status: string; exitCode: number | null; durationMs: number;
      blockedReason?: string | null;
      expectedSha256?: string | null; observedSha256?: string | null;
    }[] | undefined) ?? [];
    if (verification["checksAttempted"] === true) {
      line(`    project checks: ${results.length} executed` +
        (verification["checksAllPassed"] === true ? ", ALL PASSED" : ", NOT ALL PASSED"));
      for (const check of results) {
        const seconds = (check.durationMs / 1000).toFixed(1);
        line(
          `      ${check.checkId}: ${check.status.toUpperCase()}` +
          (check.exitCode !== null ? ` (exit ${String(check.exitCode)})` : "") +
          ` ${seconds}s`,
        );
        // Digests, never contents. Enough to see that two things differ.
        if (check.blockedReason === "executable_integrity_changed"
          || check.blockedReason === "executable_identity_unavailable") {
          line("        VERIFICATION EXECUTABLE INTEGRITY FAILED");
          line("        the executable is not the program trusted before implementation");
          if (check.expectedSha256) line(`        expected sha256: ${check.expectedSha256}...`);
          if (check.observedSha256) line(`        observed sha256: ${check.observedSha256}...`);
          line("        execution: NOT STARTED");
        }
      }
      if (verification["checksChangedRepository"] === true) {
        const changed = (verification["filesChangedByChecks"] as string[] | undefined) ?? [];
        line(`      THE CHECKS THEMSELVES CHANGED THE REPOSITORY: ${changed.join(", ")}`);
        line("      nothing was reverted - this is a report");
      }
    } else {
      line("    project checks: NOT EXECUTED - this is NOT a pass");
      const reason = verification["checksNotRunReason"];
      if (typeof reason === "string" && reason.length > 0) line(`      reason: ${reason}`);
      line("      any claim that tests pass is the agent's alone and is unverified");
    }
    line(`    independently verified: ${String(verification["verifiedIndependently"])}`);
    line(`    observed files ${String(verification["observedFileCount"])}, commits ${String(verification["observedCommitCount"])}`);
    const drift = (verification["scopeDrift"] as string[] | undefined) ?? [];
    line(`    diff covers: ${String(verification["observedDiffBasis"] ?? "none")}`);
    line(`    scope drift: ${drift.length ? drift.join(", ") : "none"}`);
    const attribution = verification["attribution"] as Record<string, unknown> | undefined;
    if (attribution) {
      if (attribution["baselineAvailable"] !== true) {
        line("    attribution: NO BASELINE - changes cannot be attributed to this run");
      } else {
        const counts = (key: string): number =>
          ((attribution[key] as unknown[] | undefined) ?? []).length;
        line(
          `    attribution: ${counts("introduced")} introduced, ` +
          `${counts("modifiedDuringRun")} modified, ${counts("removed")} removed, ` +
          `${counts("renamed")} renamed, ${counts("restored")} restored ` +
          `(${String(attribution["preExisting"])} pre-existing, not this run)`,
        );
        const metadataOnly = (attribution["metadataOnly"] as string[] | undefined) ?? [];
        if (metadataOnly.length > 0) {
          line(`    metadata-only attribution: ${metadataOnly.join(", ")}`);
        }
      }
    }
    line(`    checks declared ${String(verification["checksDeclared"])}, executed ${String(verification["checksExecuted"])}`);
  }

  line("  decisions   approve | edit | reject | feedback");
}

/** Render one read-only inspection pass for a human. */
export function renderInspection(outcome: InspectionOutcome): void {
  if (!outcome.ok) {
    line(`inspection FAILED: ${outcome.failure.code}`);
    line(`  ${outcome.failure.message}`);
    if (outcome.failure.detail) line(`  ${outcome.failure.detail}`);
    return;
  }
  const e = outcome.evidence;
  const partial = e.repositoryRootWithinBoundary ? "" : "  [ABOVE THE BOUNDARY - partial view]";
  line(`boundary          ${e.boundaryRoot}`);
  line(`repository root   ${e.repositoryRoot ?? "(none)"}${partial}`);
  line(`branch            ${e.branch ?? "(detached HEAD)"}`);
  line(`head              ${e.headCommit ?? "(no commits)"}`);
  line(`working tree      ${e.clean ? "clean" : "dirty"}`);
  line(`staged            ${e.stagedFiles.length}`);
  line(`unstaged          ${e.unstagedFiles.length}`);
  line(`untracked         ${e.untrackedFiles.length}`);
  line(`tracked files     ${e.trackedFileCount}${e.trackedFilesTruncated ? "+ (truncated)" : ""}`);
  line(`recent commits    ${e.recentCommits.length}`);
  line(`declared checks   ${e.declaredChecks.length} (execution disabled)`);
  if (e.changedFiles.length > 0) {
    line("changed files:");
    for (const file of e.changedFiles.slice(0, 50)) line(`  ${file}`);
    if (e.changedFiles.length > 50) line(`  ... and ${e.changedFiles.length - 50} more`);
  }
  if (e.diff) {
    line(`diff              ${e.diff.bytes} bytes${e.diff.truncated ? " (truncated)" : ""}`);
    for (const excluded of e.diff.excludedFiles) {
      line(`  EXCLUDED  ${excluded.path}  (${excluded.reason})`);
    }
  }
  for (const file of e.contextFiles) {
    const state = file.available ? `${file.bytes} bytes` : `withheld (${file.withheldReason})`;
    line(`context ${file.path}: ${state}`);
  }
  for (const note of e.notes) line(`note: ${note}`);
}

export function renderRuns(runs: WorkflowRun[]): void {
  if (runs.length === 0) return line("no runs awaiting approval");
  for (const run of runs) {
    line(`${run.id}  ${run.projectId.padEnd(16)} ${run.phase.padEnd(15)} ${run.request.slice(0, 40)}`);
  }
}
