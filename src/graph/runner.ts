import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { buildWorkflow } from "./workflow.js";
import type { NodeContext } from "./context.js";
import type { OrchestratorStateType } from "./state.js";
import { ProjectStore } from "../projects/projectStore.js";
import { EventLog, now } from "../events/log.js";
import type { OrchestratorEvent } from "../events/types.js";
import {
  ApprovalRequest,
  HumanDecision,
  type ApprovalRequest as TApprovalRequest,
  type HumanDecision as THumanDecision,
} from "../domain/approval.js";
import {
  WorkflowRun, newRunId, type WorkflowRun as TWorkflowRun, type WorkflowPhase,
} from "../domain/workflow.js";
import { createCheckpointer, closeCheckpointer } from "../persistence/checkpointer.js";
import { createInspectorForProject } from "../adapters/repository/index.js";
import { DisabledCheckRunner } from "../verification/checks.js";

export interface RunResult {
  run: TWorkflowRun;
  /** Set when the workflow suspended at a human gate. */
  pendingApproval: TApprovalRequest | null;
  state: Partial<OrchestratorStateType>;
}

/** Shape LangGraph returns on an interrupt. */
interface InterruptedResult {
  __interrupt__?: Array<{ value?: unknown }>;
  [k: string]: unknown;
}

/**
 * Owns the lifecycle of a workflow run: creating it, driving the graph, and -
 * critically - recording enough on disk that a DIFFERENT PROCESS can find the
 * run and resume it.
 *
 * Two separate stores are in play and they must not be conflated:
 *   - the SQLite checkpointer holds resumable graph state (machine-owned)
 *   - the project store holds the WorkflowRun record (human-readable)
 * The run record is what makes a suspended run discoverable; the checkpoint is
 * what makes it resumable.
 */
export class WorkflowRunner {
  private readonly checkpointer: BaseCheckpointSaver;
  /** True when this runner opened the checkpointer and therefore owns closing it. */
  private readonly ownsCheckpointer: boolean;

  constructor(
    private readonly store: ProjectStore = new ProjectStore(),
    checkpointer?: BaseCheckpointSaver,
  ) {
    this.ownsCheckpointer = checkpointer === undefined;
    this.checkpointer = checkpointer ?? createCheckpointer();
  }

  /**
   * Release the SQLite handle. Windows keeps the database file locked while a
   * handle is open, so a caller that wants to delete or move the checkpoint
   * directory must close first.
   */
  close(): void {
    if (this.ownsCheckpointer) closeCheckpointer(this.checkpointer);
  }

  private makeContext(run: TWorkflowRun, log: EventLog): {
    ctx: NodeContext;
    captured: { approval: TApprovalRequest | null };
  } {
    const captured: { approval: TApprovalRequest | null } = { approval: null };

    // The inspector is built HERE, from the project record, and handed to the
    // graph as an interface. Nodes therefore cannot choose what they inspect or
    // widen their own boundary - the project's workingDir decides both.
    const project = this.store.getProject(run.projectId);

    const ctx: NodeContext = {
      store: this.store,
      inspector: project ? createInspectorForProject(project) : null,
      // Declared checks are recorded, never run. See verification/checks.ts.
      checkRunner: new DisabledCheckRunner(),
      emit: (event: OrchestratorEvent) => { log.append(event); },
      onApprovalRequested: (request) => {
        captured.approval = ApprovalRequest.parse(request);
        log.append({
          type: "approval_requested", runId: run.id, approvalId: request.approvalId,
          kind: request.kind, risk: request.risk, summary: request.summary, at: now(),
        });
      },
      onApprovalReceived: (decision) => {
        log.append({
          type: "approval_received", runId: run.id, approvalId: decision.approvalId,
          decision: decision.kind, decidedBy: decision.decidedBy, at: now(),
        });
      },
      onFinalise: () => { /* task-status writes belong to a later phase */ },
    };
    return { ctx, captured };
  }

  /** Begin a new run. Returns as soon as the graph suspends or completes. */
  async start(projectId: string, request: string): Promise<RunResult> {
    this.store.requireProject(projectId);

    const runId = newRunId();
    const run = this.store.saveRun(
      WorkflowRun.parse({
        id: runId,
        projectId,
        threadId: runId, // one thread per run keeps the mapping trivial
        request,
        status: "running",
        phase: "understand",
        startedAt: now(),
      }),
    );

    const log = new EventLog(this.store.historyFile(projectId, runId));
    log.append({ type: "workflow_started", runId, projectId, request, at: now() });

    return this.drive(run, log, { runId, projectId, request });
  }

  /**
   * Resume a suspended run - typically from a brand-new process that shares
   * nothing with the original except the checkpoint database and the run file.
   */
  async resume(runId: string, decision: THumanDecision): Promise<RunResult> {
    const existing = this.store.findRun(runId);
    if (!existing) throw new Error(`Unknown run "${runId}".`);
    if (existing.status !== "awaiting_approval") {
      throw new Error(`Run "${runId}" is ${existing.status}, not awaiting approval.`);
    }

    const parsed = HumanDecision.parse(decision);
    if (existing.pendingApprovalId && parsed.approvalId !== existing.pendingApprovalId) {
      throw new Error(
        `Run "${runId}" is waiting on approval ${existing.pendingApprovalId}, ` +
          `but the decision answers ${parsed.approvalId}.`,
      );
    }

    const log = new EventLog(this.store.historyFile(existing.projectId, runId));
    log.append({
      type: "workflow_resumed", runId, phase: existing.phase, pid: process.pid, at: now(),
    });

    return this.drive(existing, log, new Command({ resume: parsed }));
  }

  /** Shared execution path for start and resume. */
  private async drive(
    run: TWorkflowRun,
    log: EventLog,
    input: unknown,
  ): Promise<RunResult> {
    const { ctx, captured } = this.makeContext(run, log);
    const graph = buildWorkflow(ctx, this.checkpointer);
    const config = { configurable: { thread_id: run.threadId } };

    let result: InterruptedResult;
    try {
      result = (await graph.invoke(input as never, config)) as InterruptedResult;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.append({ type: "workflow_failed", runId: run.id, reason, at: now() });
      const failed = this.store.saveRun({
        ...run, status: "failed", endedAt: now(), outcome: reason,
      });
      return { run: failed, pendingApproval: null, state: {} };
    }

    const interrupts = result.__interrupt__ ?? [];
    if (interrupts.length > 0) {
      // Suspended at a human gate. The checkpoint is already durable; record
      // the run so another process can discover it.
      const value = interrupts[0]?.value;
      const approval = captured.approval ?? ApprovalRequest.parse(value);
      const phase: WorkflowPhase =
        approval.kind === "plan" ? "approve_plan" : "approve_review";

      log.append({
        type: "workflow_interrupted", runId: run.id, phase,
        approvalId: approval.approvalId, at: now(),
      });

      const suspended = this.store.saveRun({
        ...run, status: "awaiting_approval", phase,
        pendingApprovalId: approval.approvalId,
        pendingApproval: approval,
      });
      return { run: suspended, pendingApproval: approval, state: result as object };
    }

    // Ran to completion.
    const state = result as unknown as OrchestratorStateType;
    const outcome = state.outcome ?? "completed";
    log.append({ type: "workflow_completed", runId: run.id, outcome, at: now() });

    const finished = this.store.saveRun({
      ...run,
      status: outcome.startsWith("rejected") ? "rejected" : "completed",
      phase: "update_state",
      pendingApprovalId: null,
      pendingApproval: null,
      endedAt: now(),
      outcome,
    });
    return { run: finished, pendingApproval: null, state };
  }
}
