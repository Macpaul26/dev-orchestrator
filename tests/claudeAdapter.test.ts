import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { ControlledImplementationRunner } from "../src/implementation/runner.js";
import { CancellationToken } from "../src/implementation/session.js";
import { ActivityJournal } from "../src/activity/journal.js";
import { issueGrant } from "../src/domain/grant.js";
import type { Capability } from "../src/domain/capability.js";
import { createRegistry, describeCapabilities } from "../src/tools/registry.js";
import type {
  ClaudeCodeConfigError} from "../src/adapters/claude-code/index.js";
import {
  ClaudeCodeAgent, validateConfig, configFromEnvironment, buildAgentEnvironment, AgentLaunchRefused, launchAgentProcess,
  BASE_ENV_PASSTHROUGH, ENV_EXECUTABLE, ENV_ALLOWED_ENV,
  type ClaudeCodeConfig,
} from "../src/adapters/claude-code/index.js";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier } from "../src/verification/verifier.js";
import { writeFakeAgent, type FakeAgentBehaviour } from "./fakeClaudeProcess.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * THE CLAUDE CODE PROCESS BOUNDARY.
 *
 * Every test here runs a REAL child process through the REAL adapter. Only the
 * configured executable is swapped - for a deterministic script that lies,
 * exits how it was told, and ignores SIGTERM on request. That is the point: a
 * boundary is proven by something that attacks it, not by something well-behaved.
 *
 * The claim being tested throughout:
 *
 *   > Claude Code is an untrusted implementation agent. Its claims are not
 *   > observations.
 */

let parent: string;
let repo: string;
let scripts: string;
let store: ProjectStore;
let runner: ControlledImplementationRunner;

const RUN = "run_claude";
const CAPS: Capability[] = ["repo.read", "repo.metadata.read", "repo.file.write", "repo.file.delete"];

const configFor = (behaviour: FakeAgentBehaviour, over: Partial<ClaudeCodeConfig> = {}) =>
  validateConfig({
    executable: process.execPath,
    baseArgs: [writeFakeAgent(scripts, behaviour)],
    ...over,
  });

function makeGrant(over: Partial<Parameters<typeof issueGrant>[0]> = {}) {
  return store.saveGrant(
    issueGrant({
      projectId: "proj", runId: RUN, approvalId: "apr_1", approvedBy: "owner",
      allowedScope: ["src/"], capabilities: CAPS, ...over,
    }),
  );
}

const journal = () => new ActivityJournal(store.activityFile("proj", RUN));
const agentFor = (behaviour: FakeAgentBehaviour, over: Partial<ClaudeCodeConfig> = {}) =>
  new ClaudeCodeAgent(configFor(behaviour, over), journal());

beforeEach(() => {
  parent = tmpDir("orch-claude-");
  repo = path.join(parent, "repo");
  scripts = path.join(parent, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
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
describe("the executable comes from trusted configuration only", () => {
  it("refuses a non-absolute executable", () => {
    try {
      validateConfig({ executable: "claude" });
      expect.unreachable("a bare name would be resolved through PATH");
    } catch (error) {
      expect((error as ClaudeCodeConfigError).code).toBe("executable_not_absolute");
    }
  });

  it("refuses an executable that does not exist", () => {
    try {
      validateConfig({ executable: path.join(parent, "nope", "claude") });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ClaudeCodeConfigError).code).toBe("executable_missing");
    }
  });

  it("refuses a directory as an executable", () => {
    try {
      validateConfig({ executable: repo });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ClaudeCodeConfigError).code).toBe("executable_not_a_file");
    }
  });

  it("is UNCONFIGURED by default, so no agent is connected", () => {
    expect(configFromEnvironment({})).toBeNull();
    expect(configFromEnvironment({ [ENV_EXECUTABLE]: "   " })).toBeNull();
  });

  it("exposes NO field through which a request could supply an executable", async () => {
    // The structural guarantee: `ImplementationRequest` has no executable, and
    // adding one to the object changes nothing about what runs.
    const evil = path.join(scripts, "evil.mjs");
    fs.writeFileSync(evil, `require("node:fs").writeFileSync(${JSON.stringify(path.join(parent, "PWNED"))}, "x");`);

    const proof = path.join(parent, "legit-ran.txt");
    const grant = makeGrant();
    await runner.run(
      grant,
      {
        instruction: "x",
        // Every plausible smuggling field, all ignored.
        executable: evil, command: evil, argv: [evil], baseArgs: [evil],
      } as never,
      agentFor({ touch: proof }),
    );

    expect(fs.existsSync(proof)).toBe(true);        // the configured agent ran
    expect(fs.existsSync(path.join(parent, "PWNED"))).toBe(false); // the smuggled one did not
  });

  it("re-validates the executable at launch, not only at configuration time", () => {
    const script = writeFakeAgent(scripts, {});
    const config = validateConfig({ executable: process.execPath, baseArgs: [script] });
    // Point the config at something that has since disappeared.
    const stale = { ...config, executable: path.join(parent, "vanished") };
    expect(() =>
      launchAgentProcess({ config: stale, workingDir: repo, payload: payload() }),
    ).toThrow(AgentLaunchRefused);
  });
});

