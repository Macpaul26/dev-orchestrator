import path from "node:path";
import type {
  ImplementationAgent, ImplementationRequest,
} from "../../implementation/runner.js";
import type { ImplementationSession, CancellationToken } from "../../implementation/session.js";
import { ImplementationCancelled } from "../../implementation/session.js";
import { AgentReport, type AgentReport as TAgentReport } from "../../domain/implementation.js";
import type { AgentProcessOutcome } from "./processBoundary.js";
import type { AgentProcessResult } from "../../domain/agentProcess.js";
import { launchAgentProcess, AgentLaunchRefused } from "./processBoundary.js";
import { ToolBridge } from "../../implementation/toolBridge.js";
import type { ClaudeCodeConfig } from "./config.js";
import type { ActivityJournal } from "../../activity/journal.js";
import { newCorrelationId } from "../../activity/journal.js";

/**
 * THE CLAUDE CODE ADAPTER
 *
 * Claude Code as an `ImplementationAgent`. It is deliberately thin: it turns a
 * bounded session into a bounded child process, waits, and converts what came
 * back into CLAIMS.
 *
 * ---------------------------------------------------------------------------
 * CLAUDE CODE IS AN UNTRUSTED IMPLEMENTATION AGENT
 * ---------------------------------------------------------------------------
 * Not "untrusted until we have integrated it properly" - untrusted as a
 * standing property. It is a capable program driven by a model, it can be
 * steered by whatever it reads in a repository, and its account of its own
 * behaviour is exactly the kind of evidence this system was built not to rely
 * on. So:
 *
 *   what it PRINTS      -> AgentReport, the claimed side, never observations
 *   what the OS SAYS    -> AgentProcessResult, evidence about the process only
 *   what CHANGED        -> established afterwards by repository inspection
 *
 * An exit code of 0 is a fact about a program returning. It is not a fact about
 * a repository, and this adapter never lets it become one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ADAPTER DOES NOT DO IN 4B.1
 * ---------------------------------------------------------------------------
 * It hands the child no repository tools. The controlled bridge that would let
 * Claude Code write through the Phase 4A session belongs to 4B.2, so in this
 * phase the child receives a description of what it is authorised to do and no
 * mechanism for doing it. That is intentional: the boundary is proven before
 * anything is allowed through it.
 */
export class ClaudeCodeAgent implements ImplementationAgent {
  readonly name = "claude-code";

  /** Set from the OS's report once the process ends. Never agent-authored. */
  #lastProcess: AgentProcessResult | null = null;

  constructor(
    private readonly config: ClaudeCodeConfig,
    /** Orchestrator-owned. The agent has no reference to it. */
    private readonly journal: ActivityJournal | null = null,
  ) {}

  /** TRUSTED process facts from the most recent run. See ImplementationAgent. */
  observations(): AgentProcessResult | null {
    return this.#lastProcess;
  }

