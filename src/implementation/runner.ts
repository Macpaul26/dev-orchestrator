import os from "node:os";
import { FsBoundary } from "../security/fsBoundary.js";
import { SafeFs } from "../security/safeFs.js";
import { SafeWriteFs } from "../security/writeBoundary.js";
import { resolveLimits, type InspectionLimits } from "../security/limits.js";
import { ActivityJournal, newCorrelationId } from "../activity/journal.js";
import { ImplementationLock, LockDenied } from "./lock.js";
import {
  ImplementationSession, CancellationToken, ImplementationCancelled,
} from "./session.js";
import {
  type ImplementationGrant, assertGrantUsable, grantIsMutating, GrantDenied,
} from "../domain/grant.js";
import {
  ImplementationRun, AgentReport,
  type ImplementationRun as TImplementationRun,
  type AgentReport as TAgentReport,
  type ImplementationStatus,
} from "../domain/implementation.js";
import type { ActivityErrorCategory } from "../domain/activity.js";
import type { ProjectStore } from "../projects/projectStore.js";

/**
 * THE CONTROLLED IMPLEMENTATION RUNNER
 *
 * Everything between "a human approved a plan" and "the repository has been
 * inspected again". It owns the lock, the session, the durable state and the
 * journal; the agent owns none of them.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN AGENT RECEIVES
 * ---------------------------------------------------------------------------
 * An `ImplementationSession` and a request. That is all. No filesystem handle,
 * no project path, no environment, no shell, no git, no network, and not the
 * grant object - so there is nothing for it to widen.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE AGENT RETURNS IS A CLAIM
 * ---------------------------------------------------------------------------
 * `AgentReport` never decides the run's status. An agent reporting success does
 * not make the run succeed, and an agent reporting nothing does not make the run
 * clean. The status comes from what the ORCHESTRATOR observed itself doing, and
 * what actually changed is settled afterwards by Phase 3 repository inspection.
 *
 * ---------------------------------------------------------------------------
 * THE RECORD IS WRITTEN BEFORE THE WORK
 * ---------------------------------------------------------------------------
 * `running` is persisted, with this process's pid, BEFORE the agent is invoked.
 * A process killed mid-write therefore leaves a `running` record with a dead
 * owner, which `reconcile()` turns into `interrupted` - never into `completed`.
 * There is no code path that marks a run completed without having reached the
 * end of `run()`.
 */

/** What an implementation agent must implement. Deliberately tiny. */
export interface ImplementationAgent {
  readonly name: string;
  /**
   * Do the work through `session`, honouring `cancellation`.
   *
   * The returned report is UNTRUSTED narrative. Throwing marks the run failed;
   * returning does not by itself mark it successful.
   */
  implement(
    session: ImplementationSession,
    request: ImplementationRequest,
    cancellation: CancellationToken,
  ): Promise<TAgentReport>;
}

export interface ImplementationRequest {
  /** The human-approved intent. Text only - it is not a command. */
  instruction: string;
  /** The approved plan summary, for the agent's context. */
  planSummary?: string;
}

export interface ImplementationRunResult {
  run: TImplementationRun;
  /** UNTRUSTED. Feeds `claimedSummary` / `claimedFiles`, nothing else. */
  agentReport: TAgentReport;
  /** True whenever the repository may hold partial work. */
  mustVerify: boolean;
}

export interface RunnerOptions {
  store: ProjectStore;
  limits?: Partial<InspectionLimits>;
  clock?: () => Date;
}

export class ControlledImplementationRunner {
  private readonly limits: InspectionLimits;
  private readonly clock: () => Date;

