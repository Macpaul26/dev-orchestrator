import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AgentProcessResult, AgentOutputSummary,
  type AgentProcessResult as TAgentProcessResult,
  type AgentOutputSummary as TAgentOutputSummary,
  type AgentLaunchFailure,
} from "../../domain/agentProcess.js";
import {
  type ClaudeCodeConfig, validateConfig, buildAgentEnvironment,
  ClaudeCodeConfigError,
} from "./config.js";

/**
 * THE AGENT PROCESS BOUNDARY
 *
 * The second - and, in this phase, last - place in the orchestrator that starts
 * a process. The first is `adapters/repository/gitExec.ts`, which runs
 * allowlisted read-only git.
 *
 * The two are different in kind, and the difference matters:
 *
 *   gitExec          runs a program WE trust, with arguments WE build, and
 *                    constrains which subcommands are even possible.
 *   this boundary    runs a program we DO NOT trust, and constrains what it is
 *                    handed and what we believe afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ACTUALLY PROTECTS - AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * It protects the LAUNCH:
 *
 *   - no shell: `spawn` with `shell: false` and an argv array, so nothing the
 *     orchestrator passes can be reinterpreted as a command
 *   - the executable comes from trusted configuration, never from a request
 *   - the environment is built, not inherited, so credentials in the parent
 *     process are not handed over
 *   - the working directory is one specific authorised path
 *   - lifetime is bounded, observable, and terminable
 *
 * IT IS NOT A SANDBOX. Once running, the child is an ordinary OS process with
 * the launching user's privileges. It can read files outside the working
 * directory, open sockets, and start processes of its own. `shell: false`
 * governs how WE start it and says nothing about what it does next.
 *
 * That is precisely why the orchestrator does not believe anything it says. The
 * containment that matters is not the process boundary; it is that repository
 * state is established by independent inspection afterwards.
 */

/** The payload handed to the child on stdin. Contains no secret and no path. */
export interface AgentRequestPayload {
  protocol: "orchestrator.implementation.v1";
  runId: string;
  projectId: string;
  grantId: string;
  instruction: string;
  planSummary: string;
  /** Derived from the GRANT, never from a request. Informational for the agent. */
  allowedScope: readonly string[];
  capabilities: readonly string[];
}

export interface LaunchOptions {
  config: ClaudeCodeConfig;
  /** Already validated and authorised by the caller. Becomes the child's cwd. */
  workingDir: string;
  payload: AgentRequestPayload;
  /** Paths the child's cwd must not be, or contain. */
  forbiddenDirectories?: readonly string[];
  now?: () => Date;
}

export interface AgentProcessOutcome {
  result: TAgentProcessResult;
  output: TAgentOutputSummary;
  /**
   * A structured report the agent printed, if any. UNTRUSTED - the agent
   * authored every byte. Never merged into observations.
   */
  claimedReport: { summary?: string; files?: string[]; claimsSuccess?: boolean } | null;
}

const REPORT_MARKER = "ORCHESTRATOR_REPORT:";

/**
 * A launched agent process, with an observable lifetime.
 *
 * Deliberately a handle rather than a fire-and-forget call: cancellation has to
 * reach a running child, and the orchestrator has to be able to observe how it
 * actually ended rather than assuming.
 */
export class AgentProcessHandle {
  #child: ChildProcess | null = null;
  #terminationRequested = false;
  #forciblyKilled = false;
  #settled: Promise<AgentProcessOutcome>;
  #startedAt: Date | null = null;

