import { z } from "zod";

/**
 * CONTROLLED REPOSITORY EVIDENCE
 *
 * Narrowly scoped, read-only facts the orchestrator can establish about a
 * repository in order to reason about it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * NOT a tool the model can call. There is no path from a reasoning proposal to
 * this service: `ReasoningModel` still has exactly one method, it still returns
 * data, and `ReasoningProposal` still has no field naming an operation, a path,
 * or an argument. The model cannot ask for a file, and adding a way for it to
 * would mean editing several files that a test watches.
 *
 * NOT a filesystem API. The operations below are a CLOSED set. There is no
 * `readFile(path)`, no glob, no recursive walk, no shell, no Git command
 * passthrough. An unknown operation is refused by the schema rather than
 * dispatched to some default.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE IS THE CONTROL
 * ---------------------------------------------------------------------------
 * A discriminated union of `.strict()` members means the request itself cannot
 * express something outside the set. That is deliberately stronger than a
 * validated string operation name plus a bag of arguments: there is no bag, and
 * an argument that does not belong to an operation is a parse error rather than
 * a field somebody later decides to honour.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const EVIDENCE_LIMITS = {
  /** Most evidence items one request batch may return. */
  maxItems: 50,
  /** Bytes of file text any single excerpt may carry. */
  maxExcerptBytes: 8 * 1024,
  /** Bytes of file text ALL excerpts in one batch may carry, together. */
  maxTotalExcerptBytes: 32 * 1024,
  /** Longest repository-relative path this service will consider. */
  maxPathLength: 400,
  /** Changed-file entries reported in one CHANGED_FILES item. */
  maxChangedFiles: 200,
  /** Paths one FILE_METADATA request may ask about. */
  maxMetadataPaths: 50,
  /** Requests in one batch. */
  maxRequests: 50,
} as const;

/** A repository-relative path. Absolute paths and traversal are refused later. */
const RepoPath = z.string().min(1).max(EVIDENCE_LIMITS.maxPathLength);

/**
 * THE CLOSED OPERATION SET.
 *
 * Adding a member is a deliberate, reviewable edit to this file - not something
 * that happens because a caller passed a new string.
 */
export const EvidenceOperation = z.enum([
  /** Branch, head, whether the repository is inside the boundary. No contents. */
  "REPOSITORY_METADATA",
  /** Clean/dirty and the counts behind it. No contents. */
  "REPOSITORY_STATUS",
  /** Which paths differ from HEAD. PATHS ONLY - never what changed in them. */
  "CHANGED_FILES",
  /** Size, kind, and whether a path is sensitive. Never opens the file. */
  "FILE_METADATA",
  /** A bounded PREFIX of a text file. The only operation that reads contents. */
  "FILE_EXCERPT",
]);
export type EvidenceOperation = z.infer<typeof EvidenceOperation>;

export const EvidenceRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("REPOSITORY_METADATA") }).strict(),
  z.object({ operation: z.literal("REPOSITORY_STATUS") }).strict(),
  z.object({ operation: z.literal("CHANGED_FILES") }).strict(),
  z.object({
    operation: z.literal("FILE_METADATA"),
    paths: z.array(RepoPath).min(1).max(EVIDENCE_LIMITS.maxMetadataPaths),
  }).strict(),
  z.object({
    operation: z.literal("FILE_EXCERPT"),
    path: RepoPath,
    /**
     * Bytes to read, capped by the schema AND again by the service.
     *
     * There is no "unlimited" value and no way to omit the cap in favour of a
     * default that reads everything. A prefix is all this operation offers -
     * see `FileExcerptEvidence` for why an arbitrary offset is absent.
     */
    maxBytes: z.number().int().positive().max(EVIDENCE_LIMITS.maxExcerptBytes),
  }).strict(),
]);
export type EvidenceRequest = z.infer<typeof EvidenceRequest>;

// ---------------------------------------------------------------- results

export const RepositoryMetadataEvidence = z.object({
  kind: z.literal("REPOSITORY_METADATA"),
  isGitRepository: z.boolean(),
  branch: z.string().nullable().default(null),
  detachedHead: z.boolean().default(false),
  headCommit: z.string().nullable().default(null),
  repositoryRootWithinBoundary: z.boolean().default(true),
  trackedFileCount: z.number().int().nonnegative().default(0),
}).strict();

