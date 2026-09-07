import {
  ContextRecord, AssembledContext, ContextFailure, CONTEXT_LIMITS, ContextProvenance,
  fieldLimitFor,
  PROVENANCE_RANK, PROVENANCE_LABEL, isCritical,
  type ContextRecord as TContextRecord,
  type AssembledContext as TAssembledContext,
  type ContextFailure as TContextFailure,
} from "../domain/reasoningContext.js";
import { looksLikeSecret } from "../security/secretShapes.js";

/**
 * THE CONTROLLED CONTEXT ASSEMBLER
 *
 * One place that decides what a reasoning model is told. Deliberately one
 * place: context construction scattered across a workflow node, a prompt
 * builder and a provider adapter is context nobody can audit, and the bounds
 * would drift apart the first time one of them was edited.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * ---------------------------------------------------------------------------
 *   1. validate      - a malformed record fails the whole assembly
 *   2. refuse secrets- a credential-shaped value is refused, never redacted-and-sent
 *   3. order         - by authority rank, then by stable key
 *   4. deduplicate   - by (provenance, text), never across provenance
 *   5. bound         - drop non-critical records; FAIL if critical will not fit
 *
 * Ordering before deduplication makes the surviving duplicate deterministic;
 * ordering before bounding means what gets dropped is always the lowest-
 * authority material and never something a human said.
 */

export interface ContextInput {
  provenance: ContextProvenance;
  key: string;
  text: string;
  at?: string | null;
}

export type ContextResult =
  | { ok: true; context: TAssembledContext }
  | { ok: false; failure: TContextFailure };

/**
 * Credential-shaped values are refused rather than forwarded.
 *
 * The policy itself lives in security/secretShapes.ts, shared with the
 * repository evidence service (Task 008). Two copies of a secret-detection
 * rule would eventually disagree, and the disagreement would be the hole.
 */

/**
 * Assemble the context.
 *
 * Returns a typed failure rather than throwing, and never returns a partial
 * success: either the caller gets a context it can rely on, or it gets a reason
 * it does not have one.
 */
