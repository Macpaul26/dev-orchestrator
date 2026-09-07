import crypto from "node:crypto";
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

/**
 * NOTHING IN THIS FILE TRUNCATES.
 *
 * There used to be a `bounded()` helper here that trimmed every record to the
 * field limit before handing it over, and it was a real defect: the task
 * description was cut to fit and the assembler then reported a complete,
 * successful assembly of a request it had only seen part of. A model planning
 * against half a request, with nothing anywhere saying so, is precisely the
 * failure the "never silently discard critical context" rule exists to stop.
 *
 * So the COMPLETE value is passed through and the assembler decides. If
 * something is over its bound, assembly fails and says so - which is loud,
 * checkable, and impossible to mistake for success.
 */

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
    text: decision.rationale
      ? `${decision.statement} (rationale: ${decision.rationale})`
      : decision.statement,
    at: decision.decidedAt,
  }));
}

export function humanConstraints(constraints: readonly string[]): ContextInput[] {
  return constraints.map((constraint, index) => ({
    provenance: "HUMAN_CONSTRAINT" as const,
    // Index-keyed, but the LIST is human-authored and ordered in project.json,
    // so this is stable configuration rather than incidental enumeration.
    key: `constraint.${String(index).padStart(3, "0")}`,
    text: constraint,
  }));
}

/**
 * Repository observations, keyed by CONTENT rather than by position.
 *
 * The review asked whether index keys were safe here. Tracing the path -
 * inspection -> `state.observations` -> here - the list is built in a fixed
 * code order and `changedFiles` is sorted by the inspector, so it is very
 * probably stable. "Very probably" is not a guarantee I want a determinism
 * property resting on, and an index key would silently change identity if a
 * line were ever inserted upstream.
 *
 * A digest of the text is stable by construction: the same observation gets the
 * same identity on any machine, in any position, forever. Ordering within the
 * category then falls to the assembler's key comparison, which is deterministic
 * for the same reason.
 *
 * Contrast `humanConstraints`, which keeps index keys deliberately: that list
 * is a human-authored array in project.json, where the ORDER is itself the
 * human's intent and is part of the stored configuration.
 */
export function repositoryObservations(observations: readonly string[]): ContextInput[] {
  return observations.map((observation) => ({
    provenance: "REPOSITORY_OBSERVATION" as const,
    key: `observation.${crypto.createHash("sha256").update(observation).digest("hex").slice(0, 16)}`,
    text: observation,
  }));
}

export function taskDescription(request: string): ContextInput[] {
  /**
   * THE COMPLETE REQUEST. No slice, no trim, no ellipsis.
   *
   * The assembler applies `maxTaskDescriptionLength` and fails closed if the
   * request is over it. Shortening here would hide that from the one component
   * whose job is to notice.
   */
  return [{
    provenance: "TASK_DESCRIPTION",
    key: "task.request",
    text: request,
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
  /**
   * RELEVANCE SELECTION, NOT BUDGET ENFORCEMENT.
   *
   * Two different jobs, and it matters which one this is. The assembler owns
   * the budget and will cap this category itself; what it cannot do is decide
   * WHICH claims matter, because its ordering is by stable key and a key says
   * nothing about recency.
   *
   * So this picks the most recent runs - a relevance judgement, made where the
   * timestamps are - and the assembler still enforces the bound afterwards. It
   * selects; it does not truncate any record's text, and it is not a second
   * size authority.
   */
  return [...runs]
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, CONTEXT_LIMITS.maxHistoricalAgentClaims)
    .map((run) => ({
      provenance: "HISTORICAL_AGENT_CLAIM" as const,
      key: `run.${run.runId}`,
      // Orchestrator-generated and inherently short; no trimming needed, and
      // none applied - an over-long one would fail assembly rather than be cut.
      text:
        `A previous implementation run (${run.runId}) ended with status ` +
        `"${run.status}". The orchestrator counted ${run.writes} write(s), ` +
        `${run.deletes} delete(s) and ${run.denials} denial(s). ` +
        (run.partialChangesPossible
          ? "Partial changes may remain in the repository."
          : "It completed cleanly."),
      at: run.startedAt,
    }));
}