export const RepositoryStatusEvidence = z.object({
  kind: z.literal("REPOSITORY_STATUS"),
  clean: z.boolean(),
  stagedCount: z.number().int().nonnegative().default(0),
  unstagedCount: z.number().int().nonnegative().default(0),
  untrackedCount: z.number().int().nonnegative().default(0),
}).strict();

export const ChangedFilesEvidence = z.object({
  kind: z.literal("CHANGED_FILES"),
  /** PATHS ONLY. Deliberately never the diff - that is content. */
  paths: z.array(z.string()).max(EVIDENCE_LIMITS.maxChangedFiles).default([]),
  truncated: z.boolean().default(false),
  totalCount: z.number().int().nonnegative().default(0),
}).strict();

export const FileMetadataEvidence = z.object({
  kind: z.literal("FILE_METADATA"),
  path: z.string(),
  exists: z.boolean(),
  fileKind: z.enum(["file", "directory", "symlink", "other"]).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().default(0),
  /**
   * Whether the sensitive-path policy covers this path.
   *
   * Reported deliberately: knowing that `.env` exists and changed is useful,
   * and says nothing about what is in it. The file is never opened to answer.
   */
  sensitive: z.boolean().default(false),
}).strict();

/**
 * A bounded PREFIX of a text file.
 *
 * `start` is always 0 and there is no way to ask for anything else. An
 * arbitrary offset would turn this into a paging API - call it repeatedly and
 * you have read the whole file, one bounded window at a time, which is the
 * unrestricted reader this operation exists to avoid being. A prefix is less
 * useful and much easier to reason about, and Task 008 chooses the narrower
 * thing.
 */
export const FileExcerptEvidence = z.object({
  kind: z.literal("FILE_EXCERPT"),
  path: z.string(),
  start: z.literal(0),
  /** Bytes actually returned. */
  end: z.number().int().nonnegative(),
  text: z.string().max(EVIDENCE_LIMITS.maxExcerptBytes),
  /** True when the file is longer than what was returned. Never implicit. */
  truncated: z.boolean().default(false),
  totalBytes: z.number().int().nonnegative().default(0),
}).strict();

export const EvidenceItem = z.discriminatedUnion("kind", [
  RepositoryMetadataEvidence,
  RepositoryStatusEvidence,
  ChangedFilesEvidence,
  FileMetadataEvidence,
  FileExcerptEvidence,
]);
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/**
 * Why an operation produced no evidence.
 *
 * Each is a REFUSAL, and a refusal is not an empty result. A caller cannot
 * mistake "we would not read that" for "there was nothing there".
 */
export const EvidenceRefusalCode = z.enum([
  "invalid_request",
  "path_escapes_boundary",
  "path_absolute",
  "path_traversal",
  "sensitive_path",
  "not_found",
  "not_a_file",
  "binary_content",
  "unreadable",
  "credential_shaped_content",
  "excerpt_budget_exhausted",
  "item_limit_exceeded",
  "inspection_failed",
]);
export type EvidenceRefusalCode = z.infer<typeof EvidenceRefusalCode>;

export const EvidenceRefusal = z.object({
  operation: EvidenceOperation,
  code: EvidenceRefusalCode,
  /**
   * Short and NON-DISCLOSING.
   *
   * A refusal caused by credential-shaped content must not quote the content
   * into a message, a log, or an event - which is precisely where secrets end
   * up when a failure path is written carelessly.
   */
  message: z.string().max(300),
  /** Repository-relative path, when naming it is safe. Never file contents. */
  path: z.string().max(EVIDENCE_LIMITS.maxPathLength).nullable().default(null),
}).strict();
export type EvidenceRefusal = z.infer<typeof EvidenceRefusal>;

export const EvidenceOutcome = z.object({
  items: z.array(EvidenceItem).max(EVIDENCE_LIMITS.maxItems).default([]),
  /** Every refusal, reported. Nothing is dropped silently. */
  refusals: z.array(EvidenceRefusal).max(EVIDENCE_LIMITS.maxItems).default([]),
  /** Excerpt bytes spent, so the budget is visible rather than implicit. */
  excerptBytesUsed: z.number().int().nonnegative().default(0),
  collectedAt: z.string().datetime(),
}).strict();
export type EvidenceOutcome = z.infer<typeof EvidenceOutcome>;
