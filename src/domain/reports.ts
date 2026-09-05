import { z } from "zod";

/**
 * IMPLEMENTATION REPORT
 *
 * The architectural point of this schema is the split between what an
 * implementation agent SAYS it did and what we OBSERVED ourselves.
 *
 * Every `claimed*` field is untrusted narrative produced by a model.
 * Every `observed*` field must originate from our own tooling - git plumbing,
 * process exit codes, the filesystem - and never from model output.
 *
 * Phase 1+2 populates neither (no coding agent runs yet), but the distinction
 * is fixed in the type now so no later phase can quietly collapse the two.
 */
export const ImplementationReport = z.object({
  runId: z.string().min(1),

  // ---- Untrusted: what the agent claims ------------------------------------
  /** The agent's own prose summary. Evidence for review, never proof. */
  claimedSummary: z.string().default(""),
  claimedFiles: z.array(z.string()).default([]),

  // ---- Observed: what our own tooling saw ----------------------------------
  /** Unified diff read from git. Null until git inspection is implemented. */
  observedDiff: z.string().nullable().default(null),
  /** Paths from `git status --porcelain`. */
  observedFiles: z.array(z.string()).default([]),
  /** Commit SHAs observed in the repository. */
  observedCommits: z.array(z.string()).default([]),

  /** Coding-agent session id, persisted before the run so a crash is recoverable. */
  sessionId: z.string().nullable().default(null),
  turns: z.number().int().nonnegative().default(0),

  /** True once observed* fields were populated by our tooling. */
  verifiedIndependently: z.boolean().default(false),

  createdAt: z.string().datetime(),
});
export type ImplementationReport = z.infer<typeof ImplementationReport>;

/** Result of one project-declared verification command. */
export const CheckResult = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int().nullish(),
  passed: z.boolean(),
  durationMs: z.number().nonnegative().default(0),
  /** Truncated output. Never contains environment values. */
  output: z.string().default(""),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const ReviewFinding = z.object({
  severity: z.enum(["info", "warning", "blocker"]),
  message: z.string().min(1),
  file: z.string().nullish(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewReport = z.object({
  runId: z.string().min(1),
  verdict: z.enum(["pass", "changes_requested", "fail"]),
  findings: z.array(ReviewFinding).default([]),
  checkResults: z.array(CheckResult).default([]),
  /**
   * Files touched that the approved plan did not authorise.
   * Computed by comparing observedFiles against Plan.allowedScope.
   */
  scopeDrift: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;
