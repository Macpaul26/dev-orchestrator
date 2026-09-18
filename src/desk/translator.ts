import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  interpreterPrompt, parseIntent, interpretLocally, type Intent, type WaitingSummary,
} from "./interpret.js";

/**
 * THE MODEL CALL BEHIND THE FRONT DESK - translation only.
 *
 * Uses the same Claude login as the bridge (no API key), through the Agent SDK,
 * with NO tools at all: every built-in tool disallowed, `canUseTool` denies
 * everything, one turn, no project settings loaded, working directory a
 * neutral one. It cannot read a file, run a command or reach the orchestrator.
 * It receives the sentence and the list of waiting gates, and returns text
 * that `parseIntent` validates strictly.
 */

export interface Translator {
  translate(utterance: string, waiting: readonly WaitingSummary[]): Promise<Intent>;
}

const NO_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "Skill",
  "ExitPlanMode", "EnterPlanMode", "ToolSearch",
];

export class ClaudeTranslator implements Translator {
  constructor(private readonly cwd: string) {}

  async translate(utterance: string, waiting: readonly WaitingSummary[]): Promise<Intent> {
    const local = interpretLocally(utterance, waiting);
    if (local) return local;

    const deny = async (name: string): Promise<PermissionResult> =>
      ({ behavior: "deny", message: `no tools in translation (${name})` });
    let reply = "";
    try {
      const run = query({
        prompt: interpreterPrompt(utterance, waiting),
        options: {
          cwd: this.cwd,
          allowedTools: [],
          disallowedTools: NO_TOOLS,
          canUseTool: deny,
          permissionMode: "default",
          settingSources: [],
          maxTurns: 1,
          systemPrompt: "You output exactly one JSON object and nothing else.",
        },
      });
      for await (const message of run as AsyncIterable<SDKMessage>) {
        if (message.type === "result" && message.subtype === "success") reply = message.result;
      }
    } catch (error) {
      return {
        kind: "unclear",
        question: `I could not reach the translator (${error instanceof Error ? error.message : "error"}). ` +
          "You can still say yes, no, or status.",
      };
    }
    return parseIntent(reply);
  }
}
