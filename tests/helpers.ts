import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/** A fresh temp directory. Callers are responsible for removing it. */
export function tmpDir(prefix: string): string {
  // realpath so the test's own root matches what FsBoundary canonicalises to.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Remove a temp directory, tolerating Windows file locking.
 *
 * A child process launched by the adapter has its cwd INSIDE these directories,
 * and Windows refuses to delete a directory any process still holds - briefly,
 * even after that process has exited. Under load the existing 250ms of retries
 * was not always enough, and teardown started failing tests that had already
 * passed every assertion.
 *
 * So: retry harder, then give up QUIETLY. A leftover temp directory is reclaimed
 * by the OS and means nothing; failing a suite over it would be reporting a
 * cleanup detail as a product defect. Anything the test actually cared about has
 * already been asserted by this point.
 */
export function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw error;
  }
}

/**
 * Create a link to a DIRECTORY.
 *
 * On Windows a real symlink needs SeCreateSymbolicLinkPrivilege, but a
 * directory JUNCTION does not - and a junction is exactly as dangerous, since
 * `realpathSync` follows it out of the boundary just the same. So the escape
 * tests below run on an ordinary Windows box, using whichever primitive is
 * available.
 */
export function linkDir(target: string, linkPath: string): boolean {
  for (const type of ["dir", "junction"] as const) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch {
      // try the next primitive
    }
  }
  return false;
}

/** Create a link to a FILE. Needs privilege on Windows; may legitimately fail. */
export function linkFile(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

/** Whether this machine can create directory links at all. */
export const DIR_LINKS_SUPPORTED = ((): boolean => {
  const probe = tmpDir("link-probe-");
  try {
    const target = path.join(probe, "target");
    fs.mkdirSync(target);
    return linkDir(target, path.join(probe, "link"));
  } finally {
    rmDir(probe);
  }
})();

export const FILE_LINKS_SUPPORTED = ((): boolean => {
  const probe = tmpDir("flink-probe-");
  try {
    const target = path.join(probe, "target.txt");
    fs.writeFileSync(target, "x");
    return linkFile(target, path.join(probe, "link.txt"));
  } finally {
    rmDir(probe);
  }
})();

// ---- real git repositories -------------------------------------------------

/** Run git directly, for FIXTURE setup only - never through the inspector. */
export function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

/** An initialised repository with one commit, identity configured locally. */
export function initRepo(dir: string, opts: { commit?: boolean } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Orchestrator Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  // Without this, Windows converts LF to CRLF on checkout and a freshly
  // committed file can read as modified - which would make "clean tree"
  // assertions machine-dependent.
  git(dir, ["config", "core.autocrlf", "false"]);
  if (opts.commit !== false) {
    fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial commit"]);
  }
  return dir;
}

export function headSha(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * A content-addressed snapshot of every file under `dir`, INCLUDING `.git`.
 *
 * Used to prove that inspection mutates nothing: a read-only pass must leave
 * this map byte-identical.
 */
export function snapshotTree(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        snapshot.set(`${rel}/`, "dir");
        walk(full);
      } else if (entry.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        snapshot.set(rel, hash);
      } else {
        snapshot.set(rel, "other");
      }
    }
  };
  walk(dir);
  return snapshot;
}

export function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const differences: string[] = [];
  for (const [key, value] of before) {
    if (!after.has(key)) differences.push(`removed: ${key}`);
    else if (after.get(key) !== value) differences.push(`changed: ${key}`);
  }
  for (const key of after.keys()) {
    if (!before.has(key)) differences.push(`added: ${key}`);
  }
  return differences;
}
