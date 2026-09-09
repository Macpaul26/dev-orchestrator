import { z } from "zod";
import { EpisodicExperience } from "./experience.js";
import { ExperienceId, StorageProjectId, ExperienceDefect } from "./experienceStorage.js";

/**
 * EXPERIENCE RETRIEVAL - TYPES AND BOUNDS
 *
 * Task 009 made experience durable. This makes a small, deterministic, relevant
 * subset of it findable, and stops there.
 *
 * ---------------------------------------------------------------------------
 * RETRIEVAL IS NOT TRUST, AND RELEVANCE IS NOT CONFIDENCE
 * ---------------------------------------------------------------------------
 * Selecting a record says one thing: it matched a query under a documented
 * ranking policy. It does not make the record true, current, corroborated or
 * safe to act on. A record that ranks first is the best MATCH, not the best
 * EVIDENCE, and nothing here may be read as the second.
 *
 *     LEARNING  ->  REASONING
 *     LEARNING  -/->  AUTHORITY
 *
 *     MEMORY  ->  PROPOSAL CONTEXT
 *     MEMORY  -/->  APPROVAL, CAPABILITY, GRANT, SCOPE, SECURITY EXCEPTION
 *
 * So `relevanceScore` exists and `confidence` does not. Task 011 owns
 * evaluation, recurrence and confidence; a retrieval layer that produced them
 * would be inferring truth from a text match, which is the exact mistake the
 * learning architecture was shaped to prevent.
 *
 * ---------------------------------------------------------------------------
 * PROJECT-SCOPED, AND NOT ARRANGEABLE OTHERWISE
 * ---------------------------------------------------------------------------
 * A request names exactly one project and there is no shape here that can name
 * two. No `projectIds`, no wildcard, no "all", no cross-project flag. Portable
 * lessons and any cross-project path remain a later task's problem, with the
 * separation Task 008-A established still intact.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const RETRIEVAL_LIMITS = {
  /** Characters a raw query may contain before it is refused. */
  maxQueryChars: 1_000,
  /** Distinct terms one query may contribute to scoring. */
  maxQueryTerms: 32,
  /** Characters one term may contribute. Longer terms are truncated. */
  maxTermChars: 64,
  /** Records one retrieval may load and score, across all pages. */
  maxCandidateRecords: 500,
  /** Store pages one retrieval may request. A second, independent stop. */
  maxCandidatePages: 10,
  /** Results one retrieval may return, however many matched. */
  maxResults: 10,
  /** UTF-8 bytes of experience one retrieval may return. */
  maxResultBytes: 128 * 1024,
  /** Characters of searchable text derived from one record. */
  maxSearchableChars: 8_000,
  /** Characters taken from any single field of a record. */
  maxFieldChars: 500,
  /** Items taken from any single list field of a record. */
  maxFieldItems: 8,
  /** Distinct tokens indexed from one record's searchable text. */
  maxRecordTerms: 600,
  /**
   * Term-comparison operations one retrieval may perform.
   *
   * A third stop, independent of the record and page bounds, so a pathological
   * corpus cannot turn a bounded number of records into unbounded work.
   */
  maxScoringOperations: 32_000,
  /** Occurrences of one term that can contribute to a score. */
  maxTermHits: 10,
} as const;

/**
 * WHAT A RETRIEVAL ASKS FOR.
 *
 * `.strict()` is doing real work. Every field a caller might be tempted to add
 * - a path, a second project, a ranking function, a confidence, a trust level,
 * a verification status, a capability - is rejected structurally rather than
 * ignored politely. The caller asks for retrieval; it does not get to define
 * the policy retrieval runs under.
 */
export const ExperienceRetrievalRequest = z.object({
  /** The SAME shape the store accepts. One project, named explicitly. */
  projectId: StorageProjectId,
  /**
   * The current task, as text.
   *
   * Free text, and bounded. It is tokenized and compared; it is never treated
   * as a path, a pattern, a command, or anything the store can be asked to do.
   */
  query: z.string().min(1).max(RETRIEVAL_LIMITS.maxQueryChars),
  /** A caller may ask for FEWER results than `maxResults`, never more. */
  limit: z.number().int().positive().max(RETRIEVAL_LIMITS.maxResults).optional(),
}).strict();
export type ExperienceRetrievalRequest = z.infer<typeof ExperienceRetrievalRequest>;

/**
 * WHY A RETRIEVAL STOPPED LOOKING.
 *
 * Same reasoning as `ExperienceRecordCount` in Task 009: "I examined
 * everything and found two matches" and "I stopped early and found two
 * matches" are different facts, and a shape that cannot tell them apart invites
 * the second to be read as the first.
 */
export const RetrievalStopReason = z.enum([
  /** `maxCandidateRecords` reached. */
  "candidate_limit",
  /** `maxCandidatePages` reached. */
  "page_limit",
  /** `maxScoringOperations` reached. */
  "work_limit",
  /** The store could not enumerate the project completely. */
  "scan_incomplete",
]);
export type RetrievalStopReason = z.infer<typeof RetrievalStopReason>;

