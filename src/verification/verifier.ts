import type { RepositoryInspector } from "../domain/inspector.js";
import type {
  RepositoryEvidence, InspectionFailure, GitCommit,
} from "../domain/repository.js";
import { GitMutationObservation } from "../domain/repository.js";
import {
  ImplementationReport, type ImplementationReport as TImplementationReport,
} from "../domain/reports.js";
import {
  ReviewEvidence, ClaimComparison, type ReviewEvidence as TReviewEvidence,
} from "../domain/evidence.js";
import { classifyScope, normalisePath } from "../domain/scope.js";
import { attributeChanges, AttributionSummary } from "../domain/attribution.js";
import type { FileFingerprint, AttributionSummary as TAttributionSummary } from "../domain/attribution.js";
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
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION COMPARES STATE, NOT FILENAMES
 * ---------------------------------------------------------------------------
 * The two snapshots are compared by CONTENT FINGERPRINT, git status code and
 * existence - not by differencing two lists of paths. That earlier approach had
 * a hole big enough to hide the entire run's work in:
 *
 *   a file dirty at baseline AND modified further by the run stayed in both
 *   sets, so the set difference was empty and the change was written off as
 *   "pre-existing"
 *
 * Real repositories are dirty when work starts. The fix is better evidence, not
 * refusing to inspect them - so a dirty tree is fully supported and
 * `verifiedIndependently` does NOT depend on the tree being clean. See
 * domain/attribution.ts.
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

  /**
   * Build the attribution verdict from two snapshots.
   *
   * The subtlety is which paths to fingerprint AFTER the run. It is not enough
   * to look at what is dirty now: a file the run DELETED, COMMITTED or REVERTED
   * has left the status listing altogether, and would be invisible. So the
   * "after" fingerprints are taken over the UNION of both snapshots' paths plus
   * anything the run committed - each of those is re-stat'ed on disk, which is
   * what makes deletions and reverts detectable at all.
   */
  private async attribute(
    baseline: RepositoryEvidence | null,
    after: RepositoryEvidence,
    committedPaths: readonly string[],
  ): Promise<TAttributionSummary> {
    if (!baseline) return attributeChanges(null, after.fingerprints, committedPaths);

    const afterByPath = new Map(after.fingerprints.map((f) => [normalisePath(f.path), f]));
    const missing = [
      ...new Set(
        [...baseline.fingerprints.map((f) => f.path), ...committedPaths]
          .map(normalisePath)
          .filter((p) => !afterByPath.has(p)),
      ),
    ];

    let afterFingerprints: FileFingerprint[] = after.fingerprints;
    if (missing.length > 0) {
      // Re-fingerprint the paths that vanished from the status listing.
      afterFingerprints = [...after.fingerprints, ...(await this.inspector.fingerprintPaths(missing))];
    }

    return attributeChanges(baseline.fingerprints, afterFingerprints, committedPaths);
  }

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
        observedDiffBasis: "none",
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
        attribution: AttributionSummary.parse({ baselineAvailable: input.baseline != null }),
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

    // ---- commits observed in git - never taken from a claim ---------------
    const headBefore = baseline?.headCommit ?? null;
    const headAfter = after.headCommit ?? null;
    let newCommits: GitCommit[] = [];
    let committedPaths: string[] = [];
    if (headBefore && headAfter && headBefore !== headAfter) {
      newCommits = await this.inspector.commitsSince(headBefore);
      // Work the run COMMITTED has left the status listing entirely. Without
      // this it would look as though those files were never touched.
      committedPaths = (await this.inspector.changedFilesSince(headBefore)).map(normalisePath);
    } else if (!headBefore && headAfter) {
      // First commit in a previously-unborn repository.
      newCommits = after.recentCommits.slice(0, 1);
      notes.push("repository had no commits at baseline; HEAD now exists.");
    }

    /**
     * DID GIT ITSELF MOVE?
     *
     * Asked separately from "what is dirty now", because the two answers come
     * apart in exactly the case that matters: an agent that writes, stages and
     * commits leaves a CLEAN working tree. `changedFiles` is then empty and
     * every dirty-tree signal reports nothing.
     *
     * HEAD, the checked-out ref and the commit list do not go quiet like that.
     * This records the observation only - whether it was ALLOWED is decided
     * from the granted capabilities, which the verifier deliberately does not
     * see. Observation and authorisation stay separate.
     */
    const mutationReasons: string[] = [];
    const headChanged = headBefore !== headAfter;
    if (headChanged) {
      mutationReasons.push(
        headBefore === null
          ? `HEAD did not exist at baseline and is now ${String(headAfter)}`
          : `HEAD moved from ${headBefore} to ${String(headAfter)}`,
      );
    }
    const branchBefore = baseline?.branch ?? null;
    const branchAfter = after.branch ?? null;
    // Only meaningful when a baseline recorded a ref to compare against.
    const branchChanged = baseline != null && branchBefore !== branchAfter;
    if (branchChanged) {
      mutationReasons.push(
        `checked-out ref changed from ${branchBefore ?? "(none)"} to ${branchAfter ?? "(none)"}`,
      );
    }
    if (newCommits.length > 0) {
      mutationReasons.push(
        `${newCommits.length} commit(s) exist now that did not at baseline`,
      );
    }
    const gitMutation = GitMutationObservation.parse({
      detected: headChanged || branchChanged || newCommits.length > 0,
      headChanged, headBefore, headAfter,
      branchChanged, branchBefore, branchAfter,
      newCommits: newCommits.map((c) => c.sha),
      reasons: mutationReasons,
    });
    if (gitMutation.detected) {
      notes.push(
        "git state moved during this attempt; this is observed from HEAD and the " +
        "commit list, and does not depend on the working tree being dirty.",
      );
    }

    // ---- attribution: compare STATE, not filenames -------------------------
    const attribution = await this.attribute(baseline, after, committedPaths);
    const attributable = attribution.attributable;
    const preExisting = attribution.preExisting;
    notes.push(...attribution.notes);
    if (attribution.modifiedDuringRun.length > 0 && preExisting.length > 0) {
      notes.push(
        `${preExisting.length} file(s) were dirty before this run and are unchanged ` +
          `since; ${attribution.modifiedDuringRun.length} changed during it.`,
      );
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

    /**
     * SENSITIVE DETECTION RUNS OVER THE ATTRIBUTED CHANGE SET, NOT THE DIRTY LIST.
     *
     * Filtering `observedFiles` - what is dirty at the end - misses every shape
     * where the file LEAVES that listing:
     *
     *   delete .env                -> gone from the working tree entirely
     *   rename secrets.json        -> the old path no longer exists
     *   modify .env then commit    -> committed, so the tree is clean again
     *
     * Each of those is a sensitive file changed by this run, and each would have
     * read as "no sensitive change". Attribution already tracks these shapes -
     * it re-stats paths that vanished from the status listing - so the honest
     * question is "did any attributable change touch a sensitive path", asked
     * over every source of attribution at once.
     *
     * Paths only. No sensitive content is read, hashed or recorded here.
     */
    const sensitiveCandidates = new Set<string>([
      ...observedFiles,
      ...attributable,
      ...attribution.renamed.flatMap((r) => [normalisePath(r.from), normalisePath(r.to)]),
      // Files carried into a commit during this run: invisible to git status.
      ...committedPaths,
    ].map(normalisePath).filter(Boolean));
    const sensitiveChanged = [...sensitiveCandidates]
      .filter((f) => classifySensitivity(f).sensitive)
      .sort();
    if (sensitiveChanged.length > 0) {
      notes.push(
        `${sensitiveChanged.length} sensitive file(s) were changed by this run - ` +
          "including any deleted, renamed or committed, which leave the working-tree " +
          "listing entirely. Names recorded, contents deliberately not captured.",
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

    /**
     * THE DIFF MUST NOT OVERSTATE THE RUN.
     *
     * `after.diff` is the WHOLE working tree against HEAD. On a repository that
     * was already dirty that includes a colleague's uncommitted work, and
     * presenting it as `observedDiff` would attribute their changes to this
     * run. So the diff is regenerated for the attributable paths only, from the
     * baseline commit - which also picks up anything the run committed.
     */
    let observedDiff: string | null = null;
    let observedDiffBasis: "attributable" | "all_changes" | "none" = "none";
    if (baseline && attributable.length > 0) {
      const scoped = await this.inspector.diffFor(attributable, headBefore);
      observedDiff = scoped.text;
      observedDiffBasis = "attributable";
      if (scoped.excludedFiles.length > 0) {
        notes.push(
          `${scoped.excludedFiles.length} sensitive file(s) excluded from the ` +
            "attributable diff; their names are recorded, their contents are not.",
        );
      }
    } else if (!baseline) {
      // No baseline: we cannot attribute, so the diff is labelled as covering
      // everything rather than silently passed off as the run's work.
      observedDiff = after.diff?.text ?? null;
      observedDiffBasis = observedDiff === null ? "none" : "all_changes";
    }

    const report = ImplementationReport.parse({
      runId: input.runId,
      claimedSummary: input.claimedSummary ?? "",
      claimedFiles,
      observedDiff,
      observedDiffBasis,
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
      attribution,
      attributableFiles: attributable,
      preExistingChanges: preExisting,
      introducedFiles: attribution.introduced,
      modifiedDuringRunFiles: attribution.modifiedDuringRun,
      removedFiles: attribution.removed,
      renamedFiles: attribution.renamed,
      restoredFiles: attribution.restored,
      scope,
      allowedScope,
      driftBasis,
      newCommits,
      headCommitBefore: headBefore,
      headCommitAfter: headAfter,
      gitMutation,
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
