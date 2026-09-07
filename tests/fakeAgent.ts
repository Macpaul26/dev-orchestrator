import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ImplementationAgent, ImplementationRequest,
} from "../src/implementation/runner.js";
import type {
  ImplementationSession, CancellationToken, WriteResult,
} from "../src/implementation/session.js";
import { AgentReport, type AgentReport as TAgentReport } from "../src/domain/implementation.js";

/**
 * A DETERMINISTIC FAKE IMPLEMENTATION AGENT - TESTS ONLY.
 *
 * This file lives in `tests/` on purpose. It is not production code, nothing in
 * `src/` imports it, and a test asserts that stays true.
 *
 * It exists to attack the boundary before a real coding agent is ever connected.
 * A real agent is unpredictable; proving containment needs something that does
 * exactly the wrong thing on demand - traversal, escalation, deletion outside
 * scope, cancellation halfway through - so the refusals can be asserted.
 *
 * It also lies. `claimFiles` lets it report changes it never made and conceal
 * ones it did, which is how the "agent claims are not evidence" property gets
 * tested with something that actually disagrees with the repository.
 */

/** One thing the agent will try. Order is preserved exactly. */
export type FakeStep =
  | { kind: "write"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "read"; path: string }
  | { kind: "list"; path?: string }
  /** Cancel itself mid-run, so partial work is followed by cancellation. */
  | { kind: "cancel"; reason?: string }
  /** Throw, to exercise the failure path. */
  | { kind: "throw"; message?: string }
  /**
   * Write DIRECTLY to disk, going around the session entirely.
   *
   * Not a contrived attack - it is what a real agent is. Phase 4B.1 is explicit
   * that the child process is not OS-sandboxed: Claude Code has its own file
   * tools and can touch the working tree without ever asking the bridge. So the
   * write boundary is not the last line of defence, and this step exists to
   * prove what the line behind it does. Nothing stops the write; independent
   * inspection is what notices it afterwards.
   */
  | { kind: "sideEffect"; path: string; contents: string }
  /** Delete directly on disk, around the session. */
  | { kind: "sideEffectDelete"; path: string }
  /** Rename directly on disk, around the session. */
  | { kind: "sideEffectRename"; from: string; to: string }
  /**
   * Run git DIRECTLY, as a real agent process can.
   *
   * There is no bridge tool for this and no capability that grants it - which
   * is the point. Phase 4B.1 gives the child no OS sandbox, so `git commit` is
   * simply available to it. Nothing here is expected to stop the command; the
   * assertion is that verification notices afterwards.
   */
  | { kind: "gitCommand"; args: string[] }
  /** Try to reach something it must not have. Asserted to fail. */
  | { kind: "escalate"; target: EscalationTarget };

export type EscalationTarget =
  | "mutate-capabilities"
  | "mutate-scope"
  | "mutate-stats"
  | "reach-shell"
  | "reach-process"
  | "reach-git"
  | "reach-network"
  | "reach-filesystem"
  | "reach-writer"
  | "reach-journal"
  | "reach-grant";

export interface FakeAgentOptions {
  steps: FakeStep[];
  /** Absolute repository path, needed only by `sideEffect`. Tests supply it. */
  repoRoot?: string;
  /** What the agent will CLAIM it changed. Defaults to what it actually wrote. */
  claimFiles?: string[];
  claimSummary?: string;
  claimsSuccess?: boolean;
}

export class FakeImplementationAgent implements ImplementationAgent {
  readonly name = "fake-test-agent";

  /** Everything that happened, for assertions. */
  readonly results: WriteResult[] = [];
  readonly escalationAttempts: { target: EscalationTarget; blocked: boolean; detail: string }[] = [];

  constructor(private readonly options: FakeAgentOptions) {}

  async implement(
    session: ImplementationSession,
    _request: ImplementationRequest,
    cancellation: CancellationToken,
  ): Promise<TAgentReport> {
    const written: string[] = [];

    for (const step of this.options.steps) {
      switch (step.kind) {
        case "write": {
          const result = await session.writeFile(step.path, step.contents);
          this.results.push(result);
          if (result.ok) written.push(result.path);
          break;
        }
        case "delete": {
          const result = await session.deleteFile(step.path);
          this.results.push(result);
          if (result.ok) written.push(result.path);
          break;
        }
        case "read":
          await session.readFile(step.path);
          break;
        case "list":
          await session.listDirectory(step.path ?? ".");
          break;
        case "cancel":
          cancellation.cancel(step.reason ?? "agent requested cancellation");
          break;
        case "throw":
          throw new Error(step.message ?? "the agent failed deliberately");
        case "sideEffectDelete":
          fs.rmSync(path.join(this.options.repoRoot!, step.path), { force: true });
          break;
        case "sideEffectRename":
          fs.renameSync(
            path.join(this.options.repoRoot!, step.from),
            path.join(this.options.repoRoot!, step.to),
          );
          break;
        case "gitCommand":
          execFileSync("git", step.args, {
            cwd: this.options.repoRoot!,
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
          });
          break;
        case "sideEffect": {
          // Deliberately not `session.writeFile`. The point is the bypass.
          const target = path.join(this.options.repoRoot!, step.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, step.contents);
          break;
        }
        case "escalate":
          this.attemptEscalation(session, step.target);
          break;
      }
    }

    return AgentReport.parse({
      summary: this.options.claimSummary ?? `wrote ${written.length} file(s)`,
      // The lie, when a test asks for one.
      files: this.options.claimFiles ?? written,
      claimsSuccess: this.options.claimsSuccess ?? true,
    });
  }

