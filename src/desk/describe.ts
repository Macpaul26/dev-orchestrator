import type { ApprovalRequest } from "../domain/approval.js";
import type { WorkflowRun } from "../domain/workflow.js";

/**
 * PLAIN-ENGLISH NARRATION OF TRUSTED STATE.
 *
 * Written by code, from the approval request and the run record - never by a
 * model. What the person hears at a gate is exactly what the orchestrator
 * established, in sentences, so a spoken "yes" answers the real thing.
 */

const n = (v: unknown): string => String(v ?? 0);

export function describeApproval(request: ApprovalRequest, run: WorkflowRun): string {
  const it = (request.payload["iteration"] ?? {}) as Record<string, unknown>;
  const where = `Iteration ${n(it["iteration"] ?? request.iteration)} of ${n(it["limit"] ?? run.iterationLimit)}.`;

  if (request.kind === "plan") {
    const plan = request.proposedPlan;
    const steps = plan?.steps.map((s) => `${s.description} (${s.risk.toLowerCase()} risk)`) ?? [];
    const scope = plan?.allowedScope ?? [];
    return [
      `The plan is ready for your approval. ${where}`,
      `Risk level: ${request.risk.toLowerCase()}.`,
      plan ? `The plan: ${plan.summary}` : "There is no plan attached.",
      steps.length ? `Steps: ${steps.join("; ")}.` : "",
      scope.length
        ? `It may touch: ${scope.join(", ")}.`
        : "It names NO folders it may touch, so nothing can be written unless you name some - for example, say: yes, only src.",
      "Say yes to approve, no to reject, or tell me what to change.",
    ].filter(Boolean).join(" ");
  }

  const review = request.payload["review"] as { verdict?: string; findings?: { severity: string; message: string; file?: string | null }[] } | undefined;
  const v = (request.payload["verification"] ?? {}) as Record<string, unknown>;
  const completion = it["completion"] as { blockers?: string[] } | undefined;
  const safety = (it["safetyConditions"] as string[] | undefined) ?? [];
  const blockers = completion?.blockers ?? [];
  const blockerFindings = (review?.findings ?? []).filter((f) => f.severity === "blocker");

  const parts = [
    `The work is done and checked. ${where}`,
    `Review verdict: ${(review?.verdict ?? "unknown").replace(/_/g, " ")}.`,
    v["independentlyVerified"] === true
      ? `The orchestrator looked at the repository itself: ${n(v["observedFileCount"])} file(s) changed, ${n(v["observedCommitCount"])} commit(s), ` +
        `${(v["scopeDrift"] as string[] | undefined)?.length ? "and changes OUTSIDE the approved scope" : "nothing outside the approved scope"}.`
      : "The repository could NOT be independently verified.",
    v["agentClaimedSuccess"] === true ? "Claude says it succeeded - that is a claim, not evidence." : "",
    v["checksAttempted"] === true
      ? `Project checks: ${v["checksAllPassed"] === true ? "all passed" : "did NOT all pass"}.`
      : "No project checks were run, so nothing here proves the software works.",
  ];
  if (safety.length) {
    parts.push(
      `SAFETY: verification observed ${safety.map((s) => s.replace(/_/g, " ")).join(", ")}. ` +
      "If you approve, your decision is recorded but the run ends incomplete - it cannot be completed.",
    );
  }
  if (blockerFindings.length) {
    parts.push(`Blocking findings: ${blockerFindings.map((f) => `${f.message}${f.file ? ` (${f.file})` : ""}`).join("; ")}.`);
  } else if (blockers.length) {
    parts.push(`Still standing in the way of completion: ${blockers.join("; ")}.`);
  }
  parts.push(
    it["anotherIterationPossible"] === true
      ? "Say approve to accept, reject to stop, or tell me what to change and it will do another round."
      : "Say approve to accept or reject to stop. Another round is not possible on this run.",
  );
  return parts.filter(Boolean).join(" ");
}

export function describeRun(run: WorkflowRun): string {
  const status = run.status.replace(/_/g, " ");
  const stop = run.stopReason ? ` (${run.stopReason.replace(/_/g, " ")})` : "";
  switch (run.status) {
    case "completed": return `Run finished and approved${stop}.`;
    case "rejected": return `Run stopped: you rejected it${stop}.`;
    case "incomplete": return `Run stopped INCOMPLETE${stop}. Nothing was approved; have a look before starting again.`;
    case "failed": return `Run failed: ${run.outcome ?? "unknown error"}.`;
    case "awaiting_approval": return `Waiting for you at the ${run.phase === "approve_plan" ? "plan" : "review"} gate.`;
    default: return `Run is ${status}.`;
  }
}

export function describeWaiting(runs: readonly WorkflowRun[]): string {
  if (runs.length === 0) return "Nothing is waiting for you.";
  if (runs.length === 1) {
    const r = runs[0]!;
    return `One run is waiting at the ${r.phase === "approve_plan" ? "plan" : "review"} gate: ${r.request.slice(0, 120)}.`;
  }
  return `${String(runs.length)} runs are waiting for you.`;
}
