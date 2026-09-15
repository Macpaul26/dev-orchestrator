import crypto from "node:crypto";
import {
  type EpisodicExperience as TEpisodicExperience,
} from "../domain/experience.js";
import {
  EvaluationRequest, EvaluationArtifact, EvaluationFailure, EVALUATION_LIMITS,
  type EvaluationArtifact as TEvaluationArtifact,
  type EvaluationFailure as TEvaluationFailure,
  type EvaluationCoverage as TEvaluationCoverage,
  type ConfidenceAssessment as TConfidenceAssessment,
  type EvaluationStatus as TEvaluationStatus,
  type EvaluationStopReason,
} from "../domain/experienceEvaluation.js";
import { type ExperienceDefect as TExperienceDefect } from "../domain/experienceStorage.js";
import type { ExperienceStore } from "./experienceStore.js";

/**
 * THE EXPERIENCE EVALUATOR
 *
 * Given one stored experience, assess how strongly the rest of that project's
 * history supports relying on the pattern it describes.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL DOES NOT EVALUATE ITS OWN MEMORY
 * ---------------------------------------------------------------------------
 * There is no model call here, and there must never be one. Asking the
 * untrusted component whether its own recorded history is trustworthy is the
 * system handing its evidence standard to the thing the standard exists to
 * check. Every number below comes from counting records under a documented
 * policy.
 *
 *     MODEL  ->  PROPOSAL
 *     MODEL  -/->  EVALUATION AUTHORITY
 *     MODEL  -/->  MEMORY TRUST
 *
 * ---------------------------------------------------------------------------
 * CONFIDENCE IS NOT AUTHORITY
 * ---------------------------------------------------------------------------
 * A score of 100 authorises nothing. It does not approve a plan, grant a
 * capability, widen a scope, lower a risk classification or skip a check. It
 * says that the bounded historical evaluation found consistent corroboration -
 * which is a statement about the past, not a permission for the future.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT REACH THE FILESYSTEM
 * ---------------------------------------------------------------------------
 * This module imports no filesystem or path module. Every record arrives
 * through `ExperienceStore`, so Task 009's integrity, identity and
 * project-ownership checks apply to evaluation without being reimplemented,
 * and there is no second storage authority to keep consistent. A test asserts
 * those imports are absent by name; this comment names none of them so that the
 * scan does not match its own explanation.
 */

/**
 * NORMALIZE ONE PATTERN STRING.
 *
 * NFKC first, so compatibility forms collapse onto their ordinary equivalents.
 * Then `toLowerCase` - NOT the locale-aware variant, which maps "I" differently
 * under a Turkish locale and would make the same corpus produce different
 * recurrence groupings on different machines. Task 010 shipped exactly that
 * defect in its comparator and it took independent review to catch; the rule
 * here is the same one, applied before the mistake.
 *
 * Runs of anything that is not a letter or a number collapse to a single space,
 * so punctuation and spacing differences do not split a recurring pattern into
 * two.
 */
function normalizePattern(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, EVALUATION_LIMITS.maxPatternChars);
}

/** Code-unit ordering. Never locale collation - see `normalizePattern`. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * THE APPROACHES ONE RECORD DESCRIBES.
 *
 * Both pattern lists, together. A record that SUCCEEDED with approach X and one
 * that FAILED with approach X are describing the same approach and belong in
 * the same recurrence cohort - which list they put it in is the OUTCOME, and
 * that is read separately by `relate`. Merging the lists here is what makes
 * "this worked" and "this did not work" comparable instead of invisible to each
 * other.
 */
function approachesOf(record: TEpisodicExperience): string[] {
  const seen = new Set<string>();
  for (const raw of [...record.successfulPatterns, ...record.failedPatterns]) {
    if (seen.size >= EVALUATION_LIMITS.maxPatternItems) break;
    const normalized = normalizePattern(raw);
    if (normalized.length === 0) continue;
    seen.add(normalized);
  }
  return [...seen].sort(byCodeUnit);
}

