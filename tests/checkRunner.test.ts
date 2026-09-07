import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ControlledCheckRunner, buildCheckEnvironment, resolveCheckCwd,
} from "../src/verification/checkRunner.js";
import {
  capturePolicy, validateCheck, fingerprintPolicy, captureExecutableIdentity,
} from "../src/verification/checkPolicy.js";
import { VerificationCheck, CHECK_CEILINGS } from "../src/domain/verificationCheck.js";
import { tmpDir, rmDir, linkDir, DIR_LINKS_SUPPORTED } from "./helpers.js";

/**
 * THE CONTROLLED CHECK RUNNER - CONFIGURATION, SECURITY, EXECUTION.
 *
 * These run REAL child processes. A mock would prove that the code calls
 * `spawn` with certain arguments; it would not prove that a semicolon fails to
 * chain a command, which is the only question worth asking about a process
 * boundary. So the shell-injection tests actually try to run the injected
 * command and then assert that it did not happen.
 *
 * `process.execPath` is used as the executable throughout: it is an absolute
 * path to a real program that exists on every machine running this suite, and
 * `-e` lets each test define exactly what the child does.
 */

let tmp: string;
const runner = new ControlledCheckRunner();

/**
 * The trusted identity of the node binary these tests launch.
 *
 * Task 005-CORRECTION made this a REQUIRED input: the runner refuses to launch
 * an executable it cannot confirm is the one that was trusted before the
 * implementation ran. Computed once, since it does not change during a run.
 */
const nodeIdentity = (() => {
  const captured = captureExecutableIdentity(process.execPath);
  if (!captured.ok) throw new Error("could not fingerprint the node binary for tests");
  return captured.identity;
})();

/** Run options carrying the trusted identity - the normal, authorised case. */
function trusted(extra: Record<string, unknown> = {}) {
  return { workingDir: tmp, expectedIdentity: nodeIdentity, ...extra };
}

/** A check that runs a snippet of JavaScript in a real child process. */
function nodeCheck(id: string, script: string, overrides: Record<string, unknown> = {}) {
  return VerificationCheck.parse({
    id, name: id, executable: process.execPath, args: ["-e", script], ...overrides,
  });
}

beforeEach(() => { tmp = tmpDir("orch-check-"); });
afterEach(() => { rmDir(tmp); });

