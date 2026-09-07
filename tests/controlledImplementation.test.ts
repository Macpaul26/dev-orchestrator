import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { HumanDecision } from "../src/domain/approval.js";
import { ActivityJournal } from "../src/activity/journal.js";
import { machineTransition, InvariantViolation } from "../src/domain/task.js";
import { ControlledImplementationRunner } from "../src/implementation/runner.js";
import { CancellationToken } from "../src/implementation/session.js";
import { GrantDenied } from "../src/domain/grant.js";
import { FakeImplementationAgent, type FakeStep } from "./fakeAgent.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * THE COMPLETE CONTROLLED IMPLEMENTATION LOOP - PHASE 4B.3.
 *
 * Human approval, grant, bounded mutation, independent inspection, verification
 * evidence, human review gate. Every test here drives the real workflow end to
 * end; nothing is stubbed except the agent itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AGENT IS HOSTILE IN ALMOST EVERY TEST
 * ---------------------------------------------------------------------------
 * An honest agent proves the happy path and nothing else. The property this
 * phase actually claims is that the account of what happened is derived from
 * the repository and never from the agent - and the only way to test that is
 * with an agent whose account is wrong. So it lies about which files it
 * touched, claims success having done nothing, writes outside the approved
 * scope by going around the bridge, touches credentials, crashes halfway, and
 * cancels itself after writing.
 *
 * In each case the assertion has the same shape: what does the ORCHESTRATOR say
 * happened, and did the agent story change that answer.
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

/**
 * Drive one full run: start, human approves with a narrowed scope, finish.
 *
 * Scope is narrowed to `src/` in most tests because an unbounded scope makes
 * "outside the approved scope" untestable.
 */
async function runToReview(
  agent: FakeImplementationAgent | undefined,
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
): { verdict: string; findings: { severity: string; message: string; file?: string }[] } {
  return after.pendingApproval!.payload["review"] as never;
}

