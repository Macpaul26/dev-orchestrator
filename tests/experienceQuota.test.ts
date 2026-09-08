import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ExperienceStore } from "../src/experience/experienceStore.js";
import {
  ProjectQuota, ProjectLock, scanDirectoryBounded,
} from "../src/experience/projectQuota.js";
import { EXPERIENCE_STORAGE_LIMITS } from "../src/domain/experienceStorage.js";
import { tmpDir, rmDir } from "./helpers.js";

/**
 * TASK 009 CORRECTION - THE PROJECT QUOTA, ATTACKED CONCURRENTLY.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS EXIST TO CATCH
 * ---------------------------------------------------------------------------
 * Independent review found two ways the documented ceiling could fail to hold:
 *
 *   1. count -> compare -> write with no mutual exclusion, so two writers could
 *      both see the last free slot and both take it;
 *   2. a count taken from the first `maxDirectoryEntries` names `readdir`
 *      happened to return, presented as the number of records on disk.
 *
 * Neither is visible from a single-threaded test, which is exactly why the
 * original suite passed while both were true. So these tests use REAL, SEPARATE
 * OS PROCESSES. `Promise.all` inside one process proves nothing here: the bug
 * is between processes, and a JavaScript mutex would "fix" a single-process
 * test while leaving the real defect untouched.
 *
 * ---------------------------------------------------------------------------
 * THE NEGATIVE CONTROL IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * "Six writers ran and only one succeeded" is worthless on its own - it is also
 * what you see when the writers never actually overlap. So the same scenario is
 * first run against the OLD algorithm, which must produce an oversubscribed
 * project. That is what proves the harness can detect the defect at all.
 */

const ISO = "2026-09-08T12:00:00.000Z";
const MAX = EXPERIENCE_STORAGE_LIMITS.maxRecordsPerProject;
const RECORD_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{32}\.json$/;

let tmp: string;
let store: ExperienceStore;

function record(overrides: Record<string, unknown> = {}) {
  return {
    scope: "project", layer: "episodic", projectId: "alpha",
    runId: "run_1", taskType: "add-endpoint", createdAt: ISO,
    ...overrides,
  };
}

/** Record-shaped filenames, created directly. See `seed` for why. */
function recordName(index: number): string {
  return `20260908T120000000Z-${index.toString(16).padStart(32, "0")}.json`;
}

/**
 * Fill a project with `count` record-SHAPED files.
 *
 * Deliberately not written through the store: writing five thousand records
 * properly would take minutes and prove nothing this test needs. What matters
 * is that these files occupy quota slots, and the quota counts names.
 *
 * They double as the malformed-record population §8 asks for: every one of them
 * is name-shaped and content-garbage, so the same fixture proves both that they
 * consume capacity (the safe direction - a file that might be a record is not
 * assumed to be free space) and that none of them is ever returned as
 * experience.
 */
function seed(projectId: string, count: number): string {
  const dir = path.join(tmp, projectId);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, recordName(i)), "{}");
  }
  return dir;
}

function recordFiles(projectId: string): string[] {
  const dir = path.join(tmp, projectId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => RECORD_NAME.test(name));
}

/** Run N genuinely separate OS processes at once and collect their output. */
async function runConcurrently(
  script: string, args: (index: number) => string[], count: number,
): Promise<string[]> {
  const children = Array.from({ length: count }, (_, index) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script, ...args(index)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
      child.on("close", () => { resolve(out.trim() || `ERROR:${err.trim()}`); });
    }));
  return Promise.all(children);
}

/** Start a child and expose its first stdout line plus a way to end it. */
function startChild(script: string, args: string[]): {
  firstLine: Promise<string>; stop: () => Promise<void>;
} {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffered = "";
  const firstLine = new Promise<string>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolve(buffered.slice(0, newline).trim());
    });
    child.on("close", () => { resolve(buffered.trim()); });
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => { child.on("close", () => { resolve(); }); child.kill(); });
    }
  };
  return { firstLine, stop };
}

/** The shape of a lock directory name. Identity lives in the NAME. */
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const compiled = (file: string): string => {
  const full = path.resolve("dist", "experience", file);
  if (!fs.existsSync(full)) {
    throw new Error(`dist build missing at ${full} - run "npm run build" first`);
  }
  return full;
};

