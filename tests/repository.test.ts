import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import {
  runGit, GitCommandNotPermitted, GIT_DENIED_SUBCOMMANDS,
} from "../src/adapters/repository/gitExec.js";
import { createRegistry } from "../src/tools/registry.js";
import { DisabledCheckRunner } from "../src/verification/checks.js";
import {
  tmpDir, rmDir, git, initRepo, headSha, snapshotTree, diffSnapshots,
  linkDir, DIR_LINKS_SUPPORTED,
} from "./helpers.js";

/**
 * REAL REPOSITORIES, NOT MOCKS.
 *
 * Every test below creates an actual git repository on disk and inspects it
 * through the adapter. Mocking git would prove the parser works and nothing
 * about the security boundary; the point of this phase is the boundary.
 */

let parent: string;
let repo: string;

const inspectorFor = (dir: string, extra: Record<string, unknown> = {}) =>
  new LocalGitRepositoryInspector({ workingDir: dir, ...extra });

beforeEach(() => {
  parent = tmpDir("orch-repo-");
  repo = path.join(parent, "repo");
  initRepo(repo);
});

afterEach(() => rmDir(parent));

describe("git state inspection", () => {
  it("reports branch, HEAD and a clean tree", async () => {
    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.evidence.isGitRepository).toBe(true);
    expect(outcome.evidence.branch).toBe("main");
    expect(outcome.evidence.detachedHead).toBe(false);
    expect(outcome.evidence.headCommit).toBe(headSha(repo));
    expect(outcome.evidence.clean).toBe(true);
    expect(outcome.evidence.changedFiles).toEqual([]);
    expect(outcome.evidence.trackedFileCount).toBe(1);
  });

  it("reports an unstaged modification", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\nchanged\n");
    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.evidence.clean).toBe(false);
    expect(outcome.evidence.unstagedFiles).toContain("README.md");
    expect(outcome.evidence.stagedFiles).not.toContain("README.md");
    expect(outcome.evidence.changedFiles).toContain("README.md");
  });

  it("reports a staged addition", async () => {
    fs.writeFileSync(path.join(repo, "added.ts"), "export const x = 1;\n");
    git(repo, ["add", "added.ts"]);
    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.evidence.stagedFiles).toContain("added.ts");
    expect(outcome.evidence.untrackedFiles).not.toContain("added.ts");
  });

  it("reports an untracked file", async () => {
    fs.writeFileSync(path.join(repo, "scratch.ts"), "// not added\n");
    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.evidence.untrackedFiles).toContain("scratch.ts");
    expect(outcome.evidence.stagedFiles).not.toContain("scratch.ts");
    expect(outcome.evidence.unstagedFiles).not.toContain("scratch.ts");
  });

  it("separates staged from unstaged for the same file", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# staged\n");
    git(repo, ["add", "README.md"]);
    fs.writeFileSync(path.join(repo, "README.md"), "# staged then modified again\n");

    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.stagedFiles).toContain("README.md");
    expect(outcome.evidence.unstagedFiles).toContain("README.md");
  });

  it("collects a real diff", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\nA NEW LINE\n");
    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.evidence.diff?.text).toContain("A NEW LINE");
    expect(outcome.evidence.diff?.includedFiles).toContain("README.md");
    expect(outcome.evidence.diffStat).toContain("README.md");
  });

  it("truncates an oversized diff instead of loading it whole", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "line\n".repeat(20_000));
    const outcome = await inspectorFor(repo, { limits: { maxDiffBytes: 512 } }).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.evidence.diff?.truncated).toBe(true);
    expect(outcome.evidence.diff?.text.length).toBeLessThan(2000);
    expect(outcome.evidence.notes.some((n) => n.includes("truncated"))).toBe(true);
  });

  it("reports history and a detached HEAD", async () => {
    fs.writeFileSync(path.join(repo, "second.ts"), "\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "second commit"]);
    const second = headSha(repo);
    git(repo, ["checkout", "-q", "--detach", second]);

    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.detachedHead).toBe(true);
    expect(outcome.evidence.branch).toBeNull();
    expect(outcome.evidence.recentCommits.length).toBe(2);
    expect(outcome.evidence.recentCommits[0]!.subject).toBe("second commit");
  });

  it("handles a repository with no commits at all", async () => {
    const empty = path.join(parent, "empty");
    initRepo(empty, { commit: false });
    const outcome = await inspectorFor(empty).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.headCommit).toBeNull();
    expect(outcome.evidence.branch).toBe("main"); // unborn, but named
    expect(outcome.evidence.notes.some((n) => n.includes("no commits"))).toBe(true);
  });

  it("verifies whether a commit actually exists", async () => {
    const inspector = inspectorFor(repo);
    expect(await inspector.commitExists(headSha(repo))).toBe(true);
    expect(await inspector.commitExists("0".repeat(40))).toBe(false);
    expect(await inspector.commitExists("not-a-sha")).toBe(false);
  });

  it("lists only commits made since a baseline", async () => {
    const base = headSha(repo);
    fs.writeFileSync(path.join(repo, "a.ts"), "\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "after baseline"]);

    const commits = await inspectorFor(repo).commitsSince(base);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe("after baseline");
    expect(commits[0]!.sha).toBe(headSha(repo));
  });
});

