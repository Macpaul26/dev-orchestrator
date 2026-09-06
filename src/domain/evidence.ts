import { z } from "zod";
import { GitCommit, InspectionFailure } from "./repository.js";
import { ScopeVerdict } from "./scope.js";

/**
 * REVIEW EVIDENCE
 *
 * The deterministic layer a future reviewer will read. Everything here is
 * computed by comparing what a coding agent CLAIMED against what the repository
 * inspector OBSERVED - no model, no judgement, no prose.
 *
 * This is not a reviewer. It answers factual questions only:
 *
 *   Did the files the agent named actually change?
 *   Did anything change that the agent never mentioned?
 *   Did anything change outside the approved scope?
 *   Does the commit it claims to have made exist?
 *   Was the working tree already dirty before we started?
 *
 * A later phase can put a model on top of these facts. It must not be able to
 * change them.
 */

/** Claimed files against observed files. Set arithmetic, nothing more. */
export const ClaimComparison = z.object({
  claimedFiles: z.array(z.string()).default([]),
  observedFiles: z.array(z.string()).default([]),
  /** Claimed as changed, but git saw no change. The agent may be overstating. */
  claimedButNotObserved: z.array(z.string()).default([]),
  /** Changed, but never claimed. The agent may be understating. */
  observedButNotClaimed: z.array(z.string()).default([]),
  /** True only when the two sets are identical. */
  matches: z.boolean().default(false),
});
export type ClaimComparison = z.infer<typeof ClaimComparison>;

export const ReviewEvidence = z.object({
  runId: z.string().min(1),

  /**
   * False when inspection could not be completed. When false, EVERY observed
   * field below is empty and nothing may be treated as verified.
   */
  inspectionSucceeded: z.boolean(),
  failure: InspectionFailure.nullable().default(null),
  /** True when a pre-implementation snapshot was captured for comparison. */
  baselineCaptured: z.boolean().default(false),

  claims: ClaimComparison,

  /**
   * Files that changed BETWEEN the baseline and now - i.e. attributable to the
   * implementation. Distinguished from files that were already dirty, so a
   * repository that started messy does not read as scope drift.
   */
  attributableFiles: z.array(z.string()).default([]),
  preExistingChanges: z.array(z.string()).default([]),

  scope: ScopeVerdict,
  /** The authorised scope this verdict was computed against. */
  allowedScope: z.array(z.string()).default([]),
  /** Whether drift was computed over attributable changes or over all changes. */
  driftBasis: z.enum(["attributable", "all_changes"]).default("all_changes"),

  /** Commits that exist now and did not at the baseline. Straight from git. */
  newCommits: z.array(GitCommit).default([]),
  headCommitBefore: z.string().nullable().default(null),
  headCommitAfter: z.string().nullable().default(null),
  /** Null when nothing was claimed; otherwise whether that SHA really exists. */
  claimedCommitExists: z.boolean().nullable().default(null),

  workingTreeClean: z.boolean().default(true),
  /** Sensitive files that changed. Names only - contents never captured. */
  sensitiveFilesChanged: z.array(z.string()).default([]),

  /** Project-declared checks, and whether any actually ran. */
  checksDeclared: z.number().int().nonnegative().default(0),
  checksExecuted: z.number().int().nonnegative().default(0),

  notes: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type ReviewEvidence = z.infer<typeof ReviewEvidence>;
