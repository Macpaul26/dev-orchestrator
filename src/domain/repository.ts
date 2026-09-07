import { z } from "zod";
import { InspectionLimits } from "../security/limits.js";
import { FileFingerprint } from "./attribution.js";

/**
 * REPOSITORY EVIDENCE
 *
 * Structured representations of what the orchestrator observed in a real
 * repository. Deliberately parsed into fields rather than kept as raw command
 * output: a later reviewer must be able to ask "which files changed?" without
 * re-parsing `git status` text, and workflow state must stay small and
 * JSON-serialisable.
 *
 * Everything here is written into the SQLite checkpoint and the JSONL history,
 * so - as with graph state - NOTHING HERE MAY CARRY A SECRET. File contents
 * only ever reach these schemas after passing the sensitive-file policy in
 * security/sensitive.ts.
 */

export const FileKind = z.enum(["file", "directory", "symlink", "other"]);
export type FileKind = z.infer<typeof FileKind>;

/** Metadata is always safe to collect - even for a file we refuse to read. */
export const FileMetadata = z.object({
  /** Forward-slash path relative to the boundary root. */
  path: z.string(),
  kind: FileKind,
  size: z.number().int().nonnegative(),
  /** True when the sensitive-file policy forbids reading the contents. */
  sensitive: z.boolean().default(false),
  sensitivityDetail: z.string().nullable().default(null),
});
export type FileMetadata = z.infer<typeof FileMetadata>;

/** Why a file's contents were withheld. Structured, so review can act on it. */
export const ContentWithheldReason = z.enum([
  "sensitive",
  "too_large",
  "binary",
  "not_a_file",
  "missing",
  "unreadable",
]);
export type ContentWithheldReason = z.infer<typeof ContentWithheldReason>;

/**
 * The result of asking for a file's contents.
 *
 * `available: false` is a normal, structured outcome - not an exception. A file
 * that was too large or too sensitive still yields its metadata and an explicit
 * reason, so nothing silently looks like an empty file.
 */
export const FileContent = z.object({
  path: z.string(),
  available: z.boolean(),
  withheldReason: ContentWithheldReason.nullable().default(null),
  detail: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  /** Size on disk, regardless of whether the contents were returned. */
  bytes: z.number().int().nonnegative().default(0),
  /** True when the file was read but cut short at the configured limit. */
  truncated: z.boolean().default(false),
});
export type FileContent = z.infer<typeof FileContent>;

export const DirectoryListing = z.object({
  path: z.string(),
  entries: z.array(FileMetadata).default([]),
  /** True when the directory held more entries than the limit allows. */
  truncated: z.boolean().default(false),
});
export type DirectoryListing = z.infer<typeof DirectoryListing>;

/** One path reported as changed by git, with where the change lives. */
export const GitFileChange = z.object({
  path: z.string(),
  /** Raw two-character porcelain code, e.g. "M ", " M", "??", "R ". */
  code: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  renamedFrom: z.string().nullable().default(null),
});
export type GitFileChange = z.infer<typeof GitFileChange>;

export const GitCommit = z.object({
  sha: z.string(),
  subject: z.string().default(""),
  authorDate: z.string().default(""),
});
export type GitCommit = z.infer<typeof GitCommit>;

/**
 * WHETHER GIT ITSELF WAS USED DURING AN ATTEMPT.
 *
 * Separate from the changed-file listing, and it has to be: an agent that
 * writes a file, stages it and commits it leaves a CLEAN working tree. Every
 * signal based on "what is dirty now" reports nothing, and the attempt reads as
 * though it did nothing at all.
 *
 * So this asks a different question - did the repository move? - and answers it
 * from HEAD, the ref, and the commit list, none of which a clean status can
 * hide. It is a pure OBSERVATION: whether the mutation was permitted is decided
 * elsewhere, from the capabilities a human actually granted.
 */
export const GitMutationObservation = z.object({
  /** True when git state moved during the attempt, by any observed signal. */
  detected: z.boolean().default(false),
  headChanged: z.boolean().default(false),
  headBefore: z.string().nullable().default(null),
  headAfter: z.string().nullable().default(null),
  /** True when the checked-out ref is not the one we started on. */
  branchChanged: z.boolean().default(false),
  branchBefore: z.string().nullable().default(null),
  branchAfter: z.string().nullable().default(null),
  /** SHAs that exist now and did not at the baseline. Observed, never claimed. */
  newCommits: z.array(z.string()).default([]),
  /**
   * Why we concluded git moved. Plain sentences for a human at the review gate,
   * kept alongside the booleans so a reader never has to infer the reason.
   */
  reasons: z.array(z.string()).default([]),
});
export type GitMutationObservation = z.infer<typeof GitMutationObservation>;

