import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import {
  ControlledImplementationRunner, NoOpImplementationAgent,
} from "../src/implementation/runner.js";
import { CancellationToken } from "../src/implementation/session.js";
import { ImplementationLock, LockDenied } from "../src/implementation/lock.js";
import { ActivityJournal } from "../src/activity/journal.js";
import { issueGrant, GrantDenied, fingerprintGrant } from "../src/domain/grant.js";
import type { Capability } from "../src/domain/capability.js";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier } from "../src/verification/verifier.js";
import { createRegistry } from "../src/tools/registry.js";
import { FakeImplementationAgent, InertAgent, type FakeStep } from "./fakeAgent.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * THE CONTROLLED IMPLEMENTATION BOUNDARY, END TO END.
 *
 * A deterministic fake agent attacks the substrate: traversal, escalation,
 * deletion outside scope, lying about what it changed, cancelling halfway. Every
 * refusal is asserted, and - crucially - the REPOSITORY is inspected afterwards
 * with the real Phase 3 machinery, because the runner's own account of what it
 * did is not evidence about files either.
 */

let parent: string;
let repo: string;
let store: ProjectStore;
let runner: ControlledImplementationRunner;

const RUN = "run_impl";
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
const journalFor = () => new ActivityJournal(store.activityFile("proj", RUN));
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");

