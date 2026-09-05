import type { ApprovalRequest } from "../domain/approval.js";
import type { WorkflowRun } from "../domain/workflow.js";
import type { RunResult } from "../graph/runner.js";

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
  line("  decisions   approve | edit | reject | feedback");
}

export function renderRuns(runs: WorkflowRun[]): void {
  if (runs.length === 0) return line("no runs awaiting approval");
  for (const run of runs) {
    line(`${run.id}  ${run.projectId.padEnd(16)} ${run.phase.padEnd(15)} ${run.request.slice(0, 40)}`);
  }
}
