import { z } from "zod";
import { Capability } from "./capability.js";
import { DenialReason } from "./denial.js";
import { AgentProcessStatus, AgentLaunchFailure } from "./agentProcess.js";

/**
 * THE ACTIVITY JOURNAL
 *
 * Phase 3 gave the orchestrator two kinds of knowledge:
 *
 *   STATE        what the repository looks like now
 *   ATTRIBUTION  which of those differences this run caused
 *
 * Both are reconstructions after the fact. Neither can say what was ATTEMPTED -
 * a write that was denied leaves no trace in the repository at all, and a write
 * that succeeded looks identical to one a human made.
 *
 * The activity journal is the third kind: what the orchestrator DID and REFUSED,
 * recorded as it happened.
 *
 * ---------------------------------------------------------------------------
 * WHO WRITES THIS
 * ---------------------------------------------------------------------------
 * The orchestrator, from inside the capability check - never the agent. An agent
 * cannot append to it, suppress an entry, or describe its own behaviour here.
 * Every denial below is emitted by the code that performed the denial.
 *
 * It is EVIDENCE, NOT PROOF OF OUTCOME. A `write_completed` entry means the
 * orchestrator wrote bytes; whether the repository ended up in the intended
 * state is still established by inspecting the repository. The journal
 * supplements Phase 3 attribution; it does not replace it.
 *
 * ---------------------------------------------------------------------------
 * NO CONTENT, EVER
 * ---------------------------------------------------------------------------
 * These records are appended to an unencrypted file that outlives the run. So
 * they carry METADATA ONLY: path, capability, byte count, outcome, category.
 *
 * No file contents. No diffs. No environment. No command output. No error
 * buffers. `byteCount` and `contentHash` describe a payload without disclosing
 * it - and for a path the sensitive-file policy covers, even the hash is
 * omitted, because a digest of a low-entropy secret can be attacked by guessing.
 */

/** Coarse failure categories. Deliberately not free-form error text. */
export const ActivityErrorCategory = z.enum([
  "denied",
  "not_found",
  "boundary_violation",
  "limit_exceeded",
  "io_error",
  "cancelled",
  "agent_error",
  "internal_error",
]);
export type ActivityErrorCategory = z.infer<typeof ActivityErrorCategory>;

const base = {
  /** Correlates every record of one implementation run. */
  runId: z.string().min(1),
  projectId: z.string().min(1),
  /** The grant in force. Null before one exists. */
  grantId: z.string().nullable().default(null),
  /** Correlates a single logical operation across attempt/outcome records. */
  correlationId: z.string().min(1),
  at: z.string().datetime(),
};

/**
 * A path plus a NON-DISCLOSING description of the payload.
 *
 * `contentHash` is present only for non-sensitive paths. See the header.
 */
const payload = {
  path: z.string(),
  byteCount: z.number().int().nonnegative().default(0),
  contentHash: z.string().nullable().default(null),
  sensitive: z.boolean().default(false),
};