beforeEach(() => {
  parent = tmpDir("orch-impl-");
  repo = path.join(parent, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "existing.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);

  store = new ProjectStore(path.join(parent, "projects"));
  store.createProject({
    id: "proj", name: "Proj", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
  });
  runner = new ControlledImplementationRunner({ store });
});

afterEach(() => rmDir(parent));

// ===========================================================================
describe("a grant is required, and it must be the ISSUED one", () => {
  it("refuses a grant that was never issued", async () => {
    const orphan = issueGrant({
      projectId: "proj", runId: RUN, approvalId: "apr_x", approvedBy: "owner",
      allowedScope: ["src/"], capabilities: CAPS,
    });
    await expect(runner.run(orphan, { instruction: "x" }, agentDoing()))
      .rejects.toThrow(/never issued/);
  });

  it("refuses a WIDENED copy even when its fingerprint is recomputed", async () => {
    // The agent's most valuable attack: re-sign a grant it rewrote. The stored
    // record is authoritative, so internal consistency is not enough.
    const real = makeGrant({ allowedScope: ["src/"] });
    const widened = { ...real, allowedScope: ["."] };
    const resigned = { ...widened, fingerprint: fingerprintGrant(widened) };

    await expect(runner.run(resigned, { instruction: "x" }, agentDoing()))
      .rejects.toThrow(/does not match the issued record/);
  });

  it("refuses an EXPIRED grant before touching anything", async () => {
    const expired = store.saveGrant(
      issueGrant({
        projectId: "proj", runId: RUN, approvalId: "apr_1", approvedBy: "owner",
        allowedScope: ["src/"], capabilities: CAPS,
        lifetimeMs: 1000, now: new Date(Date.now() - 60_000),
      }),
    );
    const agent = agentDoing({ kind: "write", path: "src/x.ts", contents: "x" });
    await expect(runner.run(expired, { instruction: "x" }, agent)).rejects.toThrow(GrantDenied);
    expect(exists("src/x.ts")).toBe(false);
  });

  it("refuses a grant issued for a DIFFERENT run", async () => {
    const other = store.saveGrant(
      issueGrant({
        projectId: "proj", runId: "run_other", approvalId: "apr_1", approvedBy: "owner",
        allowedScope: ["src/"], capabilities: CAPS,
      }),
    );
    // Present it as though it belonged to this run.
    const repointed = { ...other, runId: RUN };
    await expect(runner.run(repointed, { instruction: "x" }, agentDoing()))
      .rejects.toThrow(GrantDenied);
  });
});

// ===========================================================================
describe("writes are bounded by the approved scope", () => {
  it("allows a write inside the scope", async () => {
    const grant = makeGrant();
    const agent = agentDoing({ kind: "write", path: "src/new.ts", contents: "export const b = 2;\n" });
    const result = await runner.run(grant, { instruction: "add b" }, agent);

    expect(result.run.status).toBe("completed");
    expect(result.run.writes).toBe(1);
    expect(read("src/new.ts")).toContain("export const b");
  });

  it("DENIES a write outside the scope, and the file is not created", async () => {
    const grant = makeGrant({ allowedScope: ["src/"] });
    const agent = agentDoing({ kind: "write", path: "tests/sneak.ts", contents: "x" });
    const result = await runner.run(grant, { instruction: "x" }, agent);

    expect(agent.results[0]!.ok).toBe(false);
    expect(agent.results[0]!.denial).toBe("out_of_scope");
    expect(exists("tests/sneak.ts")).toBe(false);
    expect(result.run.denials).toBe(1);
    expect(result.run.writes).toBe(0);
  });

  it("DENIES traversal out of the project", async () => {
    const grant = makeGrant();
    const agent = agentDoing({ kind: "write", path: "../../escaped.ts", contents: "x" });
    await runner.run(grant, { instruction: "x" }, agent);

    expect(agent.results[0]!.ok).toBe(false);
    expect(fs.existsSync(path.join(parent, "escaped.ts"))).toBe(false);
  });

  it("DENIES a deletion outside the scope", async () => {
    fs.writeFileSync(path.join(repo, "keep.ts"), "important\n");
    const grant = makeGrant({ allowedScope: ["src/"] });
    const agent = agentDoing({ kind: "delete", path: "keep.ts" });
    await runner.run(grant, { instruction: "x" }, agent);

    expect(agent.results[0]!.ok).toBe(false);
    expect(read("keep.ts")).toBe("important\n");
  });

  it("allows a deletion INSIDE the scope", async () => {
    const grant = makeGrant();
    const agent = agentDoing({ kind: "delete", path: "src/existing.ts" });
    const result = await runner.run(grant, { instruction: "x" }, agent);
    expect(result.run.deletes).toBe(1);
    expect(exists("src/existing.ts")).toBe(false);
  });

  it("an EMPTY scope authorises nothing at all", async () => {
    const grant = makeGrant({ allowedScope: [] });
    const agent = agentDoing({ kind: "write", path: "src/x.ts", contents: "x" });
    await runner.run(grant, { instruction: "x" }, agent);
    expect(agent.results[0]!.ok).toBe(false);
    expect(exists("src/x.ts")).toBe(false);
  });

  it("enforces the grant's write budget", async () => {
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

  it("enforces the grant's per-file size limit", async () => {
    const grant = makeGrant({ maxWriteBytes: 8 });
    const agent = agentDoing({ kind: "write", path: "src/big.ts", contents: "x".repeat(100) });
    await runner.run(grant, { instruction: "x" }, agent);
    expect(agent.results[0]!.denial).toBe("file_too_large");
    expect(exists("src/big.ts")).toBe(false);
  });

  it("refuses to write a sensitive file even inside the scope", async () => {
    const grant = makeGrant({ allowedScope: ["."] });
    const agent = agentDoing({ kind: "write", path: ".env", contents: "TOKEN=planted\n" });
    await runner.run(grant, { instruction: "x" }, agent);
    expect(agent.results[0]!.denial).toBe("sensitive_path");
    expect(exists(".env")).toBe(false);
  });
});

// ===========================================================================
describe("the agent cannot expand its own permissions", () => {
  const targets = [
    "mutate-capabilities", "mutate-scope", "mutate-stats",
    "reach-grant", "reach-writer", "reach-journal",
    "reach-shell", "reach-process", "reach-git", "reach-network", "reach-filesystem",
  ] as const;

  it("blocks every escalation route", async () => {
    const grant = makeGrant();
    const agent = new FakeImplementationAgent({
      steps: targets.map((target) => ({ kind: "escalate", target }) as FakeStep),
    });
    await runner.run(grant, { instruction: "x" }, agent);

    expect(agent.escalationAttempts).toHaveLength(targets.length);
    for (const attempt of agent.escalationAttempts) {
      expect(attempt.blocked, `${attempt.target}: ${attempt.detail}`).toBe(true);
    }
  });

  it("cannot reach the unchecked writer to bypass scope entirely", async () => {
    // Regression guard. TypeScript's `private` is compile-time only, so the
    // first version of the session exposed `writer` - a SafeWriteFs that writes
    // with NO grant, capability or scope check - to any `as any` cast.
    const grant = makeGrant({ allowedScope: ["src/"] });
    let bypassed = false;

    const agent = new InertAgent(() => { /* replaced below */ });
    const probing = {
      name: "probe",
      async implement(session: unknown) {
        const loose = session as Record<string, unknown>;
        const writer = loose["writer"] as { writeFile?: (p: string, c: string) => unknown } | undefined;
        if (writer && typeof writer.writeFile === "function") {
          try {
            writer.writeFile("tests/bypassed.ts", "scope bypassed\n");
            bypassed = true;
          } catch {
            bypassed = false;
          }
        }
        return { summary: "", files: [], claimsSuccess: false, notes: [] };
      },
    };
    void agent;
    await runner.run(grant, { instruction: "x" }, probing as never);

    expect(bypassed).toBe(false);
    expect(exists("tests/bypassed.ts")).toBe(false);
  });

  it("cannot mutate the grant object it operates under", async () => {
    const grant = makeGrant({ allowedScope: ["src/"] });
    let widened = false;

    const probing = {
      name: "probe",
      async implement(session: unknown) {
        const loose = session as Record<string, unknown>;
        const g = loose["grant"] as { allowedScope?: string[] } | undefined;
        if (g?.allowedScope) {
          try {
            g.allowedScope.push(".");
            widened = true;
          } catch {
            widened = false;
          }
        }
        return { summary: "", files: [], claimsSuccess: false, notes: [] };
      },
    };
    await runner.run(grant, { instruction: "x" }, probing as never);
    expect(widened).toBe(false);
  });

  it("cannot use a capability the grant omits", async () => {
    const readOnly = makeGrant({ capabilities: ["repo.read", "repo.metadata.read"] as Capability[] });
    const agent = agentDoing({ kind: "write", path: "src/x.ts", contents: "x" });
    await runner.run(readOnly, { instruction: "x" }, agent);

    expect(agent.results[0]!.denial).toBe("capability_not_granted");
    expect(exists("src/x.ts")).toBe(false);
  });

  it("cannot obtain git mutation, process execution or network access at all", async () => {
    // Not merely ungranted - they cannot be put in a grant in the first place.
    for (const capability of ["git.mutate", "process.execute", "network.access"] as Capability[]) {
      expect(() =>
        issueGrant({
          projectId: "proj", runId: RUN, approvalId: "a", approvedBy: "o",
          allowedScope: ["src/"], capabilities: [capability],
        }),
      ).toThrow();
    }
  });

  it("gets no write tools in a registry built without a session", () => {
    const registry = createRegistry();
    expect(registry.hasWriteCapability()).toBe(false);
    expect(registry.list().map((t) => t.name)).toEqual(["orchestrator.describe"]);
  });
});

// ===========================================================================
describe("the orchestrator records activity, not the agent's account", () => {
  it("records start, capability decisions, attempts, outcomes and finish", async () => {
    const grant = makeGrant();
    const agent = agentDoing(
      { kind: "write", path: "src/ok.ts", contents: "ok\n" },
      { kind: "write", path: "tests/denied.ts", contents: "no\n" },
      { kind: "delete", path: "src/existing.ts" },
    );
    await runner.run(grant, { instruction: "x" }, agent);

    const types = journalFor().read().map((r) => r.type);
    for (const expected of [
      "implementation_started", "lock_acquired",
      "capability_granted", "capability_denied",
      "write_attempted", "write_completed", "write_denied",
      "delete_attempted", "delete_completed",
      "implementation_finished", "lock_released",
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
  });

  it("records a denial the agent never mentions", async () => {
    const grant = makeGrant();
    // The agent conceals everything in its report.
    const agent = new FakeImplementationAgent({
      steps: [{ kind: "write", path: "tests/hidden.ts", contents: "x" }],
      claimFiles: [],
      claimSummary: "I did nothing unusual.",
    });
    const result = await runner.run(grant, { instruction: "x" }, agent);

    expect(result.agentReport.summary).toBe("I did nothing unusual.");
    // The orchestrator recorded it regardless.
    const denials = journalFor().read().filter((r) => r.type === "write_denied");
    expect(denials).toHaveLength(1);
    expect(result.run.denials).toBe(1);
  });

  it("counts writes itself rather than believing the agent", async () => {
    const grant = makeGrant();
    const agent = new FakeImplementationAgent({
      steps: [{ kind: "write", path: "src/one.ts", contents: "1" }],
      claimFiles: ["src/one.ts", "src/two.ts", "src/three.ts"], // a lie
    });
    const result = await runner.run(grant, { instruction: "x" }, agent);

    expect(result.agentReport.files).toHaveLength(3);
    expect(result.run.writes).toBe(1); // what actually happened
  });

  it("NEVER records file contents, only metadata", async () => {
    const grant = makeGrant();
    const secret = "SUPER_SECRET_PAYLOAD_abc123";
    const agent = agentDoing({ kind: "write", path: "src/secret.ts", contents: `const s = "${secret}";\n` });
    await runner.run(grant, { instruction: "x" }, agent);

    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain(secret);
    // But the write IS recorded, with a byte count and a hash.
    const completed = journalFor().read().find((r) => r.type === "write_completed") as
      { byteCount: number; contentHash: string | null };
    expect(completed.byteCount).toBeGreaterThan(0);
    expect(completed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits even the hash for a sensitive path, and never its contents", async () => {
    const grant = makeGrant({ allowedScope: ["."] });
    const agent = agentDoing({ kind: "write", path: ".env", contents: "TOKEN=NEVER_LOG_THIS\n" });
    await runner.run(grant, { instruction: "x" }, agent);

    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain("NEVER_LOG_THIS");
    const denied = journalFor().read().find((r) => r.type === "write_denied");
    expect(denied).toBeDefined();
  });

  it("does not put an agent's error message into the record", async () => {
    const grant = makeGrant();
    const agent = agentDoing({ kind: "throw", message: "LEAKY /etc/passwd contents here" });
    const result = await runner.run(grant, { instruction: "x" }, agent);

    expect(result.run.status).toBe("failed");
    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain("LEAKY");
    expect(result.run.failureDetail).toContain("agent threw");
  });
});

// ===========================================================================
describe("cancellation", () => {
  it("cancelled before start writes nothing", async () => {
    const grant = makeGrant();
    const token = new CancellationToken();
    token.cancel("cancelled by human before start");

    const agent = agentDoing({ kind: "write", path: "src/x.ts", contents: "x" });
    const result = await runner.run(grant, { instruction: "x" }, agent, token);

    expect(result.run.status).toBe("cancelled");
    expect(exists("src/x.ts")).toBe(false);
  });

  it("cancelled MID-RUN keeps the partial work and says so", async () => {
    const grant = makeGrant();
    const agent = agentDoing(
      { kind: "write", path: "src/first.ts", contents: "written\n" },
      { kind: "cancel", reason: "stop now" },
      { kind: "write", path: "src/second.ts", contents: "never\n" },
    );
    const result = await runner.run(grant, { instruction: "x" }, agent);

    expect(result.run.status).toBe("cancelled");
    // NO ROLLBACK IS CLAIMED: the first write stands.
    expect(exists("src/first.ts")).toBe(true);
    expect(exists("src/second.ts")).toBe(false);
    expect(result.run.partialChangesPossible).toBe(true);
    expect(result.mustVerify).toBe(true);
  });

  it("records the cancellation in the journal", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing({ kind: "cancel" }));
    expect(journalFor().read().map((r) => r.type)).toContain("implementation_cancelled");
  });

  it("a failed run also keeps partialChangesPossible", async () => {
    const grant = makeGrant();
    const agent = agentDoing(
      { kind: "write", path: "src/partial.ts", contents: "landed\n" },
      { kind: "throw" },
    );
    const result = await runner.run(grant, { instruction: "x" }, agent);

    expect(result.run.status).toBe("failed");
    expect(exists("src/partial.ts")).toBe(true);
    expect(result.run.partialChangesPossible).toBe(true);
  });

  it("a clean completion clears it", async () => {
    const grant = makeGrant();
    const result = await runner.run(grant, { instruction: "x" }, agentDoing());
    expect(result.run.status).toBe("completed");
    expect(result.run.partialChangesPossible).toBe(false);
    // Verification is still required regardless.
    expect(result.mustVerify).toBe(true);
  });
});

// ===========================================================================
describe("concurrency", () => {
  it("refuses a second mutating run while the first holds the lock", async () => {
    const grant = makeGrant();
    let second: unknown = null;

    // Attempt the second run from inside the first, while the lock is held.
    const agent = new InertAgent(async () => {
      const other = store.saveGrant(
        issueGrant({
          projectId: "proj", runId: "run_second", approvalId: "apr_2",
          approvedBy: "owner", allowedScope: ["src/"], capabilities: CAPS,
        }),
      );
      second = await runner
        .run(other, { instruction: "y" }, agentDoing({ kind: "write", path: "src/y.ts", contents: "y" }))
        .catch((error: unknown) => error);
    });

    await runner.run(grant, { instruction: "x" }, agent);

    expect(second).toBeInstanceOf(LockDenied);
    expect((second as LockDenied).message).toContain("Concurrent mutation is refused");
    expect(exists("src/y.ts")).toBe(false);
  });

  it("releases the lock after normal completion", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing());
    expect(ImplementationLock.forProject(store.dir("proj")).isHeld()).toBe(false);
  });

  it("releases the lock after a failure", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing({ kind: "throw" }));
    expect(ImplementationLock.forProject(store.dir("proj")).isHeld()).toBe(false);
  });

  it("releases the lock after cancellation", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentDoing({ kind: "cancel" }));
    expect(ImplementationLock.forProject(store.dir("proj")).isHeld()).toBe(false);
  });

  it("takes no lock for a read-only grant", async () => {
    const readOnly = makeGrant({ capabilities: ["repo.read"] as Capability[] });
    const agent = new InertAgent(() => {
      expect(ImplementationLock.forProject(store.dir("proj")).isHeld()).toBe(false);
    });
    await runner.run(readOnly, { instruction: "x" }, agent);
  });

  it("a STALE lock fails closed rather than being stolen", async () => {
    // A lock left by a process that no longer exists.
    const lock = ImplementationLock.forProject(store.dir("proj"));
    fs.mkdirSync(store.dir("proj"), { recursive: true });
    fs.writeFileSync(
      path.join(store.dir("proj"), "implementation.lock"),
      JSON.stringify({
        projectId: "proj", runId: "run_dead", grantId: null,
        pid: 999_999, hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );

    const grant = makeGrant();
    const agent = agentDoing({ kind: "write", path: "src/x.ts", contents: "x" });
    await expect(runner.run(grant, { instruction: "x" }, agent)).rejects.toThrow(LockDenied);
    expect(exists("src/x.ts")).toBe(false);

    // It reports staleness so a HUMAN can clear it deliberately.
    const described = lock.describe();
    expect(described.alive).toBe(false);
    expect(lock.forceRelease()?.runId).toBe("run_dead");
  });

  it("only the holder may release the lock", () => {
    const lock = ImplementationLock.forProject(store.dir("proj"));
    lock.acquire({ projectId: "proj", runId: "run_a" });
    expect(lock.release("run_b")).toBe(false);
    expect(lock.isHeld()).toBe(true);
    expect(lock.release("run_a")).toBe(true);
  });
});