  private constructor(
    private readonly options: LaunchOptions,
    settled: (handle: AgentProcessHandle) => Promise<AgentProcessOutcome>,
  ) {
    this.#settled = settled(this);
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }
  get isRunning(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /**
   * Ask the child to stop, then make sure it did.
   *
   * SIGTERM first, so a well-behaved agent can finish what it is doing; SIGKILL
   * after the grace period, because a badly-behaved one must not be able to keep
   * running by ignoring the request. Either way the ACTUAL outcome is recorded -
   * the orchestrator never assumes termination worked.
   */
  async terminate(reason = "cancelled"): Promise<void> {
    void reason;
    this.#terminationRequested = true;
    const child = this.#child;
    if (!child || !this.isRunning) return;

    child.kill("SIGTERM");

    const grace = this.options.config.gracefulTerminationMs;
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), grace)),
    ]);

    if (!exited && this.isRunning) {
      this.#forciblyKilled = true;
      child.kill("SIGKILL");
    }
  }

  /** Resolve when the process has ended, with what was actually observed. */
  async wait(): Promise<AgentProcessOutcome> {
    return this.#settled;
  }

  // ---- internals used by `launch` ---------------------------------------
  /** @internal */
  _attach(child: ChildProcess, startedAt: Date): void {
    this.#child = child;
    this.#startedAt = startedAt;
  }
  /** @internal */
  _state(): { terminationRequested: boolean; forciblyKilled: boolean; startedAt: Date | null } {
    return {
      terminationRequested: this.#terminationRequested,
      forciblyKilled: this.#forciblyKilled,
      startedAt: this.#startedAt,
    };
  }

  static create(
    options: LaunchOptions,
    settled: (handle: AgentProcessHandle) => Promise<AgentProcessOutcome>,
  ): AgentProcessHandle {
    return new AgentProcessHandle(options, settled);
  }
}

export class AgentLaunchRefused extends Error {
  constructor(
    readonly failure: AgentLaunchFailure,
    message: string,
  ) {
    super(message);
    this.name = "AgentLaunchRefused";
  }
}

/**
 * Validate everything, then start the process.
 *
 * Every refusal below happens BEFORE a process exists, so a misconfiguration
 * cannot half-launch something.
 */
export function launchAgentProcess(options: LaunchOptions): AgentProcessHandle {
  const now = options.now ?? (() => new Date());

  // ---- re-validate the executable at launch time, not just at config time --
  let config: ClaudeCodeConfig;
  try {
    config = validateConfig(options.config);
  } catch (error) {
    if (error instanceof ClaudeCodeConfigError) {
      throw new AgentLaunchRefused(
        error.code === "executable_missing" ? "executable_missing"
        : error.code === "executable_not_a_file" ? "executable_not_a_file"
        : error.code === "executable_not_absolute" ? "executable_not_absolute"
        : "not_configured",
        error.message,
      );
    }
    throw error;
  }

  // ---- the working directory ---------------------------------------------
  const workingDir = assertUsableWorkingDir(options.workingDir, options.forbiddenDirectories ?? []);

  const startedAt = now();
  const handle = AgentProcessHandle.create(options, (self) =>
    run(self, config, workingDir, options.payload, now, startedAt),
  );
  return handle;
}