/** Wait until a wall-clock instant, so every child starts in the same moment. */
const BARRIER = [
  "const park = new Int32Array(new SharedArrayBuffer(4));",
  "function waitUntil(at) {",
  "  while (Date.now() < at) { Atomics.wait(park, 0, 0, Math.min(5, at - Date.now())); }",
  "}",
];

beforeEach(() => {
  tmp = tmpDir("orch-quota-");
  store = new ExperienceStore(tmp);
});

afterEach(() => { rmDir(tmp); });

// ===========================================================================
describe("the directory scan is bounded at the READ, not afterwards", () => {
  it("reports a complete scan when the directory fits", () => {
    seed("alpha", 5);
    const scan = scanDirectoryBounded(path.join(tmp, "alpha"), 10);
    expect(scan.complete).toBe(true);
    expect(scan.names).toHaveLength(5);
  });

  it("reports an INCOMPLETE scan rather than a short count", () => {
    seed("alpha", 12);
    const scan = scanDirectoryBounded(path.join(tmp, "alpha"), 10);
    expect(scan.complete).toBe(false);
    expect(scan.names).toHaveLength(10);
  });

  it("stops reading entries, instead of reading all and slicing", () => {
    /**
     * The distinction the correction turns on. `readdirSync(dir).slice(0, n)`
     * produces an identical `names` array while still materialising the entire
     * directory, so an assertion on the array alone cannot tell the two apart.
     * This counts the actual reads.
     */
    seed("alpha", 200);
    const opendir = fs.opendirSync;
    let reads = 0;
    try {
      (fs as { opendirSync: typeof fs.opendirSync }).opendirSync = ((...args: [string]) => {
        const handle = opendir(...args);
        const readSync = handle.readSync.bind(handle);
        handle.readSync = () => { reads += 1; return readSync(); };
        return handle;
      }) as typeof fs.opendirSync;

      const scan = scanDirectoryBounded(path.join(tmp, "alpha"), 20);
      expect(scan.names).toHaveLength(20);
      expect(scan.complete).toBe(false);
    } finally {
      (fs as { opendirSync: typeof fs.opendirSync }).opendirSync = opendir;
    }

    // 20 entries kept, plus the one read that revealed there were more.
    expect(reads).toBe(21);
  });

  it("treats a project with no directory as empty, not as an error", () => {
    const scan = scanDirectoryBounded(path.join(tmp, "never-created"));
    expect(scan).toEqual({ names: [], complete: true });
  });
});