export const ActivityRecord = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("implementation_started"),
    ...base,
    agent: z.string(),
    capabilities: z.array(Capability).default([]),
    allowedScope: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("capability_granted"),
    ...base,
    capability: Capability,
    path: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("capability_denied"),
    ...base,
    capability: Capability,
    path: z.string().nullable().default(null),
    reason: DenialReason,
    detail: z.string(),
  }),
  z.object({
    type: z.literal("tool_invoked"),
    ...base,
    tool: z.string(),
    capability: Capability,
    path: z.string().nullable().default(null),
  }),

  z.object({ type: z.literal("write_attempted"), ...base, ...payload }),
  z.object({
    type: z.literal("write_completed"),
    ...base,
    ...payload,
    created: z.boolean().default(false),
    atomic: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("write_denied"),
    ...base,
    path: z.string(),
    reason: DenialReason,
    detail: z.string(),
  }),

  z.object({ type: z.literal("delete_attempted"), ...base, path: z.string() }),
  z.object({ type: z.literal("delete_completed"), ...base, path: z.string() }),
  z.object({
    type: z.literal("delete_denied"),
    ...base,
    path: z.string(),
    reason: DenialReason,
    detail: z.string(),
  }),

  z.object({ type: z.literal("implementation_cancel_requested"), ...base, requestedBy: z.string() }),
  z.object({ type: z.literal("implementation_cancelled"), ...base, writesBefore: z.number().int().nonnegative().default(0) }),
  z.object({
    type: z.literal("implementation_failed"),
    ...base,
    category: ActivityErrorCategory,
    /** A short, non-disclosing message. Never a buffer, never file content. */
    detail: z.string(),
  }),
  z.object({
    type: z.literal("implementation_finished"),
    ...base,
    writes: z.number().int().nonnegative().default(0),
    deletes: z.number().int().nonnegative().default(0),
    denials: z.number().int().nonnegative().default(0),
  }),

  z.object({ type: z.literal("verification_started"), ...base }),
  z.object({
    type: z.literal("verification_completed"),
    ...base,
    verifiedIndependently: z.boolean(),
    attributableFiles: z.number().int().nonnegative().default(0),
    scopeDrift: z.number().int().nonnegative().default(0),
  }),

  /**
   * The grant was claimed for this attempt and is now permanently unusable.
   *
   * Metadata only: which grant, when, and by which process. Written by the
   * orchestrator at the moment of the atomic claim - an agent has no way to
   * forge it, suppress it, or delete it.
   */
  z.object({
    type: z.literal("grant_consumed"),
    ...base,
    claimedByPid: z.number().int().nonnegative(),
    claimedByHost: z.string(),
  }),
  z.object({
    type: z.literal("grant_reuse_denied"),
    ...base,
    reason: DenialReason,
    detail: z.string(),
  }),
  /**
   * AGENT PROCESS BOUNDARY (Phase 4B.1).
   *
   * Metadata only, and deliberately so: an agent authors its own stdout, so
   * none of it appears here. What is recorded came from the operating system -
   * a pid, an exit code, a signal - or from the orchestrator's own decisions.
   */
  z.object({
    type: z.literal("agent_launch_attempted"),
    ...base,
    agent: z.string(),
    /** Basename only. The full path is orchestrator configuration. */
    executable: z.string(),
  }),
  z.object({
    type: z.literal("agent_started"),
    ...base,
    agent: z.string(),
    pid: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("agent_exited"),
    ...base,
    agent: z.string(),
    status: AgentProcessStatus,
    exitCode: z.number().int().nullable().default(null),
    signal: z.string().nullable().default(null),
    durationMs: z.number().int().nonnegative().default(0),
    /** Byte counts describe the output without reproducing any of it. */
    stdoutBytes: z.number().int().nonnegative().default(0),
    stderrBytes: z.number().int().nonnegative().default(0),
    outputTruncated: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("agent_launch_failed"),
    ...base,
    agent: z.string(),
    failure: AgentLaunchFailure,
    /** Adapter-authored. Never an agent message or an OS error buffer. */
    detail: z.string(),
  }),
  z.object({
    type: z.literal("agent_termination_requested"),
    ...base,
    agent: z.string(),
    pid: z.number().int().nonnegative().nullable().default(null),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("agent_terminated"),
    ...base,
    agent: z.string(),
    status: AgentProcessStatus,
    /** True when SIGTERM was ignored and the process had to be killed. */
    forciblyKilled: z.boolean().default(false),
  }),
  /**
   * CONTROLLED TOOL BRIDGE (Phase 4B.2).
   *
   * Written by the orchestrator inside the bridge, never by the agent. The path
   * recorded is the repository-relative one the SESSION resolved - never an
   * absolute host path - and no file content, argument value or protocol
   * payload appears here.
   */
  z.object({
    type: z.literal("bridge_request_completed"),
    ...base,
    requestId: z.string().max(128),
    tool: z.string(),
    capability: z.string(),
    path: z.string().max(512),
    ok: z.boolean(),
    denial: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("bridge_request_rejected"),
    ...base,
    requestId: z.string().max(128),
    /** A closed-vocabulary code. Never an exception message. */
    code: z.string(),
  }),
  z.object({ type: z.literal("lock_acquired"), ...base, holder: z.string() }),
  z.object({ type: z.literal("lock_released"), ...base }),
  z.object({
    type: z.literal("lock_denied"),
    ...base,
    heldByRun: z.string(),
    detail: z.string(),
  }),
]);
export type ActivityRecord = z.infer<typeof ActivityRecord>;

export type ActivityType = ActivityRecord["type"];
