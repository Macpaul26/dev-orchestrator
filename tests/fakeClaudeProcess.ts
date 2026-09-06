import fs from "node:fs";
import path from "node:path";
import { REPORT_MARKER } from "../src/adapters/claude-code/processBoundary.js";

/**
 * A DETERMINISTIC, HOSTILE STAND-IN FOR CLAUDE CODE - TESTS ONLY.
 *
 * Real Claude Code is not installed in CI, is not deterministic, and cannot be
 * asked to misbehave in a specific way on demand. Proving a boundary needs the
 * opposite of a capable agent: a program that lies precisely, exits how you
 * asked, ignores SIGTERM when told to, and prints exactly the claims you want to
 * see disbelieved.
 *
 * These scripts are run by the SAME adapter, through the SAME `spawn` call, with
 * the SAME environment and working-directory policy as a real agent would be.
 * The only thing swapped out is which executable the trusted configuration
 * points at - which is itself the property being tested.
 */

export interface FakeAgentBehaviour {
  /** Text on stdout before anything else. */
  stdout?: string;
  stderr?: string;
  /** A structured report the adapter will parse as CLAIMS. */
  report?: { summary?: string; files?: string[]; claimsSuccess?: boolean };
  exitCode?: number;
  /** Dump the received environment as JSON, so a test can inspect it. */
  dumpEnvTo?: string;
  /** Dump `process.cwd()`, so a test can prove where it was launched. */
  dumpCwdTo?: string;
  /** Dump the stdin payload, so a test can prove what it was told. */
  dumpPayloadTo?: string;
  /** Write a marker file - used to prove a process did or did not run. */
  touch?: string;
  /** Stay alive this long, so cancellation has something to terminate. */
  sleepMs?: number;
  /** Ignore SIGTERM entirely, forcing the orchestrator to escalate. */
  ignoreSigterm?: boolean;
  /** Kill itself with a signal nobody asked for. */
  selfSignal?: "SIGKILL";

  /**
   * Tool requests to send down the protocol channel (fd 3), in order.
   *
   * Raw strings, not objects, so a test can send malformed JSON, oversized
   * lines, duplicate ids and forged authority fields - the things a typed
   * helper would quietly prevent.
   */
  toolRequests?: string[];
  /** Write every response the orchestrator sent, so a test can assert on them. */
  dumpResponsesTo?: string;
  /** Emit one unterminated line of this many bytes, to probe the read bound. */
  floodBytes?: number;
  /**
   * Wait this long before sending any tool request.
   *
   * Lets a test cancel the run while the child is still "thinking", so the
   * requests genuinely arrive AFTER cancellation rather than racing it.
   */
  preRequestDelayMs?: number;
}

/**
 * Write a Node script that behaves as described, and return its path.
 *
 * The adapter is configured with `executable = process.execPath` and
 * `baseArgs = [scriptPath]` - a real absolute executable and fixed trusted
 * arguments, exactly the shape an operator would configure.
 */
export function writeFakeAgent(dir: string, behaviour: FakeAgentBehaviour): string {
  const file = path.join(dir, `fake-agent-${Math.random().toString(36).slice(2)}.mjs`);
  const b = JSON.stringify(behaviour);
  const marker = JSON.stringify(REPORT_MARKER);

  const script = `
const b = ${b};
const fs = await import("node:fs");

if (b.dumpEnvTo) fs.writeFileSync(b.dumpEnvTo, JSON.stringify(process.env), "utf8");
if (b.dumpCwdTo) fs.writeFileSync(b.dumpCwdTo, process.cwd(), "utf8");
if (b.touch) fs.writeFileSync(b.touch, "ran", "utf8");

if (b.dumpPayloadTo) {
  // ONE LINE, not to EOF. stdin stays open as the response channel for the
  // whole run, so reading to EOF would block until the run ended - which is a
  // deadlock, and was one until this stopped doing it.
  let raw = "";
  process.stdin.setEncoding("utf8");
  await new Promise((resolve) => {
    const onData = (chunk) => {
      raw += chunk;
      if (raw.includes("\\n")) {
        process.stdin.off("data", onData);
        resolve();
      }
    };
    process.stdin.on("data", onData);
    setTimeout(resolve, 3000);
  });
  fs.writeFileSync(b.dumpPayloadTo, raw.split("\\n")[0], "utf8");
}

if (b.ignoreSigterm) process.on("SIGTERM", () => { /* deliberately deaf */ });

// ---- the tool protocol channel -----------------------------------------
//
// ESCAPING: this script lives inside a template literal, so any escape it needs
// must be double-escaped here. Note that this applies to COMMENTS too - the
// first version of this note spelt the escape out literally, the template
// turned it into a real newline, and the comment broke across lines and took
// the whole child down with a syntax error before it ran a single statement.
if (b.toolRequests || b.floodBytes) {
  const responses = [];
  let pending = "";
  // Responses arrive on stdin, after the session payload. Read line by line -
  // stdin does not close until the run is over.
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    let i = pending.indexOf("\\n");
    while (i !== -1) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      // Line 1 is the session payload; only responses carry a requestId.
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && "requestId" in parsed) {
            responses.push(line);
          }
        } catch {
          responses.push(line);
        }
      }
      i = pending.indexOf("\\n");
    }
  });

  if (b.preRequestDelayMs) await new Promise((r) => setTimeout(r, b.preRequestDelayMs));

  if (b.floodBytes) {
    // One enormous line with NO newline: a memory-exhaustion probe.
    fs.writeSync(3, "x".repeat(b.floodBytes));
  }
  for (const request of b.toolRequests ?? []) {
    fs.writeSync(3, request + "\\n");
  }

  // Give the orchestrator time to answer before exiting.
  await new Promise((r) => setTimeout(r, b.toolRequests ? 900 : 400));
  if (b.dumpResponsesTo) fs.writeFileSync(b.dumpResponsesTo, JSON.stringify(responses), "utf8");
}

if (b.stdout) process.stdout.write(b.stdout);
if (b.stderr) process.stderr.write(b.stderr);
if (b.report) process.stdout.write("\\n" + ${marker} + JSON.stringify(b.report) + "\\n");

if (b.sleepMs) await new Promise((r) => setTimeout(r, b.sleepMs));
if (b.selfSignal) process.kill(process.pid, b.selfSignal);

process.exit(b.exitCode ?? 0);
`;
  fs.writeFileSync(file, script, "utf8");
  return file;
}
