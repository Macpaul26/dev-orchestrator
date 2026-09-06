import type { RepositoryInspector } from "../domain/inspector.js";
import type {
  RepositoryEvidence, InspectionFailure, GitCommit,
} from "../domain/repository.js";
import {
  ImplementationReport, type ImplementationReport as TImplementationReport,
} from "../domain/reports.js";
import {
  ReviewEvidence, ClaimComparison, type ReviewEvidence as TReviewEvidence,
} from "../domain/evidence.js";
import { classifyScope, normalisePath } from "../domain/scope.js";
import { classifySensitivity } from "../security/sensitive.js";

/**
 * INDEPENDENT VERIFICATION
 *
 * The single rule this module exists to enforce:
 *
 *   > The coding agent's report is never proof of what happened.
 *
 * `claimed*` comes in as an argument. `observed*` comes out of a
 * `RepositoryInspector`. THEY NEVER MEET: there is no code path below that
 * writes a claimed value into an observed field, and no fallback that fills an
 * observed field from a claim when inspection fails. When inspection fails, the
 * observed fields stay EMPTY and `verifiedIndependently` stays FALSE - an
 * unverified report, not an optimistic one.
 *
 * Verification is a two-snapshot process:
 *
 *   baseline  - inspected BEFORE the implementation phase
 *   after     - inspected AFTER it
 *
 * The difference is what the implementation is answerable for. Without a
 * baseline, a repository that was already dirty would read as though the agent
 * had changed those files, and drift would be reported against work nobody did.
 */

export interface VerificationInput {
  runId: string;
  /** UNTRUSTED. Whatever the implementation agent said it did. */
  claimedSummary?: string;
  claimedFiles?: readonly string[];
  /** UNTRUSTED. A commit SHA the agent claims to have created. */
  claimedCommit?: string | null;
  /** Snapshot taken before implementation, when one was captured. */
  baseline?: RepositoryEvidence | null;
  /** The scope a human approved at the plan gate. */
  allowedScope?: readonly string[];
  /** How many project checks were declared, and how many actually ran. */
  checksDeclared?: number;
  checksExecuted?: number;
}

export interface VerificationResult {
  report: TImplementationReport;
  evidence: TReviewEvidence;
  /** The raw post-implementation observation, when inspection succeeded. */
  observed: RepositoryEvidence | null;
  failure: InspectionFailure | null;
}

export class RepositoryVerifier {
  constructor(private readonly inspector: RepositoryInspector) {}

  /** The pre-implementation snapshot. Returns null if the repo cannot be read. */
  async captureBaseline(): Promise<RepositoryEvidence | null> {
    const outcome = await this.inspector.inspect();
    return outcome.ok ? outcome.evidence : null;
  }

