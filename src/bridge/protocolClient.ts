import fs from "node:fs";
import type { Readable } from "node:stream";
import { z } from "zod";
import {
  ToolRequest, ToolResponse, PROTOCOL_LIMITS,
  type ToolName, type ToolResponse as TToolResponse,
} from "../domain/toolProtocol.js";

/**
 * THE CHILD'S SIDE OF THE CONTROLLED TOOL PROTOCOL
 *
 * The orchestrator launches an executable, writes ONE JSON line - the session
 * payload - on its stdin, and then answers tool requests. The channel contract
 * (adapters/claude-code/processBoundary.ts) is:
 *
 *   stdin   line 1 is the payload; every further line is a tool RESPONSE
 *   fd 3    tool REQUESTS, child -> orchestrator, one JSON line each
 *   stdout  untrusted narrative, and a final ORCHESTRATOR_REPORT: line
 *
 * This module is the client for that contract. It knows how to ask for
 * exactly four things - read_file, list_directory, write_file, delete_file -
 * because those are the only four the orchestrator will answer, and it holds
 * no grant, no scope and no capability: the orchestrator re-authorises every
 * request against the session it built from the human's approval. The bridge
 * can ask; it cannot decide.
 */

/** What the orchestrator tells the child. No secret, no host path. */
export const SessionPayload = z.object({
  protocol: z.literal("orchestrator.implementation.v1"),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  grantId: z.string().min(1),
  instruction: z.string(),
  planSummary: z.string().default(""),
  allowedScope: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
}).passthrough();
export type SessionPayload = z.infer<typeof SessionPayload>;

export interface RequestChannel {
  /** Write one request line towards the orchestrator. */
  send(line: string): void;
}

/** fd 3, as the contract specifies. Opened lazily so tests can substitute. */
export function fd3Channel(fd = 3): RequestChannel {
  return {
    send(line) {
      fs.writeSync(fd, `${line}\n`, null, "utf8");
    },
  };
}

/**
 * Line-by-line reader over a stream that must NOT be read to EOF: stdin stays
 * open for the whole run, because it is how responses come back.
 */
export class LineSource {
  #buffer = "";
  #waiting: ((line: string) => void)[] = [];
  #queued: string[] = [];
  #ended = false;

  constructor(stream: Readable) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.#buffer.slice(0, index).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(index + 1);
        this.#deliver(line);
        index = this.#buffer.indexOf("\n");
      }
    });
    stream.on("end", () => { this.#ended = true; this.#flushWaiters(); });
    stream.on("error", () => { this.#ended = true; this.#flushWaiters(); });
  }

  #deliver(line: string): void {
    const waiter = this.#waiting.shift();
    if (waiter) waiter(line);
    else this.#queued.push(line);
  }

  #flushWaiters(): void {
    for (const waiter of this.#waiting.splice(0)) waiter("");
  }

  /** Resolves with the next line, or "" once the stream has ended. */
  next(): Promise<string> {
    const queued = this.#queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve("");
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
}

export class ProtocolClient {
  #nextId = 0;
  #pending = new Map<string, (response: TToolResponse) => void>();
  #closed = false;
  /** Paths this client successfully wrote or deleted. The bridge's own count, for its claim. */
  readonly mutated: string[] = [];

  constructor(
    private readonly requests: RequestChannel,
    private readonly responses: LineSource,
    private readonly runId: string,
  ) {
    void this.#pump();
  }

  async #pump(): Promise<void> {
    for (;;) {
      const line = await this.responses.next();
      if (line === "" && this.#pending.size === 0) {
        // Either the stream ended or an empty line arrived; check again
        // unless the stream is gone. An ended stream keeps returning "".
        if (this.#closed) return;
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      if (line.trim().length === 0) continue;
      let parsed: TToolResponse;
      try {
        parsed = ToolResponse.parse(JSON.parse(line));
      } catch {
        // Not a response. The orchestrator never writes anything else here,
        // so this is noise; ignore it rather than guess a correlation.
        continue;
      }
      const waiter = this.#pending.get(parsed.requestId);
      if (waiter) {
        this.#pending.delete(parsed.requestId);
        waiter(parsed);
      }
    }
  }

  close(): void { this.#closed = true; }

  /** Send one request and await its response. Never throws on a denial. */
  request(tool: ToolName, args: Record<string, unknown>): Promise<TToolResponse> {
    this.#nextId += 1;
    const requestId = `${this.runId.slice(0, 40)}-${String(this.#nextId)}`
      .slice(0, PROTOCOL_LIMITS.maxRequestIdLength);
    const line = JSON.stringify(ToolRequest.parse({ requestId, tool, arguments: args }));
    return new Promise((resolve) => {
      this.#pending.set(requestId, resolve);
      this.requests.send(line);
    });
  }

  async readFile(path: string): Promise<TToolResponse> {
    return this.request("read_file", { path });
  }

  async listDirectory(path = "."): Promise<TToolResponse> {
    return this.request("list_directory", { path });
  }

  async writeFile(path: string, contents: string): Promise<TToolResponse> {
    const response = await this.request("write_file", { path, contents });
    if (response.ok) this.mutated.push(path);
    return response;
  }

  async deleteFile(path: string): Promise<TToolResponse> {
    const response = await this.request("delete_file", { path });
    if (response.ok) this.mutated.push(path);
    return response;
  }
}

/** Render a response as text for the model. Short, and never a host path. */
export function describeResponse(response: TToolResponse): { text: string; isError: boolean } {
  if (!response.ok || !response.result) {
    const code = response.error?.code ?? "unknown";
    const message = response.error?.message ?? "the orchestrator refused the request";
    return { text: `DENIED (${code}): ${message}`, isError: true };
  }
  const result = response.result;
  switch (result.kind) {
    case "read_file":
      if (!result.available || result.contents === null) {
        return {
          text: `File "${result.path}" is not available: ${result.withheldReason ?? "withheld"}`,
          isError: true,
        };
      }
      return {
        text: `${result.contents}${result.truncated ? "\n\n[truncated by the orchestrator]" : ""}`,
        isError: false,
      };
    case "list_directory":
      return {
        text: (result.entries
          .map((e) => `${e.kind === "directory" ? "d" : e.kind === "file" ? "f" : "?"} ${e.path}` +
            `${e.sensitive ? "  [sensitive: contents withheld]" : ""}`)
          .join("\n") || "(empty)") +
          (result.truncated ? "\n[listing truncated by the orchestrator]" : ""),
        isError: false,
      };
    default:
      return {
        text: `OK: ${result.kind} ${result.path} (${String(result.bytes)} bytes; ` +
          `mutations used ${String(result.mutationsUsed)} of ${String(result.mutationsAllowed)})`,
        isError: false,
      };
  }
}
