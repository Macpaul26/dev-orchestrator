import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier } from "../src/verification/verifier.js";
import {
  gitArgvFor, runGit, GitCommandNotPermitted,
  GIT_SAFETY_FLAGS, GIT_CONFIG_OVERRIDES,
} from "../src/adapters/repository/gitExec.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * GIT MUST NOT BECOME A LAUNCHER.
 *
 * `shell: false` controls how WE start git. It says nothing about what git then
 * starts. Git executes programs named in configuration, and a repository we are
 * merely INSPECTING owns its `.git/config` and `.gitattributes`:
 *
 *     [diff "x"] command  = <anything>      -> run by `git diff`
 *     [diff "y"] textconv = <anything>      -> run by `git diff`
 *     [core]     fsmonitor = <anything>     -> run by `git status`
 *
 * `GIT_CONFIG_NOSYSTEM=1` does NOT help: it suppresses the SYSTEM config, and
 * these live in the repository.
 *
 * ---------------------------------------------------------------------------
 * EVERY TEST BELOW CARRIES A POSITIVE CONTROL.
 * ---------------------------------------------------------------------------
 * An assertion that "the marker file was not created" passes trivially if the
 * fixture never worked - if `sh` is missing, if the config key is misspelled,
 * if git ignored the driver. So each test FIRST proves the attack fires against
 * plain git, then deletes the marker, then proves it does not fire through the
 * inspector. A broken fixture fails the control and the test fails loudly.
 */

let parent: string;
let repo: string;

/** Forward slashes: this string is interpreted by a shell, and `\` escapes. */
const shPath = (p: string): string => p.split(path.sep).join("/");

/** A git config value that creates `marker` when git runs it. */
const markerCommand = (marker: string): string => `touch '${shPath(marker)}'`;

const inspector = () => new LocalGitRepositoryInspector({ workingDir: repo });

beforeEach(() => {
  parent = tmpDir("orch-hard-");
  repo = path.join(parent, "repo");
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "file.txt"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add file"]);
});

afterEach(() => rmDir(parent));

describe("the invocation carries the protection", () => {
  it("forces --no-ext-diff and --no-textconv onto diff", () => {
    const argv = gitArgvFor("diff", ["HEAD", "--", "a.ts"]);
    expect(argv).toContain("--no-ext-diff");
    expect(argv).toContain("--no-textconv");
  });

  it("forces them onto log too, so adding -p later cannot reopen the hole", () => {
    const argv = gitArgvFor("log", ["--format=%H"]);
    expect(argv).toContain("--no-ext-diff");
    expect(argv).toContain("--no-textconv");
  });

  it("places the safety flags AFTER the subcommand and BEFORE caller arguments", () => {
    const argv = gitArgvFor("diff", ["HEAD"]);
    const subcommand = argv.indexOf("diff");
    expect(argv.indexOf("--no-ext-diff")).toBeGreaterThan(subcommand);
    expect(argv.indexOf("--no-textconv")).toBeGreaterThan(subcommand);
    expect(argv.indexOf("HEAD")).toBeGreaterThan(argv.indexOf("--no-textconv"));
  });

  it("pins the config settings that execute programs outside the diff machinery", () => {
    const argv = gitArgvFor("status", ["--porcelain"]);
    expect(argv.join(" ")).toContain("-c core.fsmonitor=");
    expect(argv.join(" ")).toContain("-c diff.external=");
    expect(GIT_CONFIG_OVERRIDES).toContain("core.fsmonitor=");
  });

  it("still refuses a CALLER-supplied -c, which is what keeps that position trusted", () => {
    const limits = { gitTimeoutMs: 5000, gitMaxBufferBytes: 65536 };
    expect(() => runGit("diff", ["-c", "diff.external=evil"], repo, limits))
      .toThrow(GitCommandNotPermitted);
    expect(() => runGit("status", ["-c", "core.fsmonitor=evil"], repo, limits))
      .toThrow(GitCommandNotPermitted);
  });

  it("declares safety flags only for the subcommands that need them", () => {
    expect(Object.keys(GIT_SAFETY_FLAGS).sort()).toEqual(["diff", "log"]);
  });
});

