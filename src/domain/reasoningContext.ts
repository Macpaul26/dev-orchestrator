import { z } from "zod";

/**
 * THE CONTROLLED REASONING CONTEXT
 *
 * What the orchestrator is willing to tell a reasoning model, and how much of
 * it, and with what label attached.
 *
 * ---------------------------------------------------------------------------
 * AN INFORMATION BOUNDARY, NOT AN AUTHORITY BOUNDARY
 * ---------------------------------------------------------------------------
 * Task 006 established that model OUTPUT is untrusted. This is the other half:
 * model INPUT is a mixture of things with wildly different standing, and
 * flattening them into one blob of prose destroys the only thing that makes the
 * mixture safe to send.
 *
 * A human decision and a sentence an implementation agent once wrote about
 * itself are not the same kind of fact. Neither are a repository observation
 * the orchestrator made itself and a line of text it found in a README. Every
 * record below therefore carries its PROVENANCE, and the provenance travels all
 * the way into the rendered prompt.
 *
 * Giving the model more information does not give it more authority. It still
 * proposes; the orchestrator still decides; the human still approves.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE LABEL DOES AND DOES NOT DO
 * ---------------------------------------------------------------------------
 * Labelling a record `[UNTRUSTED AGENT CLAIM]` does not make a model treat it as
 * untrusted. Models can be argued out of labels. What the label actually buys:
 *
 *   - the ORCHESTRATOR can enforce precedence mechanically, because the ranking
 *     is a number attached to the record rather than a sentence in a prompt
 *   - a HUMAN reading the gate can see which claim came from where
 *   - a conflict can be DETECTED and surfaced rather than silently resolved by
 *     whichever text the model happened to weight more heavily
 *
 * The model is never asked to resolve an authority conflict. Where two records
 * of different standing disagree, both are preserved with their labels, and the
 * disagreement is reported.
 */

/**
 * Where a piece of context came from. Ordered by authority - see
 * `PROVENANCE_RANK`, which is the machine-readable version of that ordering.
 */
export const ContextProvenance = z.enum([
  /** Trusted project facts held by the orchestrator itself. */
  "PROJECT_METADATA",
  /** An explicit, recorded human decision. The highest authority here. */
  "HUMAN_DECISION",
  /** A durable constraint a human imposed. */
  "HUMAN_CONSTRAINT",
  /** A fact the repository intelligence layer established by looking. */
  "REPOSITORY_OBSERVATION",
  /** The request currently being reasoned about. */
  "TASK_DESCRIPTION",
  /** Something an implementation agent once said. UNTRUSTED, permanently. */
  "HISTORICAL_AGENT_CLAIM",
]);
export type ContextProvenance = z.infer<typeof ContextProvenance>;

/**
 * AUTHORITY PRECEDENCE, AS A NUMBER.
 *
 *   HUMAN DECISION > HUMAN CONSTRAINT > REPOSITORY OBSERVATION
 *     > TASK DATA > HISTORICAL AGENT CLAIM > MODEL INFERENCE
 *
 * Deliberately a rank rather than a paragraph of prompt text. A sentence
 * telling a model which source wins is a request; a number lets the
 * orchestrator sort, compare and refuse without consulting the model at all.
 *
 * `PROJECT_METADATA` sits just below a human decision: it is trusted, being the
 * orchestrator's own record, but a human who has decided something outranks the
 * stored fact it was derived from.
 *
 * MODEL INFERENCE has no entry here on purpose. It is not context - it is
 * output, it arrives later, and it ranks below everything in this table.
 */
export const PROVENANCE_RANK: Readonly<Record<ContextProvenance, number>> = {
  HUMAN_DECISION: 100,
  HUMAN_CONSTRAINT: 90,
  PROJECT_METADATA: 80,
  REPOSITORY_OBSERVATION: 70,
  TASK_DESCRIPTION: 60,
  HISTORICAL_AGENT_CLAIM: 10,
} as const;

/**
 * Records that may NEVER be silently dropped to make room.
 *
 * If one of these cannot fit, assembly FAILS - it does not quietly produce a
 * smaller context that looks complete. A model reasoning without a human
 * constraint it was never shown is worse than a model that was not asked.
 */
export const CRITICAL_PROVENANCE: readonly ContextProvenance[] = [
  "HUMAN_DECISION", "HUMAN_CONSTRAINT", "TASK_DESCRIPTION",
] as const;

export function isCritical(provenance: ContextProvenance): boolean {
  return CRITICAL_PROVENANCE.includes(provenance);
}

