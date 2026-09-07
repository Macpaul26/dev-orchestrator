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
import { buildVerificationOutcome } from "../../verification/outcome.js";
import { capturePolicy } from "../../verification/checkPolicy.js";
import { planFromProposal } from "../../reasoning/proposal.js";
import { assembleContext, detectAuthorityConflicts } from "../../reasoning/context.js";
import {
  projectMetadata, humanDecisions, humanConstraints,
  repositoryObservations, taskDescription, historicalAgentClaims,
} from "../../reasoning/contextSources.js";
import { summariseContext } from "../../domain/reasoningContext.js";
import { isBlocking, VerificationOutcome } from "../../domain/verification.js";
import { AgentReport } from "../../domain/implementation.js";
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
          `legacy string checks: ${project.checks.length} (never executed)`,
          `verification checks: ${project.verificationChecks.length}`,
          `constraints: ${project.constraints.length}`,
        ]
      : [`project ${state.projectId} not found in store`];

    /**
     * CAPTURE THE CHECK POLICY HERE - BEFORE THE AGENT EXISTS.
     *
     * This node runs before planning, approval and implementation, which is the
     * whole point: the definitions are read at a moment when nothing untrusted
     * has had a chance to write to the project. The fingerprint taken here is
     * what the check phase compares against later.
     */
    const policy = capturePolicy(project?.verificationChecks ?? []);
    observations.push(
      `check policy captured: ${policy.checks.length} runnable, ` +
      `${policy.rejected.length} refused, fingerprint ${policy.fingerprint.slice(0, 12)}`,
    );

    if (!ctx.inspector) {
      observations.push("repository inspection unavailable: no inspector configured");
      ctx.emit({ type: "node_completed", runId: state.runId, node: "inspect", at: now() });
      return { observations, checkPolicy: policy, phase: "plan" } as OrchestratorUpdate;
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
      return {
        observations, inspectionFailure: outcome.failure, repository: null,
        checkPolicy: policy, phase: "plan",
      } as OrchestratorUpdate;
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
    return {
      observations, repository: evidence, inspectionFailure: null,
      checkPolicy: policy, phase: "plan",
    } as OrchestratorUpdate;
  };

