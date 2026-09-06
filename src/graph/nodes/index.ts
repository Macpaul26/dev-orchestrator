import { interrupt } from "@langchain/langgraph";
import {
  ApprovalRequest,
  HumanDecision,
  Plan,
  approvalIdFor,
  type Plan as TPlan,
  type HumanDecision as THumanDecision,
} from "../../domain/approval.js";
import { ImplementationReport, ReviewReport } from "../../domain/reports.js";
import { RepositoryVerifier } from "../../verification/verifier.js";
import { issueGrant, grantIdFor } from "../../domain/grant.js";
import {
  ControlledImplementationRunner, NoOpImplementationAgent,
} from "../../implementation/runner.js";
import { CancellationToken } from "../../implementation/session.js";
import type { OrchestratorStateType, OrchestratorUpdate } from "../state.js";
import type { NodeContext } from "../context.js";
import { now } from "../../events/log.js";

/**
 * The nine workflow nodes.
 *
 * SCOPE AFTER PHASE 3:
 *
 *   understand      deterministic stub
 *   inspect         REAL - read-only repository inspection
 *   plan            deterministic stub
 *   approve_plan    REAL - human gate (LangGraph interrupt)
 *   implement       stub - THERE IS NO CODING AGENT. Nothing is modified.
 *   verify          REAL - re-inspects and derives observed* evidence
 *   review          REAL - deterministic evidence, not an AI reviewer
 *   approve_review  REAL - human gate
 *   update_state    deterministic
 *
 * There are still no model calls and no repository writes anywhere in this file.
 */

/**
 * A COMPACT repository summary for an approval payload.
 *
 * Counts and identifiers only. The full evidence - including diff text - stays
 * in workflow state; the approval request is written into the run record, which
 * a human reads, so it must stay small and must never carry file contents.
 */
function repositorySummary(state: OrchestratorStateType): Record<string, unknown> {
  if (state.inspectionFailure) {
    return {
      inspected: false,
      failureCode: state.inspectionFailure.code,
      failure: state.inspectionFailure.message,
    };
  }
  const repo = state.repository;
  if (!repo) return { inspected: false, failureCode: null, failure: "no inspector configured" };
  return {
    inspected: true,
    branch: repo.branch,
    headCommit: repo.headCommit,
    clean: repo.clean,
    changedFileCount: repo.changedFiles.length,
    trackedFileCount: repo.trackedFileCount,
    repositoryRootWithinBoundary: repo.repositoryRootWithinBoundary,
    sensitiveFilesExcludedFromDiff: repo.diff?.excludedFiles.length ?? 0,
  };
}

// 1 ---------------------------------------------------------------- understand
export const understand = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "understand", at: now() });
    // Deterministic stand-in for model-based intent classification (later phase).
    const intent = state.request.trim().length > 0 ? "development_request" : "empty_request";
    ctx.emit({ type: "node_completed", runId: state.runId, node: "understand", at: now() });
    return { intent, phase: "inspect" };
  };

// 2 ------------------------------------------------------------------- inspect
/**
 * READ-ONLY REPOSITORY INSPECTION.
 *
 * The baseline snapshot. Two things make it worth the effort:
 *   - a plan can be made against what the repository ACTUALLY contains;
 *   - `verify` later has something to measure against, so a repository that was
 *     already dirty is not mistaken for work this run performed.
 *
 * Failure is recorded, never swallowed. The run continues to the plan gate -
 * inspection is not the point of the run - but `inspectionFailure` is set, the
 * failure is written to the event history, and the human sees it at the gate.
 * Nothing downstream may treat an incomplete pass as a clean repository.
 */
