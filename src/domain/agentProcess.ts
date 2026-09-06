import { z } from "zod";

/**
 * THE AGENT PROCESS LIFECYCLE
 *
 * What the orchestrator OBSERVED about a child process it launched: whether it
 * started, how it ended, what the operating system said about it.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONLY PART OF AN AGENT RUN THAT IS NOT A CLAIM
 * ---------------------------------------------------------------------------
 * Everything the agent SAYS - stdout, stderr, a structured report, "I changed
 * three files", "the tests passed" - is narrative produced by an untrusted
 * program. None of it is evidence.
 *
 * What IS evidence is this: a pid the OS gave us, an exit code the OS reported,
 * a signal that terminated it, timestamps we took ourselves. Those facts came
 * from the kernel, not from the agent, which is why they live in a separate type
 * from `AgentReport` and are never merged with it.
 *
 * Even so, they are evidence about the PROCESS, not about the REPOSITORY.
 * `exitCode: 0` means the program returned zero. It does not mean the work was
 * done, done correctly, or done within scope. Only inspecting the repository
 * establishes that.
 */

export const AgentProcessStatus = z.enum([
  /** Constructed, not yet spawned. */
  "started",
  /** Spawned and alive. */
  "running",
  /** Exited with code 0. */
  "completed",
  /** Exited non-zero. */
  "failed",
  /** Terminated because the orchestrator asked it to stop. */
  "cancelled",
  /** Died on a signal we did not send, or vanished. */
  "interrupted",
  /** Never started: executable missing, not permitted, spawn refused. */
  "launch_failed",
]);
export type AgentProcessStatus = z.infer<typeof AgentProcessStatus>;

/** Why the adapter itself refused or failed, distinct from the agent failing. */
export const AgentLaunchFailure = z.enum([
  "not_configured",
  "executable_missing",
  "executable_not_a_file",
  "executable_not_absolute",
  "working_dir_invalid",
  "working_dir_unsafe",
  "spawn_error",
  "timed_out",
]);
export type AgentLaunchFailure = z.infer<typeof AgentLaunchFailure>;

/**
 * The observed outcome of one agent process.
 *
 * Note what is NOT here: stdout, stderr, or any agent text. Output is handled
 * separately and deliberately - see `AgentOutputSummary` - so that nothing which
 * ends up in a durable record can be authored by the agent.
 */
export const AgentProcessResult = z.object({
  status: AgentProcessStatus,
  /** Assigned by the OS. Null when the process never started. */
  pid: z.number().int().nonnegative().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  endedAt: z.string().datetime().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  /** From the OS. Null when killed by a signal or never started. */
  exitCode: z.number().int().nullable().default(null),
  /** From the OS, e.g. "SIGTERM". Null when it exited normally. */
  signal: z.string().nullable().default(null),
  /** Set only when the ADAPTER failed, not when the agent did. */
  launchFailure: AgentLaunchFailure.nullable().default(null),
  /** Short, adapter-authored. Never agent text, never an OS error buffer. */
  detail: z.string().nullable().default(null),
  /** True when the orchestrator had to escalate to a forced kill. */
  forciblyKilled: z.boolean().default(false),
});
export type AgentProcessResult = z.infer<typeof AgentProcessResult>;

/**
 * What the agent WROTE, described without reproducing it.
 *
 * Byte counts and a hash are facts about a payload that disclose nothing about
 * its contents. They let a human see that the agent was verbose, or silent, or
 * that two runs produced identical output, without any agent-authored text
 * entering a checkpoint or an audit record.
 *
 * `excerpt` is null unless an operator explicitly opted in. See
 * `ClaudeCodeConfig.retainOutputExcerpt` for why the default is off.
 */
export const AgentOutputSummary = z.object({
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
  /** True when output exceeded the cap and was discarded from that point. */
  truncated: z.boolean().default(false),
  stdoutHash: z.string().nullable().default(null),
  /** Opt-in, bounded, and UNTRUSTED AGENT TEXT wherever it appears. */
  excerpt: z.string().nullable().default(null),
  /** True when the agent emitted a parseable structured report. Still a claim. */
  structuredReportPresent: z.boolean().default(false),
});
export type AgentOutputSummary = z.infer<typeof AgentOutputSummary>;

export function isTerminalProcessStatus(status: AgentProcessStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted", "launch_failed"].includes(status);
}
