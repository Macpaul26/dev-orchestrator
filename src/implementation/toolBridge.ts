import type { ImplementationSession, CancellationToken } from "./session.js";
import { ImplementationCancelled } from "./session.js";
import type { ActivityJournal } from "../activity/journal.js";
import { newCorrelationId } from "../activity/journal.js";
import { GrantDenied } from "../domain/grant.js";
import { WriteRefused } from "../security/writeBoundary.js";
import type { DenialReason } from "../domain/denial.js";
import {
  ToolRequest, ToolResponse, ToolArguments, ToolName,
  TOOL_CAPABILITY, PROTOCOL_LIMITS,
  type ToolResponse as TToolResponse,
  type ToolErrorCode, type ToolName as TToolName,
} from "../domain/toolProtocol.js";

/**
 * THE CONTROLLED TOOL BRIDGE
 *
 * The only route from an untrusted agent to a repository, and the whole of it.
 *
 * ---------------------------------------------------------------------------
 * IT HOLDS A SESSION; IT NEVER TAKES ONE FROM A REQUEST
 * ---------------------------------------------------------------------------
 * One bridge, one `ImplementationSession`, fixed at construction by trusted
 * code. Nothing an agent sends can name, swap, or influence which session is
 * used - which is why "session confusion" is not defended against with a check,
 * but is simply not expressible: the request schema has no session field and is
 * `.strict()`.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE DOES NOT TOUCH THE FILESYSTEM
 * ---------------------------------------------------------------------------
 * There is no `fs` import here, and there must never be one. Every operation
 * goes through `ImplementationSession`, which is where the Phase 4A checks live:
 * grant validity, capability, scope, sensitive-file policy, mutation budget,
 * physical path containment, and the activity journal.
 *
 * That matters for a specific failure mode. If someone later "simplified" a
 * handler into `fs.readFile(path)`, every one of those controls would be
 * bypassed at once, and nothing about the code would look obviously wrong. Tests
 * assert the absence of `fs` and `child_process` in this module for exactly that
 * reason.
 *
 * ---------------------------------------------------------------------------
 * ITS METHODS ARE NATIVE-PRIVATE
 * ---------------------------------------------------------------------------
 * `#` rather than TypeScript `private`, which does not exist at runtime. The
 * bridge is handed to code that talks to an untrusted child, so a reachable
 * `journal()` or `refuse()` would be a way to forge or suppress audit records.
 * `#` members cannot be reached by any cast or property access.
 *
 * ---------------------------------------------------------------------------
 * AUTHORISATION IS PER INVOCATION
 * ---------------------------------------------------------------------------
 * Not once at construction. Every call re-enters the session, which re-validates
 * the grant's fingerprint, binding, status and expiry before doing anything - so
 * a grant that is consumed or expires mid-session stops working immediately
 * rather than at the next run.
 */

export interface BridgeOptions {
  session: ImplementationSession;
  cancellation: CancellationToken;
  /** Orchestrator-owned. The agent has no reference to it. */
  journal?: ActivityJournal | null;
  limits?: { maxRequests?: number };
}

export class ToolBridge {
  readonly #session: ImplementationSession;
  readonly #cancellation: CancellationToken;
  readonly #journal: ActivityJournal | null;
  readonly #maxRequests: number;
  /** Duplicate detection. Bounded by `maxRequests`, so it cannot grow forever. */
  readonly #seen = new Set<string>();
  #handled = 0;
  #closed = false;

  constructor(options: BridgeOptions) {
    this.#session = options.session;
    this.#cancellation = options.cancellation;
    this.#journal = options.journal ?? null;
    this.#maxRequests = options.limits?.maxRequests ?? PROTOCOL_LIMITS.maxRequestsPerSession;
  }

  get requestsHandled(): number {
    return this.#handled;
  }

  /** Stop accepting requests. Called when the agent's run ends. */
  close(): void {
    this.#closed = true;
  }

