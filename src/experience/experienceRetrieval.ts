import {
  type EpisodicExperience as TEpisodicExperience,
} from "../domain/experience.js";
import {
  ExperienceRetrievalRequest, ExperienceRetrievalOutcome, RetrievalFailure,
  RETRIEVAL_LIMITS,
  type ExperienceRetrievalOutcome as TExperienceRetrievalOutcome,
  type RetrievalFailure as TRetrievalFailure,
  type RetrievalCoverage as TRetrievalCoverage,
  type RetrievedExperience as TRetrievedExperience,
  type RetrievalStopReason,
} from "../domain/experienceRetrieval.js";
import { type ExperienceDefect as TExperienceDefect } from "../domain/experienceStorage.js";
import type { ExperienceStore } from "./experienceStore.js";

/**
 * EXPERIENCE RETRIEVAL
 *
 * Given a task and a project, find a small, deterministic, relevant subset of
 * that project's prior experience.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * No numeric-similarity index, no nearest-neighbour database, no external
 * search service, and NO MODEL CALL. A model deciding which memories are worth
 * trusting would be the system asking the untrusted component to select its own
 * evidence, so retrieval is a plain deterministic function of the query and the
 * stored text.
 *
 * It also does not evaluate, score confidence, count recurrence, promote a
 * record to a lesson, write anything, or reach a reasoning prompt. Those are
 * Tasks 011 and 012, separately scoped because each can go wrong differently.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT TOUCH THE FILESYSTEM
 * ---------------------------------------------------------------------------
 * This module imports no filesystem or path module at all. Every candidate
 * arrives through `ExperienceStore`, so Task 009's integrity checking, identity
 * checking, project-ownership checking and bounds all apply to retrieval
 * without being reimplemented - and a corrupt record cannot reach a caller by
 * coming in through a side door. A test asserts those imports are absent by
 * name, because "we chose not to" is worth less than "it is not reachable from
 * here". The test scans for literal module specifiers, so this comment names
 * none of them.
 *
 * ---------------------------------------------------------------------------
 * RELEVANCE IS NOT CONFIDENCE
 * ---------------------------------------------------------------------------
 * A high score means the record matched the query well. It does not mean the
 * record is true, and this layer produces no value that could be mistaken for
 * saying it is.
 */

/**
 * THE SEARCHABLE PROJECTION.
 *
 * An explicit, ordered list of fields - never `JSON.stringify(record)`, which
 * would drag identifiers, timestamps, provenance labels and evidence pointers
 * into the match space and make the ranking depend on things that are not
 * about the task at all.
 *
 * WHAT IS SEARCHED, and why each earns its place: the task label and the four
 * outcome summaries describe what happened, and the four pattern and failure
 * lists describe what was learned. That is the material a "have we done this
 * before?" question is actually asking about.
 *
 * WHAT IS NOT SEARCHED, and why:
 *
 *   projectId, runId    identifiers. `projectId` is constant within a search
 *                       and `runId` is noise that would let a query mentioning
 *                       a run id outrank a query about the work.
 *   createdAt           a timestamp is not text about a task.
 *   evidence[].ref      POINTERS - commit shas, check ids, and shapes that can
 *                       look like paths. Searching them would make record
 *                       ranking depend on identifier fragments, and it is the
 *                       one field the domain describes as path-like.
 *   sources, status     PROVENANCE AND AUTHORITY LABELS. Searching them would
 *                       let a query containing "HUMAN_DECISION" rank records
 *                       higher for carrying an authority label - authority
 *                       semantics leaking into relevance, which is precisely
 *                       the confusion this layer exists to avoid.
 *   scope, layer        constants. They discriminate nothing.
 */
function searchableText(record: TEpisodicExperience): string {
  const field = (value: string): string =>
    value.slice(0, RETRIEVAL_LIMITS.maxFieldChars);
  const list = (values: readonly string[]): string =>
    values.slice(0, RETRIEVAL_LIMITS.maxFieldItems).map(field).join(" ");

  // Fixed order, so the projection is a pure function of the record.
  return [
    field(record.taskType),
    field(record.planSummary),
    field(record.implementationOutcome),
    field(record.verificationOutcome),
    field(record.reviewOutcome),
    list(record.failures),
    list(record.corrections),
    list(record.successfulPatterns),
    list(record.failedPatterns),
  ].join(" ").slice(0, RETRIEVAL_LIMITS.maxSearchableChars);
}

/**
 * THE TOKENIZER. Documented because determinism is the whole claim.
 *
 *   1. NFKC normalization, so compatibility forms - fullwidth Latin, ligatures,
 *      non-breaking spaces - collapse onto their ordinary equivalents and the
 *      same word written two ways matches itself.
 *   2. `toLowerCase`, NOT `toLocaleLowerCase`. The locale-aware version maps
 *      "I" differently under a Turkish locale, so an identical query would
 *      tokenize differently on two machines. Determinism outranks linguistic
 *      correctness here.
 *   3. Split on anything that is not a Unicode letter or number. Scripts
 *      without word separators - Chinese, Japanese - therefore yield one long
 *      token rather than words; that is a documented limitation, not a bug
 *      hiding as one.
 *   4. Terms of one character are dropped: they match nearly everything and
 *      contribute noise rather than relevance.
 *   5. Each term is truncated, the list is de-duplicated in first-seen order,
 *      and the count is capped.
 *
 * A query containing "../../etc/passwd" tokenizes to "etc" and "passwd". There
 * is nothing for traversal to act on: this text is compared against strings and
 * is never used to build a path, because this module cannot open a file.
 */
