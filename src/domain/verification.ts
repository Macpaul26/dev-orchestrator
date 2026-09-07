import { z } from "zod";
import { AgentProcessResult } from "./agentProcess.js";
import { AttributionSummary } from "./attribution.js";
import { ScopeVerdict } from "./scope.js";
import { InspectionFailure, GitMutationObservation } from "./repository.js";

/**
 * THE VERIFICATION OUTCOME
 *
 * What the orchestrator concluded about one implementation attempt, with the
 * evidence kept in four separate compartments that must never be merged.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR COMPARTMENTS AND NOT ONE BOOLEAN
 * ---------------------------------------------------------------------------
 * The tempting shape is `success: true`. It is wrong, because the four things
 * below can and do disagree, and the disagreement is the most valuable thing
 * this system produces:
 *
 *   PROCESS      the OS's account: did the program start, what did it return.
 *                A fact, but a fact about a program - not about a repository.
 *
 *   CLAIM        the agent's account. Untrusted narrative. An agent that says
 *                "all tests passed" has asserted something, not established it.
 *
 *   OBSERVATION  the repository's account, from Phase 3 inspection. This is what
 *                actually changed, established without asking the agent.
 *
 *   VERDICT      the orchestrator's conclusion, derived ONLY from observation -
 *                never from the claim, and never from the exit code.
 *
 * `exitCode: 0` alongside `claimsSuccess: true` alongside an empty
 * `attributable` list is a perfectly coherent outcome, and it means the agent
 * did nothing and said otherwise. Collapsing these would erase exactly that.
 */

export const VerificationVerdict = z.enum([
  /** Inspection succeeded, changes were in scope, nothing sensitive changed. */
  "verified",
  /** Inspection succeeded and found something wrong with the attempt. */
  "failed",
  /**
   * Inspection could not be completed, so NOTHING is established.
   *
   * Distinct from `failed` on purpose: "we looked and it was bad" and "we could
   * not look" are different facts, and only the second means a human is reading
   * a report with a hole in it.
   */
  "blocked",
  /** Changes landed outside the approved scope. */
  "scope_drift",
  /**
   * Git itself was used, and no capability authorised that.
   *
   * Deliberately its own verdict rather than a flavour of `scope_drift`. The two
   * describe different failures: drift says the run touched a path a human did
   * not approve; this says the run reached for a CAPABILITY nobody granted -
   * true even when every committed file was perfectly in scope.
   *
   * It also catches what nothing else can: a commit leaves the working tree
   * clean, so an attempt that writes, stages and commits looks - to every
   * dirty-file signal - exactly like an attempt that did nothing.
   */
  "git_mutation",
  /** A file the sensitive-file policy covers was modified. */
  "sensitive_change",
]);
export type VerificationVerdict = z.infer<typeof VerificationVerdict>;

/** UNTRUSTED. Exactly what the agent said, quarantined in its own field. */
export const AgentClaim = z.object({
  summary: z.string().default(""),
  files: z.array(z.string()).default([]),
  claimsSuccess: z.boolean().default(false),
  /** True when a tool actually served the agent. Orchestrator-counted. */
  usedTools: z.boolean().default(false),
});
export type AgentClaim = z.infer<typeof AgentClaim>;

/** TRUSTED. What inspecting the repository established. */
export const RepositoryObservation = z.object({
  inspected: z.boolean(),
  failure: InspectionFailure.nullable().default(null),
  headCommit: z.string().nullable().default(null),
  clean: z.boolean().default(true),
  changedFiles: z.array(z.string()).default([]),
  attributableFiles: z.array(z.string()).default([]),
  preExistingChanges: z.array(z.string()).default([]),
  attribution: AttributionSummary.nullable().default(null),
  scope: ScopeVerdict.nullable().default(null),
  sensitiveFilesChanged: z.array(z.string()).default([]),
  newCommits: z.array(z.string()).default([]),
  /** Whether git moved, observed independently of the working tree. */
  gitMutation: GitMutationObservation.default(() => GitMutationObservation.parse({})),
  /**
   * Whether a human granted `git.mutate`. Not an observation about the
   * repository - it is what the observation gets judged against, recorded here
   * so a reader can see both halves of the decision in one place.
   */
  gitMutationAuthorised: z.boolean().default(false),
});
export type RepositoryObservation = z.infer<typeof RepositoryObservation>;

/**
 * Project-declared checks.
 *
 * `available: false` throughout this phase. Running them means executing a
 * command string, which is the arbitrary process execution the capability model
 * refuses - so they are reported as unavailable rather than run, and never
 * reported as passing because an agent said so.
 */
export const CheckObservation = z.object({
  declared: z.number().int().nonnegative().default(0),
  executed: z.number().int().nonnegative().default(0),
  available: z.boolean().default(false),
  unavailableReason: z.string().nullable().default(null),
});
export type CheckObservation = z.infer<typeof CheckObservation>;

export const VerificationOutcome = z.object({
  runId: z.string().min(1),
  verdict: VerificationVerdict,

  /** The OS's account. Null when no process was involved. */
  process: AgentProcessResult.nullable().default(null),
  /** The agent's account. Never evidence. */
  claim: AgentClaim,
  /** The repository's account. This is what the verdict is derived from. */
  observation: RepositoryObservation,
  checks: CheckObservation,

  /**
   * True only when the repository was successfully inspected.
   *
   * Not "the implementation worked" - "we looked, ourselves, and what is below
   * came from looking".
   */
  independentlyVerified: z.boolean().default(false),

  /**
   * Where the agent's account and the repository's account differ.
   *
   * Populated whenever a claim is contradicted: files claimed but not observed,
   * changes observed but not claimed, or success asserted with nothing to show.
   */
  disagreements: z.array(z.string()).default([]),

  notes: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

/** Verdicts that must stop an attempt being waved through at review. */
export const BLOCKING_VERDICTS: readonly VerificationVerdict[] = [
  "failed", "blocked", "scope_drift", "sensitive_change", "git_mutation",
] as const;

export function isBlocking(verdict: VerificationVerdict): boolean {
  return BLOCKING_VERDICTS.includes(verdict);
}
