import { spawn } from "node:child_process";
import path from "node:path";
import {
  VerificationCheckResult, CHECK_CEILINGS,
  type VerificationCheck as TVerificationCheck,
  type VerificationCheckResult as TVerificationCheckResult,
  type VerificationExecutableIdentity as TIdentity,
  type CheckBlockReason,
} from "../domain/verificationCheck.js";
import { BASE_ENV_PASSTHROUGH } from "../adapters/claude-code/config.js";
import { FsBoundary } from "../security/fsBoundary.js";
import { PathEscapeError } from "../persistence/paths.js";
import { verifyExecutableIdentity } from "./checkPolicy.js";

/**
 * THE CONTROLLED CHECK RUNNER
 *
 * Runs one predefined verification check and reports what the operating system
 * said about it. It is the narrowest process-execution surface that can answer
 * "did the tests pass", and every property below exists to keep it narrow.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * NOT A SANDBOX. A check runs with the orchestrator user's privileges and can
 * do anything that user can do - write files, delete them, invoke git, open a
 * socket. Nothing here prevents that.
 *
 * What this provides is CONTROL OVER WHAT IS LAUNCHED - a fixed executable and
 * a fixed argv from configuration captured before the untrusted run - plus
 * independent inspection of what the repository looks like afterwards. Those
 * are different guarantees from containment, and the difference is the honest
 * description of this phase.
 */

export interface CheckRunOptions {
  /** Absolute project working directory. The containment root. */
  workingDir: string;
  /**
   * What this executable WAS before the untrusted implementation ran.
   *
   * Required in practice: when it is absent the check is blocked rather than
   * run, because an executable with no trusted identity cannot be confirmed as
   * the program that was approved.
   */
  expectedIdentity?: TIdentity;
  /** Aborts the check. Wired to the run's existing cancellation. */
  signal?: AbortSignal;
  /** Remaining wall-clock budget for the whole check phase. */
  remainingBudgetMs?: number;
  now?: () => Date;
}

/** Bounded capture: keeps a tail, counts everything, never grows without limit. */
class BoundedStream {
  #bytes = 0;
  #kept: Buffer[] = [];
  #keptBytes = 0;
  #truncated = false;

  constructor(private readonly maxKeptBytes: number) {}

  append(chunk: Buffer): void {
    this.#bytes += chunk.length;
    this.#kept.push(chunk);
    this.#keptBytes += chunk.length;
    // Keep a TAIL rather than a head: the end of a failing test run is where
    // the failure is, and the beginning is usually a banner.
    while (this.#keptBytes > this.maxKeptBytes && this.#kept.length > 1) {
      const dropped = this.#kept.shift()!;
      this.#keptBytes -= dropped.length;
      this.#truncated = true;
    }
    if (this.#keptBytes > this.maxKeptBytes) {
      const only = this.#kept[0]!;
      this.#kept = [only.subarray(only.length - this.maxKeptBytes)];
      this.#keptBytes = this.maxKeptBytes;
      this.#truncated = true;
    }
  }

  get bytes(): number { return this.#bytes; }
  get truncated(): boolean { return this.#truncated; }

  excerpt(limit: number): string {
    const joined = Buffer.concat(this.#kept);
    const slice = joined.subarray(Math.max(0, joined.length - limit));
    // Control characters are stripped: check output is project-controlled text
    // that lands in a terminal report, where escape sequences can rewrite what
    // a human sees. A reviewer reading a forged line is a real risk.
    //
    // Filtered by code point rather than by regex on purpose - a character
    // class of raw control bytes is exactly the kind of source a tool or a
    // merge quietly mangles, and it would fail open.
    let text = "";
    for (const ch of slice.toString("utf8")) {
      const code = ch.codePointAt(0) ?? 0;
      const printable = code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f);
      if (printable) text += ch;
    }
    return text;
  }
}

/**
 * Build the child environment.
 *
 * Reuses `BASE_ENV_PASSTHROUGH` from the Claude Code boundary rather than
 * defining a second list. Two environment policies would eventually disagree,
 * and the disagreement would be the vulnerability - so there is one list, and
 * widening it is a reviewable edit to that file.
 *
 * No allowlist parameter is accepted. The agent boundary has one because an
 * operator may need to authenticate a real agent; a verification check has no
 * such need, so the hole simply does not exist here.
 */
export function buildCheckEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASE_ENV_PASSTHROUGH) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  // Non-interactive, no colour, no pager, no prompting. A check that waits for
  // input would otherwise burn its entire timeout doing nothing.
  env["CI"] = "1";
  env["TERM"] = "dumb";
  env["NO_COLOR"] = "1";
  env["FORCE_COLOR"] = "0";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_PAGER"] = "cat";
  env["npm_config_yes"] = "true";
  env["npm_config_audit"] = "false";
  env["npm_config_fund"] = "false";
  return env;
}

function blocked(
  check: TVerificationCheck,
  reason: CheckBlockReason,
  detail: string,
  digests: { expected?: string | null; observed?: string | null } = {},
): TVerificationCheckResult {
  return VerificationCheckResult.parse({
    checkId: check.id, name: check.name, status: "blocked",
    blockedReason: reason, detail,
    expectedSha256: digests.expected ?? null,
    observedSha256: digests.observed ?? null,
  });
}

/**
 * Resolve the check's working directory inside the project boundary.
 *
 * Goes through the same `FsBoundary` as every other path in the system, which
 * is what rejects `..`, absolute paths, and symlink or junction escapes - by
 * `realpath`, so a link created after configuration was written is caught at
 * use rather than at definition.
 */
