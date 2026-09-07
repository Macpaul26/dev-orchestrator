import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { HumanDecision } from "../src/domain/approval.js";
import { machineTransition, InvariantViolation } from "../src/domain/task.js";
import { FakeImplementationAgent, type FakeStep } from "./fakeAgent.js";
import { tmpDir, rmDir, git, initRepo, headSha } from "./helpers.js";

/**
 * TASK 005 THROUGH THE REAL WORKFLOW.
 *
 * Checks execute as real child processes, inside the actual graph, between two
 * independent repository inspections.
 *
 * ---------------------------------------------------------------------------
 * THE TWO QUESTIONS THESE TESTS ASK
 * ---------------------------------------------------------------------------
 * 1. Does an independently executed check outrank what the agent said?
 * 2. When a CHECK changes the repository, is that noticed?
 *
 * The second one is the easy thing to get wrong. A verification command is
 * executable code; "it was only a test" is an assumption. So several tests here
 * use checks that deliberately write, delete, rename and commit - and assert
 * that the existing 4B.3 machinery catches each one.
 */

let tmp: string;
let repo: string;
let store: ProjectStore;
let dbPath: string;

const iso = () => new Date().toISOString();
const openSavers: unknown[] = [];

/** A check that runs real JavaScript in a real child process. */
function check(id: string, script: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name: id, executable: process.execPath, args: ["-e", script],
    cwd: ".", timeoutMs: 60_000, enabled: true, ...overrides,
  };
}

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
  const started = await newRunner(agent).start("proj", "do the work");
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

function checkResults(
  after: { pendingApproval?: { payload: Record<string, unknown> } | null },
): { checkId: string; status: string; exitCode: number | null }[] {
  return (verificationOf(after)["checkResults"] as never) ?? [];
}

/** Create the project with a given set of executable checks. */
function createProject(verificationChecks: unknown[]): void {
  store.createProject({
    id: "proj", name: "Proj", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
    verificationChecks: verificationChecks as never,
  });
}

const writeOk: FakeStep[] = [
  { kind: "write", path: "src/added.ts", contents: "export const b = 2;\n" },
];

