import { spawnSync } from "node:child_process";
import type { InspectionLimits } from "../../security/limits.js";

/**
 * THE GIT READ-ONLY BOUNDARY
 *
 * This module is the ONLY place in the orchestrator that starts a process. Four
 * properties make that acceptable, and all four are enforced here rather than
 * trusted to callers:
 *
 *   1. NO SHELL. `spawnSync` with `shell: false` and an argv array. There is no
 *      string that gets parsed by cmd.exe or /bin/sh, so quoting, `;`, `&&`,
 *      backticks and globs have no meaning. A malicious filename is an
 *      argument, not a command.
 *
 *   2. NO ARBITRARY COMMAND. The executable is hard-coded to `git`. There is no
 *      `exec(command)` export and no way to pass one - deliberately. The
 *      subcommand must appear in ALLOWED_SUBCOMMANDS below, which contains only
 *      read-only plumbing and porcelain.
 *
 *   3. NO MUTATION. Every repository-modifying subcommand is absent from the
 *      allowlist, and DENIED_SUBCOMMANDS re-states the important ones so a
 *      rejection says why. `--no-optional-locks` additionally stops `status`
 *      from refreshing the on-disk index, so inspection leaves no trace at all.
 *
 *   4. NO INHERITED SECRETS. The child's environment is BUILT, not inherited.
 *      An `ANTHROPIC_API_KEY` or `GITHUB_TOKEN` in the parent process is not
 *      visible to git, and neither are `GIT_DIR` / `GIT_WORK_TREE`, which could
 *      otherwise redirect the command outside the boundary.
 *
 * Arguments are always constructed by trusted adapter code. Nothing model-
 * generated reaches this file; the validation below exists so that stays true
 * even if a later caller is careless.
 */

/** Read-only subcommands. Adding to this list is a security decision. */
const ALLOWED_SUBCOMMANDS = new Set([
  "rev-parse",
  "status",
  "diff",
  "log",
  "ls-files",
  "cat-file",
  "rev-list",
  "symbolic-ref",
  "show-ref",
  "version",
]);

/**
 * Mutating subcommands, listed explicitly so a rejection explains itself.
 *
 * Not the security mechanism - the allowlist is. This is documentation that
 * fails loudly. Note `branch` and `config` appear here even though they can
 * read: `branch -D` deletes and `config --global` writes, so neither is safe to
 * expose. Branch information comes from `rev-parse` and `symbolic-ref` instead.
 */
const DENIED_SUBCOMMANDS = new Set([
  "add", "commit", "push", "pull", "fetch", "clone", "init", "merge", "rebase",
  "reset", "checkout", "switch", "restore", "clean", "rm", "mv", "apply", "am",
  "cherry-pick", "revert", "stash", "tag", "branch", "remote", "submodule",
  "worktree", "config", "gc", "prune", "repack", "notes", "update-ref",
  "update-index", "write-tree", "commit-tree", "hash-object", "filter-branch",
  "sparse-checkout", "bisect", "replace", "reflog", "daemon", "credential",
]);

/**
 * Argument prefixes that would move git outside the directory we chose or make
 * it run something else. Rejected wherever they appear.
 */
const FORBIDDEN_ARG_PREFIXES = [
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "--upload-pack",
  "--receive-pack",
  "-C",
  "-c",
];

export class GitCommandNotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCommandNotPermitted";
  }
}

export class GitUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`git is not available: ${detail}`);
    this.name = "GitUnavailable";
  }
}

export interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A minimal, fixed environment.
 *
 * Only what git genuinely needs to start. Everything else - including every
 * credential in the parent environment - is dropped.
 */
function safeEnv(): NodeJS.ProcessEnv {
  const passthrough = ["PATH", "Path", "SystemRoot", "windir", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Never prompt, never hit the network, never take a lock, stable output.
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ASKPASS"] = "";
  env["SSH_ASKPASS"] = "";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_PAGER"] = "cat";
  env["LC_ALL"] = "C";
  return env;
}

function validate(subcommand: string, args: readonly string[]): void {
  if (DENIED_SUBCOMMANDS.has(subcommand)) {
    throw new GitCommandNotPermitted(
      `git "${subcommand}" can modify a repository and is not available to the inspector.`,
    );
  }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GitCommandNotPermitted(
      `git "${subcommand}" is not on the read-only allowlist.`,
    );
  }
  for (const arg of args) {
    const forbidden = FORBIDDEN_ARG_PREFIXES.find(
      (prefix) => arg === prefix || arg.startsWith(`${prefix}=`),
    );
    if (forbidden !== undefined) {
      throw new GitCommandNotPermitted(
        `git argument "${arg}" could redirect the command outside its working directory.`,
      );
    }
  }
}

/**
 * Run one allowlisted, read-only git subcommand in `cwd`.
 *
 * `cwd` must already have been validated by the caller's FsBoundary - this
 * function does not resolve paths, it only refuses to run anything that could
 * escape whatever directory it is given.
 */
export function runGit(
  subcommand: string,
  args: readonly string[],
  cwd: string,
  limits: Pick<InspectionLimits, "gitTimeoutMs" | "gitMaxBufferBytes">,
): GitResult {
  validate(subcommand, args);

  const result = spawnSync(
    "git",
    ["--no-pager", "--no-optional-locks", subcommand, ...args],
    {
      cwd,
      env: safeEnv(),
      shell: false, // no shell interpretation, ever
      encoding: "utf8",
      timeout: limits.gitTimeoutMs,
      maxBuffer: limits.gitMaxBufferBytes,
      windowsHide: true,
    },
  );

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new GitUnavailable("the git executable was not found on PATH");
    if (code === "ETIMEDOUT") {
      return { ok: false, status: null, stdout: "", stderr: "timed out", timedOut: true };
    }
    // Output exceeded maxBuffer. A bounded failure, not a crash: the caller
    // retries with a narrower query rather than loading an unbounded result.
    if (code === "ENOBUFS") {
      return {
        ok: false, status: null, stdout: "",
        stderr: `output exceeded the ${limits.gitMaxBufferBytes}-byte limit`,
        timedOut: false,
      };
    }
    throw new GitUnavailable(result.error.message);
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: false,
  };
}

/** Exported for tests: the exact surface the inspector is allowed to use. */
export const GIT_READ_ONLY_SUBCOMMANDS: readonly string[] = [...ALLOWED_SUBCOMMANDS].sort();
export const GIT_DENIED_SUBCOMMANDS: readonly string[] = [...DENIED_SUBCOMMANDS].sort();
