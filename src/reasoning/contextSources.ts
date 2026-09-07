import type { Project, Decision } from "../domain/project.js";
import type { ImplementationRun } from "../domain/implementation.js";
import { CONTEXT_LIMITS } from "../domain/reasoningContext.js";
import type { ContextInput } from "./context.js";

/**
 * TURNING STORED RECORDS INTO CONTEXT INPUTS
 *
 * The mapping layer, kept separate from the assembler so that "where does a
 * human decision come from" and "how much context may a model receive" are
 * answered in different files. The assembler enforces bounds and authority; this
 * decides only what each stored object is, and stops.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY KEY IS EXPLICIT
 * ---------------------------------------------------------------------------
 * The project store lists decisions and implementations with `readdirSync`, so
 * their order depends on the filesystem and is not stable across machines. Every
 * record therefore gets a stable, meaningful key derived from its own identity,
 * and the assembler sorts on that. Nothing here relies on the order it received.
 */

/** Truncate to the record limit, marking that it happened. */
function bounded(text: string): string {
  const limit = CONTEXT_LIMITS.maxTextLength;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}... [truncated]`;
}

export function projectMetadata(project: Project): ContextInput[] {
  return [
    {
      provenance: "PROJECT_METADATA",
      key: "project.name",
      text: `Project name: ${project.name}`,
    },
    {
      provenance: "PROJECT_METADATA",
      key: "project.id",
      text: `Project id: ${project.id}`,
    },
    /**
     * Counts, not contents.
     *
     * "There are 3 configured verification checks" is useful for reasoning.
     * The executable and argv of those checks are not - they are trusted
     * configuration, and putting them in a prompt would be describing the
     * verification mechanism to something whose output that mechanism exists
     * to check.
     */
    {
      provenance: "PROJECT_METADATA",
      key: "project.checks",
      text: `Configured verification checks: ${project.verificationChecks.length}`,
    },
  ];
}

/**
 * Human decisions. The highest-authority context there is.
 *
 * Keyed by the decision's own stable code, so ordering does not depend on how
 * the files happened to be listed.
 */
export function humanDecisions(decisions: readonly Decision[]): ContextInput[] {
  return decisions.map((decision) => ({
    provenance: "HUMAN_DECISION" as const,
    key: `decision.${decision.code}`,
    text: bounded(
      decision.rationale
        ? `${decision.statement} (rationale: ${decision.rationale})`
        : decision.statement,
    ),
    at: decision.decidedAt,
  }));
}

export function humanConstraints(constraints: readonly string[]): ContextInput[] {
  return constraints.map((constraint, index) => ({
    provenance: "HUMAN_CONSTRAINT" as const,
    // Index-keyed, but the LIST is human-authored and ordered in project.json,
    // so this is stable configuration rather than incidental enumeration.
    key: `constraint.${String(index).padStart(3, "0")}`,
    text: bounded(constraint),
  }));
}

export function repositoryObservations(observations: readonly string[]): ContextInput[] {
  return observations.map((observation, index) => ({
    provenance: "REPOSITORY_OBSERVATION" as const,
    key: `observation.${String(index).padStart(3, "0")}`,
    text: bounded(observation),
  }));
}

export function taskDescription(request: string): ContextInput[] {
  return [{
    provenance: "TASK_DESCRIPTION",
    key: "task.request",
    text: bounded(request.slice(0, CONTEXT_LIMITS.maxTaskDescriptionLength)),
  }];
}

/**
 * What implementation agents previously reported about themselves.
 *
 * PERMANENTLY UNTRUSTED, and the most dangerous material in the context: it is
 * agent-authored text that has been sitting in the store, and a previous agent
 * that wanted to influence a later plan would put it here.
 *
 * So what is sent is the ORCHESTRATOR'S OWN RECORD of the run - status, counts,
 * whether partial changes are possible - rather than the agent's narrative
 * summary. Those counts were observed by the orchestrator as it performed the
 * operations; they are not something the agent wrote. The label still says
 * UNTRUSTED AGENT CLAIM, because the run as a whole is the agent's activity.
 */
export function historicalAgentClaims(
  runs: readonly ImplementationRun[],
): ContextInput[] {
  return [...runs]
    // Newest first, by the orchestrator's own timestamps - then bounded, so an
    // old project cannot flood the context with history.
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, CONTEXT_LIMITS.maxHistoricalAgentClaims)
    .map((run) => ({
      provenance: "HISTORICAL_AGENT_CLAIM" as const,
      key: `run.${run.runId}`,
      text: bounded(
        `A previous implementation run (${run.runId}) ended with status ` +
        `"${run.status}". The orchestrator counted ${run.writes} write(s), ` +
        `${run.deletes} delete(s) and ${run.denials} denial(s). ` +
        (run.partialChangesPossible
          ? "Partial changes may remain in the repository."
          : "It completed cleanly."),
      ),
      at: run.startedAt,
    }));
}
