import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { ControlledImplementationRunner } from "../src/implementation/runner.js";
import { CancellationToken } from "../src/implementation/session.js";
import { ActivityJournal } from "../src/activity/journal.js";
import { issueGrant } from "../src/domain/grant.js";
import type { Capability } from "../src/domain/capability.js";
import { ClaudeCodeAgent, validateConfig } from "../src/adapters/claude-code/index.js";
import type { ClaudeCodeConfig } from "../src/adapters/claude-code/config.js";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier } from "../src/verification/verifier.js";
import { writeFakeAgent, type FakeAgentBehaviour } from "./fakeClaudeProcess.js";
import { tmpDir, rmDir, git, initRepo, linkDir, DIR_LINKS_SUPPORTED } from "./helpers.js";

/**
 * THE BRIDGE, THROUGH A REAL HOSTILE CHILD PROCESS.
 *
 * toolBridge.test.ts attacks the bridge directly, which is cheap and lets there
 * be many attacks. This file proves the same answers come back when the attacker
 * is an actual OS process talking over a real pipe - that the framing, the
 * transport, the wiring and the enforcement all hold together, not just the
 * enforcement in isolation.
 *
 * Nothing here is mocked. Every test spawns a child that writes protocol lines
 * to fd 3 and reads responses from stdin.
 */

let parent: string;
let repo: string;
let scripts: string;
let store: ProjectStore;
let runner: ControlledImplementationRunner;

const RUN = "run_e2e";
const CAPS: Capability[] = ["repo.read", "repo.metadata.read", "repo.file.write", "repo.file.delete"];

const configFor = (behaviour: FakeAgentBehaviour, over: Partial<ClaudeCodeConfig> = {}) =>
  validateConfig({
    executable: process.execPath,
    baseArgs: [writeFakeAgent(scripts, behaviour)],
    ...over,
  });

const journal = () => new ActivityJournal(store.activityFile("proj", RUN));

function makeGrant(over: Partial<Parameters<typeof issueGrant>[0]> = {}) {
  return store.saveGrant(
    issueGrant({
      projectId: "proj", runId: RUN, approvalId: "apr_1", approvedBy: "owner",
      allowedScope: ["src/"], capabilities: CAPS, ...over,
    }),
  );
}

/** Run a hostile child that sends `requests`, and return what it received back. */
async function attack(
  requests: string[],
  over: Partial<Parameters<typeof issueGrant>[0]> = {},
): Promise<{ responses: { ok: boolean; error?: { code: string } }[] }> {
  const dump = path.join(parent, `resp-${Math.random().toString(36).slice(2)}.json`);
  const grant = makeGrant(over);
  const agent = new ClaudeCodeAgent(
    configFor({ toolRequests: requests, dumpResponsesTo: dump }),
    journal(),
  );
  await runner.run(grant, { instruction: "attack" }, agent);

  if (!fs.existsSync(dump)) return { responses: [] };
  const raw = JSON.parse(fs.readFileSync(dump, "utf8")) as string[];
  return { responses: raw.map((line) => JSON.parse(line) as { ok: boolean; error?: { code: string } }) };
}

const exists = (rel: string) => fs.existsSync(path.join(repo, rel));
let n = 0;
const request = (tool: string, args: unknown) =>
  JSON.stringify({ requestId: `e${(n += 1)}`, tool, arguments: args });

beforeEach(() => {
  parent = tmpDir("orch-e2e-");
  repo = path.join(parent, "repo");
  scripts = path.join(parent, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "existing.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "protected.ts"), "do not touch\n");
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=E2E_SECRET_VALUE\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);

  fs.mkdirSync(path.join(parent, "outside"), { recursive: true });
  fs.writeFileSync(path.join(parent, "outside", "victim.txt"), "HOST SECRET\n");

  store = new ProjectStore(path.join(parent, "projects"));
  store.createProject({
    id: "proj", name: "Proj", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
  });
  runner = new ControlledImplementationRunner({ store });
});

afterEach(() => rmDir(parent));