  constructor(private readonly options: RunnerOptions) {
    this.limits = resolveLimits(options.limits ?? {});
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Execute one bounded implementation.
   *
   * Refuses before touching anything if the grant is unusable or the project is
   * already locked. Always releases a lock it acquired, on every path.
   */
  async run(
    grant: ImplementationGrant,
    request: ImplementationRequest,
    agent: ImplementationAgent,
    cancellation: CancellationToken = new CancellationToken(),
  ): Promise<ImplementationRunResult> {
    const store = this.options.store;
    const journal = new ActivityJournal(store.activityFile(grant.projectId, grant.runId));
    const correlationId = newCorrelationId();

    // ---- 1. the presented grant must match the STORED one -----------------
    // This is what stops an agent (or any caller) handing us a widened copy.
    const stored = store.getGrant(grant.projectId, grant.grantId);
    if (!stored) {
      throw new GrantDenied(
        "unknown_grant",
        `Grant ${grant.grantId} was never issued for project "${grant.projectId}".`,
      );
    }
    if (JSON.stringify(stored) !== JSON.stringify(grant)) {
      throw new GrantDenied(
        "tampered",
        `Grant ${grant.grantId} does not match the issued record; the copy supplied ` +
          "to the runner has been modified.",
      );
    }
    assertGrantUsable(stored, {
      projectId: stored.projectId, runId: stored.runId, now: this.clock(),
    });

    const project = store.requireProject(stored.projectId);

    // ---- 2. state before work --------------------------------------------
    let record = store.saveImplementation(
      ImplementationRun.parse({
        runId: stored.runId,
        projectId: stored.projectId,
        grantId: stored.grantId,
        agent: agent.name,
        capabilities: stored.capabilities,
        allowedScope: stored.allowedScope,
        status: "not_started" satisfies ImplementationStatus,
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: null,
        partialChangesPossible: false,
      }),
    );

    // ---- 3. the lock, only when the grant can actually mutate -------------
    const mutating = grantIsMutating(stored);
    const lock = ImplementationLock.forProject(store.dir(stored.projectId));
    let holdsLock = false;

    if (mutating) {
      try {
        const held = lock.acquire({
          projectId: stored.projectId, runId: stored.runId, grantId: stored.grantId,
        });
        holdsLock = true;
        journal.append({
          type: "lock_acquired", runId: stored.runId, projectId: stored.projectId,
          grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
          holder: `${held.hostname}:${held.pid}`,
        });
      } catch (error) {
        if (error instanceof LockDenied) {
          journal.append({
            type: "lock_denied", runId: stored.runId, projectId: stored.projectId,
            grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
            heldByRun: error.holder?.runId ?? "unknown", detail: error.message,
          });
          // Persisted, then rethrown: the caller sees the refusal and the
          // record shows why, rather than sitting at `not_started` forever.
          store.saveImplementation({
            ...record, status: "failed", endedAt: this.clock().toISOString(),
            failureCategory: "denied",
            failureDetail: "project is locked by another implementation run",
          });
        }
        throw error;
      }
    }

    // ---- 4. the bounded session ------------------------------------------
    const boundary = FsBoundary.create(project.workingDir);
    const session = new ImplementationSession(
      stored,
      new SafeFs(boundary, this.limits),
      new SafeWriteFs(boundary, this.limits),
      journal,
      cancellation,
      this.clock,
    );

    journal.append({
      type: "implementation_started", runId: stored.runId, projectId: stored.projectId,
      grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
      agent: agent.name, capabilities: stored.capabilities, allowedScope: stored.allowedScope,
    });

    record = store.saveImplementation({
      ...record,
      status: "running",
      startedAt: this.clock().toISOString(),
      // From this instant until a terminal state is reached, the repository may
      // hold partial work. Set BEFORE the agent runs, so a crash cannot skip it.
      partialChangesPossible: true,
    });

    // ---- 5. run the agent -------------------------------------------------
    let agentReport: TAgentReport = AgentReport.parse({});
    let status: ImplementationStatus = "completed";
    let failureCategory: ActivityErrorCategory | null = null;
    let failureDetail: string | null = null;

    try {
      if (cancellation.isCancelled) throw new ImplementationCancelled("cancelled before start");
      agentReport = AgentReport.parse(await agent.implement(session, request, cancellation));
      // A late cancellation still counts: work may have landed before it.
      if (cancellation.isCancelled) throw new ImplementationCancelled("cancelled during implementation");
    } catch (error) {
      if (error instanceof ImplementationCancelled) {
        status = "cancelled";
        journal.append({
          type: "implementation_cancelled", runId: stored.runId, projectId: stored.projectId,
          grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
          writesBefore: session.stats.writes,
        });
      } else {
        status = "failed";
        failureCategory = error instanceof GrantDenied ? "denied" : "agent_error";
        // The agent's error MESSAGE is not recorded - it could carry file
        // content or an environment value. Only its type is.
        failureDetail = `agent threw ${error instanceof Error ? error.name : "an unknown error"}`;
        journal.append({
          type: "implementation_failed", runId: stored.runId, projectId: stored.projectId,
          grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
          category: failureCategory, detail: failureDetail,
        });
      }
    } finally {
      if (holdsLock) {
        lock.release(stored.runId);
        journal.append({
          type: "lock_released", runId: stored.runId, projectId: stored.projectId,
          grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
        });
      }
    }

    const stats = session.stats;
    if (status === "completed") {
      journal.append({
        type: "implementation_finished", runId: stored.runId, projectId: stored.projectId,
        grantId: stored.grantId, correlationId, at: this.clock().toISOString(),
        writes: stats.writes, deletes: stats.deletes, denials: stats.denials,
      });
    }

    record = store.saveImplementation({
      ...record,
      status,
      endedAt: this.clock().toISOString(),
      writes: stats.writes,
      deletes: stats.deletes,
      denials: stats.denials,
      // Cleared ONLY on a clean completion. Cancelled and failed runs keep it,
      // because either may have written something before stopping.
      partialChangesPossible: status !== "completed",
      failureCategory,
      failureDetail,
      cancelRequestedBy: cancellation.isCancelled ? "orchestrator" : record.cancelRequestedBy,
      cancelRequestedAt: cancellation.isCancelled ? this.clock().toISOString() : record.cancelRequestedAt,
    });

    return {
      run: record,
      agentReport,
      // ALWAYS true. Even a clean completion is verified against the real
      // repository - the runner's own account is not evidence about files.
      mustVerify: true,
    };
  }

  /**
   * Turn abandoned `running` records into `interrupted`.
   *
   * Called on startup. A record still marked `running` whose owner process is
   * gone did not finish, and the only honest thing to say about it is that we do
   * not know what it wrote. It is never promoted to `completed`, and
   * `partialChangesPossible` stays true so verification remains mandatory.
   *
   * Liveness is only consulted for records owned by THIS host; a record from
   * another machine is left alone rather than guessed at.
   */
  reconcile(projectId: string): TImplementationRun[] {
    const store = this.options.store;
    const reconciled: TImplementationRun[] = [];

    for (const record of store.listImplementations(projectId)) {
      if (record.status !== "running" && record.status !== "cancel_requested") continue;
      if (record.hostname !== os.hostname() || record.pid === null) continue;
      if (record.pid === process.pid) continue; // this process is the owner
      if (isAlive(record.pid)) continue;

      reconciled.push(
        store.saveImplementation({
          ...record,
          status: "interrupted",
          endedAt: this.clock().toISOString(),
          partialChangesPossible: true,
          failureCategory: "internal_error",
          failureDetail:
            "the process running this implementation exited before finishing; " +
            "what it wrote is unknown until the repository is inspected",
        }),
      );
    }
    return reconciled;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The agent used when none is configured: it does nothing at all.
 *
 * This is the DEFAULT in production. Phase 4A builds the substrate; no coding
 * agent is connected to it, so a workflow that reaches `implement` writes
 * nothing. Wiring a real agent is a Phase 4B decision, not a config toggle.
 */
export class NoOpImplementationAgent implements ImplementationAgent {
  readonly name = "none";
  async implement(): Promise<TAgentReport> {
    return AgentReport.parse({
      summary: "No implementation agent is configured; nothing was attempted.",
      claimsSuccess: false,
    });
  }
}
