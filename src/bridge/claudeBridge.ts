import process from "node:process";
import { z } from "zod";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  SessionPayload, LineSource, ProtocolClient, fd3Channel, describeResponse,
} from "./protocolClient.js";

/**
 * THE CLAUDE CODE BRIDGE - the executable the orchestrator launches.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * The orchestrator's implement node spawns a configured executable and speaks
 * the controlled tool protocol to it (see protocolClient.ts). Claude Code does
 * not speak that protocol. This program does, on Claude Code's behalf:
 *
 *   orchestrator  --payload-->  bridge  --prompt + 4 MCP tools-->  Claude Code
 *   orchestrator  <--requests-- bridge  <--tool calls-------------  Claude Code
 *
 * Every file operation Claude Code performs goes: Claude calls an MCP tool ->
 * the bridge turns it into a protocol request -> the ORCHESTRATOR authorises
 * it against the human-approved grant (scope, capability, budgets, sensitive
 * paths) and performs it -> the result comes back. The bridge itself holds no
 * grant, opens no file, runs no command.
 *
 * ---------------------------------------------------------------------------
 * CLAUDE CODE GETS NO TOOLS OF ITS OWN
 * ---------------------------------------------------------------------------
 * Its built-in Read, Write, Edit, Glob, Grep, Bash, web and sub-agent tools
 * are DISALLOWED, and `canUseTool` denies anything that is not one of the four
 * orchestrator tools. The target repository's own `.claude` settings are not
 * loaded (`settingSources: []`), so a hook or MCP server checked into the
 * project being worked on cannot add tools to the session. What Claude Code
 * can do in this session is exactly what the orchestrator will authorise, and
 * nothing else.
 *
 * Honest limit, unchanged from Phase 4B.1: the Claude Code process is not
 * OS-sandboxed. This bridge removes its tools; it does not remove the process's
 * ability to be a process. Verification observes the repository afterwards
 * regardless, and out-of-scope change is a safety stop.
 *
 * ---------------------------------------------------------------------------
 * CONFIGURATION
 * ---------------------------------------------------------------------------
 *   ORCHESTRATOR_CLAUDE_EXECUTABLE = <absolute path to node.exe>
 *   ORCHESTRATOR_CLAUDE_ARGS       = <absolute path to dist/bridge/claudeBridge.js>
 *
 * Claude Code authenticates with its own stored login under the user profile,
 * which the orchestrator passes through. No API key is forwarded, and the
 * orchestrator's environment denylist would refuse one.
 */

const REPORT_MARKER = "ORCHESTRATOR_REPORT:";
const BRIDGE_LIMITS = {
  /** Model turns for one implementation. The orchestrator's timeout bounds wall-clock. */
  maxTurns: 80,
} as const;

const ORCHESTRATOR_TOOLS = [
  "mcp__orchestrator__read_file",
  "mcp__orchestrator__list_directory",
  "mcp__orchestrator__write_file",
  "mcp__orchestrator__delete_file",
] as const;

/** Claude Code's own tools, every one refused. The list is explicit on purpose. */
const DISALLOWED_BUILTINS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "Skill",
  "ExitPlanMode", "EnterPlanMode",
];

const narrate = (text: string): void => { process.stdout.write(`${text}\n`); };