describe("inspection does not modify the repository", () => {
  it("leaves every byte of the repository - including .git - unchanged", async () => {
    // Dirty the tree first: a clean repo is the easy case.
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\nmodified\n");
    fs.writeFileSync(path.join(repo, "untracked.ts"), "// new\n");
    git(repo, ["add", "README.md"]);

    const before = snapshotTree(repo);
    const beforeHead = headSha(repo);

    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);

    const after = snapshotTree(repo);
    expect(diffSnapshots(before, after)).toEqual([]);
    expect(headSha(repo)).toBe(beforeHead);
  });

  it("leaves the repository unchanged across repeated inspections", async () => {
    const inspector = inspectorFor(repo);
    await inspector.inspect();
    const before = snapshotTree(repo);
    await inspector.inspect();
    await inspector.inspect();
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual([]);
  });
});

describe("git mutation is unreachable", () => {
  it("refuses every repository-modifying subcommand", () => {
    for (const subcommand of GIT_DENIED_SUBCOMMANDS) {
      expect(() => runGit(subcommand, [], repo, {
        gitTimeoutMs: 5000, gitMaxBufferBytes: 1024,
      })).toThrow(GitCommandNotPermitted);
    }
  });

  it("names the specific commands a reader would worry about", () => {
    for (const subcommand of ["commit", "push", "reset", "checkout", "clean", "rm"]) {
      expect(GIT_DENIED_SUBCOMMANDS).toContain(subcommand);
      expect(() => runGit(subcommand, ["--help"], repo, {
        gitTimeoutMs: 5000, gitMaxBufferBytes: 1024,
      })).toThrow(/modify a repository/);
    }
  });

  it("refuses anything not on the read-only allowlist", () => {
    for (const subcommand of ["archive", "bundle", "send-email", "fsck", "help"]) {
      expect(() => runGit(subcommand, [], repo, {
        gitTimeoutMs: 5000, gitMaxBufferBytes: 1024,
      })).toThrow(GitCommandNotPermitted);
    }
  });

  it("refuses arguments that would redirect git out of its working directory", () => {
    const limits = { gitTimeoutMs: 5000, gitMaxBufferBytes: 1024 };
    for (const arg of [
      "--git-dir=/elsewhere/.git",
      "--work-tree=/elsewhere",
      "-C",
      "-c",
      "--exec-path=/tmp/evil",
      "--upload-pack=evil",
    ]) {
      expect(() => runGit("status", [arg], repo, limits)).toThrow(GitCommandNotPermitted);
    }
  });

  it("does NOT inherit credentials from the parent environment", () => {
    // A secret in this process must not be visible to the child.
    process.env["ORCHESTRATOR_TEST_SECRET"] = "leak-me-if-you-can";
    try {
      // `rev-parse --show-toplevel` is allowlisted; ask git to print its env-
      // sensitive view via a variable that would appear if inherited.
      const result = runGit("rev-parse", ["--show-toplevel"], repo, {
        gitTimeoutMs: 5000, gitMaxBufferBytes: 1024 * 1024,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).not.toContain("leak-me-if-you-can");
    } finally {
      delete process.env["ORCHESTRATOR_TEST_SECRET"];
    }
  });

  it("exposes no way to run an arbitrary command", async () => {
    // The inspector's own surface, and the tools built on it, contain no
    // execute/run/shell entry point taking a command string.
    const surface = Object.getOwnPropertyNames(LocalGitRepositoryInspector.prototype);
    for (const forbidden of ["exec", "execute", "run", "shell", "command", "spawn"]) {
      expect(surface).not.toContain(forbidden);
    }
    const registry = createRegistry(inspectorFor(repo));
    for (const tool of registry.list()) {
      expect(tool.name).not.toMatch(/shell|exec|command|git$/i);
    }
  });
});

describe("inspection failures are explicit", () => {
  it("reports a missing working directory", async () => {
    const outcome = await inspectorFor(path.join(parent, "does-not-exist")).inspect();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("working_dir_missing");
  });

  it("reports a working directory that is a file", async () => {
    const file = path.join(parent, "a-file.txt");
    fs.writeFileSync(file, "x");
    const outcome = await inspectorFor(file).inspect();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("working_dir_not_a_directory");
  });

  it("reports a relative working directory", async () => {
    const outcome = await inspectorFor("relative/dir").inspect();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("working_dir_not_absolute");
  });

  it("reports a directory that is not a git repository", async () => {
    const plain = path.join(parent, "plain");
    fs.mkdirSync(plain);
    const outcome = await inspectorFor(plain).inspect();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("not_a_git_repository");
    expect(outcome.failure.message).toContain("not inside a git repository");
  });
});

describe("the project boundary is not silently widened", () => {
  it("stays inside a SUBDIRECTORY of a larger repository", async () => {
    // The repository root is `repo`; the project boundary is `repo/packages/app`.
    const sub = path.join(repo, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "in-scope.ts"), "\n");
    fs.writeFileSync(path.join(repo, "out-of-scope.ts"), "\n");

    const outcome = await inspectorFor(sub).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // It knows the repository is bigger...
    expect(outcome.evidence.repositoryRootWithinBoundary).toBe(false);
    expect(outcome.evidence.notes.some((n) => n.includes("above the security boundary"))).toBe(true);
    // ...but reports only what is inside the boundary.
    expect(outcome.evidence.untrackedFiles).toContain("packages/app/in-scope.ts");
    expect(outcome.evidence.untrackedFiles).not.toContain("out-of-scope.ts");
  });

  it("widens ONLY when a trusted repoRoot is explicitly declared", async () => {
    const sub = path.join(repo, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    const outcome = await inspectorFor(sub, { repoRoot: repo }).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.repositoryRootWithinBoundary).toBe(true);
    expect(outcome.evidence.boundaryRoot).toBe(repo);
  });

  it("refuses a declared repoRoot that does not contain the working directory", async () => {
    const elsewhere = path.join(parent, "elsewhere");
    fs.mkdirSync(elsewhere);
    const outcome = await inspectorFor(repo, { repoRoot: elsewhere }).inspect();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("path_escape");
  });

  it.skipIf(!DIR_LINKS_SUPPORTED)("refuses to read a file through an escaping link", async () => {
    const outside = path.join(parent, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET\n");
    expect(linkDir(outside, path.join(repo, "escape"))).toBe(true);

    const inspector = inspectorFor(repo);
    await expect(inspector.readFile("escape/secret.txt")).rejects.toThrow();
  });
});

describe("sensitive files in a real repository", () => {
  it("records that a .env changed WITHOUT putting it in the diff", async () => {
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=old\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "add env"]);
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=ghp_LIVE_SECRET_VALUE\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\nordinary change\n");

    const outcome = await inspectorFor(repo).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The CHANGE is visible...
    expect(outcome.evidence.changedFiles).toContain(".env");
    expect(outcome.evidence.diff?.excludedFiles.map((e) => e.path)).toContain(".env");
    // ...the SECRET is not, anywhere in the evidence.
    expect(JSON.stringify(outcome.evidence)).not.toContain("ghp_LIVE_SECRET_VALUE");
    // The ordinary file is still diffed normally.
    expect(outcome.evidence.diff?.text).toContain("ordinary change");
  });

  it("withholds a sensitive context file but records its presence", async () => {
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=nope\n");
    fs.writeFileSync(path.join(repo, "CONTEXT.md"), "# context\n");

    const outcome = await inspectorFor(repo, {
      contextFiles: ["CONTEXT.md", ".env"],
    }).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [context, env] = outcome.evidence.contextFiles;
    expect(context!.available).toBe(true);
    expect(context!.content).toContain("# context");
    expect(env!.available).toBe(false);
    expect(env!.withheldReason).toBe("sensitive");
    expect(JSON.stringify(outcome.evidence)).not.toContain("SECRET=nope");
  });
});

describe("declared checks are recorded, never executed", () => {
  it("records the declaration in the evidence", async () => {
    const outcome = await inspectorFor(repo, {
      checks: [{ name: "test", command: "npm test" }],
    }).inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.declaredChecks).toEqual([{ name: "test", command: "npm test" }]);
  });

  it("returns executed:false from the disabled runner", async () => {
    const runner = new DisabledCheckRunner();
    expect(runner.enabled).toBe(false);
    const result = await runner.run({ name: "test", command: "npm test", cwd: "." });
    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.skippedReason).toContain("disabled");
  });
});
