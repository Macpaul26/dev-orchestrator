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
