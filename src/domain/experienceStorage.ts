import { z } from "zod";
import { EpisodicExperience } from "./experience.js";

/**
 * EXPERIENCE PERSISTENCE - TYPES AND BOUNDS
 *
 * The storage layer for project-scoped episodic experience.
 *
 * ---------------------------------------------------------------------------
 * PERSISTENCE IS NOT TRUST
 * ---------------------------------------------------------------------------
 * A record surviving to disk says one thing: somebody wrote it. It does not
 * make the record true, current, relevant, or safe to act on. Stored experience
 * can hold mistakes, stale assumptions, project-specific quirks, an agent's
 * self-flattering account of a run, or text written specifically to influence a
 * later reader.
 *
 * So the store's job is narrow and unglamorous: keep bounded records, keep them
 * apart by project, notice when one has changed underneath us, and refuse to
 * hand back anything it cannot parse. Deciding what any of it MEANS is Task 011
 * and beyond.
 *
 *     EXPERIENCE IS MEMORY, NOT AUTHORITY.
 *     PERSISTENCE IS NOT TRUST.
 *     HISTORY IS NOT TRUTH.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const EXPERIENCE_STORAGE_LIMITS = {
  /** Serialized UTF-8 bytes one stored record may occupy. */
  maxRecordBytes: 32 * 1024,
  /** Records one project may accumulate before writes are refused. */
  maxRecordsPerProject: 5_000,
  /** Records one list call may return, however large the history. */
  maxListResults: 50,
  /** UTF-8 bytes one list call may return in total. */
  maxListBytes: 256 * 1024,
  /** Entries a single directory scan will read before it stops AND SAYS SO. */
  maxDirectoryEntries: 20_000,
  /**
   * How long a project write lock may go untouched before another process may
   * break it.
   *
   * The critical section is a bounded directory scan plus one small file write
   * - milliseconds. Thirty seconds is four orders of magnitude of headroom, so
   * a lock this old almost certainly belongs to a process that died. "Almost
   * certainly" is the honest word: see `ProjectLock` for what breaking a lock
   * does and does not guarantee.
   */
  lockStaleMs: 30_000,
  /** How long a writer waits for the project lock before reporting contention. */
  lockAcquireTimeoutMs: 5_000,
  /** Longest pause between lock attempts. */
  lockPollMaxMs: 50,
  /** Abandoned temporary files one write may clear up. Bounded on purpose. */
  maxTemporaryCleanupsPerWrite: 64,
} as const;

/**
 * A stored experience identifier.
 *
 * Derived from the record's content (see `experienceId`), so it is
 * deterministic, collision-resistant, and safe as a filename by construction -
 * lower-case hex only, so there is nothing in it to escape a path with.
 */
export const ExperienceId = z.string().regex(
  /^[0-9a-f]{32}$/,
  "an experience id is 32 lower-case hex characters",
);
export type ExperienceId = z.infer<typeof ExperienceId>;

/**
 * A project identifier, as the store will accept it.
 *
 * The SAME shape `Project.id` uses. Deliberately not a looser rule: the id
 * becomes a directory name, and every character that is not in this set is a
 * character that cannot be used to leave the experience root. Traversal,
 * absolute paths, drive letters, UNC prefixes and alternate separators are all
 * unrepresentable rather than filtered.
 */
export const StorageProjectId = z.string().min(1).max(100).regex(
  /^[a-z0-9][a-z0-9-]*$/,
  "a project id is kebab-case: lower-case letters, digits and hyphens",
);
export type StorageProjectId = z.infer<typeof StorageProjectId>;

/**
 * INTEGRITY EVIDENCE - AND WHAT IT IS NOT
 *
 * A SHA-256 digest over the canonical serialization of the record.
 *
 * ---------------------------------------------------------------------------
 * INTEGRITY != AUTHENTICITY != VERIFICATION != TRUST
 * ---------------------------------------------------------------------------
 * These are four different things and conflating them would be the most
 * dangerous mistake available here:
 *
 *   INTEGRITY     the bytes on disk match the digest stored beside them.
 *                 That is all this provides.
 *
 *   AUTHENTICITY  someone holding a key vouched for the content. There is NO
 *                 key and NO signature here, so this is NOT provided. Anyone
 *                 who can rewrite the record can also rewrite the digest -
 *                 the two sit in the same file, on the same disk, behind the
 *                 same permissions.
 *
 *   VERIFICATION  the claims inside the record were independently confirmed.
 *                 That is `OutcomeSource`, and it is orthogonal to this.
 *
 *   TRUST         someone decided the content should influence a decision.
 *                 Never granted by any of the above.
 *
 * What it genuinely catches: accidental truncation, a partial write, a
 * hand-edit, disk corruption, a botched migration. What it cannot catch: an
 * attacker with write access to the store, who simply recomputes it.
 *
 * `digestMatches: true` therefore means "unchanged since we wrote it", and must
 * never be read as "safe", "verified" or "authorised".
 */
export const IntegrityMetadata = z.object({
  algorithm: z.literal("sha256"),
  /** Hex digest over the canonical record serialization. */
  digest: z.string().regex(/^[0-9a-f]{64}$/, "a sha256 digest is 64 lower-case hex characters"),
  /** When the digest was computed. Storage metadata, NOT part of identity. */
  computedAt: z.string().datetime(),
}).strict();
export type IntegrityMetadata = z.infer<typeof IntegrityMetadata>;

/**
 * What actually lands on disk.
 *
 * The record and its integrity metadata, plus the id the record was filed
 * under. `id` is stored as well as encoded in the filename so a mismatch
 * between the two is detectable - a renamed file is a tampering signal, not a
 * silently relocated record.
 */
