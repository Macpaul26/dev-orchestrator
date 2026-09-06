import path from "node:path";
import { FsBoundary, BoundaryRootError, SymlinkEscapeError } from "../../security/fsBoundary.js";
import { PathEscapeError } from "../../persistence/paths.js";
import { SafeFs } from "../../security/safeFs.js";
import { classifySensitivity } from "../../security/sensitive.js";
import { resolveLimits, type InspectionLimits } from "../../security/limits.js";
import { runGit, GitUnavailable, GitCommandNotPermitted } from "./gitExec.js";
import type { RepositoryInspector } from "../../domain/inspector.js";
import { FileFingerprint, type FileFingerprint as TFileFingerprint } from "../../domain/attribution.js";
import {
  RepositoryEvidence, InspectionFailure, GitCommit,
  type InspectionOutcome, type FileContent, type DirectoryListing,
  type FileMetadata, type GitFileChange, type GitCommit as TGitCommit,
  type DiffEvidence, type InspectionFailureCode,
} from "../../domain/repository.js";

/**
 * LOCAL GIT REPOSITORY INSPECTOR
 *
 * The concrete adapter behind `RepositoryInspector`. It knows about git and the
 * filesystem; nothing above it does.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY DECISION (see docs/PHASE-3.md)
 * ---------------------------------------------------------------------------
 * `project.workingDir` IS the security boundary. If the git repository extends
 * above it - workingDir is a subdirectory of a larger repo - the scope is NOT
 * silently widened. Instead:
 *
 *   - every git command runs with `cwd = workingDir` and the pathspec `.`, so
 *     only changes at or below the boundary are reported;
 *   - `repositoryRootWithinBoundary: false` records that we saw part of a
 *     repository, not all of it.
 *
 * A project may widen the boundary only by DECLARING it: `project.repoRoot`.
 * That is a human editing project.json - not something the workflow, and
 * certainly not a model, can do.
 */

export interface LocalInspectorConfig {
  /** Absolute path to the working copy. The security boundary by default. */
  workingDir: string;
  /**
   * Explicitly declared trusted repository root. When set it becomes the
   * boundary and MUST contain workingDir. Absent = workingDir is the boundary.
   */
  repoRoot?: string | null;
  /** Trusted configuration only; clamped to CEILINGS. Never model-supplied. */
  limits?: Partial<InspectionLimits>;
  /** Project-declared context files, relative to workingDir. */
  contextFiles?: readonly string[];
  /** Project-declared checks. RECORDED ONLY - this phase never executes them. */
  checks?: readonly { name: string; command: string }[];
}

/** Cap on pathspecs passed to one git invocation, to bound the command line. */
const MAX_DIFF_PATHSPECS = 200;

export class LocalGitRepositoryInspector implements RepositoryInspector {
  private readonly limits: InspectionLimits;
  private readonly declaredRoot: string;

  constructor(private readonly config: LocalInspectorConfig) {
    this.limits = resolveLimits(config.limits ?? {});
    this.declaredRoot = config.repoRoot ?? config.workingDir;
  }

  get boundaryRoot(): string {
    return this.declaredRoot;
  }

  // ---- public interface ----------------------------------------------------

  async inspect(): Promise<InspectionOutcome> {
    const prepared = this.prepare();
    if ("failure" in prepared) return { ok: false, failure: prepared.failure };
    const { fs: safe, workingDir } = prepared;

    try {
      return this.collect(safe, workingDir);
    } catch (error) {
      return { ok: false, failure: toFailure(error) };
    }
  }

  async statPath(relativePath: string): Promise<FileMetadata | null> {
    return this.requireFs().stat(relativePath);
  }

  async readFile(relativePath: string): Promise<FileContent> {
    return this.requireFs().readTextFile(relativePath);
  }

  async listDirectory(relativePath = "."): Promise<DirectoryListing> {
    return this.requireFs().listDirectory(relativePath);
  }