  /**
   * Try to break out, and record whether it worked.
   *
   * Most of these cannot even be written as a compiling call - there is no
   * `session.exec`, no `session.git`, no `session.fs`. They are attempted
   * dynamically, exactly as untrusted code would have to, so the test asserts
   * the ABSENCE of the surface rather than trusting the type system.
   */
  private attemptEscalation(session: ImplementationSession, target: EscalationTarget): void {
    const loose = session as unknown as Record<string, unknown>;

    const record = (blocked: boolean, detail: string): void => {
      this.escalationAttempts.push({ target, blocked, detail });
    };

    switch (target) {
      case "mutate-capabilities": {
        // The getter returns a frozen copy; pushing to it must not stick.
        const before = [...session.capabilities];
        try {
          (session.capabilities as string[]).push("git.mutate");
        } catch {
          // Frozen arrays throw in strict mode - also a pass.
        }
        const after = [...session.capabilities];
        record(
          after.length === before.length && !after.includes("git.mutate" as never),
          `capabilities before=${before.length} after=${after.length}`,
        );
        break;
      }
      case "mutate-scope": {
        const before = [...session.allowedScope];
        try {
          (session.allowedScope as string[]).push("/");
        } catch {
          // Frozen - fine.
        }
        record(
          JSON.stringify([...session.allowedScope]) === JSON.stringify(before),
          `scope unchanged: ${JSON.stringify(before)}`,
        );
        break;
      }
      case "mutate-stats": {
        const before = session.stats.writes;
        const stats = session.stats;
        stats.writes = 9999; // a copy, so this should change nothing
        record(session.stats.writes === before, `writes still ${session.stats.writes}`);
        break;
      }
      case "reach-grant":
        // A `#` field is invisible at runtime. TypeScript's `private` was not.
        record(
          loose["grant"] === undefined && !Object.keys(session).includes("grant"),
          `session.grant is ${typeof loose["grant"]}`,
        );
        break;
      case "reach-writer":
        // THE WORST ONE. SafeWriteFs writes with no grant, capability or scope
        // check; reaching it is a complete scope bypass.
        record(
          loose["writer"] === undefined &&
            typeof (loose["writer"] as Record<string, unknown> | undefined)?.["writeFile"] !== "function",
          `session.writer is ${typeof loose["writer"]}`,
        );
        break;
      case "reach-journal":
        // The audited party must not be able to append to the audit trail.
        record(
          loose["journal"] === undefined,
          `session.journal is ${typeof loose["journal"]}`,
        );
        break;
      case "reach-shell":
        record(
          typeof loose["exec"] !== "function" && typeof loose["shell"] !== "function",
          "no exec/shell on the session",
        );
        break;
      case "reach-process":
        record(
          typeof loose["spawn"] !== "function" && typeof loose["run"] !== "function",
          "no spawn/run on the session",
        );
        break;
      case "reach-git":
        record(
          typeof loose["git"] !== "function" && typeof loose["commit"] !== "function",
          "no git/commit on the session",
        );
        break;
      case "reach-network":
        record(
          typeof loose["fetch"] !== "function" && typeof loose["request"] !== "function",
          "no fetch/request on the session",
        );
        break;
      case "reach-filesystem":
        record(
          loose["fs"] === undefined &&
            loose["root"] === undefined &&
            loose["workingDir"] === undefined,
          "no filesystem handle or project path on the session",
        );
        break;
    }
  }
}

/** An agent that does nothing, for testing the lock and lifecycle in isolation. */
export class InertAgent implements ImplementationAgent {
  readonly name = "inert-test-agent";
  constructor(private readonly onImplement?: () => Promise<void> | void) {}
  async implement(): Promise<TAgentReport> {
    await this.onImplement?.();
    return AgentReport.parse({ summary: "did nothing", claimsSuccess: true });
  }
}