export const inspect = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "inspect", at: now() });

    const project = ctx.store.getProject(state.projectId);
    const observations = project
      ? [
          `project: ${project.name} (${project.id})`,
          `workingDir: ${project.workingDir}`,
          `checks declared: ${project.checks.length} (execution disabled)`,
          `constraints: ${project.constraints.length}`,
        ]
      : [`project ${state.projectId} not found in store`];

    if (!ctx.inspector) {
      observations.push("repository inspection unavailable: no inspector configured");
      ctx.emit({ type: "node_completed", runId: state.runId, node: "inspect", at: now() });
      return { observations, phase: "plan" };
    }

    const outcome = await ctx.inspector.inspect();

    if (!outcome.ok) {
      ctx.emit({
        type: "repository_inspection_failed", runId: state.runId, node: "inspect",
        code: outcome.failure.code, reason: outcome.failure.message, at: now(),
      });
      observations.push(
        `repository inspection FAILED (${outcome.failure.code}): ${outcome.failure.message}`,
      );
      ctx.emit({ type: "node_completed", runId: state.runId, node: "inspect", at: now() });
      return { observations, inspectionFailure: outcome.failure, repository: null, phase: "plan" };
    }

    const evidence = outcome.evidence;
    ctx.emit({
      type: "repository_inspected", runId: state.runId, node: "inspect",
      branch: evidence.branch, headCommit: evidence.headCommit,
      clean: evidence.clean, changedFileCount: evidence.changedFiles.length, at: now(),
    });

    observations.push(
      `branch: ${evidence.branch ?? "(detached)"}`,
      `head: ${evidence.headCommit ?? "(no commits)"}`,
      `working tree: ${evidence.clean ? "clean" : `${evidence.changedFiles.length} changed file(s)`}`,
      `tracked files: ${evidence.trackedFileCount}${evidence.trackedFilesTruncated ? "+" : ""}`,
      ...evidence.notes.map((note) => `note: ${note}`),
    );

    ctx.emit({ type: "node_completed", runId: state.runId, node: "inspect", at: now() });
    return { observations, repository: evidence, inspectionFailure: null, phase: "plan" };
  };

// 3 ---------------------------------------------------------------------- plan
export const plan = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "plan", at: now() });

    // Deterministic placeholder plan. A later phase replaces this with a model
    // call; the shape it must produce is fixed here.
    const proposed: TPlan = Plan.parse({
      summary: `Plan for: ${state.request}`,
      steps: [
        { order: 0, description: "Inspect the affected area (read-only)", risk: "LOW" },
        { order: 1, description: "Apply the requested change", risk: "HIGH" },
        { order: 2, description: "Run project verification checks", risk: "LOW" },
      ],
      allowedScope: [],
      risks: ["Phase 1+2 stub plan - no implementation capability exists yet"],
      highestRisk: "HIGH",
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
    return { proposedPlan: proposed, phase: "approve_plan" };
  };

// 4 -------------------------------------------------------------- approve_plan
/**
 * FIRST HUMAN GATE - a real LangGraph interrupt.
 *
 * `interrupt()` throws a GraphInterrupt that the runtime catches after writing
 * a checkpoint. The process may then exit; the run resumes from the checkpoint
 * when `Command({ resume })` is supplied, and the resume value becomes the
 * return value of this call.
 */
export const approvePlan = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "approve_plan", at: now() });

    const request = ApprovalRequest.parse({
      // Deterministic: this node body replays on resume. See approvalIdFor.
      approvalId: approvalIdFor(state.runId, "plan", state.revisions),
      workflowRunId: state.runId,
      projectId: state.projectId,
      kind: "plan",
      summary: state.proposedPlan?.summary ?? "(no plan)",
      risk: state.proposedPlan?.highestRisk ?? "LOW",
      proposedPlan: state.proposedPlan,
      // What the human is shown about the repository they are authorising work on.
      payload: { repository: repositorySummary(state) },
      createdAt: now(),
    });

    ctx.onApprovalRequested(request);

    // ---- execution suspends here; the process may die ----
    const raw = interrupt(request);
    // ---- execution resumes here, in a possibly different process ----

    const decision: THumanDecision = HumanDecision.parse(raw);
    if (decision.approvalId !== request.approvalId) {
      throw new Error(
        `Decision answers approval ${decision.approvalId}, but ${request.approvalId} was requested.`,
      );
    }
    ctx.onApprovalReceived(decision);

    if (decision.kind === "reject") {
      return {
        decisions: [decision], pendingApprovalId: null,
        phase: "update_state", outcome: "rejected_at_plan",
      };
    }
    if (decision.kind === "feedback") {
      // Loop back and replan with the human's commentary recorded.
      return {
        decisions: [decision], pendingApprovalId: null,
        phase: "plan", revisions: state.revisions + 1,
      };
    }
    // approve, or edit (which substitutes the human's revised plan)
    const approvedPlan = decision.kind === "edit" ? decision.editedPlan! : state.proposedPlan;

    /**
     * THE HUMAN DECISION IS THE AUTHORISATION.
     *
     * This is the only place an implementation grant is minted, and it is
     * downstream of a real `HumanDecision` carrying an approvalId and a
     * decidedBy. There is no other path to write capability: no flag, no
     * environment variable, no default, no "implementation enabled" setting.
     *
     * The grant inherits the scope the human approved - including narrowing
     * they applied with `edit`. An empty allowedScope authorises nothing, so a
     * plan that declared no scope produces a grant that can write nothing.
     */
    const grant = ctx.store.saveGrant(
      issueGrant({
        // Deterministic: this node body replays on resume. See grantIdFor.
        grantId: grantIdFor(state.runId, state.revisions),
        projectId: state.projectId,
        runId: state.runId,
        approvalId: request.approvalId,
        approvedBy: decision.decidedBy,
        allowedScope: approvedPlan?.allowedScope ?? [],
        capabilities: ["repo.read", "repo.metadata.read", "repo.file.write", "repo.file.delete"],
      }),
    );

    return {
      decisions: [decision],
      proposedPlan: approvedPlan,
      grant,
      pendingApprovalId: null,
      phase: "implement",
    };
  };

