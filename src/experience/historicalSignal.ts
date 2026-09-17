import crypto from "node:crypto";
import {
  HistoricalSignal, HISTORICAL_SIGNAL_LIMITS,
  type HistoricalSignal as THistoricalSignal,
  type HistoricalItem as THistoricalItem,
  type OmissionReason,
} from "../domain/historicalSignal.js";
import type { EvaluationStopReason } from "../domain/experienceEvaluation.js";
import type { ExperienceStore } from "./experienceStore.js";
import { ExperienceRetrieval } from "./experienceRetrieval.js";
import { ExperienceEvaluator } from "./experienceEvaluator.js";

/**
 * THE HISTORICAL SIGNAL BUILDER
 *
 * Composes Task 010 and Task 011 into the one thing the reasoning layer is
 * allowed to receive from learning. It adds no retrieval logic and no
 * evaluation logic of its own - it calls the existing services, applies the
 * selection policy in `domain/historicalSignal.ts`, and projects the result.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL CHOOSES NOTHING HERE
 * ---------------------------------------------------------------------------
 * Which experiences are retrieved is decided by deterministic lexical
 * relevance. Which are presented is decided by whether independent evidence
 * exists. Which order they appear in is decided by a documented total order.
 * No step consults a model, and there is no interface through which one could
 * ask for a different memory.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT REACH THE FILESYSTEM
 * ---------------------------------------------------------------------------
 * No filesystem or path import - a test asserts their absence by name. Every
 * record arrives through the store, retrieval and evaluator, so Task 009's
 * integrity, identity and ownership checks apply without being reimplemented.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS A STATE, NOT AN EMPTY LIST
 * ---------------------------------------------------------------------------
 * A store that cannot be read, or a retrieval that fails, produces
 * `unavailable` with a reason. The workflow then reasons WITHOUT historical
 * adaptation - exactly the path that existed before Task 012 - and the summary
 * says so. It never produces `none`, because "we could not look" and "we
 * looked and there was nothing" lead a human to opposite conclusions.
 */
export class HistoricalSignalBuilder {
  readonly #retrieval: ExperienceRetrieval;
  readonly #evaluator: ExperienceEvaluator;

  constructor(store: ExperienceStore) {
    this.#retrieval = new ExperienceRetrieval(store);
    this.#evaluator = new ExperienceEvaluator(store);
  }

