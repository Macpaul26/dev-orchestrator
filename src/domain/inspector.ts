import type {
  InspectionOutcome, FileContent, DirectoryListing, FileMetadata, GitCommit,
} from "./repository.js";

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
}
