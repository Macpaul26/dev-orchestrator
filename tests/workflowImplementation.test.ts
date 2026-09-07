import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { HumanDecision } from "../src/domain/approval.js";
import { ActivityJournal } from "../src/activity/journal.js";
import { machineTransition, InvariantViolation } from "../src/domain/task.js";
import { FakeImplementationAgent } from "./fakeAgent.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * PHASE 4A THROUGH THE ACTUAL WORKFLOW.
 *
 * The unit suites prove the substrate. This proves the wiring: that a grant is
 * minted by the HUMAN APPROVAL and by nothing else, that the implement node
 * cannot write without one, and that verification and the second human gate are
 * still in the path afterwards.
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

beforeEach(() => {
  tmp = tmpDir("orch-wfimpl-");
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

describe("the grant comes from the human approval and nowhere else", () => {
  it("mints NO grant before the plan gate", async () => {
    const started = await newRunner().start("proj", "do a thing");
    expect(started.run.status).toBe("awaiting_approval");
    expect(store.listGrants("proj")).toHaveLength(0);
  });

  it("mints one when a human approves, bound to project, run and approval", async () => {
    const started = await newRunner().start("proj", "do a thing");
    await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "the-owner", decidedAt: iso(),
      }),
    );

    const grants = store.listGrants("proj");
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant.projectId).toBe("proj");
    expect(grant.runId).toBe(started.run.id);
    expect(grant.approvalId).toBe(started.pendingApproval!.approvalId);
    expect(grant.approvedBy).toBe("the-owner");
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("inherits the scope the human NARROWED with edit", async () => {
    const started = await newRunner().start("proj", "narrow me");
    await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "edit", decidedBy: "owner", decidedAt: iso(),
        editedPlan: { ...started.pendingApproval!.proposedPlan!, allowedScope: ["src/only/"] },
      }),
    );
    expect(store.listGrants("proj")[0]!.allowedScope).toEqual(["src/only"]);
  });

  it("mints NO grant when the human rejects", async () => {
    const started = await newRunner().start("proj", "no thanks");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "reject", decidedBy: "owner", decidedAt: iso(), comment: "no",
      }),
    );
    expect(after.run.status).toBe("rejected");
    expect(store.listGrants("proj")).toHaveLength(0);
  });

  it("carries only bounded repository capabilities", async () => {
    const started = await newRunner().start("proj", "x");
    await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    const grant = store.listGrants("proj")[0]!;
    // Task 005: the same human decision also authorises running the check
    // policy captured before this run. Nothing broader.
    expect([...grant.capabilities].sort()).toEqual([
      "repo.file.delete", "repo.file.write", "repo.metadata.read", "repo.read",
      "verification.execute",
    ]);
    for (const forbidden of ["git.mutate", "process.execute", "network.access"]) {
      expect(grant.capabilities).not.toContain(forbidden);
    }
  });
});

describe("the default configuration writes nothing", () => {
  it("issues the grant but leaves it unused when no agent is connected", async () => {
    const before = fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8");
    const started = await newRunner().start("proj", "x");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );

    expect(after.pendingApproval?.kind).toBe("review");
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe(before);
    expect(store.listGrants("proj")).toHaveLength(1);
    // No implementation record at all: the runner was never entered.
    expect(store.getImplementation("proj", started.run.id)).toBeNull();
  });
});

describe("with an agent connected, the boundary holds inside the workflow", () => {
  it("writes inside the approved scope and is verified afterwards", async () => {
    const agent = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: "src/added.ts", contents: "export const b = 2;\n" },
        { kind: "write", path: "outside.ts", contents: "should be denied\n" },
      ],
      claimFiles: ["src/added.ts", "src/imaginary.ts"],
    });

    const started = await newRunner(agent).start("proj", "add b");
    const after = await newRunner(agent).resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "edit", decidedBy: "owner", decidedAt: iso(),
        editedPlan: { ...started.pendingApproval!.proposedPlan!, allowedScope: ["src/"] },
      }),
    );

    // The in-scope write landed; the out-of-scope one did not.
    expect(fs.existsSync(path.join(repo, "src", "added.ts"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "outside.ts"))).toBe(false);

    // Verification ran and observed the real change, not the claimed one.
    const verification = after.pendingApproval!.payload["verification"] as Record<string, unknown>;
    expect(verification["verifiedIndependently"]).toBe(true);
    const attribution = verification["attribution"] as Record<string, unknown>;
    expect(attribution["introduced"]).toContain("src/added.ts");
    expect(attribution["introduced"]).not.toContain("src/imaginary.ts");

    // The activity journal recorded both the write and the denial.
    const types = new ActivityJournal(store.activityFile("proj", started.run.id))
      .read().map((r) => r.type);
    expect(types).toContain("write_completed");
    expect(types).toContain("write_denied");
  });

  it("still stops at the SECOND human gate - no machine path to approved", async () => {
    const agent = new FakeImplementationAgent({
      steps: [{ kind: "write", path: "src/added.ts", contents: "x\n" }],
    });
    const started = await newRunner(agent).start("proj", "x");
    const after = await newRunner(agent).resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "edit", decidedBy: "owner", decidedAt: iso(),
        editedPlan: { ...started.pendingApproval!.proposedPlan!, allowedScope: ["src/"] },
      }),
    );

    // A successful implementation does NOT bypass review.
    expect(after.run.status).toBe("awaiting_approval");
    expect(after.pendingApproval?.kind).toBe("review");

    // And the machine still cannot reach APPROVED on its own.
    expect(() =>
      machineTransition(
        {
          id: "t", projectId: "proj", title: "t", status: "REVIEW",
          createdAt: iso(), updatedAt: iso(),
        } as never,
        "APPROVED",
      ),
    ).toThrow(InvariantViolation);
  });

  it("records the run so a human can see what the substrate did", async () => {
    const agent = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: "src/one.ts", contents: "1\n" },
        { kind: "write", path: "nope/two.ts", contents: "2\n" },
      ],
    });
    const started = await newRunner(agent).start("proj", "x");
    await newRunner(agent).resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "edit", decidedBy: "owner", decidedAt: iso(),
        editedPlan: { ...started.pendingApproval!.proposedPlan!, allowedScope: ["src/"] },
      }),
    );

    const record = store.getImplementation("proj", started.run.id)!;
    expect(record.status).toBe("completed");
    expect(record.writes).toBe(1);
    expect(record.denials).toBe(1);
    expect(record.partialChangesPossible).toBe(false);
    expect(record.agent).toBe("fake-test-agent");
  });

  it("leaves no lock behind after the run", async () => {
    const agent = new FakeImplementationAgent({
      steps: [{ kind: "write", path: "src/x.ts", contents: "x\n" }],
    });
    const started = await newRunner(agent).start("proj", "x");
    await newRunner(agent).resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    expect(fs.existsSync(path.join(store.dir("proj"), "implementation.lock"))).toBe(false);
  });
});
