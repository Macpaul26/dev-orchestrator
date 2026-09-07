import { z } from "zod";

/**
 * THE REASONING BOUNDARY
 *
 * What an LLM is allowed to hand back to the orchestrator.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS UNTRUSTED DATA
 * ---------------------------------------------------------------------------
 * A reasoning model is useful precisely because it produces text nobody wrote
 * in advance, which is the same reason none of it can be believed. It is also
 * downstream of content the orchestrator does not control - a README, a source
 * comment, a task description - any of which may contain instructions aimed at
 * the model rather than at a person.
 *
 * So the model occupies exactly one position in this system:
 *
 *   it PROPOSES.  The orchestrator decides what is structurally valid.
 *   A human decides what is approved.
 *
 * There is no field below that grants anything, approves anything, or executes
 * anything, and that is enforced structurally rather than by convention:
 *
 *   1. `.strict()` - a response carrying `approved`, `capabilities`, `execute`
 *      or any other unexpected key is REJECTED IN FULL, not quietly ignored.
 *      An authority field cannot ride along inside a valid proposal.
 *
 *   2. No authority-shaped field is DECLARED. There is nowhere for a grant to
 *      land even if validation were bypassed, because the type has no such
 *      property to read.
 *
 *   3. Risk is absent on purpose. A model that says "risk: LOW" would otherwise
 *      be lowering the gate that governs it. The orchestrator classifies risk
 *      itself, from what the plan would DO - see reasoning/proposal.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY FIELD IS BOUNDED
 * ---------------------------------------------------------------------------
 * This object is written into LangGraph state and into a SQLite checkpoint. An
 * unbounded response would therefore be a way to make the orchestrator persist
 * as much as the model felt like emitting - a denial of service that arrives
 * looking like a plan. Limits are enforced by the schema, so they hold whatever
 * the provider returned and whatever the prompt asked for.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const REASONING_LIMITS = {
  /** Whole provider response, before any parsing is attempted. */
  maxResponseBytes: 128 * 1024,
  maxSummaryLength: 4_000,
  maxRationaleLength: 2_000,
  maxItemLength: 500,
  maxObjectives: 20,
  maxRequirements: 40,
  maxSteps: 30,
  maxProposedPaths: 100,
  maxPathLength: 400,
  maxVerificationItems: 20,
  maxRisks: 30,
  maxQuestions: 20,
} as const;

const Item = z.string().min(1).max(REASONING_LIMITS.maxItemLength);

/** One thing the model thinks should happen. Carries NO risk field - see above. */
export const ProposedStep = z.object({
  order: z.number().int().nonnegative().max(REASONING_LIMITS.maxSteps),
  description: Item,
}).strict();
export type ProposedStep = z.infer<typeof ProposedStep>;

export const ProposedScope = z.object({
  /**
   * Repository-relative paths the model believes need changing.
   *
   * A SUGGESTION and nothing more. These are re-normalised and traversal-checked
   * by trusted code before they reach a plan, and even then they only become
   * authority if a human approves them at the existing gate.
   */
  paths: z.array(z.string().min(1).max(REASONING_LIMITS.maxPathLength))
    .max(REASONING_LIMITS.maxProposedPaths).default([]),
  rationale: z.string().max(REASONING_LIMITS.maxRationaleLength).default(""),
}).strict();
export type ProposedScope = z.infer<typeof ProposedScope>;

export const ProposedVerification = z.object({
  /**
   * Checks the model thinks should run. TEXT ONLY.
   *
   * Deliberately not a `VerificationCheck`: those carry an executable and an
   * argv, and letting a model populate them would hand it process execution
   * through the back door. Task 005 checks come from trusted configuration
   * captured before any of this runs, and nothing here can add to that set.
   */
  checks: z.array(Item).max(REASONING_LIMITS.maxVerificationItems).default([]),
  rationale: z.string().max(REASONING_LIMITS.maxRationaleLength).default(""),
}).strict();
export type ProposedVerification = z.infer<typeof ProposedVerification>;