// ===========================================================================
describe("environment isolation", () => {
  const CREDENTIALS = {
    ANTHROPIC_API_KEY: "sk-ant-LEAK-ME",
    GITHUB_TOKEN: "ghp_LEAK_ME",
    AWS_SECRET_ACCESS_KEY: "aws-LEAK-ME",
    DATABASE_URL: "postgres://leak",
    MY_DEPLOY_PASSWORD: "hunter2",
    ORCHESTRATOR_CLAUDE_EXECUTABLE: "/somewhere/else",
  };

  it("does NOT inherit credentials from the orchestrator process", async () => {
    for (const [k, v] of Object.entries(CREDENTIALS)) process.env[k] = v;
    try {
      const dump = path.join(parent, "env.json");
      const grant = makeGrant();
      await runner.run(grant, { instruction: "x" }, agentFor({ dumpEnvTo: dump }));

      const childEnv = JSON.parse(fs.readFileSync(dump, "utf8")) as Record<string, string>;
      for (const name of Object.keys(CREDENTIALS)) {
        expect(childEnv[name], `${name} must not reach the child`).toBeUndefined();
      }
      // And no VALUE leaked under a different name either.
      const serialised = JSON.stringify(childEnv);
      for (const value of Object.values(CREDENTIALS)) {
        expect(serialised).not.toContain(value);
      }
    } finally {
      for (const k of Object.keys(CREDENTIALS)) delete process.env[k];
    }
  });

  it("passes only the fixed base plus explicitly allowlisted names", async () => {
    process.env["MY_AGENT_SETTING"] = "permitted-value";
    process.env["MY_OTHER_SETTING"] = "not-permitted";
    try {
      const dump = path.join(parent, "env2.json");
      const grant = makeGrant();
      await runner.run(
        grant, { instruction: "x" },
        agentFor({ dumpEnvTo: dump }, { environmentAllowlist: ["MY_AGENT_SETTING"] }),
      );

      const childEnv = JSON.parse(fs.readFileSync(dump, "utf8")) as Record<string, string>;
      // POSITIVE CONTROL: the mechanism genuinely passes what it is told to.
      expect(childEnv["MY_AGENT_SETTING"]).toBe("permitted-value");
      expect(childEnv["MY_OTHER_SETTING"]).toBeUndefined();
    } finally {
      delete process.env["MY_AGENT_SETTING"];
      delete process.env["MY_OTHER_SETTING"];
    }
  });

  it("REFUSES to allowlist a credential-shaped name", () => {
    for (const name of [
      "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
      "MY_PASSWORD", "SOME_SECRET", "DB_HOST", "ORCHESTRATOR_CLAUDE_EXECUTABLE",
    ]) {
      try {
        validateConfig({ executable: process.execPath, environmentAllowlist: [name] });
        expect.unreachable(`${name} must not be allowlistable`);
      } catch (error) {
        expect((error as ClaudeCodeConfigError).code).toBe("forbidden_env_allowlist");
      }
    }
  });

  it("builds the environment rather than inheriting it", () => {
    const built = buildAgentEnvironment(
      validateConfig({ executable: process.execPath }),
      { PATH: "/bin", ANTHROPIC_API_KEY: "leak", RANDOM_THING: "no" },
    );
    expect(built["PATH"]).toBe("/bin");
    expect(built["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(built["RANDOM_THING"]).toBeUndefined();
    // Non-interactive by construction.
    expect(built["CI"]).toBe("1");
    expect(built["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("names no credential in the base passthrough list", () => {
    for (const name of BASE_ENV_PASSTHROUGH) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
    }
  });

  it("reads its allowlist from orchestrator configuration, not from a request", () => {
    const config = configFromEnvironment({
      [ENV_EXECUTABLE]: process.execPath,
      [ENV_ALLOWED_ENV]: "MY_AGENT_SETTING, ANOTHER_ONE",
    });
    expect(config?.environmentAllowlist).toEqual(["MY_AGENT_SETTING", "ANOTHER_ONE"]);
  });
});

// ===========================================================================
describe("working-directory boundary", () => {
  it("launches in the PROJECT directory, not the orchestrator's", async () => {
    const dump = path.join(parent, "cwd.txt");
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentFor({ dumpCwdTo: dump }));

    const cwd = fs.realpathSync(fs.readFileSync(dump, "utf8").trim());
    expect(cwd).toBe(fs.realpathSync(repo));
  });

  it("DISCARDS a caller-supplied working directory", async () => {
    const dump = path.join(parent, "cwd2.txt");
    const elsewhere = path.join(parent, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });

    const grant = makeGrant();
    await runner.run(
      grant,
      { instruction: "x", workingDir: elsewhere },
      agentFor({ dumpCwdTo: dump }),
    );

    const cwd = fs.realpathSync(fs.readFileSync(dump, "utf8").trim());
    expect(cwd).toBe(fs.realpathSync(repo));
    expect(cwd).not.toBe(fs.realpathSync(elsewhere));
  });

  it("refuses a directory that contains the orchestrator's own state", () => {
    // A project pointed at a parent of the project store would hand the agent
    // its own grants and audit trail as ordinary files.
    expect(() =>
      launchAgentProcess({
        config: configFor({}),
        workingDir: parent,
        forbiddenDirectories: [store.root],
        payload: payload(),
      }),
    ).toThrow(/orchestrator state/);
  });

  it("refuses a missing or non-absolute working directory", () => {
    for (const dir of [path.join(parent, "gone"), "relative/dir"]) {
      expect(() =>
        launchAgentProcess({ config: configFor({}), workingDir: dir, payload: payload() }),
      ).toThrow(AgentLaunchRefused);
    }
  });
});

// ===========================================================================
describe("what the agent is told", () => {
  it("receives scope and capabilities from the GRANT, not from the request", async () => {
    const dump = path.join(parent, "payload.json");
    const grant = makeGrant({ allowedScope: ["src/"] });

    await runner.run(
      grant,
      {
        instruction: "do the thing",
        // A caller trying to tell the agent it may go anywhere.
        allowedScope: ["."], capabilities: ["git.mutate", "process.execute"],
      } as never,
      agentFor({ dumpPayloadTo: dump }),
    );

    const received = JSON.parse(fs.readFileSync(dump, "utf8")) as Record<string, unknown>;
    expect(received["allowedScope"]).toEqual(["src"]);
    expect(received["capabilities"]).toEqual([...CAPS].sort());
    expect(received["capabilities"]).not.toContain("git.mutate");
  });

  it("carries no secret, no store path and no checkpoint state", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-MUST-NOT-APPEAR";
    try {
      const dump = path.join(parent, "payload2.json");
      const grant = makeGrant();
      await runner.run(grant, { instruction: "x" }, agentFor({ dumpPayloadTo: dump }));

      const raw = fs.readFileSync(dump, "utf8");
      expect(raw).not.toContain("sk-ant-MUST-NOT-APPEAR");
      expect(raw).not.toContain(store.root);
      expect(raw).not.toContain("checkpoints.sqlite");
      expect(raw).not.toContain("fingerprint");
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("cannot widen the grant by anything it is told", async () => {
    const grant = makeGrant({ allowedScope: ["src/"] });
    await runner.run(grant, { instruction: "x" }, agentFor({ exitCode: 0 }));
    const stored = store.getGrant("proj", grant.grantId)!;
    expect(stored.allowedScope).toEqual(["src"]);
    expect(stored.capabilities).not.toContain("git.mutate");
  });
});

// ===========================================================================
describe("agent output is a CLAIM, never an observation", () => {
  it("does not turn a fabricated file list into observed state", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    const grant = makeGrant();
    const result = await runner.run(
      grant, { instruction: "x" },
      agentFor({
        stdout: "I rewrote the authentication system and all tests passed.\n",
        report: {
          summary: "Rewrote auth, everything green.",
          files: ["src/auth.ts", "src/session.ts"],
          claimsSuccess: true,
        },
      }),
    );

    // The claim survives, labelled.
    expect(result.agentReport.files).toEqual(["src/auth.ts", "src/session.ts"]);
    expect(result.agentReport.summary).toContain("AGENT-REPORTED (untrusted, not verified)");

    // The repository disagrees, and the repository wins.
    const verified = await verifier.verify({
      runId: RUN,
      claimedSummary: result.agentReport.summary,
      claimedFiles: result.agentReport.files,
      baseline,
      allowedScope: grant.allowedScope,
    });
    expect(verified.report.observedFiles).toEqual([]);
    expect(verified.evidence.claims.claimedButNotObserved).toEqual([
      "src/auth.ts", "src/session.ts",
    ]);
    expect(verified.evidence.attribution.attributable).toEqual([]);
  });

  it("a fabricated 'tests passed' produces no verified check result", async () => {
    const grant = makeGrant();
    const result = await runner.run(
      grant, { instruction: "x" },
      agentFor({ stdout: "All 412 tests passed.\n", report: { claimsSuccess: true } }),
    );
    // Check execution is disabled; nothing the agent says changes that.
    expect(result.run.status).toBe("completed");
    expect(result.agentReport.claimsSuccess).toBe(true); // its claim
    expect(result.run.writes).toBe(0);                    // what we observed
  });

  it("a zero exit code does not become a success claim on the agent's behalf", async () => {
    const grant = makeGrant();
    const result = await runner.run(grant, { instruction: "x" }, agentFor({ exitCode: 0 }));
    // No report emitted -> no success asserted, despite exit 0.
    expect(result.agentReport.claimsSuccess).toBe(false);
    expect(result.agentReport.summary).toContain("supplied no summary");
  });

  it("concealing a real change does not hide it from inspection", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    const baseline = await verifier.captureBaseline();

    // The agent writes directly (it is an OS process - see the docs on what the
    // boundary does NOT protect) and then denies it.
    const sneak = path.join(repo, "src", "sneaked.ts");
    const grant = makeGrant();
    const result = await runner.run(
      grant, { instruction: "x" },
      agentFor({
        touch: sneak,
        report: { summary: "I changed nothing at all.", files: [], claimsSuccess: true },
      }),
    );
    expect(result.agentReport.files).toEqual([]);

    const verified = await verifier.verify({
      runId: RUN, claimedFiles: result.agentReport.files, baseline,
      allowedScope: grant.allowedScope,
    });
    expect(verified.evidence.claims.observedButNotClaimed).toContain("src/sneaked.ts");
    expect(verified.evidence.attribution.introduced).toContain("src/sneaked.ts");
  });

  it("does not retain agent output in the durable record by default", async () => {
    const grant = makeGrant();
    const secret = "AGENT_PRINTED_SECRET_abc123";
    await runner.run(
      grant, { instruction: "x" },
      agentFor({ stdout: `here is something sensitive: ${secret}\n` }),
    );

    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain(secret);
    // But the fact that it printed IS recorded.
    const exited = journal().read().find((r) => r.type === "agent_exited") as
      { stdoutBytes: number } | undefined;
    expect(exited!.stdoutBytes).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("process result classification", () => {
  it("records a clean exit as completed", async () => {
    const grant = makeGrant();
    const result = await runner.run(grant, { instruction: "x" }, agentFor({ exitCode: 0 }));
    expect(result.run.status).toBe("completed");
    const exited = journal().read().find((r) => r.type === "agent_exited") as
      { status: string; exitCode: number | null } | undefined;
    expect(exited!.status).toBe("completed");
    expect(exited!.exitCode).toBe(0);
  });

  it("records a non-zero exit as failed, with the code", async () => {
    const grant = makeGrant();
    const result = await runner.run(grant, { instruction: "x" }, agentFor({ exitCode: 3 }));
    expect(result.run.status).toBe("completed"); // the RUN completed; the agent failed
    const exited = journal().read().find((r) => r.type === "agent_exited") as
      { status: string; exitCode: number | null } | undefined;
    expect(exited!.status).toBe("failed");
    expect(exited!.exitCode).toBe(3);
  });

  it("records an unrequested death as NOT cancelled", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentFor({ selfSignal: "SIGKILL" }));
    const exited = journal().read().find((r) => r.type === "agent_exited") as
      { status: string; signal: string | null } | undefined;

    // The property that matters everywhere: a death nobody asked for must never
    // read as an orderly cancellation.
    expect(exited!.status).not.toBe("cancelled");
    expect(exited!.status).not.toBe("completed");

    /**
     * PLATFORM TRUTH, not a weakened assertion.
     *
     * POSIX reports the terminating signal, so an unrequested kill is
     * distinguishable and classifies as `interrupted`. Windows has no signals:
     * the OS reports an ordinary non-zero exit and nothing else, so the same
     * event is indistinguishable from a program choosing to fail, and honestly
     * classifies as `failed`. Asserting `interrupted` on Windows would be
     * asserting information the platform does not provide.
     */
    if (process.platform === "win32") {
      expect(exited!.status).toBe("failed");
      expect(exited!.signal).toBeNull();
    } else {
      expect(exited!.status).toBe("interrupted");
      expect(exited!.signal).toBe("SIGKILL");
    }
  });

  it("records a launch failure without starting anything", async () => {
    const grant = makeGrant();
    const broken = new ClaudeCodeAgent(
      { ...configFor({}), executable: path.join(parent, "does-not-exist") } as ClaudeCodeConfig,
      journal(),
    );
    const result = await runner.run(grant, { instruction: "x" }, broken);

    expect(result.run.status).toBe("failed");
    const failed = journal().read().find((r) => r.type === "agent_launch_failed") as
      { failure: string } | undefined;
    expect(failed!.failure).toBe("executable_missing");
    expect(journal().read().some((r) => r.type === "agent_started")).toBe(false);
  });

  it("emits launch_attempted with the basename only, never the full path", async () => {
    const grant = makeGrant();
    await runner.run(grant, { instruction: "x" }, agentFor({}));
    const attempted = journal().read().find((r) => r.type === "agent_launch_attempted") as
      { executable: string } | undefined;
    expect(attempted!.executable).toBe(path.basename(process.execPath));
    expect(attempted!.executable).not.toContain(path.sep);
  });
});

// ===========================================================================
describe("cancellation reaches the child process", () => {
  it("terminates a running agent and records it as cancelled", async () => {
    const grant = makeGrant();
    const token = new CancellationToken();
    const marker = path.join(parent, "late.txt");

    // Long-lived; it would write the marker only if allowed to finish.
    const promise = runner.run(
      grant, { instruction: "x" },
      agentFor({ sleepMs: 30_000, touch: undefined }),
      token,
    );
    await new Promise((r) => setTimeout(r, 400));
    token.cancel("human asked to stop");

    const result = await promise;
    expect(result.run.status).toBe("cancelled");
    expect(fs.existsSync(marker)).toBe(false);

    const types = journal().read().map((r) => r.type);
    expect(types).toContain("agent_termination_requested");
    expect(types).toContain("agent_terminated");
  }, 60_000);

  it("an agent that ignores SIGTERM is still stopped", async () => {
    const grant = makeGrant();
    const token = new CancellationToken();
    const marker = path.join(parent, "survived.txt");

    const promise = runner.run(
      grant, { instruction: "x" },
      agentFor(
        { sleepMs: 30_000, ignoreSigterm: true, touch: undefined },
        { gracefulTerminationMs: 500 },
      ),
      token,
    );
    await new Promise((r) => setTimeout(r, 400));
    token.cancel("stop");

    const result = await promise;

    // THE SECURITY PROPERTY, and it holds on every platform: a badly-behaved
    // agent cannot stay alive by refusing to cooperate.
    expect(result.run.status).toBe("cancelled");
    expect(fs.existsSync(marker)).toBe(false);
    const terminated = journal().read().find((r) => r.type === "agent_terminated") as
      { forciblyKilled: boolean } | undefined;
    expect(terminated).toBeDefined();

    /**
     * PLATFORM TRUTH about HOW it is stopped.
     *
     * On POSIX, SIGTERM is deliverable and ignorable, so the orchestrator must
     * escalate - and `forciblyKilled` records that it did. On Windows there are
     * no signals: `child.kill("SIGTERM")` calls TerminateProcess, the child's
     * handler never runs, and the very first attempt is already forcible. So no
     * escalation is observed there, because none was needed.
     */
    if (process.platform !== "win32") {
      expect(terminated!.forciblyKilled).toBe(true);
    }
  }, 60_000);

  it("cancellation does NOT create a replacement grant, and verification still applies", async () => {
    const grant = makeGrant();
    const token = new CancellationToken();
    const promise = runner.run(
      grant, { instruction: "x" }, agentFor({ sleepMs: 30_000 }), token,
    );
    await new Promise((r) => setTimeout(r, 400));
    token.cancel("stop");
    const result = await promise;

    expect(result.run.status).toBe("cancelled");
    expect(result.run.partialChangesPossible).toBe(true);
    expect(result.mustVerify).toBe(true);
    // One grant, consumed. No reissue, no retry.
    expect(store.listGrants("proj")).toHaveLength(1);
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");
    await expect(runner.run(grant, { instruction: "x" }, agentFor({})))
      .rejects.toMatchObject({ reason: "consumed" });
  }, 60_000);
});

// ===========================================================================
describe("no capability expansion", () => {
  it("leaves the capability matrix unchanged", () => {
    const matrix = describeCapabilities();
    for (const capability of ["process.execute", "git.mutate", "network.access"]) {
      const entry = matrix.find((m) => m.capability === capability)!;
      expect(entry.implemented, `${capability} must remain unimplemented`).toBe(false);
    }
  });

  it("registers no write tool merely because an agent can be launched", () => {
    const registry = createRegistry();
    expect(registry.hasWriteCapability()).toBe(false);
    expect(registry.list().map((t) => t.name)).toEqual(["orchestrator.describe"]);
  });

  it("exposes no tool that launches a process", () => {
    for (const tool of createRegistry().list()) {
      expect(tool.name).not.toMatch(/exec|spawn|shell|process|claude|agent/i);
    }
  });

  // The exact spawn-site inventory lives in gitHardening.test.ts, where it
  // originated - one canonical list, one place to update.

  it("never builds a shell command string", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "adapters", "claude-code", "processBoundary.ts"),
      "utf8",
    );
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source.match(/\bspawn\(/g)).toHaveLength(1);
  });
});

function payload() {
  return {
    protocol: "orchestrator.implementation.v1" as const,
    runId: RUN, projectId: "proj", grantId: "grn_x",
    instruction: "x", planSummary: "", allowedScope: [], capabilities: [],
  };
}