  /**
   * Handle one raw protocol line.
   *
   * Takes a STRING rather than a parsed object on purpose: parsing is part of
   * the boundary, and a caller that hands in an already-parsed object would be
   * making a trust decision this class is supposed to make.
   *
   * Never throws for hostile input. A malformed line, an unknown tool, a
   * forged field or a 10MB path all produce a structured refusal, because an
   * exception escaping here would take down the orchestrator on input the agent
   * fully controls.
   */
  async handleRaw(line: string): Promise<TToolResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.#refuse("(unparseable)", "malformed_json", "request was not valid JSON");
    }
    return this.handle(parsed);
  }

  async handle(raw: unknown): Promise<TToolResponse> {
    // ---- 1. shape ---------------------------------------------------------
    const envelope = ToolRequest.safeParse(raw);
    if (!envelope.success) {
      // `.strict()` lands here for any attempt to smuggle in authority fields -
      // grantId, projectId, sessionId, allowedScope, capabilities, workingDir.
      const id = extractRequestId(raw);
      const unknownTool =
        typeof raw === "object" && raw !== null &&
        typeof (raw as Record<string, unknown>)["tool"] === "string" &&
        !ToolName.options.includes((raw as Record<string, unknown>)["tool"] as TToolName);
      return this.#refuse(
        id,
        unknownTool ? "unknown_tool" : "invalid_request",
        unknownTool
          ? "no such tool"
          : "request did not match the tool protocol",
      );
    }
    const request = envelope.data;

    // ---- 2. session-level gates ------------------------------------------
    if (this.#closed) {
      return this.#refuse(request.requestId, "session_closed", "the session has ended");
    }
    if (this.#cancellation.isCancelled) {
      // Checked BEFORE the handler: cancellation must stop new work starting,
      // not merely be noticed once it has.
      return this.#refuse(request.requestId, "cancelled", "the run was cancelled");
    }
    if (this.#handled >= this.#maxRequests) {
      return this.#refuse(
        request.requestId, "too_many_requests",
        `this session may make at most ${this.#maxRequests} requests`,
      );
    }
    if (this.#seen.has(request.requestId)) {
      // A replayed id would let one response be matched to two operations.
      return this.#refuse(
        request.requestId, "duplicate_request_id", "request id has already been used",
      );
    }

    // ---- 3. per-tool arguments -------------------------------------------
    const schema = ToolArguments[request.tool];
    const args = schema.safeParse(request.arguments ?? {});
    if (!args.success) {
      return this.#refuse(
        request.requestId, "invalid_arguments",
        `arguments were not valid for ${request.tool}`,
      );
    }

    this.#seen.add(request.requestId);
    this.#handled += 1;

    // ---- 4. dispatch ------------------------------------------------------
    try {
      return await this.#dispatch(request.requestId, request.tool, args.data as never);
    } catch (error) {
      // The session throws for a denial it could not express as a result.
      // Nothing from the exception's message reaches the agent except a code.
      if (error instanceof ImplementationCancelled) {
        return this.#refuse(request.requestId, "cancelled", "the run was cancelled");
      }
      if (error instanceof GrantDenied) {
        return this.#refuse(request.requestId, error.reason, denialMessage(error.reason));
      }
      if (error instanceof WriteRefused) {
        return this.#refuse(request.requestId, error.code, denialMessage(error.code));
      }
      return this.#refuse(
        request.requestId, "internal_error", "the operation could not be completed",
      );
    }
  }

  async #dispatch(
    requestId: string,
    tool: TToolName,
    args: { path: string; contents?: string },
  ): Promise<TToolResponse> {
    const capability = TOOL_CAPABILITY[tool];

    switch (tool) {
      case "read_file": {
        // Scope, capability, sensitivity and containment are all enforced
        // inside the session. Nothing is re-decided here.
        const file = await this.#session.readFile(args.path);
        this.#recordCompletion(requestId, tool, capability, args.path, file.available);
        return this.#ok(requestId, {
          kind: "read_file",
          path: file.path,
          available: file.available,
          // A withheld file yields null, never a partial disclosure.
          contents: file.available
            ? (file.content ?? "").slice(0, PROTOCOL_LIMITS.maxReadBytes)
            : null,
          bytes: file.bytes,
          truncated:
            file.truncated ||
            (file.content?.length ?? 0) > PROTOCOL_LIMITS.maxReadBytes,
          withheldReason: file.withheldReason,
        });
      }

      case "list_directory": {
        const listing = await this.#session.listDirectory(args.path);
        const entries = listing.entries.slice(0, PROTOCOL_LIMITS.maxListEntries);
        this.#recordCompletion(requestId, tool, capability, args.path, true);
        return this.#ok(requestId, {
          kind: "list_directory",
          path: listing.path,
          entries: entries.map((e) => ({
            path: e.path, kind: e.kind, size: e.size, sensitive: e.sensitive,
          })),
          truncated: listing.truncated || listing.entries.length > entries.length,
        });
      }

      case "write_file": {
        const outcome = await this.#session.writeFile(args.path, args.contents ?? "");
        if (!outcome.ok) {
          this.#recordCompletion(requestId, tool, capability, args.path, false, outcome.denial);
          return this.#refuse(
            requestId,
            (outcome.denial ?? "internal_error") as ToolErrorCode,
            denialMessage(outcome.denial ?? "internal_error"),
          );
        }
        this.#recordCompletion(requestId, tool, capability, args.path, true);
        return this.#ok(requestId, this.#mutationResult("write_file", outcome));
      }

      case "delete_file": {
        const outcome = await this.#session.deleteFile(args.path);
        if (!outcome.ok) {
          this.#recordCompletion(requestId, tool, capability, args.path, false, outcome.denial);
          return this.#refuse(
            requestId,
            (outcome.denial ?? "internal_error") as ToolErrorCode,
            denialMessage(outcome.denial ?? "internal_error"),
          );
        }
        this.#recordCompletion(requestId, tool, capability, args.path, true);
        return this.#ok(requestId, this.#mutationResult("delete_file", outcome));
      }
    }
  }

  #mutationResult(
    kind: "write_file" | "delete_file",
    outcome: { path: string; bytes: number; created: boolean },
  ) {
    const stats = this.#session.stats;
    return {
      kind,
      path: outcome.path,
      bytes: outcome.bytes,
      created: outcome.created,
      // Counted by the ORCHESTRATOR. Reported so an agent can pace itself; it
      // cannot change either number by saying anything.
      mutationsUsed: stats.writes + stats.deletes,
      mutationsAllowed: this.#session.mutationBudget,
    };
  }

  #ok(requestId: string, result: unknown): TToolResponse {
    return ToolResponse.parse({ requestId, ok: true, result, error: null });
  }

  #refuse(
    requestId: string, code: ToolErrorCode, message: string,
  ): TToolResponse {
    this.#journal?.append({
      type: "bridge_request_rejected",
      runId: this.#session.runId,
      projectId: this.#session.projectId,
      grantId: this.#session.grantId,
      correlationId: newCorrelationId(),
      at: new Date().toISOString(),
      requestId: requestId.slice(0, 128),
      code,
    } as never);
    return ToolResponse.parse({ requestId, ok: false, result: null, error: { code, message } });
  }

  /**
   * Record the outcome of a dispatched request.
   *
   * The path is recorded because a reviewer needs to know WHICH file was
   * touched - but only ever the repository-relative one the session resolved,
   * never an absolute host path, and never any content.
   */
  #recordCompletion(
    requestId: string,
    tool: string,
    capability: string,
    path: string,
    ok: boolean,
    denial?: string | null,
  ): void {
    this.#journal?.append({
      type: "bridge_request_completed",
      runId: this.#session.runId,
      projectId: this.#session.projectId,
      grantId: this.#session.grantId,
      correlationId: newCorrelationId(),
      at: new Date().toISOString(),
      requestId: requestId.slice(0, 128),
      tool,
      capability,
      path: path.slice(0, 512),
      ok,
      denial: denial ?? null,
    } as never);
  }
}

