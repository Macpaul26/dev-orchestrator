import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProjectStore } from "../src/projects/projectStore.js";
import { ControlledImplementationRunner } from "../src/implementation/runner.js";
import { ActivityJournal } from "../src/activity/journal.js";
import {
  issueGrant, fingerprintGrant,
  MAX_GRANT_WRITES, MAX_GRANT_WRITE_BYTES, ImplementationGrant,
} from "../src/domain/grant.js";
import type { Capability } from "../src/domain/capability.js";
import { FakeImplementationAgent, type FakeStep } from "./fakeAgent.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * ONE APPROVAL, ONE ATTEMPT.
 *
 *   > A grant authorises at most one implementation attempt. After it has been
 *   > claimed, every later attempt fails closed.
 *
 * The gap these tests close: `consumed` existed in the schema and in the
 * validator, but nothing ever transitioned a grant into it - so a grant stayed
 * `active` after a run and could be replayed until it expired.
 */

let parent: string;
let repo: string;
let store: ProjectStore;
let runner: ControlledImplementationRunner;

const RUN = "run_life";
const CAPS: Capability[] = ["repo.read", "repo.metadata.read", "repo.file.write", "repo.file.delete"];

function makeGrant(over: Partial<Parameters<typeof issueGrant>[0]> = {}) {
  return store.saveGrant(
    issueGrant({
      projectId: "proj", runId: RUN, approvalId: "apr_1", approvedBy: "owner",
      allowedScope: ["src/"], capabilities: CAPS, ...over,
    }),
  );
}

const agentDoing = (...steps: FakeStep[]) => new FakeImplementationAgent({ steps });
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));

beforeEach(() => {
  parent = tmpDir("orch-life-");
  repo = path.join(parent, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);

  store = new ProjectStore(path.join(parent, "projects"));
  store.createProject({
    id: "proj", name: "Proj", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
  });
  runner = new ControlledImplementationRunner({ store });
});

afterEach(() => rmDir(parent));

// ===========================================================================
describe("a grant is consumed by ONE attempt, whatever its outcome", () => {
  it("SUCCESS consumes the grant, and reuse is denied with no further mutation", async () => {
    const grant = makeGrant();

    const first = await runner.run(
      grant, { instruction: "x" },
      agentDoing({ kind: "write", path: "src/one.ts", contents: "one\n" }),
    );
    expect(first.run.status).toBe("completed");
    expect(exists("src/one.ts")).toBe(true);
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");

    // The same grant object, presented again.
    const second = agentDoing({ kind: "write", path: "src/two.ts", contents: "two\n" });
    await expect(runner.run(grant, { instruction: "x" }, second))
      .rejects.toMatchObject({ reason: "consumed" });

    // NOTHING further reached the repository.
    expect(exists("src/two.ts")).toBe(false);
    expect(second.results).toHaveLength(0);
  });

  it("FAILURE consumes the grant", async () => {
    const grant = makeGrant();
    const first = await runner.run(
      grant, { instruction: "x" },
      agentDoing(
        { kind: "write", path: "src/partial.ts", contents: "landed\n" },
        { kind: "throw" },
      ),
    );
    expect(first.run.status).toBe("failed");
    // Partial work stands, and the authorisation is spent.
    expect(exists("src/partial.ts")).toBe(true);
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");

    await expect(runner.run(grant, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "consumed" });
  });

  it("CANCELLATION consumes the grant", async () => {
    const grant = makeGrant();
    const first = await runner.run(
      grant, { instruction: "x" },
      agentDoing(
        { kind: "write", path: "src/half.ts", contents: "half\n" },
        { kind: "cancel" },
      ),
    );
    expect(first.run.status).toBe("cancelled");
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");

    await expect(runner.run(grant, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "consumed" });
  });

  it("a read-only grant is single-use too, without any lock involved", async () => {
    const readOnly = makeGrant({ capabilities: ["repo.read"] as Capability[] });
    await runner.run(readOnly, { instruction: "x" }, agentDoing());
    expect(store.getGrant("proj", readOnly.grantId)!.status).toBe("consumed");
    await expect(runner.run(readOnly, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "consumed" });
  });

  it("does not silently issue a replacement grant", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());
    await runner.run(grant, { instruction: "x" }, agentDoing()).catch(() => undefined);
    expect(store.listGrants("proj")).toHaveLength(1);
  });
});

