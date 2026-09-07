import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { HumanDecision } from "../src/domain/approval.js";
import { FakeImplementationAgent, type FakeStep } from "./fakeAgent.js";
import { tmpDir, rmDir, git, initRepo, headSha } from "./helpers.js";

/**
 * TASK 004B.3-CORRECTION - GIT MUTATION AND SENSITIVE ATTRIBUTION.
 *
 * Two holes closed, both with the same shape: a change that leaves no trace in
 * the FINAL working-tree listing.
 *
 * ---------------------------------------------------------------------------
 * WHY A CLEAN TREE IS THE DANGEROUS CASE
 * ---------------------------------------------------------------------------
 * Every dirty-file signal answers "what is uncommitted right now". An agent
 * that writes, stages and commits produces a CLEAN tree - so that question
 * returns nothing, and the attempt looks identical to one that did nothing at
 * all. The same disappearance hides a deleted `.env` and a renamed key file.
 *
 * These tests therefore assert on attempts that end clean, and on files that
 * are gone by the time we look.
 *
 * The agent runs `git` directly, not through a bridge tool. There is no such
 * tool and no capability that grants it. Phase 4B.1 gives the child no OS
 * sandbox, so the command simply works - nothing here is expected to prevent
 * it. The assertion is that verification notices.
 */

let tmp: string;
let repo: string;
let store: ProjectStore;
let dbPath: string;

const iso = () => new Date().toISOString();
const openSavers: unknown[] = [];

function newRunner(agent?: FakeImplementationAgent): WorkflowRunner {
  const saver = createCheckpointer(dbPath);
  openSavers.push(saver);
  return new WorkflowRunner(
    new ProjectStore(path.join(tmp, "projects")),
    saver,
    agent ? { agent } : {},
  );
}

function agentThat(steps: FakeStep[], options: {
  claimFiles?: string[]; claimSummary?: string; claimsSuccess?: boolean;
} = {}): FakeImplementationAgent {
  return new FakeImplementationAgent({ steps, repoRoot: repo, ...options });
}

async function runToReview(
  agent: FakeImplementationAgent,
  scope: string[] = ["src/"],
): Promise<{ runId: string; after: Awaited<ReturnType<WorkflowRunner["resume"]>> }> {
  const started = await newRunner(agent).start("proj", "make the change");
  const after = await newRunner(agent).resume(
    started.run.id,
    HumanDecision.parse({
      approvalId: started.pendingApproval!.approvalId,
      kind: "edit", decidedBy: "the-owner", decidedAt: iso(),
      editedPlan: { ...started.pendingApproval!.proposedPlan!, allowedScope: scope },
    }),
  );
  return { runId: started.run.id, after };
}

function verificationOf(
  after: { pendingApproval?: { payload: Record<string, unknown> } | null },
): Record<string, unknown> {
  return after.pendingApproval!.payload["verification"] as Record<string, unknown>;
}

function reviewOf(
  after: { pendingApproval?: { payload: Record<string, unknown> } | null },
): { verdict: string; findings: { severity: string; message: string }[] } {
  return after.pendingApproval!.payload["review"] as never;
}

/** The steps a real agent would use to commit its own work, around the bridge. */
function commitDirectly(message: string): FakeStep[] {
  return [
    { kind: "gitCommand", args: ["add", "-A"] },
    { kind: "gitCommand", args: ["commit", "-q", "-m", message] },
  ];
}