async function main(): Promise<number> {
  const stdin = new LineSource(process.stdin);
  const first = await stdin.next();
  let payload: SessionPayload;
  try {
    payload = SessionPayload.parse(JSON.parse(first));
  } catch {
    narrate("bridge: the first stdin line was not a valid session payload");
    return 2;
  }
  const client = new ProtocolClient(fd3Channel(), stdin, payload.runId);
  narrate(`bridge: session for run ${payload.runId}; scope [${payload.allowedScope.join(", ") || "none"}]`);

  const text = (t: string, isError = false) => ({
    content: [{ type: "text" as const, text: t }],
    ...(isError ? { isError: true } : {}),
  });

  const server = createSdkMcpServer({
    name: "orchestrator",
    version: "1.0.0",
    // Always in the prompt: no discovery turn, no ToolSearch.
    alwaysLoad: true,
    instructions:
      "These four tools are the ONLY way to inspect or change the repository. Paths are " +
      "relative to the repository root. Every call is authorised by the orchestrator against " +
      "the human-approved scope; a DENIED result is final - do not retry it or look for another way.",
    tools: [
      tool("read_file", "Read a repository file's contents (authorised by the orchestrator).",
        { path: z.string().min(1) },
        async ({ path }) => { const r = describeResponse(await client.readFile(path)); return text(r.text, r.isError); }),
      tool("list_directory", "List a repository directory (authorised by the orchestrator).",
        { path: z.string().default(".") },
        async ({ path }) => { const r = describeResponse(await client.listDirectory(path)); return text(r.text, r.isError); }),
      tool("write_file", "Create or overwrite a repository file with the FULL new contents (authorised by the orchestrator against the approved scope).",
        { path: z.string().min(1), contents: z.string() },
        async ({ path, contents }) => { const r = describeResponse(await client.writeFile(path, contents)); return text(r.text, r.isError); }),
      tool("delete_file", "Delete a repository file (authorised by the orchestrator against the approved scope).",
        { path: z.string().min(1) },
        async ({ path }) => { const r = describeResponse(await client.deleteFile(path)); return text(r.text, r.isError); }),
    ],
  });

  const canUseTool = async (name: string): Promise<PermissionResult> =>
    (ORCHESTRATOR_TOOLS as readonly string[]).includes(name)
      ? { behavior: "allow" }
      : { behavior: "deny", message: `Tool "${name}" is not available in an orchestrated session. Use the orchestrator tools.` };

  const prompt =
    `You are implementing ONE approved change in a software project, under supervision.\n\n` +
    `APPROVED PLAN: ${payload.planSummary || "(none given)"}\n\n` +
    `REQUEST: ${payload.instruction}\n\n` +
    `RULES\n` +
    `- You may only touch paths inside the approved scope: ${payload.allowedScope.length ? payload.allowedScope.join(", ") : "(NONE - you may read, but no write will be permitted)"}.\n` +
    `- Use read_file and list_directory to understand the code, then write_file with COMPLETE file contents to change it.\n` +
    `- You cannot run commands, tests, git, or anything outside these four tools. Do not claim to have run anything.\n` +
    `- Make the smallest correct change. Do not touch unrelated files. Do not create secrets or configuration.\n` +
    `- When finished, reply with a short summary of exactly what you changed and what you could not do.`;

  let summary = "";
  let success = false;
  let turns = 0;
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    const run = query({
      prompt,
      options: {
        cwd: process.cwd(),
        mcpServers: { orchestrator: server },
        allowedTools: [...ORCHESTRATOR_TOOLS],
        disallowedTools: DISALLOWED_BUILTINS,
        permissionMode: "default",
        canUseTool,
        settingSources: [],
        maxTurns: BRIDGE_LIMITS.maxTurns,
        abortController: abort,
        systemPrompt:
          "You are a careful software engineer working through a supervised tool bridge. " +
          "You have exactly four tools, all provided by the orchestrator. Never assume a file " +
          "changed unless write_file returned OK.",
      },
    });
    for await (const message of run as AsyncIterable<SDKMessage>) {
      if (message.type === "assistant") {
        turns += 1;
        for (const block of message.message.content) {
          if (block.type === "tool_use") narrate(`bridge: tool ${block.name}`);
        }
      } else if (message.type === "result") {
        success = message.subtype === "success" && !message.is_error;
        summary = message.subtype === "success" ? message.result : `agent ended: ${message.subtype}`;
        narrate(`bridge: result ${message.subtype} after ${String(message.num_turns)} turn(s)`);
      }
    }
  } catch (error) {
    summary = `bridge error: ${error instanceof Error ? error.message : String(error)}`;
    narrate(summary);
  } finally {
    client.close();
  }

  // The claimed report. Labelled and treated as a CLAIM by the orchestrator;
  // verification establishes what actually changed.
  narrate(`${REPORT_MARKER} ${JSON.stringify({
    summary: summary.slice(0, 2000),
    files: [...new Set(client.mutated)],
    claimsSuccess: success,
  })}`);
  narrate(`bridge: ${String(turns)} assistant turn(s), ${String(client.mutated.length)} mutation(s) via the orchestrator`);
  return success ? 0 : 1;
}

/**
 * EXIT EXPLICITLY. The stdin listener (protocol responses) and the SDK's own
 * child keep the event loop alive after the work is done; without this the
 * bridge sat idle until the orchestrator's timeout killed it - measured, not
 * assumed. Flush stdout first so the report line is never lost.
 */
const exit = (code: number): void => {
  process.stdout.write("", () => process.exit(code));
};
main().then(exit, (error: unknown) => {
  narrate(`bridge: fatal ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