  async commitExists(sha: string): Promise<boolean> {
    if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) return false;
    const prepared = this.prepare();
    if ("failure" in prepared) return false;
    // `cat-file -e` exits 0 if the object exists and is a commit. Read-only.
    return this.git(prepared.workingDir, "cat-file", ["-e", `${sha}^{commit}`]).ok;
  }

  async commitsSince(baseSha: string): Promise<TGitCommit[]> {
    if (!/^[0-9a-fA-F]{4,64}$/.test(baseSha)) return [];
    const prepared = this.prepare();
    if ("failure" in prepared) return [];
    const result = this.git(prepared.workingDir, "rev-list", [
      `--max-count=${this.limits.maxCommits}`,
      "--format=%H%x1f%s%x1f%aI",
      `${baseSha}..HEAD`,
    ]);
    if (!result.ok) return [];
    return parseCommits(result.stdout);
  }

  /**
   * Fingerprint specific paths, existing or not.
   *
   * Verification needs this for paths the BASELINE knew about that have since
   * left the status listing: deleted, committed, or reverted. Without
   * re-fingerprinting them, all three look identical to "nothing happened".
   */
  async fingerprintPaths(paths: readonly string[]): Promise<TFileFingerprint[]> {
    const prepared = this.prepare();
    if ("failure" in prepared) return [];
    return this.collectFingerprints(prepared.fs, paths, [], prepared.workingDir).fingerprints;
  }

  /** Paths touched by commits made since `baseSha`. */
  async changedFilesSince(baseSha: string): Promise<string[]> {
    if (!/^[0-9a-fA-F]{4,64}$/.test(baseSha)) return [];
    const prepared = this.prepare();
    if ("failure" in prepared) return [];
    const result = this.git(prepared.workingDir, "diff", [
      "--name-only", "-z", `${baseSha}..HEAD`, "--", ".",
    ]);
    if (!result.ok) return [];
    return result.stdout.split("\0").filter(Boolean).slice(0, this.limits.maxListedFiles);
  }

  /**
   * A diff limited to specific paths, optionally spanning back to `baseSha`.
   *
   * `baseSha` matters: when the run created commits, its changes are no longer
   * in `git diff HEAD` at all. Diffing from the BASELINE commit captures
   * committed and uncommitted work together, which is what "what did this run
   * do" actually means.
   */
  async diffFor(
    paths: readonly string[],
    baseSha: string | null = null,
  ): Promise<DiffEvidence> {
    const prepared = this.prepare();
    if ("failure" in prepared) {
      return { text: "", bytes: 0, truncated: false, includedFiles: [], excludedFiles: [] };
    }
    return this.diffForPaths(prepared.workingDir, paths, baseSha);
  }

  // ---- setup and validation ------------------------------------------------

  /**
   * Validate the declared paths and build the boundary.
   *
   * Every path problem is turned into a structured failure code here, so the
   * rest of the class can assume a valid, contained working directory.
   */
  private prepare():
    | { fs: SafeFs; workingDir: string; boundary: FsBoundary }
    | { failure: InspectionFailure } {
    const { workingDir } = this.config;

    if (!path.isAbsolute(workingDir)) {
      return {
        failure: fail("working_dir_not_absolute", `workingDir "${workingDir}" is not absolute.`),
      };
    }

    let boundary: FsBoundary;
    try {
      boundary = FsBoundary.create(this.declaredRoot);
    } catch (error) {
      if (error instanceof BoundaryRootError) {
        const map: Record<BoundaryRootError["code"], InspectionFailureCode> = {
          not_absolute: "working_dir_not_absolute",
          missing: "working_dir_missing",
          not_a_directory: "working_dir_not_a_directory",
          unreadable: "working_dir_unreadable",
        };
        return { failure: fail(map[error.code], error.message) };
      }
      return { failure: toFailure(error) };
    }

    // A declared repoRoot only counts if it genuinely contains workingDir.
    let resolvedWorkingDir: string;
    try {
      resolvedWorkingDir = boundary.resolve(workingDir).absolute;
    } catch (error) {
      return {
        failure: fail(
          error instanceof SymlinkEscapeError ? "symlink_escape" : "path_escape",
          `workingDir "${workingDir}" is not inside the declared boundary ` +
            `"${boundary.root}": ${(error as Error).message}`,
        ),
      };
    }

    const safe = new SafeFs(boundary, this.limits);
    const meta = safe.stat(resolvedWorkingDir);
    if (!meta) return { failure: fail("working_dir_missing", `"${workingDir}" does not exist.`) };
    if (meta.kind !== "directory") {
      return { failure: fail("working_dir_not_a_directory", `"${workingDir}" is not a directory.`) };
    }

    return { fs: safe, workingDir: resolvedWorkingDir, boundary };
  }

  private requireFs(): SafeFs {
    const prepared = this.prepare();
    if ("failure" in prepared) {
      throw new Error(`${prepared.failure.code}: ${prepared.failure.message}`);
    }
    return prepared.fs;
  }

  private git(cwd: string, subcommand: string, args: readonly string[]) {
    return runGit(subcommand, args, cwd, this.limits);
  }

  // ---- the inspection pass -------------------------------------------------

  private collect(safe: SafeFs, workingDir: string): InspectionOutcome {
    const notes: string[] = [];

    // git present at all?
    try {
      this.git(workingDir, "version", []);
    } catch (error) {
      if (error instanceof GitUnavailable) {
        return { ok: false, failure: fail("git_unavailable", error.message) };
      }
      throw error;
    }

    const topLevel = this.git(workingDir, "rev-parse", ["--show-toplevel"]);
    if (!topLevel.ok) {
      return {
        ok: false,
        failure: fail(
          "not_a_git_repository",
          `"${workingDir}" is not inside a git repository.`,
          topLevel.stderr.trim() || null,
        ),
      };
    }
    const repositoryRoot = path.resolve(topLevel.stdout.trim());
    const rootWithinBoundary = safe.boundary.contains(repositoryRoot);
    if (!rootWithinBoundary) {
      notes.push(
        `repository root "${repositoryRoot}" is above the security boundary ` +
          `"${safe.boundary.root}"; inspection is limited to the boundary.`,
      );
    }

    // ---- HEAD ------------------------------------------------------------
    const headResult = this.git(workingDir, "rev-parse", ["HEAD"]);
    const headCommit = headResult.ok ? headResult.stdout.trim() : null;
    if (!headCommit) notes.push("repository has no commits yet (unborn HEAD).");

    const abbrev = this.git(workingDir, "rev-parse", ["--abbrev-ref", "HEAD"]);
    let branch: string | null = abbrev.ok ? abbrev.stdout.trim() : null;
    let detachedHead = false;
    if (branch === "HEAD") {
      detachedHead = true;
      branch = null;
    }
    if (branch === null && !detachedHead) {
      // Unborn branch: HEAD points at a ref that does not exist yet.
      const symbolic = this.git(workingDir, "symbolic-ref", ["--short", "HEAD"]);
      if (symbolic.ok) branch = symbolic.stdout.trim();
    }

    // ---- working tree status ---------------------------------------------
    // Pathspec "." keeps reporting inside the boundary even when the repository
    // extends above it.
    let status = this.git(workingDir, "status", [
      "--porcelain=v1", "-z", "--untracked-files=all", "--", ".",
    ]);
    if (!status.ok) {
      // Usually an unbounded untracked listing. Fall back to git's own default,
      // which collapses untracked directories into a single entry.
      const fallback = this.git(workingDir, "status", [
        "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".",
      ]);
      if (!fallback.ok) {
        return {
          ok: false,
          failure: fail("git_failed", "git status failed.", status.stderr.trim() || null),
        };
      }
      notes.push("untracked listing collapsed to directories: the full listing exceeded limits.");
      status = fallback;
    }

    const changes = parseStatus(status.stdout);
    const staged = changes.filter((c) => c.staged).map((c) => c.path);
    const unstaged = changes.filter((c) => c.unstaged).map((c) => c.path);
    const untracked = changes.filter((c) => c.untracked).map((c) => c.path);
    const changedFiles = [...new Set(changes.map((c) => c.path))].sort();

    // ---- diff -------------------------------------------------------------
    const { diff, diffNotes } = this.collectDiff(workingDir, changes, headCommit !== null);
    notes.push(...diffNotes);

    const statResult = this.git(
      workingDir,
      "diff",
      headCommit ? ["--stat", headCommit, "--", "."] : ["--stat", "--", "."],
    );
    const diffStat = statResult.ok ? truncate(statResult.stdout, 8 * 1024).text : null;

    // ---- history ----------------------------------------------------------
    let recentCommits: TGitCommit[] = [];
    if (headCommit) {
      const log = this.git(workingDir, "log", [
        `--max-count=${this.limits.maxCommits}`,
        "--format=%H%x1f%s%x1f%aI",
      ]);
      if (log.ok) recentCommits = parseCommits(log.stdout);
    }

    // ---- tracked files -----------------------------------------------------
    let trackedFileCount = 0;
    let trackedFilesTruncated = false;
    const tracked = this.git(workingDir, "ls-files", ["-z", "--", "."]);
    if (tracked.ok) {
      const all = tracked.stdout.split("\0").filter(Boolean);
      trackedFileCount = Math.min(all.length, this.limits.maxListedFiles);
      trackedFilesTruncated = all.length > this.limits.maxListedFiles;
    } else {
      notes.push("tracked-file listing unavailable.");
    }

    // ---- project context files --------------------------------------------
    const contextFiles = (this.config.contextFiles ?? []).map((file) => {
      try {
        return safe.readTextFile(file);
      } catch (error) {
        // A context file that escapes the boundary is a configuration error,
        // surfaced as a withheld file rather than crashing the whole pass.
        notes.push(`context file "${file}" rejected: ${(error as Error).message}`);
        return {
          path: file, available: false as const, withheldReason: "unreadable" as const,
          detail: "outside the project boundary", content: null, bytes: 0, truncated: false,
        };
      }
    });

    // ---- fingerprints for attribution -------------------------------------
    // Taken over every dirty path, so a later snapshot can tell "changed
    // further" apart from "still dirty in the same way".
    const fingerprinted = this.collectFingerprints(safe, changedFiles, changes, workingDir);
    if (fingerprinted.truncated) {
      notes.push(
        `fingerprints limited to ${this.limits.maxFingerprintedFiles} paths; ` +
          "attribution for the remainder will be less precise.",
      );
    }

    const evidence = RepositoryEvidence.parse({
      collectedAt: new Date().toISOString(),
      boundaryRoot: safe.boundary.root,
      workingDir,
      isGitRepository: true,
      repositoryRoot,
      repositoryRootWithinBoundary: rootWithinBoundary,
      branch,
      detachedHead,
      headCommit,
      clean: changes.length === 0,
      stagedFiles: staged,
      unstagedFiles: unstaged,
      untrackedFiles: untracked,
      changedFiles,
      changes,
      diff,
      diffStat,
      fingerprints: fingerprinted.fingerprints,
      fingerprintsTruncated: fingerprinted.truncated,
      recentCommits,
      trackedFileCount,
      trackedFilesTruncated,
      contextFiles,
      declaredChecks: (this.config.checks ?? []).map((c) => ({ name: c.name, command: c.command })),
      limits: this.limits,
      notes,
    });

    return { ok: true, evidence };
  }

  /**
   * Fingerprint a set of paths, bounded by `maxFingerprintedFiles`.
   *
   * `changes` supplies the git status code for each path so a fingerprint
   * records not just the bytes but WHERE the change lives - a file can move
   * between index and worktree with identical content, and that is still
   * something this run did.
   */
  private collectFingerprints(
    safe: SafeFs,
    paths: readonly string[],
    changes: readonly GitFileChange[],
    workingDir?: string,
  ): { fingerprints: TFileFingerprint[]; truncated: boolean } {
    const byPath = new Map(changes.map((c) => [c.path, c]));
    const unique = [...new Set(paths)].sort();
    const capped = unique.slice(0, this.limits.maxFingerprintedFiles);

    const fingerprints = capped.flatMap((relative) => {
      let fingerprint: TFileFingerprint;
      try {
        fingerprint = safe.fingerprint(relative);
      } catch {
        // Outside the boundary - it cannot be ours, and must not be inspected.
        return [];
      }
      const status = byPath.get(relative);
      // For a path that is GONE from disk, ask git for the blob id its HEAD
      // version had. That is an identifier, not content - nothing is read back
      // out of the repository - and it is what makes a rename recognisable
      // after the original file has already been removed.
      const headBlobSha =
        !fingerprint.present && workingDir ? this.headBlobShaFor(workingDir, relative) : null;

      return [
        FileFingerprint.parse({
          ...fingerprint,
          headBlobSha,
          statusCode: status?.code ?? null,
          staged: status?.staged ?? false,
          unstaged: status?.unstaged ?? false,
          untracked: status?.untracked ?? false,
          renamedFrom: status?.renamedFrom ?? null,
        }),
      ];
    });

    return { fingerprints, truncated: unique.length > capped.length };
  }

  /**
   * The git blob id of `relative` as it exists at HEAD, or null.
   *
   * `rev-parse HEAD:<path>` returns an object id and nothing else - no file
   * contents cross this boundary, so this is safe even for a path the
   * sensitive-file policy forbids reading.
   */
  private headBlobShaFor(workingDir: string, relative: string): string | null {
    const result = this.git(workingDir, "rev-parse", [`HEAD:${relative}`]);
    if (!result.ok) return null;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  /**
   * Build a diff for an explicit path list, dropping sensitive paths.
   *
   * Shared by the inspection pass and by `diffFor`, so there is exactly one
   * place where paths become diff text - and therefore one place where the
   * sensitive-file exclusion has to hold.
   */
  private diffForPaths(
    workingDir: string,
    paths: readonly string[],
    baseSha: string | null,
  ): DiffEvidence {
    const excluded: { path: string; reason: string }[] = [];
    const included: string[] = [];

    for (const candidate of [...new Set(paths)].sort()) {
      const verdict = classifySensitivity(candidate);
      if (verdict.sensitive) {
        excluded.push({ path: candidate, reason: verdict.detail ?? "sensitive file" });
      } else {
        included.push(candidate);
      }
    }

    const empty: DiffEvidence = {
      text: "", bytes: 0, truncated: false, includedFiles: [], excludedFiles: excluded,
    };
    if (included.length === 0) return empty;

    const pathspecs = included.slice(0, MAX_DIFF_PATHSPECS);
    const args = baseSha ? [baseSha, "--", ...pathspecs] : ["HEAD", "--", ...pathspecs];
    const result = this.git(workingDir, "diff", args);
    if (!result.ok) return empty;

    const { text, truncated } = truncate(result.stdout, this.limits.maxDiffBytes);
    return {
      text,
      bytes: Buffer.byteLength(result.stdout, "utf8"),
      truncated,
      includedFiles: pathspecs,
      excludedFiles: excluded,
    };
  }

  /**
   * Collect a diff over changed paths, EXCLUDING sensitive ones.
   *
   * The exclusion is why the diff is built from an explicit pathspec list
   * instead of a bare `git diff`: a bare diff of a modified `.env` would put
   * the credential straight into the checkpoint and the audit log. Excluded
   * paths are still reported - by name - so the change is not hidden.
   */
  private collectDiff(
    workingDir: string,
    changes: readonly GitFileChange[],
    hasHead: boolean,
  ): { diff: DiffEvidence | null; diffNotes: string[] } {
    const notes: string[] = [];
    const excluded: { path: string; reason: string }[] = [];
    const included: string[] = [];

    for (const change of changes) {
      if (change.untracked) continue; // untracked contents are never diffed
      const verdict = classifySensitivity(change.path);
      if (verdict.sensitive) {
        excluded.push({ path: change.path, reason: verdict.detail ?? "sensitive file" });
      } else {
        included.push(change.path);
      }
    }

    if (excluded.length > 0) {
      notes.push(
        `${excluded.length} sensitive file(s) changed; their names are recorded but ` +
          "their contents were excluded from the diff.",
      );
    }
    if (included.length === 0) {
      return {
        diff: { text: "", bytes: 0, truncated: false, includedFiles: [], excludedFiles: excluded },
        diffNotes: notes,
      };
    }

    let pathspecs = included;
    if (pathspecs.length > MAX_DIFF_PATHSPECS) {
      pathspecs = pathspecs.slice(0, MAX_DIFF_PATHSPECS);
      notes.push(
        `diff limited to the first ${MAX_DIFF_PATHSPECS} of ${included.length} changed files.`,
      );
    }

    // `git diff HEAD` covers staged and unstaged together. Without a HEAD (a
    // repository with no commits) only the index comparison is meaningful.
    const args = hasHead
      ? ["HEAD", "--", ...pathspecs]
      : ["--cached", "--", ...pathspecs];
    const result = this.git(workingDir, "diff", args);
    if (!result.ok) {
      notes.push(`diff unavailable: ${result.stderr.trim() || "git diff failed"}`);
      return {
        diff: { text: "", bytes: 0, truncated: false, includedFiles: [], excludedFiles: excluded },
        diffNotes: notes,
      };
    }

    const { text, truncated } = truncate(result.stdout, this.limits.maxDiffBytes);
    if (truncated) notes.push(`diff truncated at ${this.limits.maxDiffBytes} bytes.`);

    return {
      diff: {
        text,
        bytes: Buffer.byteLength(result.stdout, "utf8"),
        truncated,
        includedFiles: pathspecs,
        excludedFiles: excluded,
      },
      diffNotes: notes,
    };
  }
}