beforeEach(() => {
  tmp = tmpDir("orch-b3-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
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

// ---------------------------------------------------------------------------
describe("an honest agent, working inside the scope a human approved", () => {
  it("changes the repository, and the change is established by inspection", async () => {
    const agent = agentThat(
      [{ kind: "write", path: "src/added.ts", contents: "export const b = 2;\n" }],
      { claimFiles: ["src/added.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(fs.readFileSync(path.join(repo, "src", "added.ts"), "utf8"))
      .toBe("export const b = 2;\n");

    const verification = verificationOf(after);
    expect(verification["verdict"]).toBe("verified");
    expect(verification["independentlyVerified"]).toBe(true);
    expect(verification["disagreements"]).toEqual([]);
  });

  it("is the ONLY case that earns a clean review verdict", async () => {
    const agent = agentThat(
      [{ kind: "write", path: "src/added.ts", contents: "b\n" }],
      { claimFiles: ["src/added.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);
    expect(reviewOf(after).verdict).toBe("pass");
  });

  it("still stops dead at the human review gate", async () => {
    const agent = agentThat(
      [{ kind: "write", path: "src/added.ts", contents: "b\n" }],
      { claimFiles: ["src/added.ts"] },
    );
    const { after } = await runToReview(agent);

    expect(after.run.status).toBe("awaiting_approval");
    expect(after.pendingApproval?.kind).toBe("review");
    // "verified" is not "approved", and no machine path joins them.
    expect(() =>
      machineTransition(
        { id: "t", projectId: "proj", title: "t", status: "REVIEW",
          createdAt: iso(), updatedAt: iso() } as never,
        "APPROVED",
      ),
    ).toThrow(InvariantViolation);
  });
});

// ---------------------------------------------------------------------------
describe("an agent that lies about which files it changed", () => {
  it("does not get its claim into the observation", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/real.ts", contents: "real\n" },
        { kind: "write", path: "src/hidden.ts", contents: "hidden\n" },
      ],
      { claimFiles: ["src/real.ts", "src/invented.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);
    const verification = verificationOf(after);

    // The invented file is nowhere in the repository, and nowhere in evidence.
    expect(fs.existsSync(path.join(repo, "src", "invented.ts"))).toBe(false);
    const repository = after.pendingApproval!.payload["repository"] as Record<string, unknown>;
    expect(JSON.stringify(repository)).not.toContain("invented.ts");

    // Both directions of the lie are named.
    const disagreements = verification["disagreements"] as string[];
    expect(disagreements.some((d) => d.includes("invented.ts"))).toBe(true);
    expect(disagreements.some((d) => d.includes("hidden.ts"))).toBe(true);
  });

  it("loses its clean verdict even though the repository is fine", async () => {
    const agent = agentThat(
      [{ kind: "write", path: "src/real.ts", contents: "real\n" }],
      { claimFiles: ["src/invented.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    // The repository verdict is about the FILES, and the files are in scope.
    expect(verificationOf(after)["verdict"]).toBe("verified");
    // The review verdict is about the ATTEMPT, and the attempt was dishonest.
    const review = reviewOf(after);
    expect(review.verdict).toBe("changes_requested");
    expect(review.findings.some((f) => f.message.startsWith("Disagreement:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("an agent that reports success having done nothing", () => {
  it("is contradicted by the absence of any attributable change", async () => {
    const agent = agentThat([], {
      claimSummary: "Implemented the feature and all tests pass.",
      claimFiles: [], claimsSuccess: true,
    });
    const { after } = await runToReview(agent);
    const verification = verificationOf(after);

    expect(verification["agentClaimedSuccess"]).toBe(true);
    expect(verification["disagreements"]).toContain(
      "agent reported success, but inspection attributes no repository change to this run",
    );
    expect(reviewOf(after).verdict).toBe("changes_requested");
  });

  it("cannot turn a claim about tests into a check result", async () => {
    const agent = agentThat([], {
      claimSummary: "All tests pass.", claimsSuccess: true,
    });
    const { after } = await runToReview(agent);
    // No check was executed, so nothing may report as executed.
    expect(verificationOf(after)["checksAvailable"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("an agent that asks the bridge for something outside the scope", () => {
  it("is refused, and the refusal is recorded", async () => {
    const agent = agentThat([
      { kind: "write", path: "src/ok.ts", contents: "ok\n" },
      { kind: "write", path: "docs/nope.md", contents: "denied\n" },
      { kind: "delete", path: "README.md" },
    ]);
    const { runId, after } = await runToReview(agent);

    expect(fs.existsSync(path.join(repo, "src", "ok.ts"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "docs", "nope.md"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);

    const record = store.getImplementation("proj", runId)!;
    expect(record.writes).toBe(1);
    expect(record.denials).toBe(2);

    const types = new ActivityJournal(store.activityFile("proj", runId)).read().map((r) => r.type);
    expect(types).toContain("write_denied");

    // Nothing escaped, so the repository verdict is clean.
    expect(verificationOf(after)["verdict"]).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
describe("an agent that goes AROUND the bridge and writes to disk itself", () => {
  /**
   * The realistic threat. Phase 4B.1 gives the child process no OS sandbox, so
   * a real coding agent can write wherever the user account can. The write
   * boundary never sees these. Inspection does.
   */
  it("is not prevented - and is caught as scope drift", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/ok.ts", contents: "ok\n" },
        { kind: "sideEffect", path: "docs/smuggled.md", contents: "went around\n" },
      ],
      { claimFiles: ["src/ok.ts"], claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    // It really did land. Nothing here claims otherwise.
    expect(fs.existsSync(path.join(repo, "docs", "smuggled.md"))).toBe(true);

    const verification = verificationOf(after);
    expect(verification["verdict"]).toBe("scope_drift");
    expect(reviewOf(after).verdict).toBe("changes_requested");
  });

  it("leaves the drifted file exactly where it is - no rollback is claimed", async () => {
    const agent = agentThat(
      [{ kind: "sideEffect", path: "docs/smuggled.md", contents: "went around\n" }],
      { claimsSuccess: true },
    );
    await runToReview(agent);
    expect(fs.readFileSync(path.join(repo, "docs", "smuggled.md"), "utf8")).toBe("went around\n");
  });

  it("overrides the agent success claim with a blocker a human must read", async () => {
    const agent = agentThat(
      [{ kind: "sideEffect", path: "docs/smuggled.md", contents: "x\n" }],
      { claimSummary: "Done, everything is clean.", claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    const blockers = reviewOf(after).findings.filter((f) => f.severity === "blocker");
    expect(blockers.some((f) => f.message.includes("scope_drift"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("an agent that touches a credential file", () => {
  it("produces sensitive_change, naming the file and not its contents", async () => {
    const agent = agentThat(
      [{ kind: "sideEffect", path: ".env", contents: "API_KEY=hunter2-do-not-leak\n" }],
      { claimsSuccess: true },
    );
    const { after } = await runToReview(agent);

    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
    // The whole approval payload is what a human, and a log, will see.
    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).toContain(".env");
    expect(payload).not.toContain("hunter2");
  });
});

// ---------------------------------------------------------------------------
describe("an agent that crashes", () => {
  it("makes no claim at all, and is still verified", async () => {
    const agent = agentThat([
      { kind: "write", path: "src/partial.ts", contents: "half done\n" },
      { kind: "throw", message: "boom" },
    ]);
    const { runId, after } = await runToReview(agent);

    const record = store.getImplementation("proj", runId)!;
    expect(record.status).toBe("failed");
    expect(record.failureCategory).toBe("agent_error");
    // A crashed agent returns nothing, so it asserted nothing.
    expect(verificationOf(after)["agentClaimedSuccess"]).toBe(false);

    // The write that landed before the crash is still found.
    expect(fs.existsSync(path.join(repo, "src", "partial.ts"))).toBe(true);
    expect(verificationOf(after)["independentlyVerified"]).toBe(true);
  });

  it("keeps partialChangesPossible set, because nothing was undone", async () => {
    const agent = agentThat([
      { kind: "write", path: "src/partial.ts", contents: "half\n" },
      { kind: "throw" },
    ]);
    const { runId } = await runToReview(agent);
    expect(store.getImplementation("proj", runId)!.partialChangesPossible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("an agent that cancels itself after writing", () => {
  it("is recorded as cancelled, with the partial write attributed to it", async () => {
    const agent = agentThat(
      [
        { kind: "write", path: "src/first.ts", contents: "first\n" },
        { kind: "cancel", reason: "changed my mind" },
      ],
      { claimsSuccess: true },
    );
    const { runId, after } = await runToReview(agent);

    const record = store.getImplementation("proj", runId)!;
    expect(record.status).toBe("cancelled");
    expect(record.partialChangesPossible).toBe(true);
    expect(fs.existsSync(path.join(repo, "src", "first.ts"))).toBe(true);

    // Cancellation does not skip verification - that is when it matters most.
    expect(verificationOf(after)["independentlyVerified"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("verification runs after EVERY attempt", () => {
  const attempts: [string, FakeStep[]][] = [
    ["success", [{ kind: "write", path: "src/x.ts", contents: "x\n" }]],
    ["nothing at all", []],
    ["a crash", [{ kind: "throw" }]],
    ["a cancellation", [{ kind: "cancel" }]],
    ["a refusal", [{ kind: "write", path: "outside.ts", contents: "x\n" }]],
    ["a bypass", [{ kind: "sideEffect", path: "docs/d.md", contents: "d\n" }]],
  ];

  for (const [label, steps] of attempts) {
    it(`produces an outcome after ${label}`, async () => {
      const { after } = await runToReview(agentThat(steps, { claimsSuccess: true }));
      const verification = verificationOf(after);
      // A verdict always exists. "We did not verify" is not a reachable state.
      expect(typeof verification["verdict"]).toBe("string");
      expect(verification["independentlyVerified"]).toBe(true);
      expect(after.pendingApproval?.kind).toBe("review");
    });
  }
});

// ---------------------------------------------------------------------------
describe("the grant is spent by the run that used it", () => {
  it("cannot be replayed for a second implementation", async () => {
    const agent = agentThat([{ kind: "write", path: "src/one.ts", contents: "1\n" }]);
    await runToReview(agent);

    const grant = store.listGrants("proj")[0]!;
    const replay = agentThat([{ kind: "write", path: "src/two.ts", contents: "2\n" }]);

    await expect(
      new ControlledImplementationRunner({ store }).run(
        grant, { instruction: "again" }, replay, new CancellationToken(),
      ),
    ).rejects.toThrow(GrantDenied);

    expect(fs.existsSync(path.join(repo, "src", "two.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("an agent reaching for authority it was not granted", () => {
  it("finds none of it, inside the real workflow", async () => {
    const agent = agentThat([
      { kind: "escalate", target: "mutate-capabilities" },
      { kind: "escalate", target: "mutate-scope" },
      { kind: "escalate", target: "reach-grant" },
      { kind: "escalate", target: "reach-writer" },
      { kind: "escalate", target: "reach-journal" },
      { kind: "escalate", target: "reach-shell" },
      { kind: "escalate", target: "reach-process" },
      { kind: "escalate", target: "reach-git" },
      { kind: "escalate", target: "reach-network" },
      { kind: "escalate", target: "reach-filesystem" },
    ]);
    await runToReview(agent);

    expect(agent.escalationAttempts).toHaveLength(10);
    for (const attempt of agent.escalationAttempts) {
      expect(attempt.blocked, `${attempt.target}: ${attempt.detail}`).toBe(true);
    }
  });

  it("cannot reach APPROVED by any of it", async () => {
    const agent = agentThat([{ kind: "escalate", target: "reach-grant" }]);
    const { after } = await runToReview(agent);
    expect(after.run.status).toBe("awaiting_approval");
  });
});