// 5 ----------------------------------------------------------------- implement
/**
 * CONTROLLED IMPLEMENTATION.
 *
 * Runs an agent inside the bounded session authorised by the grant, and does
 * NOTHING otherwise. Three separate conditions must all hold before a single
 * byte can be written:
 *
 *   1. a grant exists - which requires a human to have approved the plan
 *   2. an agent is configured - null in production throughout Phase 4A
 *   3. the path the agent asks for is inside the approved scope
 *
 * The report produced here carries ONLY `claimed*` fields. Whatever the agent
 * says it did is narrative; `verify` establishes what actually changed by
 * inspecting the repository, and `verifiedIndependently` stays false until it
 * has.
 */
export const implement = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "implement", at: now() });

    const unimplemented = (summary: string): OrchestratorUpdate => {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "implement", at: now() });
      return {
        implementation: ImplementationReport.parse({
          runId: state.runId,
          claimedSummary: summary,
          claimedFiles: [],
          observedDiff: null,
          observedFiles: [],
          observedCommits: [],
          sessionId: null,
          turns: 0,
          verifiedIndependently: false,
          createdAt: now(),
        }),
        phase: "verify",
      };
    };

    if (!state.grant) {
      return unimplemented("No implementation grant exists; nothing was attempted.");
    }
    const agent = ctx.agent ?? new NoOpImplementationAgent();
    if (agent.name === "none") {
      return unimplemented(
        "No implementation agent is configured; the grant was issued but unused.",
      );
    }

    const runner = new ControlledImplementationRunner({ store: ctx.store });
    // Anything abandoned by a dead process becomes `interrupted` first, so a
    // stale record can never be mistaken for a finished one.
    runner.reconcile(state.projectId);

    let claimedSummary: string;
    let claimedFiles: string[] = [];
    let implementationRun = null;

    try {
      const result = await runner.run(
        state.grant,
        {
          instruction: state.request,
          planSummary: state.proposedPlan?.summary ?? "",
        },
        agent,
        new CancellationToken(),
      );
      implementationRun = result.run;
      // UNTRUSTED. Kept strictly on the claimed side of the report.
      claimedSummary = result.agentReport.summary;
      claimedFiles = result.agentReport.files;
    } catch (error) {
      // A refused run is a normal outcome, not a crash. Verification still
      // happens: a denial may have arrived after some writes had landed.
      claimedSummary = `Implementation did not run: ${
        error instanceof Error ? error.name : "unknown error"
      }`;
    }

    ctx.emit({ type: "node_completed", runId: state.runId, node: "implement", at: now() });
    return {
      implementation: ImplementationReport.parse({
        runId: state.runId,
        claimedSummary,
        claimedFiles,
        observedDiff: null,
        observedFiles: [],
        observedCommits: [],
        sessionId: null,
        turns: 0,
        verifiedIndependently: false,
        createdAt: now(),
      }),
      implementationRun,
      phase: "verify",
    } as OrchestratorUpdate;
  };

// 6 -------------------------------------------------------------------- verify
/**
 * INDEPENDENT VERIFICATION.
 *
 * Re-inspects the repository and derives `observed*` from what git actually
 * reports, comparing it against the baseline captured by `inspect`.
 *
 * The claimed/observed separation is absolute here: `claimedSummary` and
 * `claimedFiles` are passed through untouched, and NOTHING from them is ever
 * written into an observed field. If inspection fails, observed stays empty and
 * `verifiedIndependently` stays false - there is no fallback that fills in the
 * gap with what an agent said.
 *
 * Declared checks are recorded, not executed. See verification/checks.ts.
 */