/**
 * A unified diff, with an explicit record of what was left out.
 *
 * `excludedFiles` matters as much as the diff text: it is how a reviewer learns
 * that a `.env` changed without the change itself entering the audit trail.
 */
export const DiffEvidence = z.object({
  text: z.string().default(""),
  bytes: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
  includedFiles: z.array(z.string()).default([]),
  excludedFiles: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});
export type DiffEvidence = z.infer<typeof DiffEvidence>;

/** Everything one read-only pass over a repository established. */
export const RepositoryEvidence = z.object({
  collectedAt: z.string().datetime(),
  /** The security boundary this pass was confined to. */
  boundaryRoot: z.string(),
  workingDir: z.string(),

  isGitRepository: z.boolean(),
  /** `git rev-parse --show-toplevel`, when there is one. */
  repositoryRoot: z.string().nullable().default(null),
  /**
   * False when the repository extends ABOVE the boundary - i.e. workingDir is a
   * subdirectory of a larger repository. Inspection stays inside the boundary
   * either way; this flag records that it saw only part of the repository.
   */
  repositoryRootWithinBoundary: z.boolean().default(true),

  branch: z.string().nullable().default(null),
  detachedHead: z.boolean().default(false),
  headCommit: z.string().nullable().default(null),

  clean: z.boolean().default(true),
  stagedFiles: z.array(z.string()).default([]),
  unstagedFiles: z.array(z.string()).default([]),
  untrackedFiles: z.array(z.string()).default([]),
  /** Union of the three above, sorted and de-duplicated. */
  changedFiles: z.array(z.string()).default([]),
  changes: z.array(GitFileChange).default([]),

  diff: DiffEvidence.nullable().default(null),
  diffStat: z.string().nullable().default(null),

  /**
   * Content fingerprints for every path dirty at the time of this snapshot.
   *
   * This is what makes attribution possible on a repository that was ALREADY
   * dirty. Comparing filenames between two snapshots cannot tell you that a
   * file which was modified before is now modified DIFFERENTLY; comparing
   * fingerprints can. See domain/attribution.ts.
   *
   * Sensitive files appear here with `contentHash: null` - their identity is
   * tracked by size, mtime and git status, never by hashing their bytes.
   */
  fingerprints: z.array(FileFingerprint).default([]),
  fingerprintsTruncated: z.boolean().default(false),

  recentCommits: z.array(GitCommit).default([]),

  trackedFileCount: z.number().int().nonnegative().default(0),
  trackedFilesTruncated: z.boolean().default(false),

  /** Project-declared context files, subject to the same content policy. */
  contextFiles: z.array(FileContent).default([]),
  /** Project-declared verification commands. Recorded, NOT executed. */
  declaredChecks: z.array(z.object({ name: z.string(), command: z.string() })).default([]),

  limits: InspectionLimits,
  /** Non-fatal observations: truncations, skipped files, partial results. */
  notes: z.array(z.string()).default([]),
});
export type RepositoryEvidence = z.infer<typeof RepositoryEvidence>;

/**
 * Why an inspection could not be completed.
 *
 * Inspection failure is reported, never swallowed: an incomplete pass must be
 * distinguishable from a clean repository, or "nothing changed" becomes
 * indistinguishable from "we could not look".
 */
export const InspectionFailureCode = z.enum([
  "working_dir_not_absolute",
  "working_dir_missing",
  "working_dir_not_a_directory",
  "working_dir_unreadable",
  "not_a_git_repository",
  "git_unavailable",
  "git_failed",
  "permission_denied",
  "path_escape",
  "symlink_escape",
  "repository_root_outside_boundary",
  "timed_out",
]);
export type InspectionFailureCode = z.infer<typeof InspectionFailureCode>;

export const InspectionFailure = z.object({
  code: InspectionFailureCode,
  message: z.string(),
  detail: z.string().nullable().default(null),
});
export type InspectionFailure = z.infer<typeof InspectionFailure>;

export const InspectionOutcome = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), evidence: RepositoryEvidence }),
  z.object({ ok: z.literal(false), failure: InspectionFailure }),
]);
export type InspectionOutcome = z.infer<typeof InspectionOutcome>;
