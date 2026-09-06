import { z } from "zod";
import { DenialReason } from "./denial.js";

/**
 * THE CONTROLLED TOOL PROTOCOL
 *
 * The complete vocabulary an untrusted agent may use to touch a repository.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN THIS FILE IS THE POINT
 * ---------------------------------------------------------------------------
 * There is no `execute`, no `command`, no `shell`, no `run`, no `git`, no
 * `fetch`. Not disabled somewhere else - ABSENT. A request naming one of them
 * fails schema validation before any authorisation code runs, because the enum
 * below is the closed set of things that can be asked for at all.
 *
 * ---------------------------------------------------------------------------
 * AUTHORITY IS STRUCTURALLY UNREPRESENTABLE
 * ---------------------------------------------------------------------------
 * A `ToolRequest` has no field for `grantId`, `projectId`, `runId`, `sessionId`,
 * `allowedScope`, `capabilities`, `workingDir` or a budget - and every object
 * here is `.strict()`, so sending one is a parse error rather than an ignored
 * key.
 *
 * That is deliberate. If the agent could NAME a grant, the whole system would
 * depend on somebody remembering never to trust the name. Instead the bridge
 * holds exactly one trusted session, and the request can only say WHAT to do,
 * never WHOSE authority to do it under.
 *
 * The agent may ask "read src/foo.ts". It cannot ask "read src/foo.ts using
 * grant X in project Y".
 */

/** The closed set of operations. Adding one is a security decision. */
export const ToolName = z.enum([
  "read_file",
  "list_directory",
  "write_file",
  "delete_file",
]);
export type ToolName = z.infer<typeof ToolName>;

/**
 * Protocol limits, enforced before any handler runs.
 *
 * A hostile child controls how much it writes down a pipe, so every bound here
 * exists to stop it consuming memory rather than to be tidy. `maxRequestBytes`
 * is enforced by the framing layer on a per-line basis: a child that never
 * sends a newline must not be able to buffer indefinitely.
 */
export const PROTOCOL_LIMITS = {
  /** One protocol line. Beyond this the transport aborts rather than buffers. */
  maxRequestBytes: 1024 * 1024,
  maxPathLength: 4096,
  /** Ceiling on `write_file` content. The GRANT's limit is separate and lower. */
  maxContentBytes: 1024 * 1024,
  maxRequestIdLength: 128,
  /** Requests one session may make. Stops an agent looping forever. */
  maxRequestsPerSession: 10_000,
  /** Bytes returned for one `read_file`. */
  maxReadBytes: 256 * 1024,
  /** Entries returned for one `list_directory`. */
  maxListEntries: 500,
} as const;

const RequestId = z.string().min(1).max(PROTOCOL_LIMITS.maxRequestIdLength);
const RepoPath = z.string().min(1).max(PROTOCOL_LIMITS.maxPathLength);

/**
 * Per-tool arguments. Each is `.strict()`, so an unexpected key is refused.
 *
 * Note `write_file` takes `path` and `contents` and nothing else: no encoding,
 * no mode, no flags, no `followSymlinks`. Every one of those would be a knob an
 * untrusted caller could turn, and none of them is needed.
 */
export const ToolArguments = {
  read_file: z.object({ path: RepoPath }).strict(),
  list_directory: z.object({ path: RepoPath.default(".") }).strict(),
  write_file: z
    .object({
      path: RepoPath,
      contents: z.string().max(PROTOCOL_LIMITS.maxContentBytes),
    })
    .strict(),
  delete_file: z.object({ path: RepoPath }).strict(),
} as const;

export const ToolRequest = z
  .object({
    /** Correlates a response. Agent-chosen, and used for nothing else. */
    requestId: RequestId,
    tool: ToolName,
    /** Validated against the per-tool schema after the tool is known. */
    arguments: z.unknown().default({}),
  })
  .strict();
export type ToolRequest = z.infer<typeof ToolRequest>;

/** Why the bridge refused, at the protocol layer rather than the policy layer. */
export const ProtocolErrorCode = z.enum([
  "malformed_json",
  "invalid_request",
  "unknown_tool",
  "invalid_arguments",
  "duplicate_request_id",
  "request_too_large",
  "too_many_requests",
  "session_closed",
  "cancelled",
]);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>;

/**
 * A refusal reason is EITHER a protocol fault OR a policy denial.
 *
 * Kept as one union so a caller cannot conflate "you asked wrongly" with "you
 * asked for something you are not allowed to have" - and so every refusal that
 * reaches the agent is drawn from a closed vocabulary rather than from an
 * exception message that might carry a path or a buffer.
 */
export const ToolErrorCode = z.union([ProtocolErrorCode, DenialReason]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

/** Results, deliberately narrow. Nothing here reveals a host path. */
export const ReadFileResult = z.object({
  kind: z.literal("read_file"),
  path: z.string(),
  available: z.boolean(),
  /** Null when withheld: sensitive, too large, binary, or absent. */
  contents: z.string().nullable().default(null),
  bytes: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
  withheldReason: z.string().nullable().default(null),
});

export const ListDirectoryResult = z.object({
  kind: z.literal("list_directory"),
  path: z.string(),
  entries: z.array(
    z.object({
      /** Repository-relative. Never an absolute host path. */
      path: z.string(),
      kind: z.enum(["file", "directory", "symlink", "other"]),
      size: z.number().int().nonnegative(),
      /** Metadata about a sensitive file is allowed; its contents are not. */
      sensitive: z.boolean(),
    }),
  ).default([]),
  truncated: z.boolean().default(false),
});

export const MutationResult = z.object({
  kind: z.enum(["write_file", "delete_file"]),
  path: z.string(),
  bytes: z.number().int().nonnegative().default(0),
  created: z.boolean().default(false),
  /** What the orchestrator counted, so an agent can see its remaining budget. */
  mutationsUsed: z.number().int().nonnegative().default(0),
  mutationsAllowed: z.number().int().nonnegative().default(0),
});

export const ToolResult = z.discriminatedUnion("kind", [
  ReadFileResult, ListDirectoryResult, MutationResult,
]);
export type ToolResult = z.infer<typeof ToolResult>;

export const ToolResponse = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  result: ToolResult.nullable().default(null),
  error: z
    .object({
      code: ToolErrorCode,
      /** Short and orchestrator-authored. Never a secret, never a host path. */
      message: z.string(),
    })
    .nullable()
    .default(null),
});
export type ToolResponse = z.infer<typeof ToolResponse>;

/** Tool -> capability. The bridge consults this; it is not negotiable. */
export const TOOL_CAPABILITY = {
  read_file: "repo.read",
  list_directory: "repo.metadata.read",
  write_file: "repo.file.write",
  delete_file: "repo.file.delete",
} as const;