/**
 * THE RECURRENCE IDENTITY.
 *
 * ---------------------------------------------------------------------------
 * AN EXPLICIT PROJECTION, NOT A SERIALIZATION
 * ---------------------------------------------------------------------------
 * Two experiences recur when they describe the SAME APPROACH TO THE SAME KIND
 * OF TASK. Serializing the record would defeat that entirely: `runId`,
 * `createdAt` and the evidence references differ on every single record, so
 * every experience would be unique and recurrence would always be zero. The
 * failure mode is silent - the evaluator would keep working and simply never
 * find a pattern.
 *
 * INCLUDED: the normalized task type, and the normalized, de-duplicated, sorted
 * set of approaches.
 *
 * THIS KEY IDENTIFIES THE PATTERN BEING EVALUATED. It is deliberately NOT the
 * cohort membership test - see `evaluate`. An earlier version used key equality
 * to select the cohort, which meant a record that tried TWO approaches could
 * never corroborate or contradict one that tried a single approach, because
 * their approach sets differed. Contradiction detection quietly stopped working
 * in exactly the case it mattered most: a run that tried the same thing among
 * others and found it failed. Caught by its own test.
 *
 * EXCLUDED, and each for a reason:
 *
 *   runId, createdAt      unique per record by construction.
 *   projectId             constant within an evaluation; it is the boundary,
 *                         not a discriminator.
 *   evidence[].ref        pointers to other artifacts, unique per run.
 *   the outcome summaries free narrative. Two runs describing the same approach
 *                         in different words are the same approach, and letting
 *                         prose into the identity would split them.
 *   sources, status       PROVENANCE AND OUTCOME LABELS. Putting them in the
 *                         identity would mean a human-decided record and an
 *                         agent-claimed record could never corroborate each
 *                         other - and would quietly make provenance part of
 *                         what recurrence means. See the note on `relate`.
 */
