import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier } from "../src/verification/verifier.js";
import type { RepositoryInspector } from "../src/domain/inspector.js";
import { attributeChanges, FileFingerprint } from "../src/domain/attribution.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * BASELINE / ATTRIBUTION INTEGRITY
 *
 * The regression these tests exist to prevent:
 *
 *   > A file that was ALREADY DIRTY at baseline is modified FURTHER during the
 *   > run, and the run's work is written off as "pre-existing".
 *
 * That is what happens if attribution differences two lists of FILENAMES. It
 * has to compare STATE.
 *
 * The standing requirement these tests also protect: a dirty repository is
 * fully supported. `verifiedIndependently` must NOT become false just because
 * someone had uncommitted work when the run started.
 */

let parent: string;
let repo: string;
let inspector: RepositoryInspector;
let verifier: RepositoryVerifier;

const write = (rel: string, body: string): void => {
  const target = path.join(repo, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
};

beforeEach(() => {
  parent = tmpDir("orch-attr-");
  repo = path.join(parent, "repo");
  initRepo(repo);
  inspector = new LocalGitRepositoryInspector({ workingDir: repo });
  verifier = new RepositoryVerifier(inspector);
});

afterEach(() => rmDir(parent));

describe("THE REGRESSION: a pre-existing dirty file changed further", () => {
  it("attributes the second change to the run", async () => {
    // 1. a tracked file, committed
    write("src/auth.ts", "export const version = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "add auth"]);

    // 2. someone's uncommitted work-in-progress, BEFORE the run
    write("src/auth.ts", "export const version = 1;\n// WIP by a human\n");

    // 3. baseline captured with the file already dirty
    const baseline = await verifier.captureBaseline();
    expect(baseline?.changedFiles).toContain("src/auth.ts");

    // 4. the run modifies the SAME file again
    write("src/auth.ts", "export const version = 2;\n// WIP by a human\n// added by the run\n");

    const result = await verifier.verify({
      runId: "run_regression", baseline, allowedScope: ["src/"],
    });

    // THE ASSERTION THAT USED TO FAIL.
    expect(result.evidence.attributableFiles).toContain("src/auth.ts");
    expect(result.evidence.modifiedDuringRunFiles).toContain("src/auth.ts");
    expect(result.evidence.preExistingChanges).not.toContain("src/auth.ts");

    const entry = result.evidence.attribution.entries.find((e) => e.path === "src/auth.ts");
    expect(entry?.kind).toBe("modified_during_run");
    expect(entry?.basis).toBe("content_hash");
    expect(entry?.evidence).toContain("already modified at baseline");
  });

  it("flags it as scope drift when the further change is outside the scope", async () => {
    write("notes.md", "original\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "notes"]);
    write("notes.md", "original\nhuman WIP\n"); // dirty before the run

    const baseline = await verifier.captureBaseline();
    write("notes.md", "original\nhuman WIP\nthe run wrote this\n"); // changed further

    const result = await verifier.verify({
      runId: "run_drift", baseline, allowedScope: ["src/"],
    });

    // A dirty file the run touched again is still the run's responsibility.
    expect(result.evidence.scope.drift).toContain("notes.md");
  });

  it("keeps verifiedIndependently TRUE on a dirty repository", async () => {
    // The fix must not be "refuse to verify when the tree is dirty".
    write("messy.ts", "dirty from the start\n");
    const baseline = await verifier.captureBaseline();
    write("messy.ts", "dirty, and changed again\n");
    write("another.ts", "and more mess\n");

    const result = await verifier.verify({ runId: "run_dirty", baseline });
    expect(result.report.verifiedIndependently).toBe(true);
    expect(result.evidence.inspectionSucceeded).toBe(true);
  });
});

describe("a pre-existing dirty file that is NOT touched", () => {
  it("is not attributable", async () => {
    write("untouched.ts", "someone else's work\n");
    const baseline = await verifier.captureBaseline();

    // The run changes something else entirely.
    write("src/mine.ts", "the run's work\n");

    const result = await verifier.verify({
      runId: "run_untouched", baseline, allowedScope: ["src/"],
    });

    expect(result.evidence.preExistingChanges).toContain("untouched.ts");
    expect(result.evidence.attributableFiles).not.toContain("untouched.ts");
    expect(result.evidence.attributableFiles).toContain("src/mine.ts");
    expect(result.evidence.scope.drift).toEqual([]);

    const entry = result.evidence.attribution.entries.find((e) => e.path === "untouched.ts");
    expect(entry?.kind).toBe("pre_existing");
    expect(entry?.attributable).toBe(false);
  });

  it("stays not-attributable even when its mtime is bumped without a content change", async () => {
    write("touched.ts", "content\n");
    const baseline = await verifier.captureBaseline();

    // Rewrite identical bytes: mtime moves, content does not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    write("touched.ts", "content\n");

    const result = await verifier.verify({ runId: "run_touch", baseline });
    // The content hash is what decides, so a bare touch is not a change.
    expect(result.evidence.preExistingChanges).toContain("touched.ts");
    expect(result.evidence.attributableFiles).not.toContain("touched.ts");
  });
});

describe("creation, deletion, rename", () => {
  it("attributes a newly created file", async () => {
    const baseline = await verifier.captureBaseline();
    write("brand-new.ts", "new\n");

    const result = await verifier.verify({ runId: "run_new", baseline });
    expect(result.evidence.introducedFiles).toContain("brand-new.ts");
    expect(result.evidence.attributableFiles).toContain("brand-new.ts");
  });

  it("attributes a deletion of a tracked file", async () => {
    write("doomed.ts", "delete me\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "add doomed"]);

    const baseline = await verifier.captureBaseline();
    expect(baseline?.clean).toBe(true);

    fs.rmSync(path.join(repo, "doomed.ts"));

    const result = await verifier.verify({ runId: "run_del", baseline });
    expect(result.evidence.removedFiles).toContain("doomed.ts");
    expect(result.evidence.attributableFiles).toContain("doomed.ts");
  });

  it("attributes a deletion of a file that was UNTRACKED and dirty at baseline", async () => {
    // The hard case: an untracked file that disappears leaves the status
    // listing entirely, so only re-fingerprinting the baseline's paths finds it.
    write("scratch.ts", "temporary\n");
    const baseline = await verifier.captureBaseline();
    expect(baseline?.untrackedFiles).toContain("scratch.ts");

    fs.rmSync(path.join(repo, "scratch.ts"));

    const result = await verifier.verify({ runId: "run_del2", baseline });
    expect(result.evidence.removedFiles).toContain("scratch.ts");
    expect(result.evidence.attributableFiles).toContain("scratch.ts");
  });

  it("represents a rename as a rename, not an unrelated add and delete", async () => {
    write("old-name.ts", "export const stable = true;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "add old-name"]);

    const baseline = await verifier.captureBaseline();

    fs.renameSync(path.join(repo, "old-name.ts"), path.join(repo, "new-name.ts"));

    const result = await verifier.verify({ runId: "run_rename", baseline });

    expect(result.evidence.renamedFiles).toContainEqual({
      from: "old-name.ts", to: "new-name.ts",
    });
    const entry = result.evidence.attribution.entries.find((e) => e.path === "new-name.ts");
    expect(entry?.kind).toBe("renamed");
    expect(entry?.renamedFrom).toBe("old-name.ts");
    expect(result.evidence.attributableFiles).toContain("new-name.ts");
  });

  it("attributes a revert of someone's pre-existing work", async () => {
    write("reverted.ts", "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    write("reverted.ts", "human WIP\n"); // dirty before the run

    const baseline = await verifier.captureBaseline();
    write("reverted.ts", "committed\n"); // the run undoes it

    const result = await verifier.verify({ runId: "run_revert", baseline });
    expect(result.evidence.restoredFiles).toContain("reverted.ts");
    expect(result.evidence.attributableFiles).toContain("reverted.ts");
  });
});

describe("staged / unstaged transitions", () => {
  it("attributes staging a pre-existing change even though the bytes are identical", async () => {
    write("staged.ts", "v1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "v1"]);
    write("staged.ts", "v2\n"); // unstaged change, before the run

    const baseline = await verifier.captureBaseline();
    expect(baseline?.unstagedFiles).toContain("staged.ts");

    git(repo, ["add", "staged.ts"]); // the run stages it - same bytes

    const result = await verifier.verify({ runId: "run_stage", baseline });
    expect(result.evidence.attributableFiles).toContain("staged.ts");

    const entry = result.evidence.attribution.entries.find((e) => e.path === "staged.ts");
    expect(entry?.kind).toBe("modified_during_run");
    expect(entry?.indexStateOnly).toBe(true);
    expect(entry?.evidence).toContain("index/worktree state changed");
  });
});

describe("commits made during the run", () => {
  it("attributes a file the run committed, even though it is no longer dirty", async () => {
    write("committed.ts", "before\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    const baseline = await verifier.captureBaseline();

    write("committed.ts", "after\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "the run's commit"]);

    const result = await verifier.verify({ runId: "run_commit", baseline });

    // The tree is clean again, so a status-only view would see nothing at all.
    expect(result.evidence.workingTreeClean).toBe(true);
    expect(result.evidence.attributableFiles).toContain("committed.ts");
    expect(result.report.observedCommits).toHaveLength(1);
  });
});

describe("observedDiff must not overstate the run", () => {
  it("excludes a pre-existing modification from the attributable diff", async () => {
    write("theirs.ts", "committed\n");
    write("ours.ts", "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    // Someone else's uncommitted work, with a distinctive marker.
    write("theirs.ts", "committed\nSOMEONE_ELSES_UNCOMMITTED_WORK\n");

    const baseline = await verifier.captureBaseline();

    // The run changes a different file.
    write("ours.ts", "committed\nTHE_RUNS_OWN_WORK\n");

    const result = await verifier.verify({
      runId: "run_diff", baseline, allowedScope: ["ours.ts"],
    });

    expect(result.report.observedDiffBasis).toBe("attributable");
    expect(result.report.observedDiff).toContain("THE_RUNS_OWN_WORK");
    // THE POINT: the colleague's work is not presented as this run's output.
    expect(result.report.observedDiff).not.toContain("SOMEONE_ELSES_UNCOMMITTED_WORK");
  });

  it("includes the further change to an already-dirty file", async () => {
    write("shared.ts", "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    write("shared.ts", "committed\nHUMAN_WIP\n");

    const baseline = await verifier.captureBaseline();
    write("shared.ts", "committed\nHUMAN_WIP\nRUN_ADDITION\n");

    const result = await verifier.verify({ runId: "run_diff2", baseline });
    expect(result.report.observedDiffBasis).toBe("attributable");
    expect(result.report.observedDiff).toContain("RUN_ADDITION");
  });

  it("labels the diff as all_changes when there is no baseline", async () => {
    write("anything.ts", "x\n");
    const result = await verifier.verify({ runId: "run_nobase" });
    expect(result.report.observedDiffBasis).not.toBe("attributable");
    expect(result.evidence.attribution.baselineAvailable).toBe(false);
  });
});

describe("sensitive files are attributed WITHOUT exposing contents", () => {
  it("never hashes or diffs a pre-existing sensitive file", async () => {
    write(".env", "TOKEN=ORIGINAL_SECRET_VALUE\n");
    const baseline = await verifier.captureBaseline();

    const fingerprint = baseline!.fingerprints.find((f) => f.path === ".env");
    expect(fingerprint).toBeDefined();
    // Metadata yes, content hash no.
    expect(fingerprint!.contentHash).toBeNull();
    expect(fingerprint!.basis).toBe("metadata_only");
    expect(fingerprint!.size).toBeGreaterThan(0);

    const result = await verifier.verify({ runId: "run_env", baseline });
    const serialised = JSON.stringify({ r: result.report, e: result.evidence, b: baseline });
    expect(serialised).not.toContain("ORIGINAL_SECRET_VALUE");
  });

  it("still detects a change to a sensitive file, by metadata", async () => {
    write(".env", "TOKEN=old\n");
    const baseline = await verifier.captureBaseline();

    write(".env", "TOKEN=a_completely_different_and_longer_secret\n");

    const result = await verifier.verify({ runId: "run_env2", baseline, allowedScope: ["src/"] });

    expect(result.evidence.attributableFiles).toContain(".env");
    expect(result.evidence.sensitiveFilesChanged).toContain(".env");
    const entry = result.evidence.attribution.entries.find((e) => e.path === ".env");
    expect(entry?.basis).toBe("metadata_only");
    // The caveat is surfaced, not hidden.
    expect(result.evidence.attribution.metadataOnlyPaths).toContain(".env");

    const serialised = JSON.stringify({ r: result.report, e: result.evidence });
    expect(serialised).not.toContain("a_completely_different_and_longer_secret");
  });

  it("does not falsely claim metadata-only when git itself decided", async () => {
    // .env is committed and CLEAN at baseline, so it has no fingerprint to
    // compare. git status alone reports the change - that verdict is exact and
    // must not be tagged with the metadata-only caveat.
    write(".env", "TOKEN=committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    const baseline = await verifier.captureBaseline();
    expect(baseline?.clean).toBe(true);

    write(".env", "TOKEN=changed\n");

    const result = await verifier.verify({ runId: "run_basis", baseline });
    const entry = result.evidence.attribution.entries.find((e) => e.path === ".env");
    expect(entry?.kind).toBe("modified_during_run");
    expect(entry?.basis).toBe("git_status");
    expect(result.evidence.attribution.metadataOnlyPaths).not.toContain(".env");
  });

  it("keeps a sensitive file out of the attributable diff", async () => {
    write(".env", "TOKEN=committed_value\n");
    write("app.ts", "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    const baseline = await verifier.captureBaseline();
    write(".env", "TOKEN=NEW_LIVE_SECRET\n");
    write("app.ts", "y\n");

    const result = await verifier.verify({ runId: "run_env3", baseline });

    expect(result.evidence.attributableFiles).toContain(".env");
    expect(result.report.observedDiff).not.toContain("NEW_LIVE_SECRET");
    expect(result.report.observedDiff).toContain("app.ts");
  });
});

describe("attributeChanges is pure and deterministic", () => {
  const fp = (over: Record<string, unknown>) =>
    FileFingerprint.parse({ path: "f.ts", present: true, kind: "file", ...over });

  it("classifies identical fingerprints as pre-existing when dirty", () => {
    const before = [fp({ contentHash: "aaa", statusCode: " M" })];
    const after = [fp({ contentHash: "aaa", statusCode: " M" })];
    const summary = attributeChanges(before, after);
    expect(summary.preExisting).toEqual(["f.ts"]);
    expect(summary.attributable).toEqual([]);
  });

  it("classifies a differing hash as modified during the run", () => {
    const summary = attributeChanges(
      [fp({ contentHash: "aaa", statusCode: " M" })],
      [fp({ contentHash: "bbb", statusCode: " M" })],
    );
    expect(summary.modifiedDuringRun).toEqual(["f.ts"]);
    expect(summary.attributable).toEqual(["f.ts"]);
  });

  it("returns the same verdict for the same inputs", () => {
    const before = [fp({ contentHash: "aaa", statusCode: " M" })];
    const after = [fp({ contentHash: "bbb", statusCode: " M" })];
    expect(attributeChanges(before, after)).toEqual(attributeChanges(before, after));
  });

  it("does not attribute anything when both snapshots are empty", () => {
    expect(attributeChanges([], []).attributable).toEqual([]);
  });
});
