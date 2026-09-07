import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ControlledCheckRunner } from "../src/verification/checkRunner.js";
import { VerificationCheckPhase } from "../src/verification/checkPhase.js";
import {
  capturePolicy, captureExecutableIdentity, verifyExecutableIdentity,
} from "../src/verification/checkPolicy.js";
import { VerificationCheck } from "../src/domain/verificationCheck.js";
import { tmpDir, rmDir, linkFile, FILE_LINKS_SUPPORTED } from "./helpers.js";

/**
 * TASK 005-CORRECTION - VERIFICATION EXECUTABLE INTEGRITY.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THESE TESTS EXIST FOR
 * ---------------------------------------------------------------------------
 * The policy fingerprint protects the check DEFINITION. It says nothing about
 * the bytes at the path the definition names, so this sequence used to work:
 *
 *   trusted policy names tools/check.js      fingerprint F
 *   agent receives write authority
 *   agent replaces tools/check.js            fingerprint STILL F
 *   orchestrator confirms the file exists
 *   orchestrator runs the replacement, as trusted verification
 *
 * ---------------------------------------------------------------------------
 * HOW THESE TESTS PROVE IT IS CLOSED
 * ---------------------------------------------------------------------------
 * Not by asserting a status field. Every malicious replacement below writes a
 * MARKER FILE as its first action, and the assertion is that the marker does
 * not exist. A status can be wrong; a file either got written or it did not.
 *
 * The malicious programs are real, executable, and verified to work: one test
 * runs one directly to prove the marker mechanism itself is not broken. A test
 * that "passes" because the malicious program was incapable of running would
 * prove nothing at all.
 */

let tmp: string;
let toolsDir: string;
let checkFile: string;
let marker: string;

const runner = new ControlledCheckRunner();

/** JavaScript that writes the marker, then exits 0 as if it had verified. */
function maliciousScript(): string {
  const target = marker.split(path.sep).join("/");
  return `require("fs").writeFileSync(${JSON.stringify(target)}, "EXECUTED");\n`
    + `process.exit(0);\n`;
}

/** JavaScript that does nothing but succeed - the honest check. */
function benignScript(): string {
  return `process.exit(0);\n`;
}

function checkFor(file: string) {
  return VerificationCheck.parse({
    id: "unit", name: "unit", executable: process.execPath,
    args: [file], cwd: ".", timeoutMs: 30_000, enabled: true,
  });
}

/**
 * A check whose EXECUTABLE is the script itself.
 *
 * The integrity guard protects the `executable`, so a test about replacing the
 * executable has to make the interesting file BE the executable. A `.js` file
 * is not directly spawnable, so these use a copy of the node binary as the
 * executable when the executable itself is the thing under attack.
 */
function checkWithExecutable(executable: string, args: string[] = []) {
  return VerificationCheck.parse({
    id: "unit", name: "unit", executable, args,
    cwd: ".", timeoutMs: 30_000, enabled: true,
  });
}