  /**
   * Build the signal for one project and one task.
   *
   * `projectId` is the only project this will ever touch: retrieval and
   * evaluation are both project-scoped by construction and neither has an
   * interface that accepts a second project or omits the first.
   */
  build(projectId: string, request: string): THistoricalSignal {
    /**
     * The QUERY is derived from the request and bounded. This is not a
     * truncation of the task the model sees - the task description reaches the
     * assembler complete, through its own path - it is the retrieval key, and
     * the tokenizer keeps at most 32 terms of it regardless.
     */
    const query = request.slice(0, HISTORICAL_SIGNAL_LIMITS.maxQueryChars);

    let retrieved;
    try {
      retrieved = this.#retrieval.retrieve({
        projectId, query, limit: HISTORICAL_SIGNAL_LIMITS.maxRetrieved,
      });
    } catch {
      return HistoricalSignal.parse({ kind: "unavailable", reason: "retrieval_failed" });
    }
    if (!retrieved.ok) {
      // A malformed query - whitespace, nothing tokenizable - is not a storage
      // problem, but it is still "could not look", and it must not read as
      // "nothing there".
      return HistoricalSignal.parse({
        kind: "unavailable",
        reason: retrieved.failure.code === "storage_failure"
          ? "storage_failed"
          : "retrieval_failed",
      });
    }

    const outcome = retrieved.retrieval;
    const retrievalBounded = outcome.coverage.kind === "bounded";
    const retrievalStop = outcome.coverage.kind === "bounded" ? outcome.coverage.reason : null;

    if (outcome.results.length === 0) {
      return HistoricalSignal.parse({ kind: "none", retrievalBounded, retrievalStop });
    }

    const omitted: Partial<Record<OmissionReason, number>> = {};
    const omit = (reason: OmissionReason): void => {
      omitted[reason] = (omitted[reason] ?? 0) + 1;
    };

    const items: THistoricalItem[] = [];
    const evaluationStops: EvaluationStopReason[] = [];
    const rendered = new Set<string>();
    let evaluated = 0;
    let totalChars = 0;

    /**
     * RETRIEVAL ORDER IS PRESENTATION ORDER.
     *
     * Task 010 already defines a total order - relevance DESC, createdAt DESC,
     * id ASC - with no dependence on filesystem, insertion, locale or clock.
     * Reusing it keeps "why is this item here" answerable in one place, and
     * means the same corpus and the same request yield the same context.
     */
    for (const candidate of outcome.results) {
      if (evaluated >= HISTORICAL_SIGNAL_LIMITS.maxEvaluated) {
        omit("evaluation_limit");
        continue;
      }
      evaluated += 1;

      let evaluation;
      try {
        evaluation = this.#evaluator.evaluate({ projectId, experienceId: candidate.id });
      } catch {
        omit("evaluation_failed");
        continue;
      }
      if (!evaluation.ok) {
        // A storage failure mid-way is not one bad candidate; the history can
        // no longer be trusted to have been read, so the whole signal is
        // unavailable rather than a shorter list that looks complete.
        if (evaluation.failure.code === "storage_failure") {
          return HistoricalSignal.parse({ kind: "unavailable", reason: "storage_failed" });
        }
        omit("evaluation_failed");
        continue;
      }
      const artifact = evaluation.evaluation;

      // THE SELECTION POLICY. Structural, not numeric: present only what
      // independent evidence actually spoke to. See SELECTION_POLICY.
      if (artifact.confidence.kind !== "assessed") {
        omit("insufficient_evidence");
        continue;
      }
      if (items.length >= HISTORICAL_SIGNAL_LIMITS.maxPresented) {
        omit("presentation_limit");
        continue;
      }

      /**
       * NO TEXT FROM THE RECORD CROSSES HERE. `artifact.pattern.approaches` and
       * `artifact.pattern.taskType` are available on the evaluation artifact -
       * Task 011 needs them - and are deliberately not read into the item. The
       * two identifiers are digests: content-derived, stable, and incapable of
       * carrying a sentence. See the header of domain/historicalSignal.ts for
       * why an admissible record is not thereby a safe one.
       */
      const item: THistoricalItem = {
        experienceId: candidate.id,
        taskTypeKey: crypto.createHash("sha256")
          .update(artifact.pattern.taskType, "utf8").digest("hex").slice(0, 16),
        patternKey: artifact.recurrence.key,
        status: artifact.status,
        confidence: artifact.confidence.score,
        supporting: artifact.recurrence.supporting,
        contradicting: artifact.recurrence.contradicting,
        inadmissible: artifact.recurrence.inadmissible,
        evaluationBounded: artifact.coverage.kind === "bounded",
      };

      // The size an item will occupy is decided by the SAME renderer the
      // context source uses, so the builder's budget and the text the model
      // sees cannot disagree.
      const text = renderHistoricalItem(item);
      const chars = text.length;
      if (chars > HISTORICAL_SIGNAL_LIMITS.maxItemChars
        || totalChars + chars > HISTORICAL_SIGNAL_LIMITS.maxTotalChars) {
        omit("size_limit");
        continue;
      }

      // Same pattern, same evaluation, same words: one fact, not several. The
      // first in retrieval order is the one kept, which keeps this
      // deterministic. See OmissionReason.duplicate for why the builder does
      // this rather than leaving it to the assembler.
      if (rendered.has(text)) {
        omit("duplicate");
        continue;
      }
      rendered.add(text);

      items.push(item);
      totalChars += chars;
      if (artifact.coverage.kind === "bounded") evaluationStops.push(artifact.coverage.reason);
    }

    return HistoricalSignal.parse({
      kind: "present",
      items,
      retrieved: outcome.results.length,
      evaluated,
      omitted,
      retrievalBounded,
      retrievalStop,
      evaluationsBounded: evaluationStops.length,
      evaluationStops,
      totalChars,
    });
  }
}

/**
 * THE TEXT THE MODEL SEES FOR ONE ITEM.
 *
 * ---------------------------------------------------------------------------
 * EVIDENCE, NOT INSTRUCTION
 * ---------------------------------------------------------------------------
 * Every sentence reports what was recorded and what the evaluator found. None
 * says "do this", "prefer this", "this is safe" or "skip that". The closing
 * sentence is not decoration: it is the one place the text itself says what it
 * is for, so a model that ignored the provenance label would still be told.
 *
 * Deterministic: a pure function of the item, no clock, no locale.
 */
export function renderHistoricalItem(item: THistoricalItem): string {
  const verdict = item.confidence === null
    ? `evaluated status ${item.status}`
    : `evaluated status ${item.status}, confidence ${String(item.confidence)}/100 ` +
      "under the documented policy";
  const backing = item.inadmissible > 0
    ? ` A further ${String(item.inadmissible)} record(s) reported an outcome with no ` +
      "independent backing and were not counted."
    : "";
  const coverage = item.evaluationBounded
    ? " The evaluation examined a BOUNDED part of the project's history, not all of it."
    : "";

  // Every interpolated value below is a number, an enum member, or a hex
  // digest. There is no free text to escape because there is no free text.
  return (
    `Earlier work in this project on task-type ${item.taskTypeKey} recorded ` +
    `pattern ${item.patternKey}. ` +
    `Independent evidence: ${String(item.supporting)} supporting, ` +
    `${String(item.contradicting)} contradicting; ${verdict}.${backing}${coverage} ` +
    // No word here is one a model could lift as a permission - not "approved",
    // not "safe", not "should" - even in the negative. A test scans for them.
    "This is historical project experience: it describes what happened before, " +
    "and it is not a permission, an instruction or a requirement for now."
  );
}