// ===========================================================================
describe("consumption is durable, not in-memory", () => {
  it("a BRAND NEW runner over the same store still refuses", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());

    const fresh = new ControlledImplementationRunner({
      store: new ProjectStore(path.join(parent, "projects")),
    });
    await expect(fresh.run(grant, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "consumed" });
  });

  it("survives a real, separate NODE PROCESS", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());

    // A different OS process, sharing nothing but the files on disk.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const storeModule = pathToFileURL(
      path.join(here, "..", "dist", "projects", "projectStore.js"),
    ).href;
    const script = `
      import { ProjectStore } from ${JSON.stringify(storeModule)};
      const store = new ProjectStore(${JSON.stringify(path.join(parent, "projects"))});
      const g = store.getGrant("proj", ${JSON.stringify(grant.grantId)});
      process.stdout.write(JSON.stringify({
        status: g.status,
        claimed: store.isGrantClaimed("proj", ${JSON.stringify(grant.grantId)}),
      }));
    `;
    const file = path.join(parent, "probe.mjs");
    fs.writeFileSync(file, script);

    const out = execFileSync(process.execPath, [file], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ status: "consumed", claimed: true });
  });

  it("the CLAIM MARKER wins even if the JSON still says active", () => {
    // Simulates a crash between the atomic claim and the status write. The
    // marker is the single indivisible commit point, so it decides.
    const grant = makeGrant();
    expect(store.claimGrant("proj", grant.grantId)).not.toBeNull();

    // Roll the JSON back to `active`, leaving the marker in place.
    store.saveGrant({ ...grant, status: "active" });
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(parent, "projects", "proj", "grants", `${grant.grantId}.json`), "utf8",
      ),
    );
    expect(raw.status).toBe("active");

    // Read back through the store: still consumed.
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");
    expect(store.claimGrant("proj", grant.grantId)).toBeNull();
  });

  it("an interrupted run never becomes a reusable grant", async () => {
    const grant = makeGrant();
    // The claim happens before the agent, so a process that dies mid-agent has
    // already spent the grant.
    await runner.run(
      grant, { instruction: "x" },
      agentDoing({ kind: "write", path: "src/x.ts", contents: "x\n" }, { kind: "throw" }),
    ).catch(() => undefined);

    runner.reconcile("proj"); // whatever reconciliation does, it must not restore it
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");
    await expect(runner.run(grant, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "consumed" });
  });
});

// ===========================================================================
describe("concurrency: exactly one consumer", () => {
  it("only one of many simultaneous claims succeeds", () => {
    const grant = makeGrant();
    const outcomes = Array.from({ length: 12 }, () => store.claimGrant("proj", grant.grantId));
    expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
    expect(outcomes.filter((o) => o === null)).toHaveLength(11);
  });

  it("two concurrent runs on the same grant produce exactly one implementation", async () => {
    const grant = makeGrant();
    const a = agentDoing({ kind: "write", path: "src/a.ts", contents: "a\n" });
    const b = agentDoing({ kind: "write", path: "src/b.ts", contents: "b\n" });

    const results = await Promise.allSettled([
      runner.run(grant, { instruction: "a" }, a),
      runner.run(grant, { instruction: "b" }, b),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // Exactly one of the two files exists.
    expect([exists("src/a.ts"), exists("src/b.ts")].filter(Boolean)).toHaveLength(1);
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");
  });

  it("the grant is single-use INDEPENDENTLY of the project lock", () => {
    // Claiming twice is refused even though no lock was ever taken.
    const grant = makeGrant();
    expect(fs.existsSync(path.join(store.dir("proj"), "implementation.lock"))).toBe(false);
    expect(store.claimGrant("proj", grant.grantId)).not.toBeNull();
    expect(store.claimGrant("proj", grant.grantId)).toBeNull();
  });

  it("lock contention alone does NOT burn the grant", async () => {
    // The claim happens after the lock, so a transient collision leaves the
    // human's approval intact rather than destroying it.
    const grant = makeGrant();
    const blocker = makeGrant({ runId: "run_other", approvalId: "apr_2" });

    // Hold the lock under a different run, then attempt ours.
    const lockFile = path.join(store.dir("proj"), "implementation.lock");
    fs.mkdirSync(store.dir("proj"), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({
      projectId: "proj", runId: "run_holder", grantId: blocker.grantId,
      pid: process.pid, hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    }));

    await expect(runner.run(grant, { instruction: "x" }, agentDoing())).rejects.toThrow();
    // Still usable once the lock clears.
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("active");

    fs.rmSync(lockFile);
    const after = await runner.run(grant, { instruction: "x" }, agentDoing());
    expect(after.run.status).toBe("completed");
  });
});

// ===========================================================================
describe("a consumed grant cannot be laundered", () => {
  it("resetting status to active in the presented copy does not help", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());

    // `status` is not part of the fingerprint, so this copy is internally
    // consistent - and still refused, because the STORED record decides.
    const laundered = { ...grant, status: "active" as const };
    await expect(runner.run(laundered, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "consumed" });
  });

  it("a widened AND re-fingerprinted consumed grant is still refused", async () => {
    const grant = makeGrant({ allowedScope: ["src/"] });
    await runner.run(grant, { instruction: "x" }, agentDoing());

    const widened = { ...grant, allowedScope: ["."], status: "active" as const };
    const resigned = { ...widened, fingerprint: fingerprintGrant(widened) };
    await expect(runner.run(resigned, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "tampered" });
  });

  it("deleting the grant JSON does not resurrect it", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());
    fs.rmSync(path.join(parent, "projects", "proj", "grants", `${grant.grantId}.json`));

    await expect(runner.run(grant, { instruction: "x" }, agentDoing()))
      .rejects.toMatchObject({ reason: "unknown_grant" });
  });

  it("project and run binding remain enforced on a fresh grant", async () => {
    const grant = makeGrant();
    await expect(runner.run({ ...grant, projectId: "other" }, { instruction: "x" }, agentDoing()))
      .rejects.toThrow();
    await expect(runner.run({ ...grant, runId: "run_other" }, { instruction: "x" }, agentDoing()))
      .rejects.toThrow();
    // Untouched by the failed attempts.
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("active");
  });
});

