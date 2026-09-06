import type {
  InspectionOutcome, FileContent, DirectoryListing, FileMetadata, GitCommit,
  DiffEvidence,
} from "./repository.js";
import type { FileFingerprint } from "./attribution.js";

/**
 * THE REPOSITORY INSPECTION INTERFACE
 *
 * The core - workflow nodes, verification, review - depends on this, never on
 * git. That keeps command construction and filesystem logic out of the graph
 * (where it would be untestable and scattered) and confined to one adapter.
 *
 * Every method is read-only BY CONSTRUCTION: there is no write, commit, stage,
 * branch or push method to call. A future phase that needs write capability
 * must add a separate, differently-risk-classified interface - it cannot get
 * there by passing a cleverer argument to this one.
 *
 *   Workflow  ->  RepositoryInspector  ->  LocalGitRepositoryInspector
 */
export interface RepositoryInspector {
  /** The security boundary every operation is confined to. */
  readonly boundaryRoot: string;

  /**
   * One complete read-only pass. Returns a structured failure rather than
   * throwing, so an incomplete inspection is a value the workflow must handle
   * and cannot silently ignore.
   */
  inspect(): Promise<InspectionOutcome>;

  statPath(relativePath: string): Promise<FileMetadata | null>;
  readFile(relativePath: string): Promise<FileContent>;
  listDirectory(relativePath?: string): Promise<DirectoryListing>;

  /** Does this commit actually exist in the repository? */
  commitExists(sha: string): Promise<boolean>;
  /** Commits reachable from HEAD but not from `baseSha`. */
  commitsSince(baseSha: string): Promise<GitCommit[]>;

  /**
   * Fingerprint specific paths, whether or not they still exist.
   *
   * Needed at verification time for paths the BASELINE knew about that are no
   * longer dirty - a file that was deleted, committed, or reverted leaves the
   * status listing entirely, and only re-fingerprinting it can tell those apart
   * from "nothing happened".
   */
  fingerprintPaths(paths: readonly string[]): Promise<FileFingerprint[]>;

  /** Paths touched by commits reachable from HEAD but not from `baseSha`. */
  changedFilesSince(baseSha: string): Promise<string[]>;

  /**
   * A diff restricted to specific paths, optionally against an older commit.
   *
   * This is how `observedDiff` is kept honest: it is generated for the
   * ATTRIBUTABLE paths only, so a repository full of someone else's uncommitted
   * work cannot be presented as the output of this run.
   */
  diffFor(paths: readonly string[], baseSha?: string | null): Promise<DiffEvidence>;
}