beforeEach(() => {
  tmp = tmpDir("orch-gitmut-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  // Credential material that EXISTS at baseline, so it can be deleted, renamed
  // or committed by the run - the shapes that vanish from the dirty listing.
  fs.writeFileSync(path.join(repo, ".env"), "API_KEY=baseline-secret-value\n");
  fs.writeFileSync(path.join(repo, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);

  store = new ProjectStore(path.join(tmp, "projects"));
  dbPath = path.join(tmp, "checkpoints.sqlite");
  store.createProject({
    id: "proj", name: "Proj", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
  });
});

afterEach(() => {
  for (const saver of openSavers.splice(0)) closeCheckpointer(saver);
  rmDir(tmp);
});

// ===========================================================================
// GIT MUTATION
// ===========================================================================

describe("Test 1 - an agent that commits its own work", () => {
  it("is detected, and the verdict is blocking", async () => {
    const before = headSha(repo);
    const agent = agentThat(
      [
        { kind: "write", path: "src/added.ts", contents: "export const b = 2;\n" },
        ...commitDirectly("agent commit"),
      ],
      { claimFiles: ["src/added.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    // The commit really happened. Nothing claims otherwise.
    expect(headSha(repo)).not.toBe(before);

    const verification = verificationOf(after);
    expect(verification["gitMutationDetected"]).toBe(true);
    expect(verification["gitMutationAuthorised"]).toBe(false);
    expect(verification["verdict"]).toBe("git_mutation");
  });

  it("raises a blocker naming the commit at the review gate", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/added.ts", contents: "b\n" },
        ...commitDirectly("agent commit"),
      ],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    const review = reviewOf(after);
    expect(review.verdict).toBe("changes_requested");
    const blockers = review.findings.filter((f) => f.severity === "blocker");
    expect(blockers.some((f) => f.message.includes("no granted capability authorised"))).toBe(true);
    expect(blockers.some((f) => f.message.startsWith("Unauthorised commit created"))).toBe(true);
  });
});

describe("Test 2 - the agent claims failure but committed anyway", () => {
  it("still reports the mutation; the claim does not suppress the observation", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/added.ts", contents: "b\n" },
        ...commitDirectly("committed then failed"),
      ],
      { claimSummary: "I could not complete this.", claimFiles: [], claimsSuccess: false },
    );
    const { after } = await runToReview(agent);

    const verification = verificationOf(after);
    expect(verification["agentClaimedSuccess"]).toBe(false);
    // A denial of success is still not evidence about the repository.
    expect(verification["gitMutationDetected"]).toBe(true);
    expect(verification["verdict"]).toBe("git_mutation");
  });

  it("still reports it when the agent crashes after committing", async () => {
    const agent = agentThat([
      { kind: "write", path: "src/added.ts", contents: "b\n" },
      ...commitDirectly("commit then crash"),
      { kind: "throw", message: "boom" },
    ]);
    const { after } = await runToReview(agent);

    expect(verificationOf(after)["gitMutationDetected"]).toBe(true);
    expect(verificationOf(after)["verdict"]).toBe("git_mutation");
  });
});

describe("Test 3 - a commit that leaves the working tree completely clean", () => {
  /**
   * The essential case. Every dirty-file signal reports nothing here, so this
   * is precisely where a verification model that only looks at `git status`
   * concludes "no changes -> verified".
   */
  it("is still detected, from HEAD rather than from the dirty listing", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/added.ts", contents: "b\n" },
        ...commitDirectly("clean after commit"),
      ],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    // Prove the premise: git status really is empty.
    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");

    const verification = verificationOf(after);
    expect(verification["gitMutationDetected"]).toBe(true);
    expect(verification["verdict"]).toBe("git_mutation");
    expect(verification["verdict"]).not.toBe("verified");
  });
});

describe("Test 4 - the committed file was entirely inside the approved scope", () => {
  it("is blocking anyway, because the CAPABILITY was never granted", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/foo.ts", contents: "in scope\n" },
        ...commitDirectly("in-scope commit"),
      ],
      { claimFiles: ["src/foo.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent, ["src/"]);

    const verification = verificationOf(after);
    // No drift: the file is where the human said it could go.
    const review = reviewOf(after);
    expect(review.findings.some((f) => f.message.includes("outside the approved scope"))).toBe(false);
    // And it is still blocked, on capability grounds rather than scope grounds.
    expect(verification["verdict"]).toBe("git_mutation");
    expect(review.verdict).toBe("changes_requested");
  });

  it("records that git.mutate was never among the granted capabilities", async () => {
    const agent = agentThat(
      [{ kind: "write", path: "src/foo.ts", contents: "x\n" }, ...commitDirectly("c")],
    );
    const { after } = await runToReview(agent);

    expect(verificationOf(after)["gitMutationAuthorised"]).toBe(false);
    expect(store.listGrants("proj")[0]!.capabilities).not.toContain("git.mutate");
  });
});

describe("Test 5 - git reached directly, not through any bridge tool", () => {
  it("is NOT prevented - and is independently detected", async () => {
    const before = headSha(repo);
    const agent = agentThat([
      { kind: "sideEffect", path: "docs/notes.md", contents: "around the bridge\n" },
      ...commitDirectly("direct git"),
    ]);
    const { runId, after } = await runToReview(agent);

    // Not prevented: the commit exists and the file is in it.
    expect(headSha(repo)).not.toBe(before);
    expect(fs.existsSync(path.join(repo, "docs", "notes.md"))).toBe(true);

    // The bridge served no mutation - it was never asked.
    const record = store.getImplementation("proj", runId)!;
    expect(record.writes).toBe(0);
    expect(record.deletes).toBe(0);

    // Detected all the same.
    expect(verificationOf(after)["gitMutationDetected"]).toBe(true);
    expect(verificationOf(after)["verdict"]).toBe("git_mutation");
  });

  it("does not revert, reset or clean anything", async () => {
    const agent = agentThat([
      { kind: "sideEffect", path: "docs/notes.md", contents: "left in place\n" },
      ...commitDirectly("direct git"),
    ]);
    await runToReview(agent);

    // Detection only. The commit stands and the file is untouched.
    expect(fs.readFileSync(path.join(repo, "docs", "notes.md"), "utf8")).toBe("left in place\n");
    expect(git(repo, ["log", "--oneline", "-1"])).toContain("direct git");
  });
});

