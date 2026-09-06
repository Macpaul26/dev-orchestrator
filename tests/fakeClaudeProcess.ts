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
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  fs.writeFileSync(b.dumpPayloadTo, raw, "utf8");
}

if (b.ignoreSigterm) process.on("SIGTERM", () => { /* deliberately deaf */ });

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