export const ReasoningProposal = z.object({
  summary: z.string().min(1).max(REASONING_LIMITS.maxSummaryLength),
  objectives: z.array(Item).max(REASONING_LIMITS.maxObjectives).default([]),
  requirements: z.array(Item).max(REASONING_LIMITS.maxRequirements).default([]),
  steps: z.array(ProposedStep).max(REASONING_LIMITS.maxSteps).default([]),
  proposedScope: ProposedScope.default(() => ProposedScope.parse({})),
  verification: ProposedVerification.default(() => ProposedVerification.parse({})),
  risks: z.array(Item).max(REASONING_LIMITS.maxRisks).default([]),
  /** Things the model wants a human to answer. Surfaced, never acted on. */
  questions: z.array(Item).max(REASONING_LIMITS.maxQuestions).default([]),
}).strict();
export type ReasoningProposal = z.infer<typeof ReasoningProposal>;

/**
 * Why a reasoning call did not produce a usable proposal.
 *
 * Every one of these is a FAILURE, and failure never advances the workflow.
 * There is no value here that a caller can mistake for "it worked" - which is
 * the point of enumerating them rather than returning null.
 */
export const ReasoningFailureCode = z.enum([
  /** No provider is configured. The normal state, and not an error. */
  "not_configured",
  /** Configured but unusable - missing credential, malformed settings. */
  "configuration_invalid",
  /** The provider rejected our credentials. */
  "authentication_failed",
  /** The provider did not answer in time. */
  "timeout",
  /** The run was cancelled while the request was in flight. */
  "cancelled",
  /** The provider could not be reached, or errored. */
  "transport_failed",
  /** The response exceeded the byte ceiling before parsing was attempted. */
  "response_too_large",
  /**
   * The rendered PROMPT exceeded the transport limit.
   *
   * Distinct from `response_too_large`, which is about what came back. This is
   * about what we refused to send - and refusing is the point: the alternative
   * is shortening a prompt whose critical context the assembler deliberately
   * preserved.
   */
  "context_too_large",
  /** The response was not the structured shape we required. */
  "malformed_response",
  /** It parsed as JSON but failed schema validation - including strict-key. */
  "schema_invalid",
]);
export type ReasoningFailureCode = z.infer<typeof ReasoningFailureCode>;

export const ReasoningFailure = z.object({
  code: ReasoningFailureCode,
  /** Short and non-disclosing. Never a raw response, never a credential. */
  message: z.string().max(500),
}).strict();
export type ReasoningFailure = z.infer<typeof ReasoningFailure>;

/**
 * PROVENANCE FOR ONE REASONING CALL.
 *
 * Deliberately metadata, not content. It records that a call happened, to
 * whom, and whether its output survived validation - without duplicating the
 * prompt or the response into the audit trail, both of which may contain
 * project data that has no business being copied into a checkpoint.
 */
export const ReasoningRecord = z.object({
  provider: z.string().max(100),
  model: z.string().max(200),
  operation: z.string().max(100),
  runId: z.string().max(200),
  at: z.string().datetime(),
  /** Did a VALIDATED proposal come out of it? Not "did the call return 200". */
  ok: z.boolean(),
  failure: ReasoningFailure.nullable().default(null),
  durationMs: z.number().nonnegative().default(0),
  /** Bounded counts only, when the provider reports them. */
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  responseBytes: z.number().int().nonnegative().default(0),
}).strict();
export type ReasoningRecord = z.infer<typeof ReasoningRecord>;

/**
 * Field names that would mean authority if this schema ever accepted them.
 *
 * Exported so a test can assert they are absent from the parsed shape. Keeping
 * the list next to the schema means adding one of these later is a visible,
 * reviewable act rather than an accident.
 */
export const FORBIDDEN_PROPOSAL_KEYS: readonly string[] = [
  "approved", "approve", "capabilities", "capability", "grant", "grants",
  "execute", "exec", "command", "shell", "tool", "tools", "risk",
  "highestRisk", "allowedScope", "authorized", "authorised", "bypass",
] as const;