/** The human-facing label each provenance renders as. */
export const PROVENANCE_LABEL: Readonly<Record<ContextProvenance, string>> = {
  PROJECT_METADATA: "TRUSTED PROJECT FACT",
  HUMAN_DECISION: "HUMAN DECISION",
  HUMAN_CONSTRAINT: "HUMAN CONSTRAINT",
  REPOSITORY_OBSERVATION: "REPOSITORY OBSERVATION",
  TASK_DESCRIPTION: "TASK DESCRIPTION",
  HISTORICAL_AGENT_CLAIM: "UNTRUSTED AGENT CLAIM",
} as const;

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const CONTEXT_LIMITS = {
  maxRecords: 200,
  maxTotalChars: 24_000,
  maxTextLength: 2_000,
  maxKeyLength: 200,
  maxProjectMetadata: 20,
  maxHumanDecisions: 40,
  maxHumanConstraints: 40,
  maxRepositoryObservations: 80,
  maxHistoricalAgentClaims: 20,
  maxTaskDescriptionLength: 4_000,
  maxWarnings: 20,
} as const;

/**
 * One piece of context.
 *
 * `.strict()` because a record carrying an unexpected field is a record whose
 * origin nobody has thought about, and this is the object that decides what a
 * model gets told.
 */
export const ContextRecord = z.object({
  provenance: ContextProvenance,
  /**
   * Stable identifier, used for deduplication and deterministic ordering.
   *
   * Must NOT be derived from filesystem enumeration or insertion order. It is
   * the thing that makes two runs over the same facts produce the same prompt.
   */
  key: z.string().min(1).max(CONTEXT_LIMITS.maxKeyLength),
  text: z.string().min(1).max(CONTEXT_LIMITS.maxTextLength),
  /** Optional ISO timestamp, used as a secondary sort key. */
  at: z.string().datetime().nullable().default(null),
}).strict();
export type ContextRecord = z.infer<typeof ContextRecord>;

/** Why context assembly refused to produce a context. */
export const ContextFailureCode = z.enum([
  /** A record did not validate - bad provenance, oversized field, unknown key. */
  "invalid_record",
  /** Critical trusted context could not fit inside the bounds. */
  "critical_context_too_large",
  /** A record appeared to carry a credential. Refused; the value is not echoed. */
  "sensitive_content_refused",
  /** The task description itself is missing or unusable. */
  "task_description_invalid",
]);
export type ContextFailureCode = z.infer<typeof ContextFailureCode>;

export const ContextFailure = z.object({
  code: ContextFailureCode,
  /**
   * Short and NON-DISCLOSING.
   *
   * A refusal caused by a suspected credential must not quote the credential
   * into an error message, a log line, or an event - which is exactly where
   * secrets end up when a failure path is written carelessly.
   */
  message: z.string().max(500),
  /** Provenance of the offending record, when that is safe to name. */
  provenance: ContextProvenance.nullable().default(null),
}).strict();
export type ContextFailure = z.infer<typeof ContextFailure>;

/**
 * The assembled, bounded, ordered context.
 *
 * `truncated` and `warnings` exist so a dropped record is VISIBLE. A context
 * that silently shed half its repository observations while still looking
 * complete would quietly mislead both the model and the human reading the gate.
 */
export const AssembledContext = z.object({
  records: z.array(ContextRecord).max(CONTEXT_LIMITS.maxRecords),
  /** True when any non-critical record was dropped to fit the bounds. */
  truncated: z.boolean().default(false),
  /** Bounded, human-readable notes about what was dropped and why. */
  warnings: z.array(z.string().max(500)).max(CONTEXT_LIMITS.maxWarnings).default([]),
  totalChars: z.number().int().nonnegative(),
  assembledAt: z.string().datetime(),
}).strict();
export type AssembledContext = z.infer<typeof AssembledContext>;

/**
 * A bounded summary of one assembly, for durable workflow state.
 *
 * The full context is NOT persisted: it is derived from records the store
 * already holds, and copying it into a checkpoint would duplicate project text
 * into a second place with a different lifetime. Counts and warnings are enough
 * for a human to see what the model was working from.
 */
export const ContextSummary = z.object({
  records: z.number().int().nonnegative(),
  /**
   * Counts per provenance, for the categories actually present.
   *
   * `z.record(enum, ...)` in Zod 4 demands EVERY enum key, which would force a
   * zero entry for categories a project simply does not have and make the
   * summary lie about what was considered. `partialRecord` keeps absent
   * meaning absent.
   */
  byProvenance: z.partialRecord(ContextProvenance, z.number().int().nonnegative())
    .default(() => ({})),
  totalChars: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  warnings: z.array(z.string().max(500)).max(CONTEXT_LIMITS.maxWarnings).default([]),
}).strict();
export type ContextSummary = z.infer<typeof ContextSummary>;

export function summariseContext(context: AssembledContext): ContextSummary {
  const byProvenance: Partial<Record<ContextProvenance, number>> = {};
  for (const record of context.records) {
    byProvenance[record.provenance] = (byProvenance[record.provenance] ?? 0) + 1;
  }
  return ContextSummary.parse({
    records: context.records.length,
    byProvenance,
    totalChars: context.totalChars,
    truncated: context.truncated,
    warnings: context.warnings,
  });
}