describe("a hostile repository cannot make the inspector run a program", () => {
  it("blocks an external diff driver selected through .gitattributes", async () => {
    const marker = path.join(parent, "MARKER_EXTDIFF");
    git(repo, ["config", "diff.evil.command", markerCommand(marker)]);
    fs.writeFileSync(path.join(repo, ".gitattributes"), "file.txt diff=evil\n");
    fs.writeFileSync(path.join(repo, "file.txt"), "hello changed\n");

    // ---- POSITIVE CONTROL: prove the attack really fires ----
    git(repo, ["diff", "HEAD", "--", "file.txt"]);
    expect(
      fs.existsSync(marker),
      "fixture is broken: plain git did not run the external diff driver, so " +
      "the negative assertion below would prove nothing",
    ).toBe(true);
    fs.rmSync(marker);

    // ---- the inspector must NOT ----
    const outcome = await inspector().inspect();
    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks a textconv driver", async () => {
    const marker = path.join(parent, "MARKER_TEXTCONV");
    git(repo, ["config", "diff.tc.textconv", markerCommand(marker)]);
    fs.writeFileSync(path.join(repo, ".gitattributes"), "file.txt diff=tc\n");
    fs.writeFileSync(path.join(repo, "file.txt"), "hello changed\n");

    git(repo, ["diff", "HEAD", "--", "file.txt"]);
    expect(
      fs.existsSync(marker),
      "fixture is broken: plain git did not run the textconv driver",
    ).toBe(true);
    fs.rmSync(marker);

    const outcome = await inspector().inspect();
    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks diff.external, which applies to every diff without .gitattributes", async () => {
    const marker = path.join(parent, "MARKER_DIFF_EXTERNAL");
    git(repo, ["config", "diff.external", markerCommand(marker)]);
    fs.writeFileSync(path.join(repo, "file.txt"), "hello changed\n");

    git(repo, ["diff", "HEAD", "--", "file.txt"]);
    expect(
      fs.existsSync(marker),
      "fixture is broken: plain git did not run diff.external",
    ).toBe(true);
    fs.rmSync(marker);

    const outcome = await inspector().inspect();
    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks core.fsmonitor, which git runs during status rather than diff", async () => {
    const marker = path.join(parent, "MARKER_FSMONITOR");
    git(repo, ["config", "core.fsmonitor", markerCommand(marker)]);
    fs.writeFileSync(path.join(repo, "file.txt"), "hello changed\n");

    git(repo, ["status", "--porcelain"]);
    expect(
      fs.existsSync(marker),
      "fixture is broken: plain git did not run the fsmonitor hook",
    ).toBe(true);
    fs.rmSync(marker);

    const outcome = await inspector().inspect();
    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks it through the ATTRIBUTABLE diff path as well", async () => {
    // `diffFor` builds its own diff, so it needs the protection independently.
    const marker = path.join(parent, "MARKER_ATTRIBUTABLE");
    git(repo, ["config", "diff.external", markerCommand(marker)]);

    const verifier = new RepositoryVerifier(inspector());
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "file.txt"), "hello changed\n");

    git(repo, ["diff", "HEAD", "--", "file.txt"]);
    expect(fs.existsSync(marker), "fixture is broken").toBe(true);
    fs.rmSync(marker);

    const result = await verifier.verify({ runId: "run_h", baseline });
    expect(result.report.observedDiffBasis).toBe("attributable");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks it during a full workflow-style inspect + verify cycle", async () => {
    const marker = path.join(parent, "MARKER_CYCLE");
    git(repo, ["config", "diff.external", markerCommand(marker)]);
    git(repo, ["config", "core.fsmonitor", markerCommand(marker)]);
    git(repo, ["config", "diff.evil.textconv", markerCommand(marker)]);
    fs.writeFileSync(path.join(repo, ".gitattributes"), "* diff=evil\n");

    const verifier = new RepositoryVerifier(inspector());
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "file.txt"), "hello changed\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
    await verifier.verify({ runId: "run_cycle", baseline });

    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("the protection does not break diff", () => {
  it("still produces a real diff of a modified file", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "hello\nA_DISTINCTIVE_LINE\n");
    const outcome = await inspector().inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.diff?.text).toContain("A_DISTINCTIVE_LINE");
    expect(outcome.evidence.diffStat).toContain("file.txt");
  });

  it("still produces a correct ATTRIBUTABLE diff", async () => {
    const verifier = new RepositoryVerifier(inspector());
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "file.txt"), "hello\nATTRIBUTABLE_MARKER\n");

    const result = await verifier.verify({ runId: "run_ok", baseline });
    expect(result.report.observedDiffBasis).toBe("attributable");
    expect(result.report.observedDiff).toContain("ATTRIBUTABLE_MARKER");
  });

  it("still detects changed files and commits with the flags applied", async () => {
    const verifier = new RepositoryVerifier(inspector());
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "file.txt"), "committed change\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "a commit"]);

    const result = await verifier.verify({ runId: "run_commits", baseline });
    expect(result.report.observedCommits).toHaveLength(1);
    expect(result.evidence.attributableFiles).toContain("file.txt");
  });

  it("still withholds a sensitive file from the diff", async () => {
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "env"]);
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=STILL_MUST_NOT_LEAK\n");

    const outcome = await inspector().inspect();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence.changedFiles).toContain(".env");
    expect(JSON.stringify(outcome.evidence)).not.toContain("STILL_MUST_NOT_LEAK");
  });
});

