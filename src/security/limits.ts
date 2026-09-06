import { z } from "zod";

/**
 * INSPECTION LIMITS
 *
 * Bounds on how much of a repository the orchestrator will pull into memory,
 * into workflow state, or into the audit trail.
 *
 * Two rules make these a security control rather than a performance tweak:
 *
 *   1. Limits come from TRUSTED configuration only - a constructor argument or
 *      project.json - and are never part of a tool's input schema. A model
 *      cannot ask for a bigger limit because no model-visible code path accepts
 *      one.
 *   2. Every field is clamped to a hard ceiling defined here. Even a mistaken
 *      trusted config cannot lift a limit past the ceiling; `resolveLimits`
 *      silently clamps rather than trusting the caller.
 */

/** Absolute maxima. Not configurable - editing this file is the only way past. */
export const CEILINGS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxDiffBytes: 2 * 1024 * 1024,
  maxDirectoryEntries: 5_000,
  maxListedFiles: 20_000,
  maxDepth: 32,
  maxCommits: 200,
  maxFingerprintBytes: 128 * 1024 * 1024,
  maxFingerprintedFiles: 20_000,
  gitTimeoutMs: 60_000,
  gitMaxBufferBytes: 8 * 1024 * 1024,
} as const;

export const InspectionLimits = z.object({
  /** Largest file the inspector will read in full. */
  maxFileBytes: z.number().int().positive().default(256 * 1024),
  /** Largest diff retained as evidence. Longer diffs are truncated, not dropped. */
  maxDiffBytes: z.number().int().positive().default(256 * 1024),
  /** Entries returned from a single directory listing. */
  maxDirectoryEntries: z.number().int().positive().default(500),
  /** Paths returned from a repository-wide file listing. */
  maxListedFiles: z.number().int().positive().default(2_000),
  /** Directory recursion depth. */
  maxDepth: z.number().int().positive().default(8),
  /** Commits returned by history inspection. */
  maxCommits: z.number().int().positive().default(50),
  /**
   * Largest file the inspector will HASH for a change fingerprint.
   *
   * Separate from `maxFileBytes` because the two do different things: reading a
   * file loads it into memory and into evidence, whereas hashing streams it in
   * fixed-size chunks and keeps only 32 bytes. So this can be far larger
   * safely - it costs time, not memory, and no content is retained.
   */
  maxFingerprintBytes: z.number().int().positive().default(16 * 1024 * 1024),
  /** Cap on how many files one attribution pass will fingerprint. */
  maxFingerprintedFiles: z.number().int().positive().default(2_000),
  /** Wall-clock budget for one git invocation. */
  gitTimeoutMs: z.number().int().positive().default(15_000),
  /** Hard cap on bytes captured from one git invocation. */
  gitMaxBufferBytes: z.number().int().positive().default(4 * 1024 * 1024),
});
export type InspectionLimits = z.infer<typeof InspectionLimits>;

export const DEFAULT_LIMITS: InspectionLimits = InspectionLimits.parse({});

/**
 * Parse trusted limit overrides and clamp every field to its ceiling.
 *
 * Clamping (rather than throwing) is deliberate: a configuration that asks for
 * too much still runs, just safely. There is no code path that returns a value
 * above `CEILINGS`.
 */
export function resolveLimits(overrides: Partial<InspectionLimits> = {}): InspectionLimits {
  const parsed = InspectionLimits.parse(overrides);
  const clamped = { ...parsed };
  for (const key of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[]) {
    clamped[key] = Math.min(parsed[key], CEILINGS[key]);
  }
  return clamped;
}