// ===========================================================================
describe("the quota holds across concurrent OS processes", () => {
  /**
   * The scenario §6 specifies: a project holding `maxRecordsPerProject - 1`
   * records, and several independent processes racing for the single remaining
   * slot.
   */
  const CONTENDERS = 6;

  it("NEGATIVE CONTROL: the old count-then-write algorithm oversubscribes", async () => {
    /**
     * This must FAIL the invariant. It reproduces exactly what the reviewed
     * implementation did - count the records, decide there is room, then write -
     * with no lock between the decision and the act.
     *
     * Without this, the test below is unfalsifiable: six processes that never
     * overlap would also produce one success. Here the children wait until all
     * of them have finished counting before any of them writes, so the race is
     * not left to chance - it is forced, and the ceiling breaks by five.
     */
    const dir = seed("alpha", MAX - 1);
    const script = path.join(tmp, "old-algorithm.cjs");
    fs.writeFileSync(script, [
      "const fs = require('fs'); const path = require('path');",
      ...BARRIER,
      "const [dir, startAt, index, contenders] = process.argv.slice(2);",
      "waitUntil(Number(startAt));",
      "const shape = /^\\d{8}T\\d{9}Z-[0-9a-f]{32}\\.json$/;",
      "const count = fs.readdirSync(dir).filter((n) => shape.test(n)).length;",
      // Announce that this process has counted, then wait for the others.
      "fs.writeFileSync(path.join(dir, 'counted-' + index + '.marker'), '');",
      "for (;;) {",
      "  const seen = fs.readdirSync(dir).filter((n) => n.endsWith('.marker')).length;",
      "  if (seen >= Number(contenders)) break;",
      "  Atomics.wait(park, 0, 0, 5);",
      "}",
      "if (count < " + String(MAX) + ") {",
      "  const id = 'c'.repeat(0) + index.padStart(2, '0') + 'f'.repeat(30);",
      "  fs.writeFileSync(path.join(dir, '20260908T120000001Z-' + id + '.json'), '{}');",
      "  process.stdout.write('WROTE');",
      "} else { process.stdout.write('REFUSED'); }",
    ].join("\n"));

    const startAt = Date.now() + 400;
    const results = await runConcurrently(
      script,
      (index) => [dir, String(startAt), String(index), String(CONTENDERS)],
      CONTENDERS,
    );

    expect(results.filter((r) => r === "WROTE")).toHaveLength(CONTENDERS);
    // The ceiling is 5,000. The old algorithm produced 5,005.
    expect(recordFiles("alpha").length).toBe(MAX - 1 + CONTENDERS);
    expect(recordFiles("alpha").length).toBeGreaterThan(MAX);
  });

  it("lets exactly ONE of six concurrent writers take the final slot", async () => {
    /**
     * Repeated across independent projects. One round landing on the right
     * answer could be one interleaving that happened to be benign; the claim is
     * about every interleaving, so the race is run more than once.
     */
    const script = path.join(tmp, "writer.cjs");
    fs.writeFileSync(script, [
      "const { ExperienceStore } = require(process.argv[2]);",
      ...BARRIER,
      "const [, , , root, project, startAt, index] = process.argv;",
      "waitUntil(Number(startAt));",
      "const store = new ExperienceStore(root);",
      "const result = store.write(project, {",
      "  scope: 'project', layer: 'episodic', projectId: project,",
      "  runId: 'run_' + index, taskType: 'add-endpoint',",
      `  createdAt: '${ISO}',`,
      "});",
      "process.stdout.write(result.ok ? 'OK' : result.failure.code);",
    ].join("\n"));

    for (const round of ["alpha", "beta", "gamma"]) {
      const dir = seed(round, MAX - 1);
      expect(recordFiles(round)).toHaveLength(MAX - 1);

      const startAt = Date.now() + 400;
      const results = await runConcurrently(
        script,
        (index) => [
          compiled("experienceStore.js"), tmp, round, String(startAt), String(index),
        ],
        CONTENDERS,
      );

      expect(results.filter((r) => r === "OK"), `round ${round}`).toHaveLength(1);

      // Every refusal is a bounded, named outcome - never a crash, never silence.
      for (const result of results.filter((r) => r !== "OK")) {
        expect(["project_quota_exceeded", "storage_busy"]).toContain(result);
      }

      // THE INVARIANT. Never MAX + 1, under any interleaving.
      expect(recordFiles(round), `round ${round}`).toHaveLength(MAX);

      // Six processes contended and every one of them let go.
      const locks = path.join(dir, ProjectLock.directoryName());
      expect(fs.existsSync(locks) ? fs.readdirSync(locks) : []).toEqual([]);
    }
  }, 110_000);

  it("serialises two processes inside the critical section, provably", async () => {
    /**
     * The race tests above show the OUTCOME is right. This shows the MECHANISM
     * is right, and does it without depending on a race landing the right way.
     *
     * Two processes hold the section for a quarter of a second each. If mutual
     * exclusion works, their intervals cannot overlap; if it does not, both
     * enter at the shared barrier and overlap by almost the whole 250ms. There
     * is no timing window in which a broken lock passes this.
     */
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });

    const script = path.join(tmp, "hold.cjs");
    fs.writeFileSync(script, [
      "const { ProjectQuota } = require(process.argv[2]);",
      ...BARRIER,
      "const [, , , dir, startAt, index] = process.argv;",
      "waitUntil(Number(startAt));",
      "const shape = /^\\d{8}T\\d{9}Z-[0-9a-f]{32}\\.json$/;",
      "let span = null;",
      "const decision = new ProjectQuota(dir).reserveAndPublish({",
      "  fileName: '20260908T120000000Z-' + index.padStart(32, '0') + '.json',",
      "  isRecordName: (n) => shape.test(n),",
      "  isTemporaryName: (n) => n.endsWith('.tmp'),",
      "  publish: () => { const from = Date.now(); waitUntil(from + 250); span = [from, Date.now()]; },",
      "  unpublish: () => {},",
      "});",
      "process.stdout.write(decision.ok ? span.join(',') : 'FAILED:' + decision.reason);",
    ].join("\n"));

    const startAt = Date.now() + 400;
    const results = await runConcurrently(
      script,
      (index) => [compiled("projectQuota.js"), dir, String(startAt), String(index)],
      2,
    );

    const spans = results.map((line) => line.split(",").map(Number));
    for (const span of spans) expect(span).toHaveLength(2);
    const [first, second] = [...spans].sort((a, b) => a[0]! - b[0]!);

    // The second process did not enter until the first had left.
    expect(second![0]).toBeGreaterThanOrEqual(first![1]!);
  });

  it("does not consume a second slot when writers race on the SAME record", async () => {
    /**
     * §7. The id is derived from content, so all six children compute the same
     * one. An overwrite is not growth: the project must end with one logical
     * record and one slot consumed, not six.
     */
    const script = path.join(tmp, "same-writer.cjs");
    fs.writeFileSync(script, [
      "const { ExperienceStore } = require(process.argv[2]);",
      ...BARRIER,
      "const [, , , root, startAt] = process.argv;",
      "waitUntil(Number(startAt));",
      "const store = new ExperienceStore(root);",
      "const result = store.write('alpha', {",
      "  scope: 'project', layer: 'episodic', projectId: 'alpha',",
      "  runId: 'identical', taskType: 'add-endpoint',",
      `  createdAt: '${ISO}',`,
      "});",
      "process.stdout.write(result.ok ? 'OK:' + result.id : result.failure.code);",
    ].join("\n"));

    const startAt = Date.now() + 400;
    const results = await runConcurrently(
      script, () => [compiled("experienceStore.js"), tmp, String(startAt)], CONTENDERS,
    );

    const ids = new Set(results.filter((r) => r.startsWith("OK:")).map((r) => r.slice(3)));
    expect(ids.size).toBe(1);
    expect(recordFiles("alpha")).toHaveLength(1);

    const listing = store.list("alpha");
    expect(listing.records).toHaveLength(1);
    expect(listing.count).toEqual({ kind: "exact", records: 1 });
  });
});

