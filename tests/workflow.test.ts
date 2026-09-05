import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { EventLog } from "../src/events/log.js";
import { HumanDecision } from "../src/domain/approval.js";
import { resolveWithin, PathEscapeError, isWithin } from "../src/persistence/paths.js";
import { createRegistry } from "../src/tools/registry.js";

let tmp: string;
let store: ProjectStore;
let dbPath: string;

const iso = () => new Date().toISOString();

/**
 * A fresh runner over the same on-disk stores - the in-process stand-in for a
 * new process. Each gets its own checkpointer handle, closed in afterEach.
 */
const openSavers: unknown[] = [];
function newRunner(): WorkflowRunner {
  const saver = createCheckpointer(dbPath);
  openSavers.push(saver);
  return new WorkflowRunner(new ProjectStore(path.join(tmp, "projects")), saver);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  store = new ProjectStore(path.join(tmp, "projects"));
  dbPath = path.join(tmp, "checkpoints.sqlite");
  store.createProject({
    id: "alpha", name: "Alpha", workingDir: path.join(tmp, "alpha-src"),
    repo: null, checks: [], constraints: [], contextFiles: [],
  });
});

afterEach(() => {
  // Release every SQLite handle before deleting the directory - Windows keeps
  // an open database file locked.
  for (const saver of openSavers.splice(0)) closeCheckpointer(saver);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("workflow progression", () => {
  it("walks to the plan gate and suspends there", async () => {
    const result = await newRunner().start("alpha", "Refine the homepage");
    expect(result.run.status).toBe("awaiting_approval");
    expect(result.run.phase).toBe("approve_plan");
    expect(result.pendingApproval?.kind).toBe("plan");
    expect(result.pendingApproval?.proposedPlan?.steps.length).toBeGreaterThan(0);
  });

  it("visits understand, inspect and plan before suspending", async () => {
    const result = await newRunner().start("alpha", "Do a thing");
    const events = new EventLog(store.historyFile("alpha", result.run.id)).read();
    const started = events.filter((e) => e.type === "node_started").map((e) => (e as { node: string }).node);
    expect(started).toEqual(["understand", "inspect", "plan", "approve_plan"]);
  });

  it("runs through both gates to completion", async () => {
    const started = await newRunner().start("alpha", "Ship it");
    const afterPlan = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    // Second gate.
    expect(afterPlan.run.status).toBe("awaiting_approval");
    expect(afterPlan.pendingApproval?.kind).toBe("review");

    const done = await newRunner().resume(
      afterPlan.run.id,
      HumanDecision.parse({
        approvalId: afterPlan.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    expect(done.run.status).toBe("completed");
    expect(done.run.outcome).toBe("approved");
  });

  it("routes feedback back to the plan node", async () => {
    const started = await newRunner().start("alpha", "Try again");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "feedback", decidedBy: "owner", decidedAt: iso(),
        comment: "narrow the scope",
      }),
    );
    // Replanned, and suspended at a NEW plan approval.
    expect(after.run.phase).toBe("approve_plan");
    expect(after.pendingApproval!.approvalId).not.toBe(started.pendingApproval!.approvalId);
  });

  it("short-circuits on rejection without reaching implement", async () => {
    const started = await newRunner().start("alpha", "No thanks");
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "reject", decidedBy: "owner", decidedAt: iso(), comment: "not now",
      }),
    );
    expect(after.run.status).toBe("rejected");
    expect(after.run.outcome).toBe("rejected_at_plan");

    const started2 = new EventLog(store.historyFile("alpha", after.run.id))
      .read().filter((e) => e.type === "node_started").map((e) => (e as { node: string }).node);
    expect(started2).not.toContain("implement");
  });

  it("applies an edited plan's narrowed scope", async () => {
    const started = await newRunner().start("alpha", "Edit me");
    const original = started.pendingApproval!.proposedPlan!;
    const after = await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "edit", decidedBy: "owner", decidedAt: iso(),
        editedPlan: { ...original, allowedScope: ["src/only-here/"] },
      }),
    );
    expect(after.run.status).toBe("awaiting_approval");
    expect(after.pendingApproval?.kind).toBe("review");
  });

  it("refuses a decision that answers a different approval", async () => {
    const started = await newRunner().start("alpha", "Mismatch");
    await expect(
      newRunner().resume(
        started.run.id,
        HumanDecision.parse({
          approvalId: "apr_someone_else", kind: "approve",
          decidedBy: "owner", decidedAt: iso(),
        }),
      ),
    ).rejects.toThrow(/waiting on approval/);
  });
});