// ===========================================================================
describe("process death does not create false success", () => {
  it("turns an abandoned running record into `interrupted`, never `completed`", () => {
    store.saveImplementation({
      runId: "run_dead", projectId: "proj", grantId: null, agent: "fake",
      capabilities: [], allowedScope: [],
      status: "running",
      pid: 999_999, hostname: os.hostname(),
      startedAt: new Date().toISOString(), endedAt: null,
      writes: 3, deletes: 0, denials: 0,
      partialChangesPossible: true,
      cancelRequestedBy: null, cancelRequestedAt: null,
      failureCategory: null, failureDetail: null,
    });

    const reconciled = runner.reconcile("proj");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.status).toBe("interrupted");
    expect(reconciled[0]!.partialChangesPossible).toBe(true);

    const stored = store.getImplementation("proj", "run_dead")!;
    expect(stored.status).toBe("interrupted");
    expect(stored.status).not.toBe("completed");
  });

  it("leaves a record owned by a LIVE process alone", () => {
    store.saveImplementation({
      runId: "run_live", projectId: "proj", grantId: null, agent: "fake",
      capabilities: [], allowedScope: [], status: "running",
      pid: process.pid, hostname: os.hostname(),
      startedAt: new Date().toISOString(), endedAt: null,
      writes: 0, deletes: 0, denials: 0, partialChangesPossible: true,
      cancelRequestedBy: null, cancelRequestedAt: null,
      failureCategory: null, failureDetail: null,
    });
    expect(runner.reconcile("proj")).toHaveLength(0);
  });

  it("leaves a record from ANOTHER HOST alone rather than guessing", () => {
    store.saveImplementation({
      runId: "run_elsewhere", projectId: "proj", grantId: null, agent: "fake",
      capabilities: [], allowedScope: [], status: "running",
      pid: 4242, hostname: "some-other-machine",
      startedAt: new Date().toISOString(), endedAt: null,
      writes: 0, deletes: 0, denials: 0, partialChangesPossible: true,
      cancelRequestedBy: null, cancelRequestedAt: null,
      failureCategory: null, failureDetail: null,
    });
    expect(runner.reconcile("proj")).toHaveLength(0);
  });

  it("persists `running` with a pid BEFORE the agent gets to act", async () => {
    const grant = makeGrant();
    let observed: { status: string; pid: number | null } | null = null;
    const agent = new InertAgent(() => {
      const record = store.getImplementation("proj", RUN)!;
      observed = { status: record.status, pid: record.pid };
    });
    await runner.run(grant, { instruction: "x" }, agent);

    expect(observed).not.toBeNull();
    expect(observed!.status).toBe("running");
    expect(observed!.pid).toBe(process.pid);
  });
});

