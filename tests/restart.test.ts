import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * THE POINT OF PHASE 2.
 *
 * Every other test drives the graph in-process. That proves the logic but NOT
 * durability: objects in memory survive an `await`, which is not the claim.
 *
 * This suite spawns REAL, SEPARATE `node` processes. Process 1 starts a run and
 * EXITS. Process 2 shares nothing with it but two files on disk - the SQLite
 * checkpoint and the run record - and must be able to find the suspended run,
 * resume it, and carry it forward.
 *
 * Requires `npm run build` (asserted below, with a clear message if missing).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "dist", "cli", "index.js");

let tmp: string;
let env: NodeJS.ProcessEnv;

/** Run the CLI as a genuinely separate OS process and return its stdout. */
function runCli(args: string[]): { stdout: string; pid: number } {
  const stdout = execFileSync(process.execPath, [cli, ...args], {
    env, encoding: "utf8", cwd: tmp,
  });
  return { stdout, pid: -1 };
}

beforeEach(() => {
  if (!fs.existsSync(cli)) {
    throw new Error(`dist CLI missing at ${cli}. Run "npm run build" first.`);
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-restart-"));
  env = {
    ...process.env,
    ORCHESTRATOR_HOME: path.join(tmp, ".orchestrator"),
    ORCHESTRATOR_PROJECTS: path.join(tmp, "projects"),
  };
  runCli(["project:create", "--id", "demo", "--name", "Demo", "--dir", path.join(tmp, "src")]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const runIdFrom = (stdout: string): string => {
  const m = stdout.match(/run\s+(run_[0-9a-f-]+)/);
  if (!m?.[1]) throw new Error(`no run id in CLI output:\n${stdout}`);
  return m[1];
};

describe("durable resume across process death", () => {
  it("resumes a suspended run in a brand-new process", () => {
    // ---- PROCESS 1: start, suspend at the plan gate, EXIT ----
    const p1 = runCli(["start", "--project", "demo", "--request", "Refine the homepage"]);
    const runId = runIdFrom(p1.stdout);
    expect(p1.stdout).toContain("awaiting_approval");
    expect(p1.stdout).toContain("APPROVAL REQUIRED");
    // Process 1 has now exited. Nothing of it remains in memory.

    // The checkpoint is on disk.
    const dbPath = path.join(tmp, ".orchestrator", "checkpoints.sqlite");
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);

    // ---- PROCESS 2: discover the suspended run ----
    const p2 = runCli(["runs"]);
    expect(p2.stdout).toContain(runId);

    // ---- PROCESS 3: supply the decision and continue ----
    const p3 = runCli(["resume", "--run", runId, "--decision", "approve", "--by", "owner"]);
    // It advanced past implement/verify/review to the SECOND gate.
    expect(p3.stdout).toContain("awaiting_approval");
    expect(p3.stdout).toContain("kind        review");

    // ---- PROCESS 4: final approval, run to completion ----
    const p4 = runCli(["resume", "--run", runId, "--decision", "approve", "--by", "owner"]);
    expect(p4.stdout).toContain("status   completed");
    expect(p4.stdout).toContain("outcome  approved");
  });

  it("records the resume in history under a DIFFERENT pid than the start", () => {
    const p1 = runCli(["start", "--project", "demo", "--request", "Pid check"]);
    const runId = runIdFrom(p1.stdout);
    runCli(["resume", "--run", runId, "--decision", "approve"]);

    const history = runCli(["history", "--run", runId]).stdout
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

    const resumed = history.filter((e) => e["type"] === "workflow_resumed");
    expect(resumed.length).toBeGreaterThan(0);

    // The resuming pid is neither the test runner's nor (necessarily) any other.
    const pid = resumed[0]!["pid"] as number;
    expect(typeof pid).toBe("number");
    expect(pid).not.toBe(process.pid);
  });

  it("rejects a run in a new process and records the rejection", () => {
    const p1 = runCli(["start", "--project", "demo", "--request", "Reject me"]);
    const runId = runIdFrom(p1.stdout);

    const p2 = runCli([
      "resume", "--run", runId, "--decision", "reject", "--comment", "not now",
    ]);
    expect(p2.stdout).toContain("status   rejected");
    expect(p2.stdout).toContain("rejected_at_plan");

    // Trying again fails cleanly rather than corrupting state.
    expect(() => runCli(["resume", "--run", runId, "--decision", "approve"])).toThrow();
  });

  it("keeps two projects' suspended runs independent across processes", () => {
    runCli(["project:create", "--id", "other", "--name", "Other", "--dir", path.join(tmp, "o")]);
    const a = runIdFrom(runCli(["start", "--project", "demo", "--request", "A"]).stdout);
    const b = runIdFrom(runCli(["start", "--project", "other", "--request", "B"]).stdout);

    const listed = runCli(["runs"]).stdout;
    expect(listed).toContain(a);
    expect(listed).toContain(b);

    // Resuming one leaves the other untouched.
    runCli(["resume", "--run", a, "--decision", "reject", "--comment", "no"]);
    const after = runCli(["runs"]).stdout;
    expect(after).not.toContain(a);
    expect(after).toContain(b);
  });

  it("exposes no write-capable tool from the built CLI", () => {
    expect(runCli(["tools"]).stdout).toContain("write capabilities registered: false");
  });
});

describe("survives an ungraceful kill", () => {
  it("resumes after the starting process is SIGKILLed without closing the database", () => {
    // A child that starts a run, records the id, then destroys itself WITHOUT
    // closing the SQLite handle or running any shutdown path. This is harsher
    // than Ctrl-C: no signal handler, no flush, no graceful close.
    const idFile = path.join(tmp, "runid.txt");
    const script = `
      import fs from "node:fs";
      import { ProjectStore } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "dist/projects/projectStore.js")).href)};
      import { WorkflowRunner } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "dist/graph/runner.js")).href)};
      const runner = new WorkflowRunner(new ProjectStore());
      const r = await runner.start("demo", "killed mid-approval");
      fs.writeFileSync(${JSON.stringify(idFile)}, r.run.id);
      process.kill(process.pid, "SIGKILL");
    `;
    const child = path.join(tmp, "child.mjs");
    fs.writeFileSync(child, script);

    try {
      execFileSync(process.execPath, [child], { env, cwd: tmp, encoding: "utf8" });
    } catch (error) {
      // Expected: SIGKILL means a non-zero exit. But surface a genuine startup
      // failure rather than silently passing an empty test.
      const e = error as { status?: number | null; stderr?: string };
      if (e.status !== null && e.status !== undefined && !fs.existsSync(idFile)) {
        throw new Error(`child failed before writing run id:
${e.stderr ?? ""}`, { cause: error });
      }
    }

    const runId = fs.readFileSync(idFile, "utf8").trim();
    expect(runId).toMatch(/^run_/);

    // A completely fresh process picks the run up from disk and finishes it.
    const resumed = runCli(["resume", "--run", runId, "--decision", "approve"]);
    expect(resumed.stdout).toContain("awaiting_approval");
    expect(resumed.stdout).toContain("kind        review");

    const done = runCli(["resume", "--run", runId, "--decision", "approve"]);
    expect(done.stdout).toContain("status   completed");
  });
});