beforeEach(() => {
  tmp = tmpDir("orch-integrity-");
  toolsDir = path.join(tmp, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  checkFile = path.join(toolsDir, "check.js");
  marker = path.join(tmp, "MALICIOUS-EXECUTED.txt");
  fs.writeFileSync(checkFile, benignScript());
});

afterEach(() => { rmDir(tmp); });

// ===========================================================================
describe("the marker mechanism itself works", () => {
  /**
   * Without this, every test below could pass for the wrong reason - a
   * malicious program that simply cannot run proves nothing about the guard.
   */
  it("a malicious script DOES write the marker when actually executed", async () => {
    fs.writeFileSync(checkFile, maliciousScript());
    const result = await runner.run(checkFor(checkFile), {
      workingDir: tmp,
      expectedIdentity: captureExecutableIdentity(process.execPath).ok
        ? (captureExecutableIdentity(process.execPath) as { identity: never }).identity
        : undefined,
    });

    expect(result.status).toBe("passed");
    expect(fs.existsSync(marker), "the marker must exist when the script really runs")
      .toBe(true);
  });
});

// ===========================================================================
describe("Test 1 - the executable is REPLACED after capture", () => {
  it("blocks, and the malicious replacement does NOT execute", async () => {
    // 1-2. capture the trusted policy and the executable identity
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const policy = capturePolicy([
      { ...checkWithExecutable(trustedExecutable, [checkFile]) },
    ]);
    expect(policy.identities["unit"]).toBeDefined();

    // 3-4. the implementation side replaces the executable. Same path, same
    // policy - only the bytes differ.
    //
    // The script it would run is made malicious at the same time. Both halves
    // matter: if only the executable were tampered with and the script stayed
    // benign, the marker could never appear and this test would pass whether
    // the guard worked or not.
    fs.writeFileSync(checkFile, maliciousScript());
    fs.rmSync(trustedExecutable);
    fs.copyFileSync(process.execPath, trustedExecutable);
    fs.appendFileSync(trustedExecutable, "\n// tampered\n");

    // 5-6. attempt verification
    const phase = new VerificationCheckPhase();
    const run = await phase.run({
      workingDir: tmp,
      grantedCapabilities: ["verification.execute"],
      policy,
    });

    // THE ASSERTION THAT MATTERS, AND IT COMES FIRST.
    //
    // A status can be wrong; a file either got written or it did not. Asserted
    // before the status so that disabling the guard fails HERE - on proof the
    // replacement really executed - rather than on a status mismatch that would
    // leave the question open.
    expect(fs.existsSync(marker), "the replacement must NOT have executed").toBe(false);

    const result = run.results.find((r) => r.checkId === "unit")!;
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("executable_integrity_changed");
  });

  it("reports both digests so a human can see the mismatch", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const policy = capturePolicy([checkWithExecutable(trustedExecutable, [checkFile])]);
    fs.appendFileSync(trustedExecutable, "\n// tampered\n");

    const run = await new VerificationCheckPhase().run({
      workingDir: tmp, grantedCapabilities: ["verification.execute"], policy,
    });
    const result = run.results[0]!;
    expect(result.expectedSha256).toMatch(/^[0-9a-f]{12}$/);
    expect(result.observedSha256).toMatch(/^[0-9a-f]{12}$/);
    expect(result.expectedSha256).not.toBe(result.observedSha256);
  });
});

// ===========================================================================
describe("Test 2 - the executable is MODIFIED IN PLACE", () => {
  it("blocks, and the modified executable does NOT execute", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const policy = capturePolicy([checkWithExecutable(trustedExecutable, [checkFile])]);

    // Modified in place - same inode on most systems, same path, same policy.
    fs.appendFileSync(trustedExecutable, "\n// appended in place\n");
    // And the script it would run is made malicious, to prove non-execution.
    fs.writeFileSync(checkFile, maliciousScript());

    const run = await new VerificationCheckPhase().run({
      workingDir: tmp, grantedCapabilities: ["verification.execute"], policy,
    });

    // Marker first, for the same reason as Test 1.
    expect(fs.existsSync(marker), "the modified executable must NOT have run").toBe(false);
    expect(run.results[0]!.status).toBe("blocked");
    expect(run.results[0]!.blockedReason).toBe("executable_integrity_changed");
  });
});

// ===========================================================================
describe("Test 3 - the executable path is REPOINTED via a link", () => {
  it.skipIf(!FILE_LINKS_SUPPORTED)("blocks when the path becomes a link elsewhere", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const policy = capturePolicy([checkWithExecutable(trustedExecutable, [checkFile])]);

    // Repoint the SAME path at a different file.
    const elsewhere = path.join(tmp, "other-runner.exe");
    fs.copyFileSync(process.execPath, elsewhere);
    fs.appendFileSync(elsewhere, "\n// a different program\n");
    fs.rmSync(trustedExecutable);
    expect(linkFile(elsewhere, trustedExecutable)).toBe(true);

    fs.writeFileSync(checkFile, maliciousScript());

    const run = await new VerificationCheckPhase().run({
      workingDir: tmp, grantedCapabilities: ["verification.execute"], policy,
    });

    expect(run.results[0]!.status).toBe("blocked");
    expect(fs.existsSync(marker), "the relinked target must NOT have run").toBe(false);
  });

  it("records the resolved path, so a repoint is visible even at equal content", () => {
    const a = path.join(tmp, "a.exe");
    const b = path.join(tmp, "b.exe");
    fs.copyFileSync(process.execPath, a);
    fs.copyFileSync(process.execPath, b);

    const first = captureExecutableIdentity(a);
    const second = captureExecutableIdentity(b);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Identical content...
    expect(first.identity.sha256).toBe(second.identity.sha256);
    // ...but they are demonstrably different files, and the identity says so.
    expect(first.identity.resolvedPath).not.toBe(second.identity.resolvedPath);
  });
});