export const StoredExperience = z.object({
  id: ExperienceId,
  record: EpisodicExperience,
  integrity: IntegrityMetadata,
}).strict();
export type StoredExperience = z.infer<typeof StoredExperience>;

/**
 * Why a stored record was refused on read.
 *
 * Every one of these means the record is NOT returned as experience. A refusal
 * is not an empty result: "we would not trust that" and "there was nothing
 * there" are different facts and never share a representation.
 */
export const ExperienceDefectCode = z.enum([
  /** The file is not parseable JSON - truncated, or not text at all. */
  "unreadable",
  /** It parsed, but is not a valid stored experience. */
  "schema_invalid",
  /** The digest does not match the record beside it. */
  "integrity_mismatch",
  /** Integrity metadata is missing entirely. */
  "integrity_missing",
  /** The filename, the stored id, or the recomputed id disagree. */
  "identity_mismatch",
  /** The record claims a different project than the directory it sits in. */
  "project_mismatch",
  /** Larger than the per-record ceiling. */
  "oversized",
]);
export type ExperienceDefectCode = z.infer<typeof ExperienceDefectCode>;

/**
 * A rejected record, reported rather than returned.
 *
 * Carries the id and the reason and NOTHING FROM INSIDE the record - a defect
 * report about a file suspected of being corrupt or tampered with is the last
 * place to start quoting its contents.
 */
export const ExperienceDefect = z.object({
  id: z.string().max(200),
  code: ExperienceDefectCode,
  detail: z.string().max(300),
}).strict();
export type ExperienceDefect = z.infer<typeof ExperienceDefect>;

/** Why a write was refused. Writes fail closed; none of these is a warning. */
export const ExperienceWriteFailureCode = z.enum([
  "invalid_project_id",
  "invalid_record",
  "oversized",
  /** The project is at `maxRecordsPerProject` and this record is a new one. */
  "project_quota_exceeded",
  /**
   * Another process holds the project write lock and did not release it within
   * `lockAcquireTimeoutMs`.
   *
   * A CONTENTION OUTCOME, NOT A QUOTA OUTCOME. Nothing was written and nothing
   * was consumed; the same write may simply be retried. It is a distinct code
   * because "someone else is writing" and "this project is full" are different
   * facts and a caller that cannot tell them apart will retry the wrong one.
   */
  "storage_busy",
  /**
   * The project's record count could not be established within
   * `maxDirectoryEntries`, so the store cannot prove the write would stay
   * under the ceiling.
   *
   * REFUSING IS THE POINT. The alternative is writing on the strength of a
   * count taken from an arbitrary prefix of a directory, which is how a hard
   * bound quietly becomes an advisory one.
   */
  "quota_indeterminate",
  "storage_failure",
]);
export type ExperienceWriteFailureCode = z.infer<typeof ExperienceWriteFailureCode>;

export const ExperienceWriteFailure = z.object({
  code: ExperienceWriteFailureCode,
  /** Short and non-disclosing. Never the record, never a path. */
  message: z.string().max(300),
}).strict();
export type ExperienceWriteFailure = z.infer<typeof ExperienceWriteFailure>;

/**
 * HOW MANY RECORDS A PROJECT HOLDS - OR AS MUCH AS COULD BE ESTABLISHED.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NUMBER
 * ---------------------------------------------------------------------------
 * Every directory scan in this store is bounded by `maxDirectoryEntries`, so
 * there are two genuinely different results and they must not share a shape:
 *
 *   EXACT     the whole directory was read. `records` is the count, full stop.
 *
 *   BOUNDED   the scan stopped at the entry ceiling. `atLeast` is what was
 *             seen before it stopped, and the true total may be larger.
 *
 * The original Task 009 listing reported a single `totalOnDisk` taken from the
 * first `maxDirectoryEntries` names `readdir` happened to return, and presented
 * it as the number of records on disk. That is a claim the implementation could
 * not support: directory order is a property of the filesystem, so a valid
 * record sitting past the cutoff was silently uncounted. Independent review
 * found it, and the fix is not a bigger ceiling - it is a shape that CANNOT
 * express "there are N records" when only a prefix was examined.
 *
 * `atLeast` is deliberately a different field name from `records`. A caller
 * that reads the count without checking `kind` gets a type error rather than a
 * plausible wrong number.
 */
export const ExperienceRecordCount = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    records: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("bounded"),
    atLeast: z.number().int().nonnegative(),
  }).strict(),
]);
export type ExperienceRecordCount = z.infer<typeof ExperienceRecordCount>;

/**
 * The result of listing a project's experience.
 *
 * `truncated`, `defects` and `count` exist so nothing is lost silently. A page
 * that quietly omitted the records it could not parse would look identical to a
 * project that simply had fewer of them.
 *
 * When `count.kind` is `bounded`, the ordering guarantee weakens with it: the
 * page holds the newest of what was SCANNED, which need not be the newest in
 * the project. `truncated` is always true in that case.
 */
export const ExperienceListing = z.object({
  records: z.array(StoredExperience).max(EXPERIENCE_STORAGE_LIMITS.maxListResults),
  /** Defective records encountered while assembling this page. Never returned. */
  defects: z.array(ExperienceDefect).max(EXPERIENCE_STORAGE_LIMITS.maxListResults),
  /** True when a bound stopped this listing returning more. */
  truncated: z.boolean().default(false),
  /** What could be established about the project's size. Never a bare number. */
  count: ExperienceRecordCount,
  bytesReturned: z.number().int().nonnegative().default(0),
}).strict();
export type ExperienceListing = z.infer<typeof ExperienceListing>;