export function tokenize(text: string, maxTerms: number): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (terms.length >= maxTerms) break;
    if (raw.length < 2) continue;
    const term = raw.slice(0, RETRIEVAL_LIMITS.maxTermChars);
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/** Occurrence counts for one record's searchable text. Bounded. */
function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const normalized = text.normalize("NFKC").toLowerCase();

  for (const raw of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const term = raw.slice(0, RETRIEVAL_LIMITS.maxTermChars);
    const current = counts.get(term);
    if (current === undefined) {
      // Bounded index: a pathological record cannot make one comparison
      // arbitrarily expensive by carrying arbitrarily many distinct words.
      if (counts.size >= RETRIEVAL_LIMITS.maxRecordTerms) continue;
      counts.set(term, 1);
      continue;
    }
    if (current < RETRIEVAL_LIMITS.maxTermHits) counts.set(term, current + 1);
  }
  return counts;
}

/**
 * THE RANKING POLICY.
 *
 *     score = 1000 x (distinct query terms found)
 *           +        (capped occurrences of those terms)
 *
 * Coverage dominates frequency on purpose. A record that mentions three of the
 * query's terms once each is a better answer to that query than a record that
 * repeats one term forty times, and a plain frequency sum would rank them the
 * other way round. The frequency term survives as a tiebreak between records
 * with equal coverage.
 *
 * Occurrences are capped at `maxTermHits`, so a record cannot climb the
 * ranking by repetition - which also means a record cannot be crafted to
 * dominate every retrieval by containing one word ten thousand times.
 *
 * Integer arithmetic throughout: no floating-point accumulation, so the same
 * inputs give a bit-identical score on any machine.
 *
 * A score of zero is NOT a weak match; it is no match, and such records never
 * appear in results.
 */
function score(
  queryTerms: readonly string[], counts: Map<string, number>,
): { score: number; matchedTerms: string[] } {
  let hits = 0;
  const matchedTerms: string[] = [];

  for (const term of queryTerms) {
    const occurrences = counts.get(term);
    if (occurrences === undefined) continue;
    matchedTerms.push(term);
    hits += Math.min(occurrences, RETRIEVAL_LIMITS.maxTermHits);
  }
  return { score: matchedTerms.length * 1000 + hits, matchedTerms };
}

/**
 * THE TOTAL ORDERING.
 *
 *     relevance DESC  ->  createdAt DESC  ->  experienceId ASC
 *
 * Every part comes from the record or its content-derived id. Nothing here
 * consults directory order, insertion order, map iteration order, a hash, a
 * random source or the clock, so the same corpus and the same request produce
 * the same ordering on any machine and on any run.
 *
 * The id tiebreak is what makes this TOTAL rather than merely stable: ids are
 * unique, so no two candidates compare equal, and a sort that never sees a tie
 * cannot depend on whether the sort itself is stable.
 *
 * EXPORTED SO IT CAN BE TESTED DIRECTLY, and that is not incidental. Mutation
 * testing showed that deleting the tiebreak entirely left every retrieval test
 * passing: the store hands candidates over in `createdAt DESC, id ASC` order
 * already, so a stable sort reproduces this ordering by accident and no
 * black-box test can tell the two apart. That is exactly the dependence on
 * insertion order the ordering rule exists to remove - unobservable through the
 * public API, and therefore untested until the comparator itself is reachable.
 */