// ===========================================================================
describe("a real child can do legitimate work through the bridge", () => {
  it("writes a file inside the approved scope", async () => {
    const { responses } = await attack([
      request("write_file", { path: "src/created.ts", contents: "export const b = 2;\n" }),
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "src", "created.ts"), "utf8")).toContain("const b");
  });

  it("reads and lists inside the approved scope", async () => {
    const { responses } = await attack([
      request("read_file", { path: "src/existing.ts" }),
      request("list_directory", { path: "src" }),
    ]);
    expect(responses.every((r) => r.ok)).toBe(true);
  });
});

// ===========================================================================
describe("a real hostile child cannot cross the boundary", () => {
  it("cannot escape the project with traversal or absolute paths", async () => {
    const { responses } = await attack([
      request("write_file", { path: "../outside/victim.txt", contents: "PWNED" }),
      request("write_file", { path: "src/../../outside/victim.txt", contents: "PWNED" }),
      request("write_file", { path: "/etc/passwd", contents: "PWNED" }),
      request("write_file", { path: "C:\\Windows\\Temp\\pwned.txt", contents: "PWNED" }),
      request("write_file", { path: "\\\\server\\share\\pwned.txt", contents: "PWNED" }),
      request("read_file", { path: "../outside/victim.txt" }),
    ], { allowedScope: ["."] });

    expect(responses).toHaveLength(6);
    expect(responses.every((r) => !r.ok)).toBe(true);
    expect(fs.readFileSync(path.join(parent, "outside", "victim.txt"), "utf8")).toBe("HOST SECRET\n");
    // The host secret never came back down the pipe either.
    expect(JSON.stringify(responses)).not.toContain("HOST SECRET");
  });

  it("cannot write outside the approved scope", async () => {
    const { responses } = await attack([
      request("write_file", { path: "protected.ts", contents: "PWNED" }),
      request("delete_file", { path: "protected.ts" }),
    ]);
    expect(responses.every((r) => r.error?.code === "out_of_scope")).toBe(true);
    expect(fs.readFileSync(path.join(repo, "protected.ts"), "utf8")).toBe("do not touch\n");
  });

  it("cannot read or write a sensitive file", async () => {
    const { responses } = await attack([
      request("read_file", { path: ".env" }),
      request("write_file", { path: ".env", contents: "TOKEN=planted" }),
      request("delete_file", { path: ".env" }),
    ], { allowedScope: ["."] });

    expect(JSON.stringify(responses)).not.toContain("E2E_SECRET_VALUE");
    expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toContain("E2E_SECRET_VALUE");
  });

  it("cannot invoke a shell, a process, git or the network", async () => {
    const { responses } = await attack([
      request("execute", { command: "rm -rf /" }),
      request("run", { cmd: "whoami" }),
      request("bash", { script: "echo pwned" }),
      request("spawn", { file: "node" }),
      request("git_commit", { message: "x" }),
      request("git_push", {}),
      request("fetch", { url: "https://example.invalid" }),
      request("deploy", {}),
      // And an attempt to smuggle a command into a legitimate tool.
      request("write_file", { path: "src/x.ts; rm -rf /", contents: "x" }),
    ]);

    expect(responses).toHaveLength(9);
    for (const response of responses.slice(0, 8)) {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("unknown_tool");
    }
    // The last one is a legitimate tool with a hostile path. `shell: false`
    // everywhere means the semicolon is just a character in a filename.
    expect(exists("src")).toBe(true);
    expect(fs.existsSync(path.join(repo, "src", "existing.ts"))).toBe(true);
  });

  it("cannot forge authority in a protocol message", async () => {
    const forged = [
      JSON.stringify({
        requestId: "f1", tool: "write_file",
        arguments: { path: "protected.ts", contents: "PWNED" },
        grantId: "grn_forged", projectId: "other", allowedScope: ["."],
      }),
      JSON.stringify({
        requestId: "f2", tool: "write_file",
        arguments: { path: "protected.ts", contents: "PWNED", allowedScope: ["."] },
      }),
      JSON.stringify({
        requestId: "f3", tool: "write_file",
        arguments: { path: "src/ok.ts", contents: "x" },
        capabilities: ["git.mutate"], maxWrites: 99999,
      }),
    ];
    const { responses } = await attack(forged);

    expect(responses).toHaveLength(3);
    expect(responses.every((r) => !r.ok)).toBe(true);
    expect(fs.readFileSync(path.join(repo, "protected.ts"), "utf8")).toBe("do not touch\n");
    // f3 was a legitimate path but carried forged authority: refused outright,
    // not silently stripped and executed.
    expect(exists("src/ok.ts")).toBe(false);
  });

  it("cannot crash the orchestrator with malformed protocol traffic", async () => {
    const { responses } = await attack([
      "{",
      "not json at all",
      "[]",
      "null",
      JSON.stringify({ requestId: "m1" }),
      JSON.stringify({ tool: "read_file" }),
      JSON.stringify({ requestId: "m2", tool: "read_file", arguments: { path: 42 } }),
      JSON.stringify({ requestId: "m3", tool: "read_file", arguments: null }),
      // A valid request AFTER the garbage: the channel must still work.
      request("write_file", { path: "src/after-garbage.ts", contents: "ok\n" }),
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(9);
    expect(responses[responses.length - 1]!.ok).toBe(true);
    expect(exists("src/after-garbage.ts")).toBe(true);
  });

  it("cannot replay a request id", async () => {
    const duplicate = JSON.stringify({
      requestId: "same", tool: "write_file",
      arguments: { path: "src/one.ts", contents: "1" },
    });
    const { responses } = await attack([
      duplicate,
      JSON.stringify({
        requestId: "same", tool: "write_file",
        arguments: { path: "src/two.ts", contents: "2" },
      }),
    ]);

    // Requests are handled in order, so the first succeeds and the replay is
    // refused. Asserted as a set as well, so the test does not silently depend
    // on ordering if that ever changes.
    expect(responses).toHaveLength(2);
    expect(responses.filter((r) => r.ok)).toHaveLength(1);
    expect(responses.filter((r) => r.error?.code === "duplicate_request_id")).toHaveLength(1);
    expect(exists("src/one.ts")).toBe(true);
    expect(exists("src/two.ts")).toBe(false);
  });

  it("cannot exhaust memory with an unterminated protocol line", async () => {
    // 2 MB with no newline, against a 1 MB line limit.
    const grant = makeGrant();
    const agent = new ClaudeCodeAgent(
      configFor({ floodBytes: 2 * 1024 * 1024, sleepMs: 2000 }),
      journal(),
    );
    const result = await runner.run(grant, { instruction: "flood" }, agent);

    // The run ends rather than buffering. Which terminal state it reaches
    // depends on timing; what matters is that it ended and nothing was written.
    expect(["completed", "cancelled", "failed"]).toContain(result.run.status);
    expect(result.run.writes).toBe(0);
  }, 60_000);

  it("cannot exceed the mutation budget", async () => {
    const { responses } = await attack([
      request("write_file", { path: "src/a.ts", contents: "1" }),
      request("write_file", { path: "src/b.ts", contents: "2" }),
      request("write_file", { path: "src/c.ts", contents: "3" }),
    ], { maxWrites: 2 });

    expect(responses[0]!.ok).toBe(true);
    expect(responses[1]!.ok).toBe(true);
    expect(responses[2]!.ok).toBe(false);
    expect(responses[2]!.error?.code).toBe("write_budget_exhausted");
    expect(exists("src/c.ts")).toBe(false);
  });

  it("cannot use a capability the grant omits", async () => {
    const { responses } = await attack([
      request("write_file", { path: "src/x.ts", contents: "x" }),
      request("delete_file", { path: "src/existing.ts" }),
    ], { capabilities: ["repo.read", "repo.metadata.read"] as Capability[] });

    expect(responses.every((r) => r.error?.code === "capability_not_granted")).toBe(true);
    expect(exists("src/x.ts")).toBe(false);
    expect(exists("src/existing.ts")).toBe(true);
  });
});

describe.skipIf(!DIR_LINKS_SUPPORTED)("a real child cannot escape through a junction", () => {
  it("is refused at the bridge, and the target is untouched", async () => {
    expect(linkDir(path.join(parent, "outside"), path.join(repo, "src", "escape"))).toBe(true);

    const { responses } = await attack([
      request("read_file", { path: "src/escape/victim.txt" }),
      request("write_file", { path: "src/escape/victim.txt", contents: "PWNED" }),
      request("write_file", { path: "src/escape/planted.txt", contents: "PWNED" }),
    ]);

    expect(responses.every((r) => !r.ok)).toBe(true);
    expect(JSON.stringify(responses)).not.toContain("HOST SECRET");
    expect(fs.readFileSync(path.join(parent, "outside", "victim.txt"), "utf8")).toBe("HOST SECRET\n");
    expect(fs.existsSync(path.join(parent, "outside", "planted.txt"))).toBe(false);
  });
});

// ===========================================================================
describe("claims remain claims, whatever the tools returned", () => {
  it("a denied write followed by a success claim does not become truth", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    const dump = path.join(parent, "resp.json");
    const grant = makeGrant({ allowedScope: ["src/"] });
    const agent = new ClaudeCodeAgent(
      configFor({
        toolRequests: [
          request("write_file", { path: "protected.ts", contents: "PWNED" }),
          request("write_file", { path: "src/real.ts", contents: "real\n" }),
        ],
        dumpResponsesTo: dump,
        // The lie: it was refused, and it says otherwise.
        report: {
          summary: "Updated protected.ts and ran the full test suite; all 412 passed.",
          files: ["protected.ts", "src/imaginary.ts"],
          claimsSuccess: true,
        },
      }),
      journal(),
    );

    const result = await runner.run(grant, { instruction: "x" }, agent);

    // The claim is preserved as a claim.
    expect(result.agentReport.files).toEqual(["protected.ts", "src/imaginary.ts"]);
    expect(result.agentReport.summary).toContain("AGENT-REPORTED (untrusted, not verified)");

    // The repository says otherwise, and the repository decides.
    const verified = await verifier.verify({
      runId: RUN,
      claimedSummary: result.agentReport.summary,
      claimedFiles: result.agentReport.files,
      baseline,
      allowedScope: grant.allowedScope,
    });
    expect(verified.report.observedFiles).toContain("src/real.ts");
    expect(verified.report.observedFiles).not.toContain("protected.ts");
    expect(verified.report.observedFiles).not.toContain("src/imaginary.ts");
    expect(verified.evidence.claims.claimedButNotObserved).toContain("protected.ts");
    expect(fs.readFileSync(path.join(repo, "protected.ts"), "utf8")).toBe("do not touch\n");
  });
});

// ===========================================================================
describe("cancellation stops the bridge", () => {
  it("refuses tool requests that arrive after cancellation", async () => {
    const dump = path.join(parent, "cancel-resp.json");
    const grant = makeGrant();
    const token = new CancellationToken();

    // The child pauses, then tries to write. Cancellation lands in between.
    const agent = new ClaudeCodeAgent(
      configFor({
        // The child waits, so cancellation lands BEFORE it asks for anything.
        preRequestDelayMs: 1200,
        toolRequests: [request("write_file", { path: "src/after-cancel.ts", contents: "x" })],
        dumpResponsesTo: dump,
      }),
      journal(),
    );

    const promise = runner.run(grant, { instruction: "x" }, agent, token);
    await new Promise((r) => setTimeout(r, 400));
    token.cancel("human stopped it");
    const result = await promise;

    expect(result.run.status).toBe("cancelled");
    // Whatever the child managed to send, nothing was written.
    expect(exists("src/after-cancel.ts")).toBe(false);
    expect(result.run.writes).toBe(0);
    // The grant is spent, and no replacement appeared.
    expect(store.listGrants("proj")).toHaveLength(1);
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");
  }, 60_000);
});

// ===========================================================================
describe("the orchestrator journals what really happened", () => {
  it("records completions and denials the agent never mentions", async () => {
    await attack([
      request("write_file", { path: "src/ok.ts", contents: "x" }),
      request("write_file", { path: "protected.ts", contents: "PWNED" }),
      request("execute", { command: "whoami" }),
    ]);

    const types = journal().read().map((r) => r.type);
    expect(types).toContain("bridge_request_completed");
    expect(types).toContain("bridge_request_rejected");
    expect(types).toContain("agent_started");
    expect(types).toContain("agent_exited");
  });

  it("leaks no secret and no host path into the journal", async () => {
    await attack([
      request("read_file", { path: ".env" }),
      request("write_file", { path: "src/s.ts", contents: "const s = 'E2E_SECRET_VALUE';" }),
    ], { allowedScope: ["."] });

    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain("E2E_SECRET_VALUE");
    expect(raw).not.toContain(repo);
    expect(raw).not.toContain(parent);
  });
});