export const verify = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "verify", at: now() });

    const project = ctx.store.getProject(state.projectId);
    const declaredChecks = project?.checks ?? [];
    // Disabled runner: results carry executed:false, so a skipped check can
    // never be mistaken for a passing one.
    const checkResults = await ctx.checkRunner.runAll(declaredChecks);
    const executed = checkResults.filter((r) => r.executed).length;

    if (!ctx.inspector) {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "verify", at: now() });
      return { phase: "review" };
    }

    const verifier = new RepositoryVerifier(ctx.inspector);
    const result = await verifier.verify({
      runId: state.runId,
      // UNTRUSTED inputs, kept strictly on the claimed side.
      claimedSummary: state.implementation?.claimedSummary ?? "",
      claimedFiles: state.implementation?.claimedFiles ?? [],
      baseline: state.repository,
      allowedScope: state.proposedPlan?.allowedScope ?? [],
      checksDeclared: declaredChecks.length,
      checksExecuted: executed,
    });

    if (result.failure) {
      ctx.emit({
        type: "repository_inspection_failed", runId: state.runId, node: "verify",
        code: result.failure.code, reason: result.failure.message, at: now(),
      });
    }
    ctx.emit({
      type: "verification_completed", runId: state.runId,
      verifiedIndependently: result.report.verifiedIndependently,
      observedFileCount: result.report.observedFiles.length,
      observedCommitCount: result.report.observedCommits.length,
      scopeDriftCount: result.evidence.scope.drift.length,
      at: now(),
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "verify", at: now() });
    return {
      implementation: result.report,
      reviewEvidence: result.evidence,
      checkResults,
      phase: "review",
    } as OrchestratorUpdate;
  };

// 7 -------------------------------------------------------------------- review
/**
 * DETERMINISTIC REVIEW.
 *
 * NOT an AI reviewer - there is no model call here. This node turns the
 * evidence `verify` collected into findings a human can act on at the second
 * gate. A later phase can add model-based judgement ON TOP of these facts; it
 * must not be able to alter them.
 */
export const review = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "review", at: now() });

    const evidence = state.reviewEvidence;
    const findings: { severity: "info" | "warning" | "blocker"; message: string; file?: string }[] = [
      {
        severity: "info",
        message:
          "No implementation was performed: the orchestrator has no coding agent " +
          "and no write capability in this phase.",
      },
    ];

    if (!evidence || !evidence.inspectionSucceeded) {
      findings.push({
        severity: "warning",
        message:
          `Repository state could not be independently verified` +
          `${evidence?.failure ? ` (${evidence.failure.code}: ${evidence.failure.message})` : ""}.`,
      });
    }

    for (const file of evidence?.scope.drift ?? []) {
      findings.push({
        severity: "blocker",
        message: "Changed outside the approved scope.",
        file,
      });
    }
    for (const file of evidence?.claims.claimedButNotObserved ?? []) {
      findings.push({
        severity: "warning",
        message: "Claimed as changed, but git reports no change to it.",
        file,
      });
    }
    for (const file of evidence?.sensitiveFilesChanged ?? []) {
      findings.push({
        severity: "warning",
        message: "A sensitive file changed. Its contents were deliberately not captured.",
        file,
      });
    }
    // Deleting or reverting work is rarely what anyone asked for, so it is
    // called out separately rather than folded into "files changed".
    for (const file of evidence?.removedFiles ?? []) {
      findings.push({ severity: "warning", message: "Deleted during this run.", file });
    }
    for (const file of evidence?.restoredFiles ?? []) {
      findings.push({
        severity: "warning",
        message: "Reverted to HEAD during this run - uncommitted work may have been discarded.",
        file,
      });
    }
    for (const file of evidence?.attribution.metadataOnlyPaths ?? []) {
      findings.push({
        severity: "info",
        message:
          "Attributed from metadata rather than a content hash (sensitive or " +
          "oversized), so this verdict may over-report a change.",
        file,
      });
    }
    if (evidence && !evidence.attribution.baselineAvailable && evidence.inspectionSucceeded) {
      findings.push({
        severity: "warning",
        message:
          "No pre-implementation baseline was captured, so changes could not be " +
          "attributed to this run specifically. Reported changes may include work " +
          "that was already in the working tree.",
      });
    }
    const implementationRun = state.implementationRun;
    if (implementationRun) {
      if (implementationRun.partialChangesPossible) {
        findings.push({
          severity: "warning",
          message:
            `The implementation ended as "${implementationRun.status}", so the repository ` +
            "may hold partial work. Nothing was rolled back - the changes listed below " +
            "are what inspection actually found.",
        });
      }
      if (implementationRun.denials > 0) {
        findings.push({
          severity: "warning",
          message:
            `${implementationRun.denials} operation(s) were refused during implementation. ` +
            "See the activity journal for what was attempted.",
        });
      }
    }
    if (evidence && evidence.checksDeclared > evidence.checksExecuted) {
      findings.push({
        severity: "info",
        message:
          `${evidence.checksDeclared} project check(s) declared, ` +
          `${evidence.checksExecuted} executed - check execution is disabled.`,
      });
    }

    const drift = evidence?.scope.drift ?? [];
    const verdict =
      drift.length > 0 ? "changes_requested"
      : !evidence || !evidence.inspectionSucceeded ? "changes_requested"
      : "pass";

    const report = ReviewReport.parse({
      runId: state.runId,
      verdict,
      findings,
      checkResults: state.checkResults ?? [],
      scopeDrift: drift,
      createdAt: now(),
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "review", at: now() });
    return { reviewReport: report, phase: "approve_review" };
  };