function assertUsableWorkingDir(
  candidate: string,
  forbidden: readonly string[],
): string {
  if (!path.isAbsolute(candidate)) {
    throw new AgentLaunchRefused(
      "working_dir_invalid",
      `Agent working directory "${candidate}" must be absolute.`,
    );
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new AgentLaunchRefused(
      "working_dir_invalid",
      `Agent working directory "${candidate}" does not exist.`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new AgentLaunchRefused(
      "working_dir_invalid",
      `Agent working directory "${candidate}" is not a directory.`,
    );
  }

  /**
   * Refuse to point the agent at the orchestrator's own state.
   *
   * A project whose working directory contained the project store, the
   * checkpoint database or the activity journals would hand the agent its own
   * grants and audit trail as ordinary files. That is a configuration mistake
   * rather than an attack, and it is exactly the kind that is invisible until
   * it matters, so it is refused here.
   */
  for (const directory of forbidden) {
    let realForbidden: string;
    try {
      realForbidden = fs.realpathSync(directory);
    } catch {
      continue; // does not exist - nothing to protect
    }
    const relative = path.relative(resolved, realForbidden);
    const contained = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (contained) {
      throw new AgentLaunchRefused(
        "working_dir_unsafe",
        `Agent working directory "${resolved}" contains orchestrator state ` +
          `("${realForbidden}"). The agent must not be pointed at the project ` +
          "store, checkpoints, or activity journals.",
      );
    }
  }

  return resolved;
}

async function run(
  handle: AgentProcessHandle,
  config: ClaudeCodeConfig,
  workingDir: string,
  payload: AgentRequestPayload,
  now: () => Date,
  startedAt: Date,
): Promise<AgentProcessOutcome> {
  let child: ChildProcess;
  try {
    child = spawn(config.executable, [...config.baseArgs], {
      cwd: workingDir,
      env: buildAgentEnvironment(config),
      // NO SHELL. The argv array is passed to the OS as-is, so nothing here is
      // ever parsed as a command line.
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return launchFailure("spawn_error", `spawn failed (${errorName(error)})`, startedAt, now);
  }

  handle._attach(child, startedAt);

  // The request goes in on stdin rather than argv: it is data, it can be long,
  // and it never has to be quoted or escaped anywhere.
  try {
    child.stdin?.end(`${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // A child that closed stdin immediately is not an error on our side.
  }

  const stdout = new BoundedCapture(config.maxOutputBytes);
  const stderr = new BoundedCapture(config.maxOutputBytes);
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  const timeout = setTimeout(() => {
    void handle.terminate("timed out");
  }, config.timeoutMs);
  let timedOut = false;
  const markTimeout = setTimeout(() => { timedOut = true; }, config.timeoutMs);

  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(timeout);
  clearTimeout(markTimeout);

  const endedAt = now();
  const state = handle._state();

  if (ended.error) {
    return launchFailure("spawn_error", `spawn failed (${ended.error.name})`, startedAt, now);
  }

  /**
   * Classify the ending from what the OS reported, not from what the agent said.
   *
   * `cancelled` requires that WE asked for termination. A process that died on a
   * signal nobody sent is `interrupted` - a distinct fact, because it means
   * something outside the orchestrator killed it and the repository may be
   * mid-edit.
   */
  const status =
    state.terminationRequested ? "cancelled"
    : ended.signal !== null ? "interrupted"
    : ended.code === 0 ? "completed"
    : "failed";

  const result = AgentProcessResult.parse({
    status,
    pid: child.pid ?? null,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    exitCode: ended.code,
    signal: ended.signal,
    launchFailure: null,
    detail:
      timedOut ? "the agent exceeded its time budget and was terminated"
      : status === "interrupted" ? `terminated by ${ended.signal} without an orchestrator request`
      : null,
    forciblyKilled: state.forciblyKilled,
  });

  const text = stdout.text();
  const claimedReport = parseClaimedReport(text);

  const output = AgentOutputSummary.parse({
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    truncated: stdout.truncated || stderr.truncated,
    stdoutHash: stdout.bytes > 0 ? crypto.createHash("sha256").update(text).digest("hex") : null,
    excerpt: config.retainOutputExcerpt ? text.slice(-config.excerptBytes) : null,
    structuredReportPresent: claimedReport !== null,
  });

  return { result, output, claimedReport };
}

function launchFailure(
  failure: AgentLaunchFailure,
  detail: string,
  startedAt: Date,
  now: () => Date,
): AgentProcessOutcome {
  return {
    result: AgentProcessResult.parse({
      status: "launch_failed",
      pid: null,
      startedAt: startedAt.toISOString(),
      endedAt: now().toISOString(),
      durationMs: 0,
      exitCode: null,
      signal: null,
      launchFailure: failure,
      detail,
      forciblyKilled: false,
    }),
    output: AgentOutputSummary.parse({}),
    claimedReport: null,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Capture output up to a cap, then count and discard.
 *
 * A verbose or hostile agent must not be able to exhaust memory, and the
 * orchestrator must still be able to say how much it produced.
 */
class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  bytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.captured >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.captured;
    const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
    if (slice.byteLength < chunk.byteLength) this.truncated = true;
    this.chunks.push(slice);
    this.captured += slice.byteLength;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Look for a structured report the agent printed.
 *
 * Parsing it is a convenience, not an endorsement: the result is labelled
 * `claimedReport` and travels only into the claimed side of the record. A
 * malformed or absent report is normal and yields null rather than an error -
 * an untrusted program is under no obligation to speak our protocol.
 */
export function parseClaimedReport(
  text: string,
): { summary?: string; files?: string[]; claimsSuccess?: boolean } | null {
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    const index = line.indexOf(REPORT_MARKER);
    if (index === -1) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(index + REPORT_MARKER.length).trim());
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      return {
        summary: typeof record["summary"] === "string" ? record["summary"] : undefined,
        files: Array.isArray(record["files"])
          ? record["files"].filter((f): f is string => typeof f === "string")
          : undefined,
        claimsSuccess:
          typeof record["claimsSuccess"] === "boolean" ? record["claimsSuccess"] : undefined,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export { REPORT_MARKER };