export const RetrievalCoverage = z.discriminatedUnion("kind", [
  /** Every stored record in the project was examined. */
  z.object({
    kind: z.literal("complete"),
    examined: z.number().int().nonnegative(),
  }).strict(),
  /** A bound stopped the search. The corpus was NOT fully examined. */
  z.object({
    kind: z.literal("bounded"),
    examined: z.number().int().nonnegative(),
    reason: RetrievalStopReason,
  }).strict(),
]);
export type RetrievalCoverage = z.infer<typeof RetrievalCoverage>;

/**
 * HOW WELL A RECORD MATCHED. NOTHING ELSE.
 *
 * An integer, computed by the documented policy in `experienceRetrieval.ts`.
 * Integers on purpose: a float invites a reader to treat it as a probability,
 * and there is no probability here to report.
 *
 * IT IS NOT: a confidence, a trust level, a verification status, a quality
 * judgement, a recency judgement, or a reason to act. It is comparable only
 * against other scores from the SAME query - a score of 2,100 means "matched
 * this query better than a 1,050 did", and means nothing on its own.
 */
export const RelevanceScore = z.object({
  score: z.number().int().nonnegative(),
  /** Which query terms were found. Query text only - never record text. */
  matchedTerms: z.array(z.string().max(RETRIEVAL_LIMITS.maxTermChars))
    .max(RETRIEVAL_LIMITS.maxQueryTerms),
}).strict();
export type RelevanceScore = z.infer<typeof RelevanceScore>;

/**
 * ONE RETRIEVED EXPERIENCE.
 *
 * The record travels UNCHANGED and keeps its own type. It is still an
 * `EpisodicExperience` with its own `sources`, and being selected did not
 * promote it into a verified observation, a project fact, or a human decision.
 * The wrapper adds the retrieval artifact beside the record rather than mixing
 * it in, so nothing downstream can mistake a match score for evidence that
 * came with the record.
 */
export const RetrievedExperience = z.object({
  id: ExperienceId,
  experience: EpisodicExperience,
  relevance: RelevanceScore,
}).strict();
export type RetrievedExperience = z.infer<typeof RetrievedExperience>;

export const ExperienceRetrievalOutcome = z.object({
  /** Ordered by the documented total ordering. Never longer than `limit`. */
  results: z.array(RetrievedExperience).max(RETRIEVAL_LIMITS.maxResults),
  /** Whether the corpus was fully examined. Never implied, always stated. */
  coverage: RetrievalCoverage,
  /**
   * Candidates the store refused - corrupt, tampered, mismatched, oversized.
   *
   * Reported so a caller knows the corpus was not entirely readable, and never
   * merged into `results`. Carries the Task 009 defect shape, which holds an id
   * and a reason and nothing from inside the record.
   */
  rejected: z.array(ExperienceDefect).max(RETRIEVAL_LIMITS.maxResults),
  /** Records that matched at all, before `limit` was applied. */
  matched: z.number().int().nonnegative(),
  bytesReturned: z.number().int().nonnegative(),
}).strict();
export type ExperienceRetrievalOutcome = z.infer<typeof ExperienceRetrievalOutcome>;

/**
 * Why a retrieval was refused. Fails closed; none of these is a warning.
 *
 * A storage problem must never arrive as "no memory found": an empty result and
 * a broken store lead a caller to opposite conclusions.
 */
export const RetrievalFailureCode = z.enum([
  "invalid_project_id",
  "invalid_query",
  "invalid_request",
  "storage_failure",
]);
export type RetrievalFailureCode = z.infer<typeof RetrievalFailureCode>;

export const RetrievalFailure = z.object({
  code: RetrievalFailureCode,
  /** Short and non-disclosing. Never a path, never the query, never a record. */
  message: z.string().max(300),
}).strict();
export type RetrievalFailure = z.infer<typeof RetrievalFailure>;

/**
 * Field names that would mean authority, trust or a payload if a retrieval
 * request or result ever accepted them.
 *
 * Asserted against the parsed shapes by a test, so adding one becomes a
 * visible, reviewable act rather than an accident. `confidence` is on this list
 * for the same reason it is absent from `EpisodicExperience`: a match is not
 * evidence, and a layer that scored relevance would be the easiest place in the
 * system to quietly start scoring truth.
 */
export const FORBIDDEN_RETRIEVAL_KEYS: readonly string[] = [
  // Trust that retrieval must never manufacture.
  "confidence", "verified", "independentlyVerified", "trust", "trusted",
  "truthScore", "authority", "authoritative",
  // Authority.
  "approved", "capabilities", "capability", "grant", "grants", "scope",
  "bypass", "policy", "risk",
  // Reach.
  "path", "paths", "projectIds", "projects", "crossProject", "allProjects",
  "ranker", "scorer", "strategy",
] as const;