// ===========================================================================
describe("lock ownership", () => {
  const lockDir = (projectId: string): string =>
    path.join(tmp, projectId, ProjectLock.directoryName());

  /** Nonce-named lock directories currently present. */
  function owners(projectId: string): string[] {
    const dir = lockDir(projectId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => NONCE.test(name));
  }

  /** Backdate an entry so any age-based rule would consider it abandoned. */
  function age(entry: string, ms = 10 * EXPERIENCE_STORAGE_LIMITS.lockAbandonMs): void {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(entry, when, when);
  }

  it("MANDATORY: a LIVE owner is not evicted, however old its lock looks", async () => {
    /**
     * BLOCKER 1. The previous protocol reclaimed a lock once it was older than
     * `lockStaleMs`, which is a guess about death rather than a test for it. A
     * process that was merely slow lost its lock while still inside the critical
     * section.
     *
     * The child here is the hardest version of that case: it holds the lock and
     * then blocks SYNCHRONOUSLY, forever. It cannot renew a heartbeat, touch a
     * file, or answer a message - anything that required the owner to run in
     * order to prove it is alive would conclude it is dead. Only the kernel can
     * tell the difference, which is why the kernel is what gets asked.
     *
     * The lock is then backdated by ten times `lockAbandonMs`, so this is not a
     * test of whether the window is long enough. It is a test that AGE DOES NOT
     * DECIDE.
     */
    fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true });
    const script = path.join(tmp, "hold-alive.cjs");
    fs.writeFileSync(script, [
      "const { ProjectLock } = require(process.argv[2]);",
      "const held = new ProjectLock(process.argv[3]).acquire();",
      "process.stdout.write(held === null ? 'NONE\\n' : 'HELD\\n');",
      // Alive, and permanently blocked. No heartbeat is possible from here.
      "const park = new Int32Array(new SharedArrayBuffer(4));",
      "for (;;) { Atomics.wait(park, 0, 0, 1000); }",
    ].join("\n"));

    const holder = startChild(script, [compiled("projectQuota.js"), path.join(tmp, "alpha")]);
    expect(await holder.firstLine).toBe("HELD");

    const [nonce] = owners("alpha");
    expect(nonce).toBeDefined();
    age(path.join(lockDir("alpha"), nonce!));

    // A writer must refuse to proceed rather than steal a living owner's lock.
    const blocked = store.write("alpha", record());
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.failure.code).toBe("storage_busy");

    // The owner still holds exactly what it held. Nothing was written.
    expect(owners("alpha")).toEqual([nonce]);
    expect(recordFiles("alpha")).toHaveLength(0);

    // And once that owner is genuinely gone, the project recovers immediately -
    // no waiting out a stale window, because death is now observed, not assumed.
    await holder.stop();
    const after = store.write("alpha", record());
    expect(after.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(1);
    expect(owners("alpha")).toEqual([]);
  });

  it("recovers from an owner that died without releasing", async () => {
    fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true });
    const script = path.join(tmp, "die-holding.cjs");
    fs.writeFileSync(script, [
      "const { ProjectLock } = require(process.argv[2]);",
      "const held = new ProjectLock(process.argv[3]).acquire();",
      "process.stdout.write(held === null ? 'NONE' : 'HELD');",
      "process.exit(0);", // Exits still holding it. Nothing cleans up after it.
    ].join("\n"));

    const [taken] = await runConcurrently(
      script, () => [compiled("projectQuota.js"), path.join(tmp, "alpha")], 1,
    );
    expect(taken).toBe("HELD");
    expect(owners("alpha")).toHaveLength(1);

    // No backdating, no waiting: the owner is observably gone.
    const written = store.write("alpha", record());
    expect(written.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(1);
    expect(owners("alpha")).toEqual([]);
  });

  it("an OLD owner cannot delete a NEW owner's lock", () => {
    /**
     * BLOCKER 2, and it is now a property of the naming rather than a race that
     * has been made narrow. The old protocol read the lock, compared a nonce,
     * then unlinked - three operations, so an owner whose lock had been
     * reclaimed could pass the check, be descheduled, and delete a lock somebody
     * else had since acquired.
     *
     * Ordering is controlled deliberately here rather than raced for. The claim
     * is not "this interleaving is unlikely"; it is that the interleaving CANNOT
     * do damage, because `release` can only name the caller's own nonce and a
     * newer owner has a different one. That is testable directly, and a test
     * that had to catch it by racing would be the weaker evidence.
     */
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    const lock = new ProjectLock(dir);

    const first = lock.acquire();
    expect(first).not.toBeNull();

    // Its lock is reclaimed underneath it, exactly as dead-owner recovery would.
    fs.rmSync(path.join(lockDir("alpha"), first!.nonce), { recursive: true, force: true });

    const second = lock.acquire();
    expect(second).not.toBeNull();
    expect(second!.nonce).not.toBe(first!.nonce);

    // The displaced owner now releases, late. It must not touch the new lock.
    lock.release(first!);
    expect(owners("alpha")).toEqual([second!.nonce]);

    lock.release(second!);
    expect(owners("alpha")).toEqual([]);
  });

  it("stale recovery cannot delete a newly acquired lock", () => {
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    const lock = new ProjectLock(dir);

    const first = lock.acquire();
    // What a reclaimer would have observed before deciding to act.
    const observed = first!.nonce;
    lock.release(first!);

    const second = lock.acquire();
    expect(second!.nonce).not.toBe(observed);

    // The reclaimer acts on its stale observation. It names the nonce it saw,
    // so it finds nothing, and the lock acquired since is untouched.
    fs.rmSync(path.join(lockDir("alpha"), observed), { recursive: true, force: true });
    expect(owners("alpha")).toEqual([second!.nonce]);
  });

  it("does not treat a reused process id as proof the owner is alive", () => {
    /**
     * A lock recorded against THIS process's pid but a different start time was
     * written by an earlier process that happened to hold the same number. The
     * pid probe would say "alive" - it is us - so the start time is what
     * distinguishes the instance.
     */
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    const nonce = "00000000-0000-4000-8000-000000000001";
    const lock = path.join(lockDir("alpha"), nonce);
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
      version: 1,
      nonce,
      pid: process.pid, // alive, and definitely signallable: it is us
      startedAt: 1, // but not when this process started
      acquiredAt: new Date().toISOString(),
    }));

    const written = store.write("alpha", record());
    expect(written.ok).toBe(true);
    expect(owners("alpha")).toEqual([]);
  });

  it("reclaims a lock whose owner metadata is unreadable, but only when old", () => {
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    const nonce = "00000000-0000-4000-8000-000000000002";
    const lock = path.join(lockDir("alpha"), nonce);
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), "not json at all");

    // Fresh: there is no owner to ask about, so it is left alone.
    const blocked = store.write("alpha", record());
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.failure.code).toBe("storage_busy");

    // Old enough that nothing is going to claim it: bounded, so a corrupt lock
    // cannot wedge a project permanently.
    age(lock);
    expect(store.write("alpha", record()).ok).toBe(true);
  });

  it("keeps one project's lock out of another project's way", async () => {
    fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true });
    const script = path.join(tmp, "hold-alpha.cjs");
    fs.writeFileSync(script, [
      "const { ProjectLock } = require(process.argv[2]);",
      "new ProjectLock(process.argv[3]).acquire();",
      "process.stdout.write('HELD\\n');",
      "const park = new Int32Array(new SharedArrayBuffer(4));",
      "for (;;) { Atomics.wait(park, 0, 0, 1000); }",
    ].join("\n"));

    const holder = startChild(script, [compiled("projectQuota.js"), path.join(tmp, "alpha")]);
    expect(await holder.firstLine).toBe("HELD");

    // Alpha is locked; beta is nobody else's business.
    expect(store.write("alpha", record()).ok).toBe(false);
    expect(store.write("beta", record({ projectId: "beta" })).ok).toBe(true);
    expect(owners("beta")).toEqual([]);
    await holder.stop();
  });
});

