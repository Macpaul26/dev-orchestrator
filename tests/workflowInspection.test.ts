import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { EventLog } from "../src/events/log.js";
import { HumanDecision } from "../src/domain/approval.js";
import { createRegistry } from "../src/tools/registry.js";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { tmpDir, rmDir, git, initRepo, snapshotTree, diffSnapshots } from "./helpers.js";

/**
 * THE INSPECT PHASE, END TO END.
 *
 * The workflow tests in workflow.test.ts prove the graph and the interrupts.
 * These prove that `inspect` and `verify` now do real work against a real
 * repository - and that an inspection failure is visible rather than silent.
 */

let tmp: string;
let repo: string;
let store: ProjectStore;
let dbPath: string;

const iso = () => new Date().toISOString();
const openSavers: unknown[] = [];

function newRunner(): WorkflowRunner {
  const saver = createCheckpointer(dbPath);
  openSavers.push(saver);
  return new WorkflowRunner(new ProjectStore(path.join(tmp, "projects")), saver);
}

beforeEach(() => {
  tmp = tmpDir("orch-wfi-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  store = new ProjectStore(path.join(tmp, "projects"));
  dbPath = path.join(tmp, "checkpoints.sqlite");
  store.createProject({
    id: "real", name: "Real Repo", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
  });
});

afterEach(() => {
  for (const saver of openSavers.splice(0)) closeCheckpointer(saver);
  rmDir(tmp);
});

describe("inspect against a real repository", () => {
  it("records genuine git state in the run's observations", async () => {
    const result = await newRunner().start("real", "Have a look around");
    const observations = (result.state as { observations?: string[] }).observations ?? [];

    expect(observations.some((o) => o.startsWith("branch: main"))).toBe(true);
    expect(observations.some((o) => o.startsWith("head: "))).toBe(true);
    expect(observations.some((o) => o.includes("working tree: clean"))).toBe(true);
    expect(observations.some((o) => o.startsWith("tracked files: 1"))).toBe(true);
  });

  it("emits a repository_inspected event carrying counts, not contents", async () => {
    const result = await newRunner().start("real", "Emit inspection");
    const events = new EventLog(store.historyFile("real", result.run.id)).read();

    const inspected = events.find((e) => e.type === "repository_inspected") as
      | { branch: string | null; clean: boolean; changedFileCount: number }
      | undefined;
    expect(inspected).toBeDefined();
    expect(inspected!.branch).toBe("main");
    expect(inspected!.clean).toBe(true);
    expect(inspected!.changedFileCount).toBe(0);
  });

  it("shows the human real repository state at the plan gate", async () => {
    const result = await newRunner().start("real", "Show me the repo");
    const repoSummary = result.pendingApproval!.payload["repository"] as Record<string, unknown>;
    expect(repoSummary["inspected"]).toBe(true);
    expect(repoSummary["branch"]).toBe("main");
    expect(repoSummary["clean"]).toBe(true);
  });

  it("verifies independently and reaches the review gate", async () => {
    const started = await newRunner().start("real", "Run it through");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );

    expect(after.pendingApproval?.kind).toBe("review");
    const verification = after.pendingApproval!.payload["verification"] as Record<string, unknown>;
    expect(verification["verifiedIndependently"]).toBe(true);
    expect(verification["checksDeclared"]).toBe(0);
    expect(verification["checksExecuted"]).toBe(0);

    const events = new EventLog(store.historyFile("real", started.run.id)).read();
    expect(events.some((e) => e.type === "verification_completed")).toBe(true);
  });

  it("detects a change made outside the approved scope", async () => {
    const started = await newRunner().start("real", "Narrow me");
    // The human narrows the scope, then something changes outside it.
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "outside-scope.ts"), "// unauthorised\n");

    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "edit", decidedBy: "owner", decidedAt: iso(),
        editedPlan: { ...started.pendingApproval!.proposedPlan!, allowedScope: ["src/"] },
      }),
    );

    const verification = after.pendingApproval!.payload["verification"] as Record<string, unknown>;
    expect(verification["scopeDrift"]).toContain("outside-scope.ts");

    const review = after.pendingApproval!.payload["review"] as { verdict: string; scopeDrift: string[] };
    expect(review.verdict).toBe("changes_requested");
    expect(review.scopeDrift).toContain("outside-scope.ts");
  });

  it("does not modify the repository over a full run", async () => {
    const before = snapshotTree(repo);
    const started = await newRunner().start("real", "Look, do not touch");
    await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual([]);
  });

  it("still stops at the human gate", async () => {
    const result = await newRunner().start("real", "Do not run away");
    expect(result.run.status).toBe("awaiting_approval");
    expect(result.run.phase).toBe("approve_plan");
  });
});