export function assembleContext(
  inputs: readonly ContextInput[],
  now: () => Date = () => new Date(),
): ContextResult {
  const fail = (
    code: TContextFailure["code"],
    message: string,
    provenance: ContextProvenance | null = null,
  ): ContextResult => ({
    ok: false,
    failure: ContextFailure.parse({ code, message, provenance }),
  });

  // ---- 1. validate ------------------------------------------------------
  const validated: TContextRecord[] = [];
  for (const input of inputs) {
    /**
     * The raw input is validated AS GIVEN, not copied field by field first.
     *
     * Rebuilding it into a known shape before validating would silently discard
     * an unexpected key - and an unexpected key on a context record means
     * something nobody has thought about is being passed into the one object
     * that decides what a model is told. `.strict()` only helps if it sees the
     * original.
     */
    const parsed = ContextRecord.safeParse({ ...input, at: input.at ?? null });
    if (!parsed.success) {
      // The record's TEXT is never quoted into the failure - it may be the
      // very thing that was too long, or sensitive.
      /**
       * The offending provenance is only named when it is a REAL one.
       *
       * `ContextFailure.provenance` is the enum, so passing the invalid value
       * through would throw out of the very function that exists to return a
       * typed failure - turning "this record is malformed" into an unhandled
       * exception. The failure path must not be able to fail.
       */
      const named = ContextProvenance.safeParse(input.provenance);
      return fail(
        named.success && named.data === "TASK_DESCRIPTION"
          ? "task_description_invalid"
          : "invalid_record",
        // Lengths and categories only. The text is never quoted into a failure:
        // it may be the very thing that was too long, or sensitive.
        "a context record did not validate (unknown provenance, unexpected " +
        "field, or a field over its length limit)",
        named.success ? named.data : null,
      );
    }
    /**
     * THE PER-PROVENANCE FIELD BOUND IS ENFORCED HERE, AND ONLY HERE.
     *
     * The schema can only apply one maximum, so it uses the largest any
     * provenance permits; this narrows it to the correct one. Doing it in the
     * assembler is the whole point of the correction: a caller that trimmed to
     * fit before calling would hand over an already-shortened value, and this
     * boundary would have no way to know something was lost.
     *
     * A TASK_DESCRIPTION over its bound is CRITICAL, so it fails the assembly
     * rather than being shortened - the model must not be asked to plan against
     * a request it was only shown part of.
     */
    const limit = fieldLimitFor(parsed.data.provenance);
    if (parsed.data.text.length > limit) {
      return fail(
        parsed.data.provenance === "TASK_DESCRIPTION"
          ? "task_description_invalid"
          : "invalid_record",
        `a ${parsed.data.provenance} record is ${String(parsed.data.text.length)} ` +
        `characters, over its ${String(limit)}-character bound; assembly refused ` +
        "rather than shortening it",
        parsed.data.provenance,
      );
    }

    validated.push(parsed.data);
  }

  // ---- 2. refuse credential-shaped values -------------------------------
  for (const record of validated) {
    if (looksLikeSecret(record.text)) {
      /**
       * REFUSED, NOT REDACTED.
       *
       * Redacting and forwarding would mean deciding a partially-scrubbed
       * secret is safe to send to a third party, which is not a call this layer
       * should be making. The value is not echoed anywhere - not into the
       * message, not into an event, not into a log.
       */
      return fail(
        "sensitive_content_refused",
        "a context record appeared to contain a credential and was refused; " +
        "its value has deliberately not been recorded anywhere",
        record.provenance,
      );
    }
  }

  // ---- 3. deterministic ordering ----------------------------------------
  /**
   * By authority rank, then by key, then by text. Never by insertion order and
   * never by whatever `readdirSync` happened to return - the project store
   * lists decisions and implementations straight off the filesystem, and that
   * order is not stable across machines.
   *
   * ORDERING COMES BEFORE DEDUPLICATION, and the sequence matters. Deduplicating
   * first keeps whichever copy arrived earliest, which is a property of the
   * CALLER rather than of the data - so the same facts supplied in a different
   * order would keep a different record and produce a different prompt. Sorting
   * first makes the survivor the lowest-sorting one, every time.
   */
  const ordered = [...validated].sort((a, b) => {
    const rank = PROVENANCE_RANK[b.provenance] - PROVENANCE_RANK[a.provenance];
    if (rank !== 0) return rank;
    const key = a.key.localeCompare(b.key);
    if (key !== 0) return key;
    return a.text.localeCompare(b.text);
  });

  // ---- 4. deduplicate, WITHIN a provenance only -------------------------
  /**
   * A human decision saying "use PostgreSQL" and an agent claim saying the same
   * words are NOT the same record. Collapsing them would silently promote the
   * claim to the decision's authority, or lose the decision entirely depending
   * on which survived. So the dedup key includes the provenance.
   */
  const seen = new Set<string>();
  const deduplicated: TContextRecord[] = [];
  for (const record of ordered) {
    // NUL as the separator, written as an escape so the source stays plain
    // text - a raw NUL byte makes git treat the file as binary. It is also
    // the right separator: it cannot occur in a provenance or in text, so
    // two different records cannot collide into one identity.
    const identity = `${record.provenance}\u0000${record.text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduplicated.push(record);
  }

  // ---- 5. bound, dropping only non-critical material --------------------
  const kept: TContextRecord[] = [];
  const warnings: string[] = [];
  const droppedByProvenance = new Map<ContextProvenance, number>();
  const perProvenanceCount = new Map<ContextProvenance, number>();
  let totalChars = 0;

  const perProvenanceCap = (provenance: ContextProvenance): number => {
    switch (provenance) {
      case "PROJECT_METADATA": return CONTEXT_LIMITS.maxProjectMetadata;
      case "HUMAN_DECISION": return CONTEXT_LIMITS.maxHumanDecisions;
      case "HUMAN_CONSTRAINT": return CONTEXT_LIMITS.maxHumanConstraints;
      case "REPOSITORY_OBSERVATION": return CONTEXT_LIMITS.maxRepositoryObservations;
      case "HISTORICAL_AGENT_CLAIM": return CONTEXT_LIMITS.maxHistoricalAgentClaims;
      case "TASK_DESCRIPTION": return CONTEXT_LIMITS.maxRecords;
    }
  };

  const drop = (record: TContextRecord): void => {
    droppedByProvenance.set(
      record.provenance, (droppedByProvenance.get(record.provenance) ?? 0) + 1,
    );
  };

  for (const record of deduplicated) {
    const cost = record.text.length + record.key.length
      + PROVENANCE_LABEL[record.provenance].length;
    const count = perProvenanceCount.get(record.provenance) ?? 0;

    const overCount = count >= perProvenanceCap(record.provenance);
    const overTotal = totalChars + cost > CONTEXT_LIMITS.maxTotalChars;
    const overRecords = kept.length >= CONTEXT_LIMITS.maxRecords;

    if (overCount || overTotal || overRecords) {
      /**
       * A CRITICAL RECORD THAT WILL NOT FIT FAILS THE WHOLE ASSEMBLY.
       *
       * Because it is ordered first, reaching this branch with a human decision
       * or constraint means the bounds genuinely cannot hold what a human said -
       * and the honest response is to refuse, not to hand the model a context
       * that looks complete with a constraint quietly missing from it.
       */
      if (isCritical(record.provenance)) {
        return fail(
          "critical_context_too_large",
          `critical ${record.provenance} context does not fit within the ` +
          "configured bounds; assembly refused rather than dropping it",
          record.provenance,
        );
      }
      drop(record);
      continue;
    }

    kept.push(record);
    perProvenanceCount.set(record.provenance, count + 1);
    totalChars += cost;
  }

  for (const [provenance, count] of [...droppedByProvenance.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))) {
    warnings.push(
      `${count} ${provenance} record(s) were omitted to stay within the context ` +
      "bounds. This context is INCOMPLETE for that category.",
    );
  }

  return {
    ok: true,
    context: AssembledContext.parse({
      records: kept,
      truncated: warnings.length > 0,
      warnings: warnings.slice(0, CONTEXT_LIMITS.maxWarnings),
      totalChars,
      assembledAt: now().toISOString(),
    }),
  };
}

/**
 * Report where records of different authority disagree.
 *
 * NOT a resolver. It does not pick a winner and it does not remove anything -
 * both records stay in the context with their labels intact. Its whole purpose
 * is to make a conflict visible to the human at the gate, so that the question
 * "which of these wins?" is never one the MODEL gets to answer.
 *
 * The heuristic is deliberately crude: shared significant words between a
 * high-authority record and a low-authority one. It over-reports rather than
 * under-reports, because a missed conflict is worse than a noisy one.
 */
export function detectAuthorityConflicts(
  context: TAssembledContext,
): { higher: TContextRecord; lower: TContextRecord; sharedTerms: string[] }[] {
  /**
   * Crude stemming, deliberately.
   *
   * "changes" and "changed" are the same idea, and a conflict detector that
   * misses them over an inflected ending is worse than useless - it reports
   * safety it has not established. Trimming a few common suffixes over-reports
   * rather than under-reports, which is the right direction for something whose
   * only job is to make a human look twice.
   */
  const stem = (word: string): string => word.replace(/(ing|ed|es|s)$/, "");

  const significant = (text: string): Set<string> =>
    new Set(
      text.toLowerCase().split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 5)
        .map(stem)
        .filter((word) => word.length >= 4),
    );

  const conflicts: { higher: TContextRecord; lower: TContextRecord; sharedTerms: string[] }[] = [];
  const authoritative = context.records.filter(
    (r) => r.provenance === "HUMAN_DECISION" || r.provenance === "HUMAN_CONSTRAINT",
  );
  const subordinate = context.records.filter(
    (r) => PROVENANCE_RANK[r.provenance] < PROVENANCE_RANK.REPOSITORY_OBSERVATION,
  );

  for (const higher of authoritative) {
    const terms = significant(higher.text);
    for (const lower of subordinate) {
      const shared = [...significant(lower.text)].filter((word) => terms.has(word));
      if (shared.length >= 2) {
        conflicts.push({ higher, lower, sharedTerms: shared.sort().slice(0, 8) });
      }
    }
  }
  return conflicts;
}

/**
 * Re-exported so existing callers keep one import site.
 *
 * The implementation is in security/secretShapes.ts; this is a name, not a
 * second copy.
 */
export { looksLikeSecret };