// ===========================================================================
describe("independent verification remains authoritative", () => {
  it("attributes what the agent ACTUALLY wrote, not what it claimed", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    const grant = makeGrant();
    const agent = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: "src/real.ts", contents: "real\n" },
        { kind: "write", path: "tests/blocked.ts", contents: "blocked\n" },
      ],
      // Claims a file it never wrote, and hides the one it did.
      claimFiles: ["src/imaginary.ts"],
      claimSummary: "Rewrote the whole test suite.",
    });
    const result = await runner.run(grant, { instruction: "x" }, agent);

    const verified = await verifier.verify({
      runId: RUN,
      claimedSummary: result.agentReport.summary,
      claimedFiles: result.agentReport.files,
      baseline,
      allowedScope: grant.allowedScope,
    });

    // git saw the real file, and never the imaginary one.
    expect(verified.report.observedFiles).toContain("src/real.ts");
    expect(verified.report.observedFiles).not.toContain("src/imaginary.ts");
    expect(verified.evidence.attributableFiles).toContain("src/real.ts");
    // The disagreement is recorded in both directions.
    expect(verified.evidence.claims.claimedButNotObserved).toContain("src/imaginary.ts");
    expect(verified.evidence.claims.observedButNotClaimed).toContain("src/real.ts");
    expect(verified.report.verifiedIndependently).toBe(true);
    // And the blocked write never reached the repository at all.
    expect(verified.report.observedFiles).not.toContain("tests/blocked.ts");
  });

  it("computes scope drift independently of the grant's own checks", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    // A human edits a file outside the scope while the run is in progress. The
    // substrate did not do it - but drift is measured from the repository.
    const grant = makeGrant({ allowedScope: ["src/"] });
    const agent = new InertAgent(() => {
      fs.writeFileSync(path.join(repo, "unrelated.ts"), "someone else\n");
    });
    await runner.run(grant, { instruction: "x" }, agent);

    const verified = await verifier.verify({
      runId: RUN, baseline, allowedScope: grant.allowedScope,
    });
    expect(verified.evidence.scope.drift).toContain("unrelated.ts");
  });

  it("still requires verification after a cancelled run", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    const grant = makeGrant();
    const agent = agentDoing(
      { kind: "write", path: "src/half.ts", contents: "half done\n" },
      { kind: "cancel" },
    );
    const result = await runner.run(grant, { instruction: "x" }, agent);
    expect(result.run.status).toBe("cancelled");

    // Cancellation does NOT mean nothing changed.
    const verified = await verifier.verify({ runId: RUN, baseline, allowedScope: ["src/"] });
    expect(verified.evidence.attributableFiles).toContain("src/half.ts");
  });
});

// ===========================================================================
describe("the default configuration writes nothing", () => {
  it("the no-op agent is what production gets, and it does nothing", async () => {
    const grant = makeGrant();
    const before = fs.readdirSync(path.join(repo, "src"));
    const result = await runner.run(grant, { instruction: "x" }, new NoOpImplementationAgent());

    expect(result.run.writes).toBe(0);
    expect(result.agentReport.claimsSuccess).toBe(false);
    expect(fs.readdirSync(path.join(repo, "src"))).toEqual(before);
  });

  it("the fake agent lives in tests/ and is imported by no production module", () => {
    const src = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        if (/fakeAgent|FakeImplementationAgent/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(full);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