export function recurrenceKey(taskType: string, approaches: readonly string[]): string {
  // Normalized and sorted HERE rather than trusted from the caller. Requiring
  // pre-normalized input would make the key silently depend on whether someone
  // remembered to normalize, which is the kind of footgun that produces two
  // keys for one pattern and a recurrence count of zero.
  const normalized = [...new Set(approaches.map(normalizePattern))]
    .filter((value) => value.length > 0)
    .sort(byCodeUnit);
  const canonical = JSON.stringify([normalizePattern(taskType), normalized]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

/**
 * IS THIS RECORD COMPARABLE TO THE SUBJECT?
 *
 * Same kind of task. That is the population an evaluation is entitled to reason
 * over - runs of the same task type are the ones whose outcomes are about the
 * same problem. Whether a comparable record has anything to SAY about the
 * subject's approaches is a separate question, answered by `relate`, and
 * keeping the two apart is what lets the artifact report how many comparable
 * runs were silent on the matter.
 */
function comparable(record: TEpisodicExperience, taskType: string): boolean {
  return normalizePattern(record.taskType) === taskType;
}

/**
 * HOW ONE COHORT RECORD RELATES TO THE SUBJECT'S APPROACHES.
 *
 * A record contradicts if it lists ANY of the subject's approaches among what
 * failed; it supports if it lists any among what succeeded and contradicts
 * none. Contradiction is checked first on purpose - a record reporting that an
 * approach failed is evidence against relying on it, and letting a partial
 * success elsewhere in the same record cancel that out would hide the finding.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE IS DELIBERATELY NOT CONSULTED
 * ---------------------------------------------------------------------------
 * `sources` plays no part in this classification, and that is a decision rather
 * than an omission. A rule like "HUMAN_DECISION corroborates more strongly"
 * would rebuild an authority ladder inside the evaluator - the exact structure
 * the learning architecture keeps out of the trust path - and it would do so
 * where it is hardest to see, behind a number. A record's provenance travels
 * with the record for a human to weigh; it does not silently weight a score.
 */
function relate(
  record: TEpisodicExperience, approaches: ReadonlySet<string>,
): "supporting" | "contradicting" | "neutral" {
  let supports = false;
  for (const raw of record.failedPatterns) {
    if (approaches.has(normalizePattern(raw))) return "contradicting";
  }
  for (const raw of record.successfulPatterns) {
    if (approaches.has(normalizePattern(raw))) supports = true;
  }
  return supports ? "supporting" : "neutral";
}

/**
 * THE CONFIDENCE POLICY.
 *
 *     n            = supporting + contradicting          (records that voted)
 *     consistency  = floor(100 * supporting / n)         how one-sided they are
 *     volume       = floor(100 * min(n, V) / V)          how much evidence there is
 *     raw          = floor(consistency * volume / 100)
 *     score        = complete ? raw : floor(raw * W / 100)
 *
 * with V = `volumeSaturation` and W = `boundedCoverageWeight`.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO FACTORS RATHER THAN A COUNT
 * ---------------------------------------------------------------------------
 * Counting occurrences and calling that confidence is the mistake this design
 * exists to avoid: it makes a pattern more trusted for being repeated, whatever
 * the outcomes were. Consistency answers "did it work when we tried it?" and
 * volume answers "how many times did we try?", and BOTH have to be high for the
 * score to be. Four successes and four failures is fifty, not eighty - the same
 * eight records that a pure count would have treated as strong evidence.
 *
 * Volume saturates, so a thousand repetitions of the same run score no higher
 * than a handful. A pattern is not more reliable for having been recorded more
 * often by the same process.
 *
 * Integer arithmetic throughout: no floating-point accumulation, so identical
 * inputs produce a bit-identical score on any machine. Zero voters produces NO
 * SCORE, not a zero - see `ConfidenceAssessment`.
 */
function assess(
  supporting: number, contradicting: number, complete: boolean,
): TConfidenceAssessment {
  const n = supporting + contradicting;
  if (n === 0) return { kind: "insufficient_evidence" };

  const consistency = Math.floor((100 * supporting) / n);
  const volume = Math.floor(
    (100 * Math.min(n, EVALUATION_LIMITS.volumeSaturation))
    / EVALUATION_LIMITS.volumeSaturation,
  );
  const raw = Math.floor((consistency * volume) / 100);

  // A bounded scan cannot support the claim a complete one would.
  const score = complete
    ? raw
    : Math.floor((raw * EVALUATION_LIMITS.boundedCoverageWeight) / 100);
  return { kind: "assessed", score };
}

function statusFor(confidence: TConfidenceAssessment): TEvaluationStatus {
  if (confidence.kind === "insufficient_evidence") return "insufficient_evidence";
  if (confidence.score >= EVALUATION_LIMITS.supportedAtOrAbove) return "supported";
  if (confidence.score <= EVALUATION_LIMITS.contradictedAtOrBelow) return "contradicted";
  return "uncertain";
}

export type EvaluationResult =
  | { ok: true; evaluation: TEvaluationArtifact }
  | { ok: false; failure: TEvaluationFailure };

export class ExperienceEvaluator {
  readonly #store: ExperienceStore;

  /**
   * Constructed OVER a store, never beside one.
   *
   * It holds no root, no path and no directory - only the store - so there is
   * no location it can reach that the store does not govern, and no second
   * storage authority for the two to disagree about.
   */
  constructor(store: ExperienceStore) {
    this.#store = store;
  }

  /**
   * Evaluate one stored experience against the rest of its project's history.
   *
   * Fails closed: a malformed request, a missing subject, a defective subject,
   * or a storage error each produce a typed failure. A storage problem is NEVER
   * reported as "insufficient evidence" - "we could not read the history" and
   * "the history says nothing" lead a caller to opposite conclusions.
   */
  evaluate(request: unknown): EvaluationResult {
    const fail = (
      code: TEvaluationFailure["code"], message: string,
    ): EvaluationResult => ({
      ok: false, failure: EvaluationFailure.parse({ code, message }),
    });

    const parsed = EvaluationRequest.safeParse(request);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      if (field === "projectId") {
        return fail("invalid_project_id",
          "the project id is not a valid kebab-case identifier");
      }
      return fail("invalid_request",
        "the evaluation request did not validate against the request schema");
    }
    const { projectId, experienceId } = parsed.data;

    /**
     * The subject comes from the store, so it has already passed integrity,
     * identity and project-ownership checking. A caller cannot supply a record
     * of its own devising to be evaluated, which is why there is no shape here
     * for one.
     */
    let subject;
    try {
      subject = this.#store.read(projectId, experienceId);
    } catch {
      return fail("storage_failure", "the experience could not be read");
    }
    if (!subject.ok) {
      if ("defect" in subject) {
        return fail("subject_defective",
          "the experience was refused on read and cannot be evaluated");
      }
      if ("indeterminate" in subject) {
        // Absence was not established, so "missing" would be a claim the store
        // did not support.
        return fail("storage_failure",
          "the project could not be enumerated well enough to locate the experience");
      }
      return fail("subject_missing", "no such experience in this project");
    }

    const record = subject.stored.record;
    const approaches = approachesOf(record);
    const approachSet = new Set(approaches);
    const taskType = normalizePattern(record.taskType);
    const key = recurrenceKey(record.taskType, approaches);

    let supporting = 0;
    let contradicting = 0;
    let neutral = 0;
    let cohort = 0;
    let examined = 0;
    let comparisons = 0;
    const rejected: TExperienceDefect[] = [];
    let stopped: EvaluationStopReason | null = null;
    let cursor: string | undefined;
    let pages = 0;

    /**
     * COHORT COLLECTION, THROUGH THE STORE AND NOTHING ELSE.
     *
     * `list` is project-scoped, so cross-project contamination is not something
     * this loop has to defend against - it is unreachable from here. Three
     * independent stops, because one bound expressed three ways is one bound.
     */
    for (;;) {
      if (pages >= EVALUATION_LIMITS.maxCandidatePages) {
        stopped = "page_limit";
        break;
      }

      let page;
      try {
        page = this.#store.list(projectId, cursor === undefined ? {} : { after: cursor });
      } catch {
        return fail("storage_failure", "the project's experience could not be read");
      }
      pages += 1;

      for (const defect of page.defects) {
        // A record the store refused is not weak evidence, it is NOT EVIDENCE.
        // It cannot support, cannot contradict, and cannot enter a count.
        if (rejected.length < EVALUATION_LIMITS.maxReportedDefects) rejected.push(defect);
      }

      for (const stored of page.records) {
        if (examined >= EVALUATION_LIMITS.maxCandidateRecords) {
          stopped = "candidate_limit";
          break;
        }
        if (comparisons >= EVALUATION_LIMITS.maxComparisons) {
          stopped = "work_limit";
          break;
        }
        examined += 1;
        comparisons += 1;

        // An experience is not evidence for itself. Without this, one record
        // would corroborate its own pattern and reach the same score as a
        // genuinely repeated one.
        if (stored.id === experienceId) continue;

        if (!comparable(stored.record, taskType)) continue;

        cohort += 1;
        const relation = relate(stored.record, approachSet);
        if (relation === "supporting") {
          if (supporting < EVALUATION_LIMITS.maxCountedRecurrences) supporting += 1;
        } else if (relation === "contradicting") {
          if (contradicting < EVALUATION_LIMITS.maxCountedRecurrences) contradicting += 1;
        } else if (neutral < EVALUATION_LIMITS.maxCountedRecurrences) {
          neutral += 1;
        }
      }
      if (stopped !== null) break;

      if (page.count.kind === "bounded") {
        stopped = "scan_incomplete";
        break;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const coverage: TEvaluationCoverage = stopped === null
      ? { kind: "complete", examined }
      : { kind: "bounded", examined, reason: stopped };

    const confidence = assess(supporting, contradicting, stopped === null);

    return {
      ok: true,
      evaluation: EvaluationArtifact.parse({
        subject: experienceId,
        pattern: { taskType, approaches },
        recurrence: {
          key,
          cohort: Math.min(cohort, EVALUATION_LIMITS.maxCountedRecurrences),
          supporting, contradicting, neutral,
        },
        confidence,
        status: statusFor(confidence),
        coverage,
        rejected,
      }),
    };
  }
}