/** Try to recover a request id from input that failed validation. */
function extractRequestId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    const id = (raw as Record<string, unknown>)["requestId"];
    if (typeof id === "string" && id.length > 0) {
      return id.slice(0, PROTOCOL_LIMITS.maxRequestIdLength);
    }
  }
  return "(unknown)";
}

/**
 * A fixed sentence per refusal code.
 *
 * Deliberately not the underlying exception's message: those name paths,
 * grant ids and limits, and everything here is read by an untrusted agent. The
 * detailed reason goes to the ACTIVITY JOURNAL, which the agent cannot read.
 */
function denialMessage(code: DenialReason | ToolErrorCode | string): string {
  switch (code) {
    case "out_of_scope": return "that path is outside the approved scope";
    case "sensitive_path": return "that path is covered by the sensitive-file policy";
    case "path_escape":
    case "symlink_escape": return "that path is outside the project boundary";
    case "capability_not_granted":
    case "capability_not_implemented": return "that capability is not available";
    case "write_budget_exhausted": return "the mutation budget for this run is exhausted";
    case "file_too_large": return "that file exceeds the permitted size";
    case "consumed": return "the implementation grant has already been used";
    case "expired": return "the implementation grant has expired";
    case "revoked": return "the implementation grant was revoked";
    case "not_a_file": return "that path is not a regular file";
    case "missing": return "no such file";
    case "cancelled": return "the run was cancelled";
    default: return "the operation was refused";
  }
}