// ===========================================================================
// SENSITIVE ATTRIBUTION
// ===========================================================================

describe("Test 6 - a sensitive file modified in place", () => {
  it("is detected, and its contents never enter the evidence", async () => {
    const agent = agentThat(
      [{ kind: "sideEffect", path: ".env", contents: "API_KEY=rotated-hunter2\n" }],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).toContain(".env");
    expect(payload).not.toContain("hunter2");
    expect(payload).not.toContain("baseline-secret-value");
  });
});

describe("Test 7 - a sensitive file DELETED", () => {
  /**
   * Regression coverage, not the isolating case: a deleted TRACKED file still
   * appears in `git status` as ` D .env`, so this shape was already covered
   * before the correction. Test 7b is the one that escapes the dirty listing.
   */
  it("is detected even though the file no longer exists", async () => {
    const agent = agentThat(
      [{ kind: "sideEffectDelete", path: ".env" }],
      { claimSummary: "Tidied up.", claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(fs.existsSync(path.join(repo, ".env"))).toBe(false);
    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
  });
});

describe("Test 7b - a sensitive DELETION that was then committed", () => {
  /**
   * This is the variant that actually isolates the fix.
   *
   * A deleted TRACKED file still shows in `git status` as ` D .env`, so plain
   * deletion never escaped the old dirty-listing check. Committing the deletion
   * is what removes it from that listing entirely - and a check filtering
   * `changedFiles` then sees nothing at all.
   */
  it("is detected once the deletion has left the working-tree listing", async () => {
    const agent = agentThat(
      [{ kind: "sideEffectDelete", path: ".env" }, ...commitDirectly("remove env")],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(path.join(repo, ".env"))).toBe(false);
    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
  });
});

describe("Test 8b - a sensitive RENAME that was then committed", () => {
  it("is detected under both paths once the tree is clean again", async () => {
    const agent = agentThat(
      [
        { kind: "sideEffectRename", from: "deploy.pem", to: "deploy-old.pem" },
        ...commitDirectly("rotate key file"),
      ],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).toContain("deploy.pem");
    expect(payload).toContain("deploy-old.pem");
  });
});

describe("Test 8 - a sensitive file RENAMED", () => {
  it("is detected under both its old and its new path", async () => {
    const agent = agentThat(
      [{ kind: "sideEffectRename", from: "deploy.pem", to: "deploy-old.pem" }],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).toContain("deploy.pem");
    expect(payload).toContain("deploy-old.pem");
  });
});

describe("Test 9 - a sensitive change that was COMMITTED", () => {
  /**
   * Both holes at once: the commit cleans the working tree, so the sensitive
   * change disappears from the dirty listing AND the mutation is invisible to
   * anything that only inspects uncommitted state.
   */
  it("detects the sensitive change and the unauthorised mutation together", async () => {
    const agent = agentThat(
      [
        { kind: "sideEffect", path: ".env", contents: "API_KEY=committed-hunter2\n" },
        ...commitDirectly("rotate key"),
      ],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");

    const verification = verificationOf(after);
    // Both observations are present; the verdict names the one to read first.
    expect(verification["verdict"]).toBe("sensitive_change");
    expect(verification["gitMutationDetected"]).toBe(true);
    expect(verification["gitMutationAuthorised"]).toBe(false);

    // And both are blockers a human will see.
    const blockers = reviewOf(after).findings.filter((f) => f.severity === "blocker");
    expect(blockers.some((f) => f.message.includes("no granted capability authorised"))).toBe(true);
  });

  it("keeps the committed secret out of the evidence entirely", async () => {
    const agent = agentThat([
      { kind: "sideEffect", path: ".env", contents: "API_KEY=committed-hunter2\n" },
      ...commitDirectly("rotate key"),
    ]);
    const { after } = await runToReview(agent);

    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).toContain(".env");
    expect(payload).not.toContain("hunter2");
  });
});

// ===========================================================================
// NO REGRESSION IN THE CLEAN CASE
// ===========================================================================

describe("a run that touches neither git nor a credential", () => {
  it("still reaches a clean verified verdict", async () => {
    const agent = agentThat(
      [{ kind: "write", path: "src/added.ts", contents: "b\n" }],
      { claimFiles: ["src/added.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    const verification = verificationOf(after);
    expect(verification["verdict"]).toBe("verified");
    expect(verification["gitMutationDetected"]).toBe(false);
    expect(reviewOf(after).verdict).toBe("pass");
  });
});