  /**
   * Re-inspect and produce an independently-derived report plus review evidence.
   *
   * @param input the run's claims and the approved scope
   */
  async verify(input: VerificationInput): Promise<VerificationResult> {
    const createdAt = new Date().toISOString();
    const claimedFiles = [...new Set((input.claimedFiles ?? []).map(normalisePath))]
      .filter(Boolean).sort();
    const allowedScope = [...(input.allowedScope ?? [])];

    const outcome = await this.inspector.inspect();

    // ---- inspection failed: nothing is verified --------------------------
    if (!outcome.ok) {
      const report = ImplementationReport.parse({
        runId: input.runId,
        claimedSummary: input.claimedSummary ?? "",
        claimedFiles,
        // Observed fields stay empty. There is deliberately no fallback here.
        observedDiff: null,
        observedFiles: [],
        observedCommits: [],
        verifiedIndependently: false,
        createdAt,
      });
      const evidence = ReviewEvidence.parse({
        runId: input.runId,
        inspectionSucceeded: false,
        failure: outcome.failure,
        baselineCaptured: input.baseline != null,
        claims: ClaimComparison.parse({
          claimedFiles, observedFiles: [],
          claimedButNotObserved: claimedFiles, observedButNotClaimed: [],
          matches: false,
        }),
        scope: classifyScope([], allowedScope),
        allowedScope,
        checksDeclared: input.checksDeclared ?? 0,
        checksExecuted: input.checksExecuted ?? 0,
        notes: [
          `repository inspection failed (${outcome.failure.code}); no observation ` +
            "was collected, so nothing in this run is independently verified.",
        ],
        createdAt,
      });
      return { report, evidence, observed: null, failure: outcome.failure };
    }

    // ---- inspection succeeded --------------------------------------------
    const after = outcome.evidence;
    const baseline = input.baseline ?? null;
    const notes: string[] = [];

    const observedFiles = [...after.changedFiles].map(normalisePath).sort();
    const baselineFiles = new Set((baseline?.changedFiles ?? []).map(normalisePath));

    // What is attributable to the implementation vs what was already dirty.
    const attributable = baseline
      ? observedFiles.filter((f) => !baselineFiles.has(f))
      : observedFiles;
    const preExisting = baseline
      ? observedFiles.filter((f) => baselineFiles.has(f))
      : [];
    if (!baseline) {
      notes.push(
        "no pre-implementation baseline was captured; every currently changed file " +
          "is treated as attributable, which may overstate what this run did.",
      );
    } else if (preExisting.length > 0) {
      notes.push(
        `${preExisting.length} file(s) were already modified before this run and are ` +
          "excluded from scope-drift attribution.",
      );
    }

    // Commits observed in git - never taken from a claim.
    const headBefore = baseline?.headCommit ?? null;
    const headAfter = after.headCommit ?? null;
    let newCommits: GitCommit[] = [];
    if (headBefore && headAfter && headBefore !== headAfter) {
      newCommits = await this.inspector.commitsSince(headBefore);
    } else if (!headBefore && headAfter) {
      // First commit in a previously-unborn repository.
      newCommits = after.recentCommits.slice(0, 1);
      notes.push("repository had no commits at baseline; HEAD now exists.");
    }

    // A claimed commit is checked against git, not believed.
    let claimedCommitExists: boolean | null = null;
    if (input.claimedCommit) {
      claimedCommitExists = await this.inspector.commitExists(input.claimedCommit);
      if (!claimedCommitExists) {
        notes.push(
          `claimed commit "${input.claimedCommit}" does not exist in the repository.`,
        );
      }
    }

    const driftBasis = baseline ? "attributable" : "all_changes";
    const scope = classifyScope(attributable, allowedScope);
    if (scope.emptyScope && attributable.length > 0) {
      notes.push(
        "the approved plan authorised no paths, so every changed file is reported " +
          "as scope drift.",
      );
    }

    const sensitiveChanged = observedFiles.filter((f) => classifySensitivity(f).sensitive);
    if (sensitiveChanged.length > 0) {
      notes.push(
        `${sensitiveChanged.length} sensitive file(s) changed; names recorded, ` +
          "contents deliberately not captured.",
      );
    }

    const claims = compareClaims(claimedFiles, observedFiles);
    if (claims.claimedButNotObserved.length > 0) {
      notes.push(
        `${claims.claimedButNotObserved.length} claimed file(s) show no change in git.`,
      );
    }
    if (claims.observedButNotClaimed.length > 0) {
      notes.push(
        `${claims.observedButNotClaimed.length} changed file(s) were not claimed.`,
      );
    }

    /**
     * The ONLY place `verifiedIndependently` becomes true.
     *
     * It asserts one narrow thing: the observed fields below were produced by
     * our own inspection of the real repository. It does NOT assert that the
     * implementation was correct, in scope, or complete - those are separate
     * questions answered by the evidence, not by this flag.
     */
    const verifiedIndependently = true;

    const report = ImplementationReport.parse({
      runId: input.runId,
      claimedSummary: input.claimedSummary ?? "",
      claimedFiles,
      observedDiff: after.diff?.text ?? null,
      observedFiles,
      observedCommits: newCommits.map((c) => c.sha),
      verifiedIndependently,
      createdAt,
    });

    const evidence = ReviewEvidence.parse({
      runId: input.runId,
      inspectionSucceeded: true,
      failure: null,
      baselineCaptured: baseline != null,
      claims,
      attributableFiles: attributable,
      preExistingChanges: preExisting,
      scope,
      allowedScope,
      driftBasis,
      newCommits,
      headCommitBefore: headBefore,
      headCommitAfter: headAfter,
      claimedCommitExists,
      workingTreeClean: after.clean,
      sensitiveFilesChanged: sensitiveChanged,
      checksDeclared: input.checksDeclared ?? 0,
      checksExecuted: input.checksExecuted ?? 0,
      notes: [...notes, ...after.notes],
      createdAt,
    });

    return { report, evidence, observed: after, failure: null };
  }
}

/** Pure set arithmetic over two path lists. */
export function compareClaims(
  claimedFiles: readonly string[],
  observedFiles: readonly string[],
): ClaimComparison {
  const claimed = new Set(claimedFiles.map(normalisePath));
  const observed = new Set(observedFiles.map(normalisePath));
  const claimedButNotObserved = [...claimed].filter((f) => !observed.has(f)).sort();
  const observedButNotClaimed = [...observed].filter((f) => !claimed.has(f)).sort();
  return ClaimComparison.parse({
    claimedFiles: [...claimed].sort(),
    observedFiles: [...observed].sort(),
    claimedButNotObserved,
    observedButNotClaimed,
    matches: claimedButNotObserved.length === 0 && observedButNotClaimed.length === 0,
  });
}