describe("inspection failure is visible, never silent", () => {
  beforeEach(() => {
    store.createProject({
      id: "gone", name: "Missing", workingDir: path.join(tmp, "not-here"),
      repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
    });
  });

  it("records the failure and still reaches the plan gate", async () => {
    const result = await newRunner().start("gone", "Inspect the void");
    expect(result.run.status).toBe("awaiting_approval");

    const observations = (result.state as { observations?: string[] }).observations ?? [];
    expect(observations.some((o) => o.includes("repository inspection FAILED"))).toBe(true);

    const events = new EventLog(store.historyFile("gone", result.run.id)).read();
    const failed = events.find((e) => e.type === "repository_inspection_failed") as
      | { code: string } | undefined;
    expect(failed?.code).toBe("working_dir_missing");
  });

  it("tells the human at the gate that nothing was inspected", async () => {
    const result = await newRunner().start("gone", "Warn me");
    const summary = result.pendingApproval!.payload["repository"] as Record<string, unknown>;
    expect(summary["inspected"]).toBe(false);
    expect(summary["failureCode"]).toBe("working_dir_missing");
  });

  it("never marks an unverifiable run as independently verified", async () => {
    const started = await newRunner().start("gone", "Do not lie to me");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    const verification = after.pendingApproval!.payload["verification"] as Record<string, unknown>;
    expect(verification["verifiedIndependently"]).toBe(false);
    expect(verification["observedFileCount"]).toBe(0);

    const review = after.pendingApproval!.payload["review"] as {
      verdict: string; findings: { severity: string; message: string }[];
    };
    expect(review.verdict).toBe("changes_requested");
    expect(review.findings.some((f) => f.message.includes("could not be independently verified")))
      .toBe(true);
  });
});

describe("declared checks are never executed by the workflow", () => {
  it("records them as declared-but-not-run", async () => {
    // A check command that would be obvious if it ever ran.
    store.createProject({
      id: "checked", name: "Checked", workingDir: repo,
      repoRoot: null, repo: null,
      checks: [{ name: "unit", command: "node -e \"require('fs').writeFileSync('PROOF','ran')\"", cwd: "." }],
      constraints: [], contextFiles: [],
    });

    const started = await newRunner().start("checked", "Verify me");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );

    const verification = after.pendingApproval!.payload["verification"] as Record<string, unknown>;
    expect(verification["checksDeclared"]).toBe(1);
    expect(verification["checksExecuted"]).toBe(0);
    // The command genuinely did not run.
    expect(fs.existsSync(path.join(repo, "PROOF"))).toBe(false);
  });
});

describe("capability boundary after Phase 3", () => {
  const inspector = () => new LocalGitRepositoryInspector({ workingDir: repo });

  it("registers repository tools WITHOUT gaining write capability", () => {
    const registry = createRegistry(inspector());
    expect(registry.list().length).toBeGreaterThan(1);
    expect(registry.hasWriteCapability()).toBe(false);
    expect(registry.list().every((t) => t.readOnly)).toBe(true);
    expect(registry.list().every((t) => t.risk === "LOW")).toBe(true);
  });

  /**
   * POSITIVE CONTROL for the two tests below.
   *
   * They assert that certain field names are ABSENT from every tool's input
   * schema. An assertion like that passes trivially if the inspection technique
   * sees nothing at all, so first prove the technique finds a field that IS
   * there.
   */
  it("can actually see field names in a tool's input schema", () => {
    const readFile = createRegistry(inspector()).get("repo.readFile")!;
    expect(JSON.stringify(readFile.input)).toContain("path");
  });

  it("exposes no tool that accepts a command, an argument list or a git subcommand", () => {
    const tools = createRegistry(inspector()).list();
    expect(tools.length).toBeGreaterThan(1);
    for (const tool of tools) {
      const shape = JSON.stringify(tool.input);
      expect(shape).toBeTypeOf("string");
      for (const forbidden of ["command", "args", "argv", "subcommand", "shell", "exec"]) {
        expect(shape).not.toContain(forbidden);
      }
    }
  });

  it("exposes no tool that accepts a security-sensitive limit override", () => {
    const tools = createRegistry(inspector()).list();
    expect(tools.length).toBeGreaterThan(1);
    for (const tool of tools) {
      const shape = JSON.stringify(tool.input);
      expect(shape).toBeTypeOf("string");
      for (const forbidden of ["maxFileBytes", "maxDepth", "maxListedFiles", "maxDiffBytes"]) {
        expect(shape).not.toContain(forbidden);
      }
    }
  });

  it("keeps repository tools out of a registry built without a project", () => {
    const registry = createRegistry();
    expect(registry.list().map((t) => t.name)).toEqual(["orchestrator.describe"]);
    expect(registry.hasWriteCapability()).toBe(false);
  });

  it("cannot reach a repository through a tool once the boundary rejects it", async () => {
    const registry = createRegistry(inspector());
    const readFile = registry.get("repo.readFile")!;
    await expect(readFile.run({ path: "../../../etc/passwd" } as never)).rejects.toThrow();
  });

  it("reads a legitimate file through a tool", async () => {
    git(repo, ["status", "--porcelain"]); // fixture sanity, not the adapter
    const registry = createRegistry(inspector());
    const result = await registry.get("repo.readFile")!.run({ path: "README.md" } as never);
    expect((result as { available: boolean; content: string }).available).toBe(true);
    expect((result as { content: string }).content).toContain("# fixture");
  });
});