describe("no second process-spawn site was introduced", () => {
  /**
   * THE CANONICAL PROCESS-SPAWN INVENTORY.
   *
   * Phase 3 asserted exactly one spawn site. Phase 4B.1 deliberately added a
   * second, and Task 005 deliberately adds a third - so this assertion is
   * UPDATED, not relaxed: the set stays exact, stays small, and stays enumerated
   * here, so a fourth cannot appear without someone editing this list and saying
   * why.
   *
   * The three are different in kind:
   *   gitExec            runs a program we trust, with arguments we build, and
   *                      constrains which subcommands are even possible.
   *   processBoundary    runs a program we do NOT trust, and constrains what it
   *                      is handed and what is believed afterwards.
   *   checkRunner        runs a program from TRUSTED CONFIGURATION captured
   *                      before the untrusted run, with a fixed argv nothing in
   *                      the run can influence - and re-inspects the repository
   *                      afterwards, because a check is executable code.
   *
   * All three are argv-only with `shell: false`. None accepts a command string.
   */
  it("keeps spawning confined to the three enumerated sites", () => {
    const root = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const source = fs.readFileSync(full, "utf8");
        const spawns = /\b(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/.test(source);
        const imports = /from "node:child_process"/.test(source);
        if (spawns || imports) {
          offenders.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    };
    walk(root);

    expect(offenders.sort()).toEqual([
      "adapters/claude-code/processBoundary.ts",
      "adapters/repository/gitExec.ts",
      "verification/checkRunner.ts",
    ]);
  });

  it("uses exactly one spawn call at each site, with shell disabled at all three", () => {
    const sites = [
      ["adapters/repository/gitExec.ts", "spawnSync"],
      ["adapters/claude-code/processBoundary.ts", "spawn"],
      ["verification/checkRunner.ts", "spawn"],
    ] as const;

    for (const [relative, fn] of sites) {
      const file = relative;
      const source = fs.readFileSync(
        path.resolve(__dirname, "..", "src", ...relative.split("/")),
        "utf8",
      );
      expect(source.match(new RegExp(`\\b${fn}\\(`, "g")), `${file}`).toHaveLength(1);
      expect(source, `${file}`).toContain("shell: false");
      expect(source, `${file}`).not.toMatch(/shell:\s*true/);
    }
  });

  it("never lets GIT_EXTERNAL_DIFF reach the child, because the env is a whitelist", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "adapters", "repository", "gitExec.ts"),
      "utf8",
    );
    // The env is built from a fixed passthrough list; this name appears nowhere.
    expect(source).not.toContain("GIT_EXTERNAL_DIFF");
    expect(source).toContain("const passthrough =");
  });
});