export function compareForOrdering(
  a: { readonly score: number; readonly createdAt: string; readonly id: string },
  b: { readonly score: number; readonly createdAt: string; readonly id: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return a.id.localeCompare(b.id);
}

export type ExperienceRetrievalResult =
  | { ok: true; retrieval: TExperienceRetrievalOutcome }
  | { ok: false; failure: TRetrievalFailure };

/** A scored candidate, before ordering and before the result budget. */
interface Candidate {
  readonly id: string;
  readonly experience: TEpisodicExperience;
  readonly score: number;
  readonly matchedTerms: string[];
}

export class ExperienceRetrieval {
  readonly #store: ExperienceStore;

  /**
   * Retrieval is constructed OVER a store, never beside one.
   *
   * It holds no root, no path and no directory - only the store - so there is
   * no location for it to reach that the store does not already govern.
   */
  constructor(store: ExperienceStore) {
    this.#store = store;
  }

  /**
   * Retrieve the most relevant prior experience for one project.
   *
   * Fails closed on a malformed request and on a storage error. A storage
   * failure is NEVER reported as an empty result: "this project has no matching
   * history" and "the history could not be read" lead a caller to opposite
   * conclusions.
   */
  retrieve(request: unknown): ExperienceRetrievalResult {
    const fail = (
      code: TRetrievalFailure["code"], message: string,
    ): ExperienceRetrievalResult => ({
      ok: false, failure: RetrievalFailure.parse({ code, message }),
    });

    const parsed = ExperienceRetrievalRequest.safeParse(request);
    if (!parsed.success) {
      // Which part failed, without echoing what the caller sent.
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      if (field === "projectId") {
        return fail("invalid_project_id",
          "the project id is not a valid kebab-case identifier");
      }
      if (field === "query") {
        return fail("invalid_query",
          "the query is empty or longer than the retrieval ceiling");
      }
      return fail("invalid_request",
        "the retrieval request did not validate against the request schema");
    }
    const { projectId, query } = parsed.data;
    const limit = Math.min(
      parsed.data.limit ?? RETRIEVAL_LIMITS.maxResults, RETRIEVAL_LIMITS.maxResults,
    );

    const queryTerms = tokenize(query, RETRIEVAL_LIMITS.maxQueryTerms);
    if (queryTerms.length === 0) {
      // Whitespace, punctuation, or single characters only. Nothing to match
      // on, and a query that matches nothing must not be answered with the
      // whole corpus in storage order.
      return fail("invalid_query",
        "the query contains no searchable terms after normalization");
    }

    const candidates: Candidate[] = [];
    const rejected: TExperienceDefect[] = [];
    let examined = 0;
    let operations = 0;
    let stopped: RetrievalStopReason | null = null;
    let cursor: string | undefined;
    let pages = 0;

    /**
     * CANDIDATE ACQUISITION, THROUGH THE STORE AND NOTHING ELSE.
     *
     * Bounded listing is the input mechanism; relevance is decided here. The
     * store's ordering is STORAGE ORDER - newest first - and it determines only
     * which records are examined, never which are returned or in what order.
     * That distinction is the difference between retrieval and pagination.
     *
     * Three independent stops, because one bound expressed three ways is one
     * bound: records examined, pages requested, and comparisons performed.
     */
    for (;;) {
      if (pages >= RETRIEVAL_LIMITS.maxCandidatePages) {
        stopped = "page_limit";
        break;
      }

      let page;
      try {
        page = this.#store.list(projectId, cursor === undefined ? {} : { after: cursor });
      } catch {
        // The message names no path: a storage error should not leak the layout.
        return fail("storage_failure", "the project's experience could not be read");
      }
      pages += 1;

      for (const defect of page.defects) {
        // Refused by Task 009 and never repaired here. A corrupt or tampered
        // record is not a weak candidate, it is not a candidate.
        if (rejected.length < RETRIEVAL_LIMITS.maxResults) rejected.push(defect);
      }

      for (const stored of page.records) {
        if (examined >= RETRIEVAL_LIMITS.maxCandidateRecords) {
          stopped = "candidate_limit";
          break;
        }
        if (operations + queryTerms.length > RETRIEVAL_LIMITS.maxScoringOperations) {
          stopped = "work_limit";
          break;
        }
        examined += 1;
        operations += queryTerms.length;

        const counts = termCounts(searchableText(stored.record));
        const ranked = score(queryTerms, counts);
        if (ranked.score > 0) {
          candidates.push({
            id: stored.id,
            experience: stored.record,
            score: ranked.score,
            matchedTerms: ranked.matchedTerms,
          });
        }
      }
      if (stopped !== null) break;

      /**
       * A page whose directory scan was incomplete means the project could not
       * be enumerated, so no claim of completeness is available regardless of
       * how many records were read.
       */
      if (page.count.kind === "bounded") {
        stopped = "scan_incomplete";
        break;
      }
      if (page.nextCursor === null) break; // Reached the end of the order.
      cursor = page.nextCursor;
    }

    // See `compareForOrdering` for the ordering and why it is exported.
    candidates.sort((a, b) => compareForOrdering(
      { score: a.score, createdAt: a.experience.createdAt, id: a.id },
      { score: b.score, createdAt: b.experience.createdAt, id: b.id },
    ));

    const results: TRetrievedExperience[] = [];
    let bytesReturned = 0;
    for (const candidate of candidates) {
      if (results.length >= limit) break;
      const size = Buffer.byteLength(JSON.stringify(candidate.experience), "utf8");
      if (bytesReturned + size > RETRIEVAL_LIMITS.maxResultBytes) break;
      results.push({
        id: candidate.id,
        experience: candidate.experience,
        relevance: { score: candidate.score, matchedTerms: candidate.matchedTerms },
      });
      bytesReturned += size;
    }

    const coverage: TRetrievalCoverage = stopped === null
      ? { kind: "complete", examined }
      : { kind: "bounded", examined, reason: stopped };

    return {
      ok: true,
      retrieval: ExperienceRetrievalOutcome.parse({
        results, coverage, rejected, matched: candidates.length, bytesReturned,
      }),
    };
  }
}