// ===========================================================================
describe("crash recovery", () => {
  it("a process that dies BEFORE reserving leaves nothing behind", async () => {
    const script = path.join(tmp, "die-early.cjs");
    fs.writeFileSync(script, ["process.exit(0);"].join("\n"));
    await runConcurrently(script, () => [], 1);

    expect(fs.existsSync(path.join(tmp, "alpha"))).toBe(false);
    expect(store.write("alpha", record()).ok).toBe(true);
  });

  it("a process killed IMMEDIATELY after publishing loses nothing", async () => {
    /**
     * The narrow point the brief asks about: the record has reached the disk and
     * the process dies before releasing the lock or returning. Forced from
     * inside the publish callback, so termination lands exactly there rather
     * than approximately there.
     */
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    const planted = recordName(7);
    const script = path.join(tmp, "die-after-publish.cjs");
    fs.writeFileSync(script, [
      "const { ProjectQuota } = require(process.argv[2]);",
      "const fs = require('fs'); const path = require('path');",
      "const [, , , dir, name] = process.argv;",
      "const shape = /^\\d{8}T\\d{9}Z-[0-9a-f]{32}\\.json$/;",
      "new ProjectQuota(dir).reserveAndPublish({",
      "  fileName: name,",
      "  isRecordName: (n) => shape.test(n),",
      "  isTemporaryName: (n) => n.endsWith('.tmp'),",
      "  publish: () => {",
      "    fs.writeFileSync(path.join(dir, name), '{}');",
      "    process.exit(3);", // dead the instant the record exists
      "  },",
      "  unpublish: () => {},",
      "});",
    ].join("\n"));

    await runConcurrently(script, () => [compiled("projectQuota.js"), dir, planted], 1);

    // The published record survived. Nothing deletes legitimate experience.
    expect(fs.existsSync(path.join(dir, planted))).toBe(true);
    expect(recordFiles("alpha")).toEqual([planted]);

    // There is no cached counter anywhere to be out of step with the records.
    const stray = fs.readdirSync(dir)
      .filter((name) => /count|quota|ledger|total/i.test(name));
    expect(stray).toEqual([]);

    // The next writer recovers on its own, and the count includes the orphan.
    const written = store.write("alpha", record());
    expect(written.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(2);
    expect(store.list("alpha").count).toEqual({ kind: "exact", records: 2 });
  });

  it("a record published before the crash needs no reconciliation", () => {
    /**
     * The reason the count is derived from the records rather than cached in a
     * counter file: there is no second source of truth to be out of step with.
     * A record that reached the disk IS the accounting, whenever the process
     * died.
     */
    const written = store.write("alpha", record());
    expect(written.ok).toBe(true);

    // Whatever else the dead process left, the count is right immediately.
    fs.writeFileSync(path.join(tmp, "alpha", "half-done.json.1234.tmp"), "{ttt");
    expect(store.list("alpha").count).toEqual({ kind: "exact", records: 1 });

    const next = store.write("alpha", record({ runId: "run_2" }));
    expect(next.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(2);
  });

  it("clears temporary files abandoned by a dead writer, but not live ones", () => {
    store.write("alpha", record());
    const dir = path.join(tmp, "alpha");
    const abandoned = path.join(dir, "20260908T120000000Z-aaaa.json.999.abcd.tmp");
    const inFlight = path.join(dir, "20260908T120000000Z-bbbb.json.998.efgh.tmp");
    fs.writeFileSync(abandoned, "partial");
    fs.writeFileSync(inFlight, "partial");
    const old = new Date(Date.now() - EXPERIENCE_STORAGE_LIMITS.temporaryAbandonMs - 5_000);
    fs.utimesSync(abandoned, old, old);

    // Temporary files never occupied a slot; cleaning them reclaims disk only.
    expect(store.list("alpha").count).toEqual({ kind: "exact", records: 1 });

    const written = store.write("alpha", record({ runId: "run_2" }));
    expect(written.ok).toBe(true);
    expect(fs.existsSync(abandoned)).toBe(false);
    // A temporary file that could still belong to a write in flight is left be.
    expect(fs.existsSync(inFlight)).toBe(true);
  });
});

// ===========================================================================
describe("quota boundary", () => {
  it("accepts the record that fills the last slot and refuses the next", () => {
    seed("alpha", MAX - 1);

    const last = store.write("alpha", record({ runId: "the-last-one" }));
    expect(last.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(MAX);

    const overflow = store.write("alpha", record({ runId: "one-too-many" }));
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.failure.code).toBe("project_quota_exceeded");
    expect(recordFiles("alpha")).toHaveLength(MAX);
  });

  it("still allows an overwrite when the project is exactly full", () => {
    seed("alpha", MAX - 1);
    const written = store.write("alpha", record({ runId: "rewritable" }));
    expect(written.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(MAX);

    // Same content, same derived id: an overwrite, so no new slot is needed.
    const again = store.write("alpha", record({ runId: "rewritable" }));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.id).toBe(written.ok ? written.id : "");
    expect(recordFiles("alpha")).toHaveLength(MAX);
  });

  it("counts each project separately", () => {
    seed("alpha", MAX);
    expect(store.write("alpha", record()).ok).toBe(false);
    // A full project must not exhaust anybody else's quota.
    expect(store.write("beta", record({ projectId: "beta" })).ok).toBe(true);
  });

  it("names no path when it refuses", () => {
    seed("alpha", MAX);
    const refused = store.write("alpha", record());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.message).not.toContain(tmp);
    expect(refused.failure.message).not.toContain(path.sep);
  });
});

// ===========================================================================
describe("a hostile directory cannot undercount experience", () => {
  it("ignores unrelated files when counting", () => {
    store.write("alpha", record());
    store.write("alpha", record({ runId: "run_2" }));
    const dir = path.join(tmp, "alpha");
    for (let i = 0; i < 50; i += 1) {
      fs.writeFileSync(path.join(dir, `noise-${String(i)}.txt`), "irrelevant");
    }
    fs.writeFileSync(path.join(dir, "20260908T120000000Z-NOTHEX.json"), "{}");
    fs.writeFileSync(path.join(dir, "records.json"), "{}");

    const listing = store.list("alpha");
    expect(listing.count).toEqual({ kind: "exact", records: 2 });
    expect(listing.records).toHaveLength(2);
  });

  it("counts malformed but record-shaped files against the quota", () => {
    /**
     * The safe direction, and a deliberate choice. Deciding whether a file is a
     * VALID record means opening it, and opening five thousand files is the
     * unbounded read the whole design exists to avoid. So a file that looks like
     * a record occupies a slot - and is still never returned as experience.
     */
    seed("alpha", MAX);
    const refused = store.write("alpha", record());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("project_quota_exceeded");

    // Occupying a slot is not the same as being experience. Every one of them
    // is refused on read - `{}` parses, but carries no integrity metadata.
    const listing = store.list("alpha");
    expect(listing.records).toEqual([]);
    expect(listing.defects.length).toBeGreaterThan(0);
    expect(listing.defects.every((d) => d.code === "integrity_missing")).toBe(true);
  });

  it("refuses to write when the count cannot be established", () => {
    /**
     * THE SECOND BLOCKER. Beyond `maxDirectoryEntries` the scan stops, so the
     * store cannot prove the write stays under the ceiling. The old code
     * silently treated the truncated count as the total - which is how a valid
     * record sitting past the cutoff became invisible to accounting.
     *
     * Slow by nature: it needs a directory larger than the real bound.
     */
    const dir = path.join(tmp, "alpha");
    const written = store.write("alpha", record());
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const needed = EXPERIENCE_STORAGE_LIMITS.maxDirectoryEntries + 1 - 1;
    for (let i = 0; i < needed; i += 1) {
      fs.closeSync(fs.openSync(path.join(dir, `filler-${String(i)}.dat`), "w"));
    }

    const refused = store.write("alpha", record({ runId: "run_2" }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("quota_indeterminate");

    // The listing says what it knows and no more.
    const listing = store.list("alpha");
    expect(listing.count.kind).toBe("bounded");
    expect(listing.truncated).toBe(true);

    /**
     * And a record that may sit beyond the cutoff is never reported as absent.
     * Directory order is a filesystem property, so which side of the boundary
     * the record falls on is not ours to predict - but "missing" is a claim the
     * store must never make on a partial look.
     */
    const read = store.read("alpha", written.id);
    if (!read.ok) expect("indeterminate" in read).toBe(true);

    /**
     * The deterministic half of the same claim. This id is definitely not on
     * disk - and the store still must not say "missing", because it did not
     * look at the whole directory. Absence is a claim; a partial look cannot
     * support it.
     */
    const absent = store.read("alpha", "0".repeat(32));
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect("indeterminate" in absent).toBe(true);
    expect("missing" in absent).toBe(false);
  }, 110_000);
});

// ===========================================================================
describe("the quota gate creates no new trust boundary", () => {
  it("never receives a record, a project id, or anything from inside one", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "experience", "projectQuota.ts"), "utf8",
    );
    // It cannot leak what it cannot see: the record types are not even imported.
    expect(source).not.toContain("domain/experience.js");
    expect(source).not.toContain("EpisodicExperience");
    expect(source).not.toContain("StoredExperience");
  });

  it("adds no capability, grant, approval or process access", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "experience", "projectQuota.ts"), "utf8",
    );
    for (const forbidden of [
      "domain/capability.js", "domain/grant.js", "domain/approval.js",
      "grantAuthority", "issueGrant", "child_process", "fetch(", "anthropic",
    ]) {
      expect(source, `the quota gate must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is not reachable from the model, reasoning or tool layers", () => {
    const root = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (!/^(models|reasoning|tools|adapters)\//.test(rel)) continue;
        if (fs.readFileSync(full, "utf8").includes("projectQuota")) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("exposes no runtime surface beyond what it needs", () => {
    // `#` members, not TypeScript `private`, which is erased at build time.
    expect(Object.getOwnPropertyNames(ProjectQuota.prototype).sort())
      .toEqual(["constructor", "reserveAndPublish"]);
    expect(Object.getOwnPropertyNames(ProjectLock.prototype).sort())
      .toEqual(["acquire", "constructor", "release"]);
  });

  it("holds the lock under a thrown publish instead of leaking it", () => {
    const dir = path.join(tmp, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    const quota = new ProjectQuota(dir);

    const decision = quota.reserveAndPublish({
      fileName: recordName(1),
      isRecordName: (name) => RECORD_NAME.test(name),
      isTemporaryName: (name) => name.endsWith(".tmp"),
      publish: () => { throw new Error("disk on fire"); },
      unpublish: () => { /* nothing was published */ },
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("failed");
    // Released in a finally: a failed write must not wedge the project, and
    // the lock directory must be left with no owner at all.
    const locks = path.join(dir, ProjectLock.directoryName());
    expect(fs.existsSync(locks) ? fs.readdirSync(locks) : []).toEqual([]);
    expect(new ProjectQuota(dir).reserveAndPublish({
      fileName: recordName(1),
      isRecordName: (name) => RECORD_NAME.test(name),
      isTemporaryName: (name) => name.endsWith(".tmp"),
      publish: () => "written",
      unpublish: () => { /* not reached */ },
    }).ok).toBe(true);
  });
});