// 3 ---------------------------------------------------------------------- plan
export const plan = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "plan", at: now() });

    /**
     * The deterministic plan. Used when no reasoning model is configured, which
     * remains the default, and when one is configured but FAILS.
     *
     * It proposes no scope, so it can mint no write authority - which is the
     * correct thing to fall back to. A failed reasoning call must never produce
     * a more capable plan than a successful one.
     */
    const fallbackPlan = (note: string): TPlan => Plan.parse({
      summary: `Plan for: ${state.request}`,
      steps: [
        { order: 0, description: "Inspect the affected area (read-only)", risk: "LOW" },
        { order: 1, description: "Apply the requested change", risk: "HIGH" },
        { order: 2, description: "Run project verification checks", risk: "LOW" },
      ],
      allowedScope: [],
      risks: [note],
      highestRisk: "HIGH",
    });

    const model = ctx.reasoningModel;
    if (!model) {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
      return {
        proposedPlan: fallbackPlan(
          "No reasoning model is configured; this is a deterministic placeholder " +
          "plan that authorises no scope.",
        ),
        phase: "approve_plan",
      } as OrchestratorUpdate;
    }

    const project = ctx.store.getProject(state.projectId);
    if (!project) {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
      return {
        proposedPlan: fallbackPlan(
          "The project record could not be read, so no reasoning context could " +
          "be assembled. This placeholder plan authorises no scope.",
        ),
        phase: "approve_plan",
      } as OrchestratorUpdate;
    }

    /**
     * ASSEMBLE THE CONTEXT (Task 007).
     *
     * One controlled assembly, in one place, with every record carrying its
     * provenance. Bounds, ordering, deduplication and the refusal of
     * credential-shaped values all happen inside `assembleContext` rather than
     * being spread across this node and the prompt builder.
     *
     * NO FILE CONTENTS. The model gets project facts, human decisions and
     * constraints, repository OBSERVATIONS, the request, and the orchestrator's
     * own record of previous runs. It does not get source code, and Task 007
     * deliberately does not add a way for it to ask.
     */
    const assembled = assembleContext([
      ...projectMetadata(project),
      ...humanDecisions(ctx.store.listDecisions(state.projectId)),
      ...humanConstraints(project.constraints),
      ...repositoryObservations(state.observations ?? []),
      ...taskDescription(state.request),
      ...historicalAgentClaims(ctx.store.listImplementations(state.projectId)),
    ]);

    /**
     * CONTEXT FAILURE IS FAIL-CLOSED.
     *
     * A refused credential, or critical human context that will not fit, stops
     * the reasoning call entirely. The run does NOT proceed with a quietly
     * smaller context that looks complete - it falls back to the zero-scope
     * plan and says why.
     */
    if (!assembled.ok) {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
      return {
        proposedPlan: fallbackPlan(
          `Reasoning context could not be assembled (${assembled.failure.code}): ` +
          `${assembled.failure.message}. No model call was made. This ` +
          "placeholder plan authorises no scope.",
        ),
        reasoningNotes: [`context assembly failed: ${assembled.failure.code}`],
        phase: "approve_plan",
      } as OrchestratorUpdate;
    }

    /**
     * Conflicts are REPORTED, never resolved here and never resolved by the
     * model. Both records stay in the context with their labels; the human sees
     * that a low-authority claim touches something they decided.
     */
    const conflicts = detectAuthorityConflicts(assembled.context);

    const result = await model.generate({
      runId: state.runId,
      operation: "propose_plan",
      context: { assembled: assembled.context },
    });

    ctx.emit({
      type: "reasoning_completed", runId: state.runId, node: "plan",
      provider: result.record.provider, model: result.record.model,
      ok: result.ok, failureCode: result.ok ? null : result.failure.code,
      durationMs: result.record.durationMs, at: now(),
    });

    /**
     * FAIL CLOSED.
     *
     * A model failure produces the zero-scope placeholder and records why. It
     * does NOT skip the gate, does not proceed to implementation, and does not
     * become an empty success - the run still stops for a human, who can now
     * see that reasoning was unavailable.
     */
    if (!result.ok) {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
      return {
        proposedPlan: fallbackPlan(
          `Reasoning failed (${result.failure.code}): ${result.failure.message}. ` +
          "This placeholder plan authorises no scope.",
        ),
        reasoning: result.record,
        reasoningFailure: result.failure,
        reasoningNotes: [`reasoning unavailable: ${result.failure.code}`],
        contextSummary: summariseContext(assembled.context),
        phase: "approve_plan",
      } as OrchestratorUpdate;
    }

    /**
     * THE TRUST BOUNDARY.
     *
     * `result.proposal` is validated but still UNTRUSTED - schema validity says
     * the shape is right, never that the content is true or well-intentioned.
     * `planFromProposal` is trusted code: it rebuilds the plan field by field,
     * computes risk itself, and re-checks every proposed path against the real
     * scope rules. Nothing from the model reaches a `Plan` without passing
     * through it, and nothing it produces is authority until a human approves.
     */
    const translated = planFromProposal(result.proposal, state.request);

    ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
    return {
      proposedPlan: translated.plan,
      reasoning: result.record,
      reasoningFailure: null,
      reasoningNotes: [
        ...translated.notes,
        ...assembled.context.warnings.map((w) => `context: ${w}`),
        ...conflicts.map((c) =>
          `AUTHORITY CONFLICT: a ${c.lower.provenance} record overlaps a ` +
          `${c.higher.provenance} (shared terms: ${c.sharedTerms.join(", ")}). ` +
          "The human record takes precedence; the model was not asked to choose.",
        ),
      ],
      contextSummary: summariseContext(assembled.context),
      phase: "approve_plan",
    } as OrchestratorUpdate;
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
        /**
         * `verification.execute` is granted by the SAME human decision.
         *
         * Deliberately not a separate switch: approving an implementation is
         * approving that the orchestrator will check the result, and a design
         * where a human can approve the writing but not the checking invites
         * exactly the wrong default. It authorises running the policy captured
         * before this run - nothing else, and nothing the agent can influence.
         */
        capabilities: [
          "repo.read", "repo.metadata.read", "repo.file.write", "repo.file.delete",
          "verification.execute",
        ],
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
    let agentClaimedSuccess = false;
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
      agentClaimedSuccess = result.agentReport.claimsSuccess;
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
      agentClaimedSuccess,
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

    /**
     * NO INSPECTOR - STILL A VERIFICATION RESULT.
     *
     * The temptation is to return early and leave `verification` null, because
     * "there was nothing to verify with". That is the one thing this node must
     * never do: an attempt with no verification record is indistinguishable, to
     * everything downstream, from an attempt that was verified and found clean.
     *
     * So the absence of an inspector produces `blocked` - we could not look -
     * rather than silence. The agent's claim is carried through unchanged, on
     * the claimed side, where a human can see it is the only account available.
     */
    if (!ctx.inspector) {
      ctx.emit({ type: "node_completed", runId: state.runId, node: "verify", at: now() });
      return {
        verification: VerificationOutcome.parse({
          runId: state.runId,
          verdict: "blocked",
          process: state.implementationRun?.processResult ?? null,
          claim: {
            summary: state.implementation?.claimedSummary ?? "",
            files: state.implementation?.claimedFiles ?? [],
            claimsSuccess: state.agentClaimedSuccess,
            usedTools: ((state.implementationRun?.writes ?? 0)
              + (state.implementationRun?.deletes ?? 0)) > 0,
          },
          observation: { inspected: false },
          checks: {
            declared: declaredChecks.length,
            executed,
            available: false,
            unavailableReason: "no repository inspector is configured",
          },
          independentlyVerified: false,
          notes: [
            "no repository inspector was available, so nothing about this attempt " +
            "was established independently - including whether anything changed",
          ],
          createdAt: now(),
        }),
        checkResults,
        phase: "review",
      } as OrchestratorUpdate;
    }

    const verifier = new RepositoryVerifier(ctx.inspector);
    const preCheck = await verifier.verify({
      runId: state.runId,
      // UNTRUSTED inputs, kept strictly on the claimed side.
      claimedSummary: state.implementation?.claimedSummary ?? "",
      claimedFiles: state.implementation?.claimedFiles ?? [],
      baseline: state.repository,
      allowedScope: state.proposedPlan?.allowedScope ?? [],
      checksDeclared: declaredChecks.length,
      checksExecuted: executed,
    });

    /**
     * ---------------------------------------------------------------------
     * THE CONTROLLED CHECK PHASE (Task 005)
     * ---------------------------------------------------------------------
     * Between two independent inspections, and in that order for a reason.
     *
     * `preCheck` establishes what the AGENT did. The checks then run. A second
     * inspection establishes what the repository looks like afterwards, and the
     * difference between the two is attributable to the CHECKS - because a
     * verification command is executable code, and "it was only a test" is an
     * assumption, not an observation.
     *
     * Checks are skipped entirely when the repository could not be inspected.
     * Running code we would then be unable to observe is strictly worse than
     * not running it: we would have executed something and have no idea what it
     * did.
     */
    const checkRun = await ctx.checkPhase.run({
      workingDir: project?.workingDir ?? "",
      grantedCapabilities: state.grant?.capabilities ?? [],
      policy: state.checkPolicy ?? capturePolicy([]),
      // Re-read from the project record as it stands NOW. The phase compares
      // this against the fingerprint captured before implementation.
      currentChecks: ctx.store.getProject(state.projectId)?.verificationChecks ?? [],
    });

    /**
     * POST-CHECK INSPECTION.
     *
     * Re-verified against the ORIGINAL baseline, so the final evidence covers
     * the agent and the checks together - which is what the review gate needs
     * to reason about the repository's actual end state.
     */
    let result = preCheck;
    let filesChangedByChecks: string[] = [];
    if (checkRun.attempted) {
      result = await verifier.verify({
        runId: state.runId,
        claimedSummary: state.implementation?.claimedSummary ?? "",
        claimedFiles: state.implementation?.claimedFiles ?? [],
        baseline: state.repository,
        allowedScope: state.proposedPlan?.allowedScope ?? [],
        checksDeclared: checkRun.declared,
        checksExecuted: checkRun.executed,
      });
      // Attributed against the snapshot taken AFTER the agent and BEFORE the
      // checks, so anything here belongs to a check rather than to the agent.
      if (preCheck.observed) {
        const checkAttribution = await verifier.verify({
          runId: state.runId,
          baseline: preCheck.observed,
          allowedScope: state.proposedPlan?.allowedScope ?? [],
        });
        filesChangedByChecks = checkAttribution.evidence.attributableFiles;
      }
    }

    const finalCheckRun = {
      ...checkRun,
      filesChangedByChecks,
      repositoryChangedByChecks: filesChangedByChecks.length > 0,
    };
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

    /**
     * THE FOUR-PART OUTCOME.
     *
     * Built here rather than inside the verifier so the PROCESS facts - which
     * come from the OS, not from the repository - are joined to the repository
     * observation at one deliberate point, without either being able to
     * influence the other's contents.
     */
    const outcome = buildVerificationOutcome({
      runId: state.runId,
      evidence: result.evidence,
      report: AgentReport.parse({
        summary: state.implementation?.claimedSummary ?? "",
        files: state.implementation?.claimedFiles ?? [],
        // A claim of success only exists if the agent actually made one.
        claimsSuccess: state.agentClaimedSuccess,
      }),
      process: state.implementationRun?.processResult ?? null,
      toolRequestsHandled: (state.implementationRun?.writes ?? 0)
        + (state.implementationRun?.deletes ?? 0),
      checksDeclared: finalCheckRun.declared,
      checkRun: finalCheckRun,
      // What the HUMAN authorised, straight from the grant. Never inferred
      // from what the agent turned out to be able to do.
      grantedCapabilities: state.grant?.capabilities ?? [],
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "verify", at: now() });
    return {
      implementation: result.report,
      reviewEvidence: result.evidence,
      verification: outcome,
      checkRun: finalCheckRun,
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

    /**
     * THE VERDICT COMES FROM VERIFICATION, NOT FROM THE AGENT.
     *
     * Anything the verification outcome flags as blocking stops this being a
     * clean pass, whatever the agent said and whatever its process returned.
     */
    const outcome = state.verification;

    /**
     * UNAUTHORISED GIT MUTATION IS ALWAYS A BLOCKER.
     *
     * Raised whenever it was OBSERVED, not only when it happened to win the
     * verdict. A run that commits a credential is both a sensitive change and
     * an unauthorised mutation; the verdict names one, and a human needs to see
     * both. Nothing has been reverted - this is a report, not a remedy.
     */
    const gitMutation = outcome?.observation.gitMutation;
    if (gitMutation?.detected && !outcome?.observation.gitMutationAuthorised) {
      findings.push({
        severity: "blocker",
        message:
          "Git was used during this run and no granted capability authorised it. " +
          `Observed: ${gitMutation.reasons.join("; ")}. The repository has been ` +
          "left exactly as found - nothing was reverted or reset.",
      });
      for (const sha of gitMutation.newCommits) {
        findings.push({
          severity: "blocker",
          message: `Unauthorised commit created during this run: ${sha}`,
        });
      }
    }

    /**
     * CHECK RESULTS AT THE GATE.
     *
     * A failing check is a blocker; an unrun one is an explicit warning rather
     * than silence. The difference between "your tests fail" and "we could not
     * run your tests" is preserved all the way to the human.
     */
    const checkRun = outcome?.checks.run;
    if (checkRun && !checkRun.attempted) {
      findings.push({
        severity: "warning",
        message:
          "No verification check was executed, so nothing here establishes that " +
          `the software works. Reason: ${checkRun.notRunReason ?? "not recorded"}`,
      });
    }
    if (checkRun?.policyChangedDuringRun) {
      findings.push({
        severity: "blocker",
        message:
          "The verification check definitions changed during this run. Neither " +
          "the captured policy nor the rewritten one was executed - an agent " +
          "that can rewrite the checks could otherwise have them run as trusted.",
      });
    }
    for (const check of checkRun?.results ?? []) {
      if (check.status === "passed") {
        findings.push({
          severity: "info",
          message: `Check "${check.checkId}" PASSED (exit 0, ${Math.round(check.durationMs)}ms).`,
        });
        continue;
      }
      /**
       * AN INTEGRITY BLOCK IS A SECURITY FINDING, NOT A FAILED TEST.
       *
       * Raised as a blocker with the digests shown, because "your check did not
       * pass" and "the check program was swapped out from under us" call for
       * completely different responses from a human.
       */
      if (check.blockedReason === "executable_integrity_changed"
        || check.blockedReason === "executable_identity_unavailable") {
        findings.push({
          severity: "blocker",
          message:
            `Check "${check.checkId}" BLOCKED: the verification executable is not ` +
            `the program that was trusted before implementation. ${check.detail ?? ""} ` +
            (check.expectedSha256 && check.observedSha256
              ? `Expected sha256 ${check.expectedSha256}..., observed ` +
                `${check.observedSha256}.... `
              : "") +
            "Execution NOT STARTED.",
        });
        continue;
      }
      findings.push({
        severity: check.status === "failed" || check.status === "timed_out"
          ? "blocker" : "warning",
        message:
          `Check "${check.checkId}" ${check.status.toUpperCase()}` +
          (check.exitCode !== null ? ` (exit ${String(check.exitCode)})` : "") +
          (check.detail ? `: ${check.detail}` : ""),
      });
    }
    if (checkRun?.repositoryChangedByChecks) {
      findings.push({
        severity: "blocker",
        message:
          "The verification checks THEMSELVES changed the repository: " +
          `${checkRun.filesChangedByChecks.join(", ")}. Nothing was reverted.`,
      });
    }

    for (const disagreement of outcome?.disagreements ?? []) {
      findings.push({ severity: "warning", message: `Disagreement: ${disagreement}` });
    }
    if (outcome && outcome.claim.claimsSuccess && isBlocking(outcome.verdict)) {
      findings.push({
        severity: "blocker",
        message:
          `The agent reported success, but independent verification returned ` +
          `"${outcome.verdict}". The verification stands.`,
      });
    }
    if (outcome?.checks.declared && !outcome.checks.available) {
      findings.push({
        severity: "info",
        message:
          `${outcome.checks.declared} project check(s) declared and none executed - ` +
          "any claim about tests passing is the agent's alone.",
      });
    }

    const drift = evidence?.scope.drift ?? [];
    /**
     * A DISAGREEMENT IS ENOUGH TO WITHHOLD "pass".
     *
     * `pass` here means something narrow: the two accounts of what happened
     * agree, and everything observed was inside what a human authorised. An
     * agent that reported success while the repository shows nothing, or that
     * listed a file it never touched, has not met that bar - even though the
     * repository itself may be perfectly fine.
     *
     * This withholds a RECOMMENDATION; it decides nothing. `changes_requested`
     * and `pass` both arrive at the same human gate, and neither can approve.
     */
    /**
     * A check that ran and did not pass withholds "pass".
     *
     * Note the condition: `attempted && !allPassed`. An unrun check does NOT
     * force changes_requested by itself - it is reported as a warning, because
     * "we never checked" is a gap in evidence rather than a defect found.
     */
    const checksFailed = (checkRun?.attempted ?? false) && !(outcome?.checks.allPassed ?? false);
    const verdict =
      outcome && isBlocking(outcome.verdict) ? "changes_requested"
      : checksFailed ? "changes_requested"
      : (outcome?.disagreements.length ?? 0) > 0 ? "changes_requested"
      : drift.length > 0 ? "changes_requested"
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
          // The four-part outcome, so the human sees process, claim,
          // observation and verdict side by side rather than one boolean.
          verdict: state.verification?.verdict ?? "blocked",
          independentlyVerified: state.verification?.independentlyVerified ?? false,
          agentClaimedSuccess: state.verification?.claim.claimsSuccess ?? false,
          disagreements: state.verification?.disagreements ?? [],
          processExitCode: state.verification?.process?.exitCode ?? null,
          processStatus: state.verification?.process?.status ?? null,
          checksAvailable: state.verification?.checks.available ?? false,
          gitMutationDetected: state.verification?.observation.gitMutation.detected ?? false,
          gitMutationAuthorised: state.verification?.observation.gitMutationAuthorised ?? false,
          gitMutationReasons: state.verification?.observation.gitMutation.reasons ?? [],
          unauthorisedCommits: state.verification?.observation.gitMutation.newCommits ?? [],
          checksAttempted: state.verification?.checks.run.attempted ?? false,
          checksAllPassed: state.verification?.checks.allPassed ?? false,
          checksNotRunReason: state.verification?.checks.run.notRunReason ?? null,
          checkResults: (state.verification?.checks.run.results ?? []).map((r) => ({
            checkId: r.checkId, name: r.name, status: r.status,
            exitCode: r.exitCode, durationMs: r.durationMs,
            outputTruncated: r.outputTruncated, detail: r.detail,
            // Truncated digests only. The executable contents are never read
            // into evidence - only what they hash to.
            blockedReason: r.blockedReason,
            expectedSha256: r.expectedSha256, observedSha256: r.observedSha256,
          })),
          checksChangedRepository:
            state.verification?.checks.run.repositoryChangedByChecks ?? false,
          filesChangedByChecks: state.verification?.checks.run.filesChangedByChecks ?? [],
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