beforeEach(() => {
  tmp = tmpDir("orch-t5-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, ".env"), "API_KEY=baseline-secret-value\n");
  fs.writeFileSync(path.join(repo, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);

  store = new ProjectStore(path.join(tmp, "projects"));
  dbPath = path.join(tmp, "checkpoints.sqlite");
});

afterEach(() => {
  for (const saver of openSavers.splice(0)) closeCheckpointer(saver);
  rmDir(tmp);
});

// ===========================================================================
describe("checks execute after implementation, as part of the run", () => {
  it("runs a passing check and records the process result", async () => {
    createProject([check("unit", "process.exit(0)")]);
    const { after } = await runToReview(agentThat(writeOk, { claimsSuccess: true }));

    const verification = verificationOf(after);
    expect(verification["checksAttempted"]).toBe(true);
    expect(verification["checksAllPassed"]).toBe(true);

    const results = checkResults(after);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("passed");
    expect(results[0]!.exitCode).toBe(0);
  });

  it("runs a failing check and does NOT let it read as success", async () => {
    createProject([check("unit", "process.exit(1)")]);
    const { after } = await runToReview(agentThat(writeOk, { claimsSuccess: true }));

    expect(verificationOf(after)["checksAllPassed"]).toBe(false);
    expect(checkResults(after)[0]!.status).toBe("failed");
    expect(reviewOf(after).verdict).toBe("changes_requested");
  });

  it("runs every configured check, not just the first", async () => {
    createProject([
      check("one", "process.exit(0)"),
      check("two", "process.exit(0)"),
      check("three", "process.exit(1)"),
    ]);
    const { after } = await runToReview(agentThat(writeOk));
    expect(checkResults(after)).toHaveLength(3);
    expect(verificationOf(after)["checksAllPassed"]).toBe(false);
  });

  it("still stops at the human review gate when everything passes", async () => {
    createProject([check("unit", "process.exit(0)")]);
    const { after } = await runToReview(agentThat(writeOk, { claimsSuccess: true }));

    expect(after.run.status).toBe("awaiting_approval");
    expect(after.pendingApproval?.kind).toBe("review");
    expect(() =>
      machineTransition(
        { id: "t", projectId: "proj", title: "t", status: "REVIEW",
          createdAt: iso(), updatedAt: iso() } as never,
        "APPROVED",
      ),
    ).toThrow(InvariantViolation);
  });
});

// ===========================================================================
describe("NOT RUN is never PASS", () => {
  it("reports no checks configured as not attempted, with a reason", async () => {
    createProject([]);
    const { after } = await runToReview(agentThat(writeOk, { claimsSuccess: true }));

    const verification = verificationOf(after);
    expect(verification["checksAttempted"]).toBe(false);
    expect(verification["checksAllPassed"]).toBe(false);
    expect(String(verification["checksNotRunReason"])).toContain("NOT independently checked");
  });

  it("warns a human that nothing was checked", async () => {
    createProject([]);
    const { after } = await runToReview(agentThat(writeOk, { claimsSuccess: true }));
    const findings = reviewOf(after).findings;
    expect(findings.some((f) =>
      f.severity === "warning" && f.message.includes("No verification check was executed"),
    )).toBe(true);
  });

  it("does not force changes_requested merely because nothing was configured", async () => {
    // An honest, in-scope, fully-agreed run with no checks is a gap in evidence,
    // not a defect found. It is reported as a warning, and stays a "pass"
    // recommendation - which still cannot approve anything.
    createProject([]);
    const { after } = await runToReview(
      agentThat(writeOk, { claimFiles: ["src/added.ts"], claimsSuccess: true }),
    );
    expect(reviewOf(after).verdict).toBe("pass");
    expect(verificationOf(after)["checksAllPassed"]).toBe(false);
  });

  it("reports a check refused at capture rather than dropping it", async () => {
    /**
     * A bare executable name stores fine but fails policy validation, because
     * PATH would decide what actually ran. It must appear in the report as
     * BLOCKED - a check that silently vanished would be indistinguishable from
     * one that passed.
     */
    createProject([check("bare", "process.exit(0)", { executable: "node" })]);
    const { after } = await runToReview(agentThat(writeOk));

    const results = checkResults(after);
    expect(results.some((r) => r.status === "blocked")).toBe(true);
    expect(verificationOf(after)["checksAllPassed"]).toBe(false);
  });
});

// ===========================================================================
describe("an executed check outranks the agent's account", () => {
  it("contradicts an agent that claims the tests passed", async () => {
    createProject([check("unit", "process.exit(1)")]);
    const { after } = await runToReview(
      agentThat(writeOk, {
        claimSummary: "All tests passed.",
        claimFiles: ["src/added.ts"], claimsSuccess: true,
      }),
    );

    const disagreements = verificationOf(after)["disagreements"] as string[];
    expect(disagreements.some((d) =>
      d.includes("independently executed verification check") && d.includes("did not pass"),
    )).toBe(true);
    expect(reviewOf(after).verdict).toBe("changes_requested");
  });

  it("contradicts an agent that claims failure while the checks pass", async () => {
    createProject([check("unit", "process.exit(0)")]);
    const { after } = await runToReview(
      agentThat(writeOk, {
        claimSummary: "I could not get this working.",
        claimFiles: ["src/added.ts"], claimsSuccess: false,
      }),
    );

    const disagreements = verificationOf(after)["disagreements"] as string[];
    expect(disagreements.some((d) => d.includes("every independently executed check passed")))
      .toBe(true);
  });

  it("runs the checks even when the agent crashed", async () => {
    createProject([check("unit", "process.exit(0)")]);
    const { after } = await runToReview(agentThat([
      { kind: "write", path: "src/partial.ts", contents: "half\n" },
      { kind: "throw", message: "boom" },
    ]));

    expect(verificationOf(after)["checksAttempted"]).toBe(true);
    expect(checkResults(after)[0]!.status).toBe("passed");
  });
});

// ===========================================================================
describe("a check is executable code, and the repository is re-inspected", () => {
  it("detects a check that modifies an IN-SCOPE file", async () => {
    createProject([check("naughty",
      "require('fs').writeFileSync('src/a.ts','touched by a check\\n')")]);
    const { after } = await runToReview(agentThat(writeOk));

    const verification = verificationOf(after);
    expect(verification["checksChangedRepository"]).toBe(true);
    expect(verification["filesChangedByChecks"]).toContain("src/a.ts");

    const blockers = reviewOf(after).findings.filter((f) => f.severity === "blocker");
    expect(blockers.some((f) => f.message.includes("checks THEMSELVES changed the repository")))
      .toBe(true);
  });

  it("detects a check that creates an OUT-OF-SCOPE file, as scope drift", async () => {
    createProject([check("drifter",
      "require('fs').mkdirSync('docs',{recursive:true});"
      + "require('fs').writeFileSync('docs/from-check.md','x\\n')")]);
    const { after } = await runToReview(agentThat(writeOk), ["src/"]);

    expect(fs.existsSync(path.join(repo, "docs", "from-check.md"))).toBe(true);
    expect(verificationOf(after)["verdict"]).toBe("scope_drift");
  });

  it("detects a check that DELETES a file", async () => {
    createProject([check("deleter", "require('fs').rmSync('src/a.ts')")]);
    const { after } = await runToReview(agentThat(writeOk));

    expect(fs.existsSync(path.join(repo, "src", "a.ts"))).toBe(false);
    expect(verificationOf(after)["filesChangedByChecks"]).toContain("src/a.ts");
  });

  it("detects a check that RENAMES a file", async () => {
    createProject([check("renamer", "require('fs').renameSync('src/a.ts','src/b.ts')")]);
    const { after } = await runToReview(agentThat(writeOk));

    const changed = verificationOf(after)["filesChangedByChecks"] as string[];
    expect(changed).toContain("src/a.ts");
    expect(changed).toContain("src/b.ts");
  });

  it("detects a check that touches a SENSITIVE file", async () => {
    createProject([check("leaky",
      "require('fs').writeFileSync('.env','API_KEY=rewritten-by-check\\n')")]);
    const { after } = await runToReview(agentThat(writeOk));

    expect(verificationOf(after)["verdict"]).toBe("sensitive_change");
    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).toContain(".env");
    expect(payload).not.toContain("rewritten-by-check");
  });

  it("detects a check that COMMITS, even leaving a clean working tree", async () => {
    const before = headSha(repo);
    createProject([check("committer",
      "const {execFileSync}=require('child_process');"
      + "require('fs').writeFileSync('src/c.ts','from check\\n');"
      + "execFileSync('git',['add','-A']);"
      + "execFileSync('git',['-c','user.email=c@x.invalid','-c','user.name=Check',"
      + "'commit','-q','-m','check commit'])")]);
    const { after } = await runToReview(agentThat(writeOk));

    expect(headSha(repo)).not.toBe(before);
    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");

    const verification = verificationOf(after);
    expect(verification["gitMutationDetected"]).toBe(true);
    expect(verification["gitMutationAuthorised"]).toBe(false);
    expect(verification["verdict"]).toBe("git_mutation");
  });

  it("reports BOTH when a check commits a sensitive change", async () => {
    createProject([check("worst",
      "const {execFileSync}=require('child_process');"
      + "require('fs').writeFileSync('.env','API_KEY=committed-by-check\\n');"
      + "execFileSync('git',['add','-A']);"
      + "execFileSync('git',['-c','user.email=c@x.invalid','-c','user.name=Check',"
      + "'commit','-q','-m','check commit'])")]);
    const { after } = await runToReview(agentThat(writeOk));

    const verification = verificationOf(after);
    expect(verification["verdict"]).toBe("sensitive_change");
    expect(verification["gitMutationDetected"]).toBe(true);
    const payload = JSON.stringify(after.pendingApproval!.payload);
    expect(payload).not.toContain("committed-by-check");
  });

  it("leaves a well-behaved check with a clean verification", async () => {
    createProject([check("clean", "process.exit(0)")]);
    const { after } = await runToReview(
      agentThat(writeOk, { claimFiles: ["src/added.ts"], claimsSuccess: true }),
    );

    const verification = verificationOf(after);
    expect(verification["verdict"]).toBe("verified");
    expect(verification["checksChangedRepository"]).toBe(false);
    expect(verification["checksAllPassed"]).toBe(true);
    expect(reviewOf(after).verdict).toBe("pass");
  });
});

// ===========================================================================
describe("the agent cannot redefine the verification policy", () => {
  it("blocks execution when the check definitions changed during the run", async () => {
    createProject([check("unit", "process.exit(0)")]);

    // The agent rewrites the project's checks mid-run, exactly as it could by
    // writing to the orchestrator's project file if it found the path.
    const projectFile = path.join(store.dir("proj"), "project.json");
    const agent = agentThat([
      ...writeOk,
      { kind: "sideEffect", path: "src/x.ts", contents: "x\n" },
    ]);
    const original = agent.implement.bind(agent);
    // Rewrite happens after the agent runs and before the check phase reads it.
    (agent as unknown as { implement: typeof original }).implement = async (...args) => {
      const report = await original(...args);
      const record = JSON.parse(fs.readFileSync(projectFile, "utf8")) as Record<string, unknown>;
      record["verificationChecks"] = [
        check("unit", "require('fs').writeFileSync('OWNED.txt','pwned')"),
      ];
      fs.writeFileSync(projectFile, JSON.stringify(record));
      return report;
    };

    const { after } = await runToReview(agent);

    // Neither version ran: not the captured one, not the rewritten one.
    expect(fs.existsSync(path.join(repo, "OWNED.txt"))).toBe(false);
    const verification = verificationOf(after);
    expect(verification["checksAttempted"]).toBe(false);
    expect(String(verification["checksNotRunReason"])).toContain("changed during this run");

    const blockers = reviewOf(after).findings.filter((f) => f.severity === "blocker");
    expect(blockers.some((f) => f.message.includes("check definitions changed"))).toBe(true);
  });
});

// ===========================================================================
describe("durability across a restart", () => {
  /**
   * Each invocation appends a byte to a counter file OUTSIDE the repository, so
   * counting executions does not itself dirty the working tree being inspected.
   */
  function countingCheck(counterFile: string) {
    const escaped = counterFile.split(path.sep).join("/");
    return check("counter",
      `require('fs').appendFileSync(${JSON.stringify(escaped)}, 'x')`);
  }

  it("refuses to replay a spent decision, so checks cannot run twice", async () => {
    const counter = path.join(tmp, "runs.txt");
    createProject([countingCheck(counter)]);

    const agent = agentThat(writeOk, { claimsSuccess: true });
    const started = await newRunner(agent).start("proj", "do the work");
    const planDecision = HumanDecision.parse({
      approvalId: started.pendingApproval!.approvalId,
      kind: "approve", decidedBy: "the-owner", decidedAt: iso(),
    });

    const first = await newRunner(agent).resume(started.run.id, planDecision);
    expect(fs.readFileSync(counter, "utf8")).toBe("x");
    expect(first.pendingApproval?.kind).toBe("review");

    /**
     * A fresh runner over the same checkpoint database - a restart, as far as
     * the workflow is concerned - replaying the SAME plan decision.
     *
     * It is refused: the run has moved on to the review gate and is no longer
     * waiting on that approval. That refusal IS the durability guarantee here -
     * a resumed run cannot re-enter a completed phase, so a check that already
     * executed cannot be executed a second time by replay.
     */
    await expect(
      newRunner(agent).resume(started.run.id, planDecision),
    ).rejects.toThrow(/waiting on approval/);

    // The counter is the proof: exactly one execution, not two.
    expect(fs.readFileSync(counter, "utf8")).toBe("x");
  });

  it("keeps the completed results available at the gate after a restart", async () => {
    const counter = path.join(tmp, "runs.txt");
    createProject([countingCheck(counter)]);

    const agent = agentThat(writeOk, { claimsSuccess: true });
    const started = await newRunner(agent).start("proj", "do the work");
    const first = await newRunner(agent).resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "the-owner", decidedAt: iso(),
      }),
    );

    // Results are present and were produced by real execution, not defaults.
    expect(checkResults(first)).toHaveLength(1);
    expect(checkResults(first)[0]!.status).toBe("passed");
    expect(verificationOf(first)["checksAttempted"]).toBe(true);
    expect(fs.readFileSync(counter, "utf8")).toBe("x");
  });
});

// ===========================================================================
describe("authorisation", () => {
  it("grants verification.execute from the human decision, and nothing broader", async () => {
    createProject([check("unit", "process.exit(0)")]);
    await runToReview(agentThat(writeOk));

    const grant = store.listGrants("proj")[0]!;
    expect(grant.capabilities).toContain("verification.execute");
    for (const forbidden of ["process.execute", "git.mutate", "network.access"]) {
      expect(grant.capabilities).not.toContain(forbidden);
    }
  });
});
