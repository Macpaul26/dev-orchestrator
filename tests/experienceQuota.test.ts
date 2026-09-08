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
    const dir = seed("alpha", MAX - 1);
    expect(recordFiles("alpha")).toHaveLength(MAX - 1);

    const script = path.join(tmp, "writer.cjs");
    fs.writeFileSync(script, [
      "const { ExperienceStore } = require(process.argv[2]);",
      ...BARRIER,
      "const [, , , root, startAt, index] = process.argv;",
      "waitUntil(Number(startAt));",
      "const store = new ExperienceStore(root);",
      "const result = store.write('alpha', {",
      "  scope: 'project', layer: 'episodic', projectId: 'alpha',",
      "  runId: 'run_' + index, taskType: 'add-endpoint',",
      `  createdAt: '${ISO}',`,
      "});",
      "process.stdout.write(result.ok ? 'OK' : result.failure.code);",
    ].join("\n"));

    const startAt = Date.now() + 400;
    const results = await runConcurrently(
      script,
      (index) => [compiled("experienceStore.js"), tmp, String(startAt), String(index)],
      CONTENDERS,
    );

    const succeeded = results.filter((r) => r === "OK");
    expect(succeeded).toHaveLength(1);

    // Every refusal is a bounded, named outcome - never a crash, never silence.
    for (const result of results.filter((r) => r !== "OK")) {
      expect(["project_quota_exceeded", "storage_busy"]).toContain(result);
    }

    // THE INVARIANT. Never MAX + 1, under any interleaving.
    expect(recordFiles("alpha")).toHaveLength(MAX);

    // Six processes contended for the lock and every one of them let go of it.
    expect(fs.existsSync(path.join(dir, ProjectLock.fileName()))).toBe(false);
  });

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
describe("crash recovery", () => {
  const lockFile = (projectId: string): string =>
    path.join(tmp, projectId, ProjectLock.fileName());

  /** Backdate a file so it looks abandoned, without waiting 30 real seconds. */
  function age(file: string, ms = EXPERIENCE_STORAGE_LIMITS.lockStaleMs + 5_000): void {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(file, when, when);
  }

  it("a process that dies BEFORE reserving leaves nothing behind", async () => {
    const script = path.join(tmp, "die-early.cjs");
    fs.writeFileSync(script, ["process.exit(0);"].join("\n"));
    await runConcurrently(script, () => [], 1);

    expect(fs.existsSync(path.join(tmp, "alpha"))).toBe(false);
    expect(store.write("alpha", record()).ok).toBe(true);
  });

  it("a process that dies HOLDING the lock blocks writes, then stops blocking", async () => {
    /**
     * A genuinely orphaned lock: a real child takes it and exits without ever
     * releasing it. Nothing in this process cleans up after it.
     */
    fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true });
    const script = path.join(tmp, "die-holding.cjs");
    fs.writeFileSync(script, [
      "const { ProjectLock } = require(process.argv[2]);",
      "const held = new ProjectLock(process.argv[3]).acquire();",
      "process.stdout.write(held === null ? 'NONE' : 'HELD');",
      "process.exit(0);",
    ].join("\n"));

    const [taken] = await runConcurrently(
      script, () => [compiled("projectQuota.js"), path.join(tmp, "alpha")], 1,
    );
    expect(taken).toBe("HELD");
    expect(fs.existsSync(lockFile("alpha"))).toBe(true);

    // While the lock still looks fresh, a writer reports contention. Bounded,
    // named, and NOTHING WAS WRITTEN - it is not a quota outcome.
    const blocked = store.write("alpha", record());
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.failure.code).toBe("storage_busy");
    expect(recordFiles("alpha")).toHaveLength(0);

    // Once it is older than the stale window, capacity comes back.
    age(lockFile("alpha"));
    const after = store.write("alpha", record());
    expect(after.ok).toBe(true);
    expect(recordFiles("alpha")).toHaveLength(1);
    expect(fs.existsSync(lockFile("alpha"))).toBe(false);
  });

  it("a stale lock does not permanently consume project capacity", () => {
    fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true });
    fs.writeFileSync(lockFile("alpha"), JSON.stringify({ pid: 1, nonce: "gone" }));
    age(lockFile("alpha"));

    for (let i = 0; i < 3; i += 1) {
      const written = store.write("alpha", record({ runId: `run_${String(i)}` }));
      expect(written.ok).toBe(true);
    }
    expect(recordFiles("alpha")).toHaveLength(3);
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
    age(abandoned);

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
    // Released in a finally: a failed write must not wedge the project.
    expect(fs.existsSync(path.join(dir, ProjectLock.fileName()))).toBe(false);
    expect(new ProjectQuota(dir).reserveAndPublish({
      fileName: recordName(1),
      isRecordName: (name) => RECORD_NAME.test(name),
      isTemporaryName: (name) => name.endsWith(".tmp"),
      publish: () => "written",
      unpublish: () => { /* not reached */ },
    }).ok).toBe(true);
  });
});
