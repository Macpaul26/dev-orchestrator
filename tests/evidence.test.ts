import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier, compareClaims } from "../src/verification/verifier.js";
import type { RepositoryInspector } from "../src/domain/inspector.js";
import { tmpDir, rmDir, git, initRepo, headSha } from "./helpers.js";

/**
 * EVIDENCE INTEGRITY.
 *
 * One rule, tested from several directions:
 *
 *   > The coding agent's report is never proof of what happened.
 *
 * A claim must never become an observation - not when it is plausible, not when
 * it is the only information available, and not when inspection fails.
 */

let parent: string;
let repo: string;
let inspector: RepositoryInspector;

beforeEach(() => {
  parent = tmpDir("orch-evi-");
  repo = path.join(parent, "repo");
  initRepo(repo);
  inspector = new LocalGitRepositoryInspector({ workingDir: repo });
});

afterEach(() => rmDir(parent));

describe("claimed never becomes observed", () => {
  it("does NOT copy claimed files into observedFiles", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    const result = await verifier.verify({
      runId: "run_1",
      claimedSummary: "I rewrote the entire authentication system.",
      claimedFiles: ["src/auth/service.ts", "src/auth/session.ts"],
      baseline,
      allowedScope: ["src/"],
    });

    // The repository is clean - nothing was actually changed.
    expect(result.report.observedFiles).toEqual([]);
    expect(result.report.observedCommits).toEqual([]);
    // The claims survive, clearly labelled as claims.
    expect(result.report.claimedFiles).toEqual(["src/auth/service.ts", "src/auth/session.ts"]);
    expect(result.report.claimedSummary).toContain("rewrote the entire");
    // And the contradiction is recorded.
    expect(result.evidence.claims.claimedButNotObserved).toEqual([
      "src/auth/service.ts", "src/auth/session.ts",
    ]);
    expect(result.evidence.claims.matches).toBe(false);
  });

  it("observes a change the agent never claimed", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "sneaky.ts"), "// nobody mentioned this\n");

    const result = await verifier.verify({
      runId: "run_2", claimedFiles: [], baseline, allowedScope: ["src/"],
    });

    expect(result.report.observedFiles).toContain("sneaky.ts");
    expect(result.evidence.claims.observedButNotClaimed).toContain("sneaky.ts");
    expect(result.evidence.scope.drift).toContain("sneaky.ts");
  });

  it("takes observedCommits from git, not from a claim", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    fs.writeFileSync(path.join(repo, "real.ts"), "\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "a real commit"]);
    const realSha = headSha(repo);

    const result = await verifier.verify({
      runId: "run_3",
      claimedCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // a lie
      baseline,
      allowedScope: ["real.ts"],
    });

    expect(result.report.observedCommits).toEqual([realSha]);
    expect(result.report.observedCommits).not.toContain("deadbeef".repeat(5));
    expect(result.evidence.claimedCommitExists).toBe(false);
    expect(result.evidence.notes.some((n) => n.includes("does not exist"))).toBe(true);
  });

  it("confirms a claimed commit that IS real", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "real.ts"), "\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "genuine"]);

    const result = await verifier.verify({
      runId: "run_4", claimedCommit: headSha(repo), baseline,
    });
    expect(result.evidence.claimedCommitExists).toBe(true);
  });
});

describe("verifiedIndependently", () => {
  it("is true only when a real observation was collected", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();
    const result = await verifier.verify({ runId: "run_5", baseline });
    expect(result.report.verifiedIndependently).toBe(true);
    expect(result.evidence.inspectionSucceeded).toBe(true);
  });

  it("stays FALSE when inspection fails, and observed stays empty", async () => {
    const broken = new LocalGitRepositoryInspector({
      workingDir: path.join(parent, "gone"),
    });
    const result = await new RepositoryVerifier(broken).verify({
      runId: "run_6",
      claimedSummary: "everything is fine",
      claimedFiles: ["src/a.ts", "src/b.ts"],
      allowedScope: ["src/"],
    });

    expect(result.report.verifiedIndependently).toBe(false);
    expect(result.report.observedFiles).toEqual([]);
    expect(result.report.observedCommits).toEqual([]);
    expect(result.report.observedDiff).toBeNull();
    // The claims are NOT promoted to fill the gap.
    expect(result.report.claimedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.evidence.inspectionSucceeded).toBe(false);
    expect(result.evidence.failure?.code).toBe("working_dir_missing");
  });

  it("stays FALSE when the directory is not a repository", async () => {
    const plain = path.join(parent, "plain");
    fs.mkdirSync(plain);
    const result = await new RepositoryVerifier(
      new LocalGitRepositoryInspector({ workingDir: plain }),
    ).verify({ runId: "run_7" });
    expect(result.report.verifiedIndependently).toBe(false);
    expect(result.evidence.failure?.code).toBe("not_a_git_repository");
  });
});