  async implement(
    session: ImplementationSession,
    request: ImplementationRequest,
    cancellation: CancellationToken,
  ): Promise<TAgentReport> {
    const correlationId = newCorrelationId();
    const workingDir = request.workingDir;

    if (!workingDir) {
      // The runner sets this. Its absence is an orchestrator wiring fault, and
      // guessing a directory would be exactly the wrong recovery.
      this.record(session, correlationId, {
        type: "agent_launch_failed",
        agent: this.name,
        failure: "working_dir_invalid",
        detail: "the runner supplied no authorised working directory",
      });
      throw new Error("No authorised working directory was supplied to the agent adapter.");
    }

    this.record(session, correlationId, {
      type: "agent_launch_attempted",
      agent: this.name,
      // Basename only: the full path is orchestrator configuration, and there is
      // no reason to copy it into a per-run audit record.
      executable: path.basename(this.config.executable),
    });

    /**
     * THE CONTROLLED TOOL BRIDGE.
     *
     * Built here, from the TRUSTED session the runner handed us. The child gets
     * a pipe it can write requests to - never the session, never the grant,
     * never a filesystem handle. Every request it sends is re-authorised from
     * scratch against this session.
     */
    const bridge = new ToolBridge({ session, cancellation, journal: this.journal });

    let handle: ReturnType<typeof launchAgentProcess>;
    try {
      handle = launchAgentProcess({
        config: this.config,
        workingDir,
        forbiddenDirectories: request.forbiddenDirectories ?? [],
        onToolRequest: async (line) => JSON.stringify(await bridge.handleRaw(line)),
        payload: {
          protocol: "orchestrator.implementation.v1",
          runId: session.runId,
          projectId: session.projectId,
          grantId: session.grantId,
          instruction: request.instruction,
          planSummary: request.planSummary ?? "",
          // FROM THE GRANT, via the session - not from the request. A caller
          // cannot widen what the agent is told it may touch, and telling it
          // more would not widen the enforcement anyway.
          allowedScope: session.allowedScope,
          capabilities: session.capabilities,
        },
      });
    } catch (error) {
      if (error instanceof AgentLaunchRefused) {
        this.record(session, correlationId, {
          type: "agent_launch_failed",
          agent: this.name,
          failure: error.failure,
          detail: error.message,
        });
        throw error;
      }
      throw error;
    }

    // Cancellation has to reach a real process, so it is wired to a signal
    // rather than to a flag the child will never read.
    const unsubscribe = cancellation.onCancel((reason) => {
      this.record(session, correlationId, {
        type: "agent_termination_requested",
        agent: this.name,
        pid: handle.pid,
        reason,
      });
      void handle.terminate(reason);
    });

    if (handle.pid !== null) {
      this.record(session, correlationId, {
        type: "agent_started", agent: this.name, pid: handle.pid,
      });
    }

    let outcome: AgentProcessOutcome;
    try {
      outcome = await handle.wait();
    } finally {
      unsubscribe();
      // No request may be served after the process has ended.
      bridge.close();
    }
    this.#lastProcess = outcome.result;

    if (outcome.result.status === "launch_failed") {
      this.record(session, correlationId, {
        type: "agent_launch_failed",
        agent: this.name,
        failure: outcome.result.launchFailure ?? "spawn_error",
        detail: outcome.result.detail ?? "launch failed",
      });
      throw new AgentLaunchRefused(
        outcome.result.launchFailure ?? "spawn_error",
        outcome.result.detail ?? "the agent process could not be started",
      );
    }

    this.record(session, correlationId, {
      type: "agent_exited",
      agent: this.name,
      status: outcome.result.status,
      exitCode: outcome.result.exitCode,
      signal: outcome.result.signal,
      durationMs: outcome.result.durationMs ?? 0,
      stdoutBytes: outcome.output.stdoutBytes,
      stderrBytes: outcome.output.stderrBytes,
      outputTruncated: outcome.output.truncated,
    });

    if (outcome.result.status === "cancelled") {
      this.record(session, correlationId, {
        type: "agent_terminated",
        agent: this.name,
        status: outcome.result.status,
        forciblyKilled: outcome.result.forciblyKilled,
      });
      // Surfaced as cancellation so the run reaches the `cancelled` state the
      // Phase 4A lifecycle already defines - partial changes possible, grant
      // consumed, verification still mandatory.
      throw new ImplementationCancelled(
        outcome.result.forciblyKilled
          ? "the agent ignored termination and was killed"
          : "the agent process was terminated",
      );
    }

    /**
     * BUILD THE CLAIM.
     *
     * Everything below is agent-authored and is treated as narrative. Note what
     * is NOT done: a zero exit code does not set `claimsSuccess` on the agent's
     * behalf, and a non-zero one does not clear a success the agent asserted.
     * Those are separate assertions from separate sources, and collapsing them
     * would quietly turn an OS fact into a claim about the work.
     */
    const claimed = outcome.claimedReport;
    return AgentReport.parse({
      summary: this.describeOutcome(outcome, claimed?.summary),
      files: claimed?.files ?? [],
      claimsSuccess: claimed?.claimsSuccess ?? false,
      notes: [
        // Both numbers, because they answer different questions: how much the
        // agent actually achieved, and how much of its budget it spent trying.
        `tool requests received by the orchestrator: ${bridge.requestsReceived}`,
        `tool requests that reached a tool: ${bridge.requestsHandled}`,
        `process ${outcome.result.status}` +
          (outcome.result.exitCode !== null ? ` (exit ${outcome.result.exitCode})` : "") +
          (outcome.result.signal !== null ? ` (signal ${outcome.result.signal})` : ""),
        `agent output: ${outcome.output.stdoutBytes} bytes stdout, ` +
          `${outcome.output.stderrBytes} bytes stderr` +
          (outcome.output.truncated ? " (truncated)" : ""),
        "All of the above beyond the process status is the agent's own account " +
          "and is not evidence of what changed.",
      ],
    });
  }

  /**
   * A summary that cannot be mistaken for an observation.
   *
   * When the agent supplied text it is included, prefixed so that anything
   * reading the record later - a human, or a model in a later phase - is told
   * whose words these are before it reads them.
   */
  private describeOutcome(
    outcome: AgentProcessOutcome,
    agentSummary: string | undefined,
  ): string {
    const status = `Claude Code process ${outcome.result.status}`;
    if (!agentSummary) {
      return `${status}. The agent supplied no summary of its own.`;
    }
    const bounded = agentSummary.slice(0, 2000);
    return `${status}. AGENT-REPORTED (untrusted, not verified): ${bounded}`;
  }

  /** Append to the orchestrator's journal. The child never touches this. */
  private record(
    session: ImplementationSession,
    correlationId: string,
    partial: Record<string, unknown>,
  ): void {
    this.journal?.append({
      runId: session.runId,
      projectId: session.projectId,
      grantId: session.grantId,
      correlationId,
      at: new Date().toISOString(),
      ...partial,
    } as never);
  }
}