// ===========================================================================
describe("the mutation budget has a real ceiling", () => {
  it("clamps an absurd write budget", () => {
    const g = issueGrant({
      projectId: "proj", runId: RUN, approvalId: "a", approvedBy: "o",
      allowedScope: ["src/"], capabilities: CAPS,
      maxWrites: Number.MAX_SAFE_INTEGER,
      maxWriteBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(g.maxWrites).toBe(MAX_GRANT_WRITES);
    expect(g.maxWriteBytes).toBe(MAX_GRANT_WRITE_BYTES);
  });

  it("keeps the existing defaults", () => {
    const g = issueGrant({
      projectId: "proj", runId: RUN, approvalId: "a", approvedBy: "o",
      allowedScope: ["src/"], capabilities: CAPS,
    });
    expect(g.maxWrites).toBe(200);
    expect(g.maxWriteBytes).toBe(1024 * 1024);
  });

  it("honours a request that TIGHTENS the budget", () => {
    const g = issueGrant({
      projectId: "proj", runId: RUN, approvalId: "a", approvedBy: "o",
      allowedScope: ["src/"], capabilities: CAPS, maxWrites: 3, maxWriteBytes: 64,
    });
    expect(g.maxWrites).toBe(3);
    expect(g.maxWriteBytes).toBe(64);
  });

  it("REJECTS a stored grant whose budget exceeds the ceiling", () => {
    // The schema is the enforcement point, so a hand-edited grant file above
    // the limit cannot be smuggled in through the store either.
    const base = issueGrant({
      projectId: "proj", runId: RUN, approvalId: "a", approvedBy: "o",
      allowedScope: ["src/"], capabilities: CAPS,
    });
    expect(() =>
      ImplementationGrant.parse({ ...base, maxWrites: MAX_GRANT_WRITES + 1 }),
    ).toThrow();
    expect(() =>
      ImplementationGrant.parse({ ...base, maxWriteBytes: MAX_GRANT_WRITE_BYTES + 1 }),
    ).toThrow();
  });

  it("rejects Infinity, NaN and fractional budgets", () => {
    const base = issueGrant({
      projectId: "proj", runId: RUN, approvalId: "a", approvedBy: "o",
      allowedScope: ["src/"], capabilities: CAPS,
    });
    for (const value of [Infinity, -Infinity, NaN, 1.5, 0, -1]) {
      expect(() => ImplementationGrant.parse({ ...base, maxWrites: value }),
        `maxWrites=${value} must be rejected`).toThrow();
    }
  });

  it("the ceiling is actually enforced during a run", async () => {
    const grant = makeGrant({ maxWrites: 2 });
    const agent = agentDoing(
      { kind: "write", path: "src/a.ts", contents: "1" },
      { kind: "write", path: "src/b.ts", contents: "2" },
      { kind: "write", path: "src/c.ts", contents: "3" },
    );
    await runner.run(grant, { instruction: "x" }, agent);
    expect(agent.results[2]!.denial).toBe("write_budget_exhausted");
    expect(exists("src/c.ts")).toBe(false);
  });
});

// ===========================================================================
describe("consumption is visible in orchestrator-owned evidence", () => {
  it("records grant_consumed with metadata only", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());

    const records = new ActivityJournal(store.activityFile("proj", RUN)).read();
    const consumed = records.find((r) => r.type === "grant_consumed") as
      { grantId: string | null; claimedByPid: number; claimedByHost: string } | undefined;

    expect(consumed).toBeDefined();
    expect(consumed!.grantId).toBe(grant.grantId);
    expect(consumed!.claimedByPid).toBe(process.pid);
    expect(typeof consumed!.claimedByHost).toBe("string");
  });

  it("records the refusal when a consumed grant is presented again", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());
    await runner.run(grant, { instruction: "x" }, agentDoing()).catch(() => undefined);

    const denied = new ActivityJournal(store.activityFile("proj", RUN))
      .read().find((r) => r.type === "grant_reuse_denied") as
      { reason: string; detail: string } | undefined;

    expect(denied).toBeDefined();
    expect(denied!.reason).toBe("consumed");
  });

  it("the journal carries no file contents", async () => {
    const grant = makeGrant();
    const secret = "GRANT_LIFECYCLE_SECRET_zzz";
    await runner.run(
      grant, { instruction: "x" },
      agentDoing({ kind: "write", path: "src/s.ts", contents: `const x = "${secret}";\n` }),
    );
    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain(secret);
  });
});