describe("baseline attribution", () => {
  it("does not blame this run for changes that were already there", async () => {
    // The repository is dirty BEFORE the run starts.
    fs.writeFileSync(path.join(repo, "pre-existing.ts"), "// dirty before we started\n");

    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();
    expect(baseline?.changedFiles).toContain("pre-existing.ts");

    // The run then changes something inside its approved scope.
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "new.ts"), "\n");

    const result = await verifier.verify({
      runId: "run_8", baseline, allowedScope: ["src/"],
    });

    expect(result.evidence.preExistingChanges).toContain("pre-existing.ts");
    expect(result.evidence.attributableFiles).toContain("src/new.ts");
    expect(result.evidence.attributableFiles).not.toContain("pre-existing.ts");
    // Crucially: the pre-existing mess is NOT reported as scope drift.
    expect(result.evidence.scope.drift).toEqual([]);
    expect(result.evidence.driftBasis).toBe("attributable");
  });

  it("says so when it had no baseline to compare against", async () => {
    fs.writeFileSync(path.join(repo, "whatever.ts"), "\n");
    const result = await new RepositoryVerifier(inspector).verify({
      runId: "run_9", allowedScope: ["src/"],
    });
    expect(result.evidence.baselineCaptured).toBe(false);
    expect(result.evidence.driftBasis).toBe("all_changes");
    // The absence of a baseline must be disclosed, and the overstatement named.
    const disclosure = result.evidence.notes.join(" ");
    expect(disclosure).toContain("no baseline");
    expect(disclosure.toLowerCase()).toContain("overstate");
    expect(result.evidence.attribution.baselineAvailable).toBe(false);
    // Without a baseline it errs toward reporting, not toward silence.
    expect(result.evidence.scope.drift).toContain("whatever.ts");
  });
});

describe("scope drift from real repository state", () => {
  it("flags a file changed outside the approved scope", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "ok.ts"), "\n");
    fs.writeFileSync(path.join(repo, "unauthorised.ts"), "\n");

    const result = await verifier.verify({
      runId: "run_10", baseline, allowedScope: ["src/"],
    });

    expect(result.evidence.scope.inScope).toContain("src/ok.ts");
    expect(result.evidence.scope.drift).toEqual(["unauthorised.ts"]);
  });

  it("reports every change as drift when the plan authorised nothing", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, "anything.ts"), "\n");

    const result = await verifier.verify({ runId: "run_11", baseline, allowedScope: [] });
    expect(result.evidence.scope.emptyScope).toBe(true);
    expect(result.evidence.scope.drift).toEqual(["anything.ts"]);
  });
});

describe("sensitive changes reach evidence as names only", () => {
  it("records that a secret file changed without recording the secret", async () => {
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();
    fs.writeFileSync(path.join(repo, ".env"), "STRIPE_KEY=sk_live_NEVER_LOG_THIS\n");

    const result = await verifier.verify({ runId: "run_12", baseline, allowedScope: [".env"] });

    expect(result.evidence.sensitiveFilesChanged).toContain(".env");
    expect(result.report.observedFiles).toContain(".env");
    const serialised = JSON.stringify({ report: result.report, evidence: result.evidence });
    expect(serialised).not.toContain("sk_live_NEVER_LOG_THIS");
  });
});

describe("claim comparison arithmetic", () => {
  it("matches identical sets regardless of order or separator", () => {
    const comparison = compareClaims(["src\\b.ts", "src/a.ts"], ["src/a.ts", "src/b.ts"]);
    expect(comparison.matches).toBe(true);
    expect(comparison.claimedButNotObserved).toEqual([]);
    expect(comparison.observedButNotClaimed).toEqual([]);
  });

  it("reports both directions of disagreement", () => {
    const comparison = compareClaims(["a.ts", "b.ts"], ["b.ts", "c.ts"]);
    expect(comparison.claimedButNotObserved).toEqual(["a.ts"]);
    expect(comparison.observedButNotClaimed).toEqual(["c.ts"]);
    expect(comparison.matches).toBe(false);
  });
});