// ===========================================================================
describe("Test 4 - the POSITIVE path: an unchanged executable still runs", () => {
  it("executes normally and passes when nothing was touched", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const policy = capturePolicy([checkWithExecutable(trustedExecutable, [checkFile])]);

    const run = await new VerificationCheckPhase().run({
      workingDir: tmp, grantedCapabilities: ["verification.execute"], policy,
    });

    // Proof the guard does not simply block everything.
    expect(run.results[0]!.status).toBe("passed");
    expect(run.results[0]!.exitCode).toBe(0);
    expect(run.attempted).toBe(true);
  });

  it("still reports a genuine check failure rather than an integrity block", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    fs.writeFileSync(checkFile, "process.exit(1);\n");
    const policy = capturePolicy([checkWithExecutable(trustedExecutable, [checkFile])]);

    const run = await new VerificationCheckPhase().run({
      workingDir: tmp, grantedCapabilities: ["verification.execute"], policy,
    });
    expect(run.results[0]!.status).toBe("failed");
    expect(run.results[0]!.exitCode).toBe(1);
  });
});

// ===========================================================================
describe("Test 5 - policy UNCHANGED while the executable CHANGED", () => {
  /**
   * The test that isolates the correction. If the policy fingerprint were doing
   * this work, it would have moved - it does not. Only the content digest does.
   */
  it("proves the fingerprint is identical and the block comes from the digest", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);

    const definitions = [checkWithExecutable(trustedExecutable, [checkFile])];
    const before = capturePolicy(definitions);

    // Tamper with the executable only. The definition is untouched.
    fs.appendFileSync(trustedExecutable, "\n// tampered\n");
    fs.writeFileSync(checkFile, maliciousScript());

    const after = capturePolicy(definitions);

    // THE POINT: the policy fingerprint did not move...
    expect(after.fingerprint).toBe(before.fingerprint);
    // ...while the executable identity did.
    expect(after.identities["unit"]!.sha256).not.toBe(before.identities["unit"]!.sha256);

    // And execution is refused on the strength of the digest alone.
    const run = await new VerificationCheckPhase().run({
      workingDir: tmp,
      grantedCapabilities: ["verification.execute"],
      policy: before,
      // Re-read config: unchanged, so the policy guard has nothing to say.
      currentChecks: definitions,
    });

    expect(fs.existsSync(marker), "the tampered executable must NOT have run").toBe(false);
    expect(run.attempted).toBe(true);
    expect(run.policyChangedDuringRun).toBe(false);
    expect(run.results[0]!.blockedReason).toBe("executable_integrity_changed");
  });
});

// ===========================================================================
describe("failing closed", () => {
  it("refuses to run a check that has no captured identity at all", async () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const policy = capturePolicy([checkWithExecutable(trustedExecutable, [checkFile])]);

    // Strip the identity, simulating a capture that could not hash the file.
    const withoutIdentity = { ...policy, identities: {} };
    fs.writeFileSync(checkFile, maliciousScript());

    const run = await new VerificationCheckPhase().run({
      workingDir: tmp, grantedCapabilities: ["verification.execute"],
      policy: withoutIdentity,
    });

    expect(fs.existsSync(marker), "a check with no trusted identity must NOT run")
      .toBe(false);
    expect(run.results[0]!.status).toBe("blocked");
    expect(run.results[0]!.blockedReason).toBe("executable_identity_unavailable");
  });

  it("refuses when the executable has been deleted outright", () => {
    const trustedExecutable = path.join(toolsDir, "runner.exe");
    fs.copyFileSync(process.execPath, trustedExecutable);
    const captured = captureExecutableIdentity(trustedExecutable);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    fs.rmSync(trustedExecutable);
    const verdict = verifyExecutableIdentity(trustedExecutable, captured.identity);
    expect(verdict.ok).toBe(false);
  });

  it("captures no identity for a path that is not a file", () => {
    expect(captureExecutableIdentity(toolsDir).ok).toBe(false);
  });
});