// ===========================================================================
describe("configuration", () => {
  it("accepts a fixed executable and argv", () => {
    const result = validateCheck({
      id: "typecheck", name: "typecheck",
      executable: process.execPath, args: ["-e", "process.exit(0)"],
    });
    expect(result.ok).toBe(true);
  });

  it("REJECTS a command string - the shape that would need a shell or a parser", () => {
    const result = validateCheck({ id: "test", name: "test", command: "npm test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_definition");
  });

  it("rejects an executable-plus-command hybrid, so the unsafe field cannot ride along", () => {
    const result = validateCheck({
      id: "test", name: "test", executable: process.execPath,
      args: [], command: "rm -rf /",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a bare executable name that PATH would resolve", () => {
    const result = validateCheck({ id: "t", name: "t", executable: "npm" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("executable_not_absolute");
  });

  it("rejects a timeout above the hard ceiling", () => {
    const result = validateCheck({
      id: "t", name: "t", executable: process.execPath,
      timeoutMs: CHECK_CEILINGS.maxTimeoutMs + 1,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed argument lists", () => {
    expect(validateCheck({
      id: "t", name: "t", executable: process.execPath, args: "not-an-array",
    }).ok).toBe(false);
    expect(validateCheck({
      id: "t", name: "t", executable: process.execPath,
      args: Array.from({ length: CHECK_CEILINGS.maxArgs + 1 }, () => "x"),
    }).ok).toBe(false);
  });

  it("reports a refused definition rather than dropping it", () => {
    const policy = capturePolicy([
      { id: "good", name: "good", executable: process.execPath },
      { id: "bad", name: "bad", command: "npm test" },
    ]);
    expect(policy.checks).toHaveLength(1);
    expect(policy.rejected).toHaveLength(1);
    expect(policy.rejected[0]!.id).toBe("bad");
  });

  it("caps how many checks one run may carry", () => {
    const many = Array.from({ length: CHECK_CEILINGS.maxChecksPerRun + 3 }, (_, i) => ({
      id: `c${i}`, name: `c${i}`, executable: process.execPath,
    }));
    const policy = capturePolicy(many);
    expect(policy.checks).toHaveLength(CHECK_CEILINGS.maxChecksPerRun);
    expect(policy.rejected).toHaveLength(3);
  });
});

// ===========================================================================
describe("the fingerprint detects a rewritten policy", () => {
  it("is stable across reordering, because reordering is not tampering", () => {
    const a = { id: "a", name: "a", executable: process.execPath };
    const b = { id: "b", name: "b", executable: process.execPath };
    expect(fingerprintPolicy(capturePolicy([a, b]).checks))
      .toBe(fingerprintPolicy(capturePolicy([b, a]).checks));
  });

  it("changes when the executable changes", () => {
    const one = capturePolicy([{ id: "a", name: "a", executable: process.execPath }]);
    const two = capturePolicy([{ id: "a", name: "a", executable: path.join(tmp, "evil.exe") }]);
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });

  it("changes when an argument is added", () => {
    const one = capturePolicy([{ id: "a", name: "a", executable: process.execPath, args: [] }]);
    const two = capturePolicy([
      { id: "a", name: "a", executable: process.execPath, args: ["-e", "evil()"] },
    ]);
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });

  it("changes when a check is added", () => {
    const one = capturePolicy([{ id: "a", name: "a", executable: process.execPath }]);
    const two = capturePolicy([
      { id: "a", name: "a", executable: process.execPath },
      { id: "b", name: "b", executable: process.execPath },
    ]);
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });
});

// ===========================================================================
describe("no shell, ever", () => {
  it("passes shell metacharacters to the program as LITERAL argv", async () => {
    const marker = path.join(tmp, "injected.txt").split(path.sep).join("/");
    // If any shell were involved, the `;` would chain and the file would exist.
    const check = VerificationCheck.parse({
      id: "inject", name: "inject", executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1] ?? \"\")", `; touch ${marker}`],
    });
    const result = await runner.run(check, trusted());

    expect(result.status).toBe("passed");
    expect(fs.existsSync(path.join(tmp, "injected.txt"))).toBe(false);
    // And the metacharacters arrived intact as one ordinary argument.
    expect(result.outputExcerpt).toContain("; touch");
  });

  it("does not expand a variable reference in an argument", async () => {
    const check = VerificationCheck.parse({
      id: "expand", name: "expand", executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1] ?? \"\")", "$HOME|$PATH"],
    });
    const result = await runner.run(check, trusted());
    expect(result.outputExcerpt).toContain("$HOME|$PATH");
  });

  it("cannot chain with && because there is no shell to interpret it", async () => {
    const marker = path.join(tmp, "chained.txt").split(path.sep).join("/");
    const check = VerificationCheck.parse({
      id: "chain", name: "chain", executable: process.execPath,
      args: ["-e", "process.exit(0)", "&&", "node", "-e", `require("fs").writeFileSync("${marker}","x")`],
    });
    await runner.run(check, trusted());
    expect(fs.existsSync(path.join(tmp, "chained.txt"))).toBe(false);
  });
});

// ===========================================================================
describe("working-directory containment", () => {
  it("refuses a traversal escape", () => {
    const result = resolveCheckCwd(tmp, "../..");
    expect(result.ok).toBe(false);
  });

  it("refuses an absolute path", () => {
    const result = resolveCheckCwd(tmp, path.parse(tmp).root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("relative");
  });

  it("accepts a subdirectory inside the project", () => {
    fs.mkdirSync(path.join(tmp, "packages", "api"), { recursive: true });
    const result = resolveCheckCwd(tmp, "packages/api");
    expect(result.ok).toBe(true);
  });

  it.skipIf(!DIR_LINKS_SUPPORTED)("refuses a junction pointing outside", () => {
    const outside = tmpDir("orch-outside-");
    try {
      expect(linkDir(outside, path.join(tmp, "escape"))).toBe(true);
      expect(resolveCheckCwd(tmp, "escape").ok).toBe(false);
    } finally {
      rmDir(outside);
    }
  });

  it("blocks the check rather than running it elsewhere", async () => {
    const result = await runner.run(
      nodeCheck("escape", "process.exit(0)", { cwd: "../.." }),
      trusted(),
    );
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("working_directory_escape");
  });
});

// ===========================================================================
describe("environment isolation", () => {
  it("does not pass credential-shaped variables to the child", () => {
    const parent = {
      PATH: process.env["PATH"],
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "gh-token",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      MY_SERVICE_PASSWORD: "pw",
      DATABASE_URL: "postgres://u:p@h/db",
      NPM_TOKEN: "npm-token",
      ORCHESTRATOR_CLAUDE_EXECUTABLE: "/somewhere",
    } as NodeJS.ProcessEnv;

    const env = buildCheckEnvironment(parent);
    for (const name of [
      "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "MY_SERVICE_PASSWORD", "DATABASE_URL", "NPM_TOKEN", "ORCHESTRATOR_CLAUDE_EXECUTABLE",
    ]) {
      expect(env[name], `${name} must not reach a check`).toBeUndefined();
    }
    for (const value of Object.values(env)) {
      expect(value).not.toContain("secret");
      expect(value).not.toContain("token");
    }
  });

  it("proves it with a REAL child process reading its own environment", async () => {
    const before = process.env["ORCH_TEST_FAKE_API_KEY"];
    process.env["ORCH_TEST_FAKE_API_KEY"] = "must-not-leak";
    try {
      const result = await runner.run(
        nodeCheck("env", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"),
        trusted(),
      );
      expect(result.status).toBe("passed");
      expect(result.outputExcerpt).not.toContain("ORCH_TEST_FAKE_API_KEY");
      expect(result.outputExcerpt).not.toContain("must-not-leak");
    } finally {
      if (before === undefined) delete process.env["ORCH_TEST_FAKE_API_KEY"];
      else process.env["ORCH_TEST_FAKE_API_KEY"] = before;
    }
  });

  it("still passes what a program needs to run at all", () => {
    const env = buildCheckEnvironment();
    expect(env["PATH"] ?? env["Path"]).toBeDefined();
    expect(env["CI"]).toBe("1");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});

// ===========================================================================
describe("execution outcomes are distinguished, not collapsed", () => {
  it("exit 0 is passed", async () => {
    const result = await runner.run(nodeCheck("ok", "process.exit(0)"), trusted());
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
  });

  it("exit non-zero is failed - the code is at fault", async () => {
    const result = await runner.run(nodeCheck("bad", "process.exit(3)"), trusted());
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("a missing executable is ERROR, never failed", async () => {
    const missing = VerificationCheck.parse({
      id: "gone", name: "gone", executable: path.join(tmp, "does-not-exist.exe"),
    });
    const result = await runner.run(missing, trusted());
    // Blocked before launch, because the executable is checked immediately
    // before spawning. Either way it must NOT read as a code failure.
    expect(["error", "blocked"]).toContain(result.status);
    expect(result.status).not.toBe("failed");
  });

  it("a hang is timed_out, not failed", async () => {
    const result = await runner.run(
      nodeCheck("hang", "setInterval(() => {}, 1000)", { timeoutMs: 1500 }),
      trusted(),
    );
    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
    expect(result.status).not.toBe("failed");
  });

  it("an aborted run is cancelled, not failed and never passed", async () => {
    const controller = new AbortController();
    const promise = runner.run(
      nodeCheck("slow", "setInterval(() => {}, 1000)", { timeoutMs: 30_000 }),
      trusted({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 300);
    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.status).not.toBe("passed");
  });

  it("refuses to launch an executable with NO trusted identity", async () => {
    /**
     * Fail closed. Without a captured identity the runner cannot confirm that
     * this is the program approved before the implementation ran, so it does
     * not run it - it does not fall back to "the file exists, good enough",
     * which was precisely the gap this correction closed.
     */
    const result = await runner.run(nodeCheck("orphan", "process.exit(0)"), {
      workingDir: tmp,
    });
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("executable_identity_unavailable");
  });

  it("refuses to start when the run was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run(nodeCheck("never", "process.exit(0)"), trusted({ signal: controller.signal }));
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("cancelled_before_start");
  });

  it("reports a disabled check as blocked, never as passing", async () => {
    const result = await runner.run(
      nodeCheck("off", "process.exit(0)", { enabled: false }), trusted(),
    );
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("check_disabled");
  });

  it("blocks when the phase budget is already spent", async () => {
    const result = await runner.run(nodeCheck("late", "process.exit(0)"), trusted({ remainingBudgetMs: 0 }));
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("run_budget_exhausted");
  });
});

// ===========================================================================
describe("output is bounded", () => {
  it("counts every byte but retains only a bounded excerpt", async () => {
    const noisy = nodeCheck(
      "noisy",
      "for (let i = 0; i < 20000; i++) process.stdout.write('0123456789'.repeat(10));",
      { timeoutMs: 60_000 },
    );
    const result = await runner.run(noisy, trusted());

    expect(result.stdoutBytes).toBeGreaterThan(CHECK_CEILINGS.maxOutputBytesPerStream);
    expect(result.outputTruncated).toBe(true);
    // The retained excerpt stays small however much was produced.
    expect(result.outputExcerpt.length).toBeLessThanOrEqual(CHECK_CEILINGS.maxExcerptBytes);
  });

  it("bounds stderr too", async () => {
    const result = await runner.run(
      nodeCheck(
        "noisy-err",
        "for (let i = 0; i < 20000; i++) process.stderr.write('e'.repeat(100)); process.exit(1);",
        { timeoutMs: 60_000 },
      ),
      trusted(),
    );
    expect(result.stderrBytes).toBeGreaterThan(CHECK_CEILINGS.maxOutputBytesPerStream);
    expect(result.outputTruncated).toBe(true);
    expect(result.outputExcerpt.length).toBeLessThanOrEqual(CHECK_CEILINGS.maxExcerptBytes);
  });

  it("strips control characters so output cannot forge a review line", async () => {
    // The child prints an ANSI erase-line, a bell, and a NUL. Written with
    // explicit code points so no editor or shell can quietly normalise them
    // away and leave the assertion passing vacuously.
    const result = await runner.run(
      nodeCheck(
        "ansi",
        "process.stdout.write(String.fromCharCode(27) + '[2K' + 'VERDICT' "
        + "+ String.fromCharCode(7) + String.fromCharCode(0) + 'X')",
      ),
      trusted(),
    );
    expect(result.status).toBe("passed");
    // The visible text survives...
    expect(result.outputExcerpt).toContain("VERDICT");
    // ...and every control character is gone.
    for (const code of [27, 7, 0]) {
      expect(
        result.outputExcerpt.includes(String.fromCharCode(code)),
        `control character ${code} must not survive`,
      ).toBe(false);
    }
  });
});