describe("checkpoint persistence", () => {
  it("writes a durable SQLite checkpoint to disk", async () => {
    await newRunner().start("alpha", "Persist me");
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
  });

  it("keeps checkpoint state separate from the project store", async () => {
    const result = await newRunner().start("alpha", "Separate stores");
    // Project store is human-readable JSON...
    const runFile = path.join(tmp, "projects", "alpha", "runs", `${result.run.id}.json`);
    expect(fs.existsSync(runFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(runFile, "utf8")).status).toBe("awaiting_approval");
    // ...and lives nowhere near the checkpoint database.
    expect(path.dirname(runFile)).not.toBe(path.dirname(dbPath));
  });
});

describe("event history", () => {
  it("emits structured JSONL events including the interrupt", async () => {
    const result = await newRunner().start("alpha", "Log me");
    const file = store.historyFile("alpha", result.run.id);
    expect(fs.existsSync(file)).toBe(true);

    const types = new EventLog(file).read().map((e) => e.type);
    expect(types).toContain("workflow_started");
    expect(types).toContain("node_started");
    expect(types).toContain("approval_requested");
    expect(types).toContain("workflow_interrupted");
  });

  it("records resume with the pid that performed it", async () => {
    const started = await newRunner().start("alpha", "Resume log");
    await newRunner().resume(
      started.run.id,
      HumanDecision.parse({
        approvalId: started.pendingApproval!.approvalId,
        kind: "approve", decidedBy: "owner", decidedAt: iso(),
      }),
    );
    const events = new EventLog(store.historyFile("alpha", started.run.id)).read();
    const resumed = events.find((e) => e.type === "workflow_resumed");
    expect(resumed).toBeDefined();
    expect((resumed as { pid: number }).pid).toBe(process.pid);
  });

  it("rejects an event that does not match the schema", () => {
    const log = new EventLog(path.join(tmp, "bad.jsonl"));
    expect(() => log.append({ type: "not_a_real_event" } as never)).toThrow();
  });
});

describe("project isolation", () => {
  it("keeps two projects' runs independent", async () => {
    store.createProject({
      id: "beta", name: "Beta", workingDir: path.join(tmp, "beta-src"),
      repo: null, checks: [], constraints: [], contextFiles: [],
    });

    const a = await newRunner().start("alpha", "alpha work");
    const b = await newRunner().start("beta", "beta work");

    expect(store.listRuns("alpha").map((r) => r.id)).toEqual([a.run.id]);
    expect(store.listRuns("beta").map((r) => r.id)).toEqual([b.run.id]);

    // Resolving one project's run does not surface the other's.
    expect(store.getRun("alpha", b.run.id)).toBeNull();
    expect(store.findAwaitingApproval()).toHaveLength(2);
  });

  it("has no project-specific logic in the core", () => {
    // A project is a directory of configuration, so an arbitrary id works.
    const p = store.createProject({
      id: "some-other-product", name: "Other", workingDir: path.join(tmp, "o"),
      repo: null, checks: [], constraints: [], contextFiles: [],
    });
    expect(p.id).toBe("some-other-product");
  });
});

describe("filesystem containment", () => {
  it("resolves paths inside the root", () => {
    const root = path.join(tmp, "root");
    expect(resolveWithin(root, "a/b.ts")).toBe(path.resolve(root, "a/b.ts"));
    expect(isWithin(root, "a/b.ts")).toBe(true);
  });

  it("rejects traversal and absolute escapes", () => {
    const root = path.join(tmp, "root");
    expect(() => resolveWithin(root, "../secrets")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "a/../../secrets")).toThrow(PathEscapeError);
    expect(isWithin(root, "../secrets")).toBe(false);
    expect(isWithin(root, path.join(tmp, "elsewhere"))).toBe(false);
  });
});

describe("capability boundary", () => {
  it("registers no write-capable tool in this phase", () => {
    const registry = createRegistry();
    expect(registry.hasWriteCapability()).toBe(false);
    expect(registry.list().every((t) => t.risk === "LOW")).toBe(true);
  });

  it("refuses a tool that claims to be both HIGH risk and read-only", () => {
    const registry = createRegistry();
    expect(() =>
      registry.register({
        name: "bogus", description: "", input: { parse: (v: unknown) => v } as never,
        risk: "HIGH", readOnly: true, run: async () => null,
      }),
    ).toThrow();
  });
});