// 8 ------------------------------------------------------------ approve_review
/**
 * SECOND HUMAN GATE.
 *
 * This is the gate that guards the APPROVED status. The graph can carry a task
 * to REVIEW on its own; only the decision returned here can finalise it, and
 * `applyHumanDecision` in domain/task.ts refuses to act without it.
 */
export const approveReview = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "approve_review", at: now() });

    const request = ApprovalRequest.parse({
      approvalId: approvalIdFor(state.runId, "review", state.revisions),
      workflowRunId: state.runId,
      projectId: state.projectId,
      kind: "review",
      summary: `Review verdict: ${state.reviewReport?.verdict ?? "unknown"}`,
      risk: "HIGH",
      proposedPlan: null,
      payload: {
        review: state.reviewReport ?? {},
        repository: repositorySummary(state),
        // The independent-verification headline, so approval is an informed act.
        verification: {
          verifiedIndependently: state.implementation?.verifiedIndependently ?? false,
          observedFileCount: state.implementation?.observedFiles.length ?? 0,
          observedCommitCount: state.implementation?.observedCommits.length ?? 0,
          // What the diff actually covers. Never leave this implicit: a
          // whole-repository diff on a dirty checkout looks identical to a
          // diff of the run's own work.
          observedDiffBasis: state.implementation?.observedDiffBasis ?? "none",
          scopeDrift: state.reviewEvidence?.scope.drift ?? [],
          checksDeclared: state.reviewEvidence?.checksDeclared ?? 0,
          checksExecuted: state.reviewEvidence?.checksExecuted ?? 0,
          attribution: {
            baselineAvailable: state.reviewEvidence?.attribution.baselineAvailable ?? false,
            preExisting: state.reviewEvidence?.preExistingChanges.length ?? 0,
            introduced: state.reviewEvidence?.introducedFiles ?? [],
            modifiedDuringRun: state.reviewEvidence?.modifiedDuringRunFiles ?? [],
            removed: state.reviewEvidence?.removedFiles ?? [],
            renamed: state.reviewEvidence?.renamedFiles ?? [],
            restored: state.reviewEvidence?.restoredFiles ?? [],
            metadataOnly: state.reviewEvidence?.attribution.metadataOnlyPaths ?? [],
          },
        },
      },
      createdAt: now(),
    });

    ctx.onApprovalRequested(request);
    const decision: THumanDecision = HumanDecision.parse(interrupt(request));

    if (decision.approvalId !== request.approvalId) {
      throw new Error(
        `Decision answers approval ${decision.approvalId}, but ${request.approvalId} was requested.`,
      );
    }
    ctx.onApprovalReceived(decision);

    const outcome =
      decision.kind === "approve" ? "approved"
      : decision.kind === "reject" ? "rejected_at_review"
      : "changes_requested";

    return {
      decisions: [decision], pendingApprovalId: null,
      phase: "update_state", outcome,
    };
  };

// 9 -------------------------------------------------------------- update_state
export const updateState = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "update_state", at: now() });
    ctx.onFinalise(state);
    ctx.emit({ type: "node_completed", runId: state.runId, node: "update_state", at: now() });
    return { phase: "update_state", outcome: state.outcome ?? "completed" };
  };