export function resolveCheckCwd(
  workingDir: string,
  cwd: string,
): { ok: true; path: string } | { ok: false; detail: string } {
  if (path.isAbsolute(cwd)) {
    return {
      ok: false,
      detail: "a check working directory must be relative to the project root",
    };
  }
  try {
    const boundary = FsBoundary.create(workingDir);
    return { ok: true, path: boundary.resolve(cwd).absolute };
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return { ok: false, detail: "the working directory resolves outside the project boundary" };
    }
    return { ok: false, detail: "the working directory could not be resolved" };
  }
}

export class ControlledCheckRunner {
  /** True: unlike the Phase 4B stub, this runner really executes. */
  readonly enabled = true;

  async run(
    check: TVerificationCheck,
    options: CheckRunOptions,
  ): Promise<TVerificationCheckResult> {
    const now = options.now ?? (() => new Date());

    if (!check.enabled) {
      return blocked(check, "check_disabled", "this check is disabled in project configuration");
    }
    if (options.signal?.aborted) {
      return blocked(check, "cancelled_before_start", "the run was cancelled before this check started");
    }

    const cwd = resolveCheckCwd(options.workingDir, check.cwd);
    if (!cwd.ok) return blocked(check, "working_directory_escape", cwd.detail);

    /**
     * EXECUTABLE INTEGRITY - THE LAST THING BEFORE `spawn`.
     *
     * Deliberately placed here, after every other precondition and immediately
     * before launch, so the window between "we confirmed which program this is"
     * and "the operating system starts it" is as small as this process can make
     * it.
     *
     * It replaces a bare existence check, which established only that SOMETHING
     * was at the path. The policy fingerprint cannot cover this: an agent that
     * rewrites the file while leaving the definition alone changes no
     * definition at all, so the fingerprint stays identical and only the
     * content digest moves.
     *
     * See docs/PHASE-005.md - this detects replacement across the
     * implementation interval. It is NOT an atomic open-and-execute guarantee.
     */
    const integrity = verifyExecutableIdentity(check.executable, options.expectedIdentity);
    if (!integrity.ok) {
      return blocked(check, integrity.reason, integrity.detail, {
        expected: integrity.expected, observed: integrity.observed,
      });
    }

    // The effective deadline is the SMALLER of the check's own timeout and what
    // is left of the whole phase's budget, so a long check cannot consume a
    // budget that later checks still need.
    const budget = options.remainingBudgetMs ?? CHECK_CEILINGS.maxTotalDurationMs;
    if (budget <= 0) {
      return blocked(check, "run_budget_exhausted", "the verification time budget was already spent");
    }
    const timeoutMs = Math.min(check.timeoutMs, CHECK_CEILINGS.maxTimeoutMs, budget);

    const startedAt = now();
    const started = Date.now();
    const stdout = new BoundedStream(CHECK_CEILINGS.maxOutputBytesPerStream);
    const stderr = new BoundedStream(CHECK_CEILINGS.maxOutputBytesPerStream);

    return await new Promise<TVerificationCheckResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;

      const child = spawn(check.executable, check.args, {
        cwd: cwd.path,
        env: buildCheckEnvironment(),
        // NEVER true. With a shell, every argument becomes shell source and the
        // argv array stops being a boundary at all.
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const finish = (result: TVerificationCheckResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const settleFrom = (
        status: TVerificationCheckResult["status"],
        exitCode: number | null,
        signalName: string | null,
        detail: string | null,
      ): void => {
        finish(VerificationCheckResult.parse({
          checkId: check.id,
          name: check.name,
          status,
          exitCode,
          signal: signalName,
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          outputTruncated: stdout.truncated || stderr.truncated,
          outputExcerpt: [
            stdout.excerpt(CHECK_CEILINGS.maxExcerptBytes / 2),
            stderr.excerpt(CHECK_CEILINGS.maxExcerptBytes / 2),
          ].filter(Boolean).join("\n").slice(0, CHECK_CEILINGS.maxExcerptBytes),
          detail,
          startedAt: startedAt.toISOString(),
          endedAt: now().toISOString(),
        }));
      };

      const stop = (): void => {
        // Best effort. See the descendant-process limitation in docs/PHASE-005.md:
        // killing the launched process does not guarantee its children die.
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2_000).unref();
      };

      const deadline = setTimeout(() => {
        timedOut = true;
        stop();
        settleFrom("timed_out", null, null, `exceeded its ${timeoutMs}ms limit`);
      }, timeoutMs);

      const onAbort = (): void => {
        cancelled = true;
        stop();
        settleFrom("cancelled", null, null, "the run was cancelled");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

      child.on("error", (error) => {
        // The process never ran: missing executable, permission refused, spawn
        // failure. Explicitly NOT `failed` - the code is not what went wrong.
        settleFrom("error", null, null, `could not start: ${errorName(error)}`);
      });

      child.on("close", (code, signalName) => {
        if (timedOut || cancelled) return; // already settled with the real reason
        // The ONLY place a check becomes `passed`, and it takes an exit code of
        // zero from a real process to get there.
        settleFrom(
          code === 0 ? "passed" : "failed",
          code,
          signalName ?? null,
          code === 0 ? null : `exited ${String(code)}`,
        );
      });
    });
  }
}

function errorName(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown error";
}