// ---- helpers ---------------------------------------------------------------

function fail(
  code: InspectionFailureCode,
  message: string,
  detail: string | null = null,
): InspectionFailure {
  return InspectionFailure.parse({ code, message, detail });
}

function toFailure(error: unknown): InspectionFailure {
  if (error instanceof GitUnavailable) return fail("git_unavailable", error.message);
  if (error instanceof GitCommandNotPermitted) return fail("git_failed", error.message);
  if (error instanceof SymlinkEscapeError) return fail("symlink_escape", error.message);
  if (error instanceof PathEscapeError) return fail("path_escape", error.message);
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return fail("permission_denied", (error as Error).message);
  }
  return fail("git_failed", error instanceof Error ? error.message : String(error));
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n[truncated]`, truncated: true };
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated so paths containing spaces, quotes or newlines survive intact.
 * A rename or copy record is followed by a second NUL-terminated token holding
 * the original path, which is why this is a while loop and not a map.
 */
export function parseStatus(stdout: string): GitFileChange[] {
  const tokens = stdout.split("\0");
  const changes: GitFileChange[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    if (!record || record.length < 3) continue;

    const index = record[0] ?? " ";
    const worktree = record[1] ?? " ";
    const filePath = record.slice(3);
    const untracked = index === "?" && worktree === "?";

    let renamedFrom: string | null = null;
    if (index === "R" || index === "C") {
      const original = tokens[i + 1];
      if (original) {
        renamedFrom = original;
        i += 1;
      }
    }

    changes.push({
      path: filePath,
      code: `${index}${worktree}`,
      staged: !untracked && index !== " " && index !== "?",
      unstaged: !untracked && worktree !== " " && worktree !== "?",
      untracked,
      renamedFrom,
    });
  }
  return changes;
}

/**
 * Parse `--format=%H<US>%s<US>%aI` output.
 *
 * The unit separator (0x1f) is the field delimiter because a commit subject can
 * contain anything a human types - tabs, pipes, quotes - but not a control
 * character. Lines without one are skipped, which discards the extra
 * `commit <sha>` header that `rev-list --format` emits.
 */
const UNIT_SEPARATOR = "\u001f";

export function parseCommits(stdout: string): TGitCommit[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(UNIT_SEPARATOR))
    .map((line) => {
      const [sha = "", subject = "", authorDate = ""] = line.split(UNIT_SEPARATOR);
      return GitCommit.parse({ sha, subject, authorDate });
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha));
}
