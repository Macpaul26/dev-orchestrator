# The Claude Code Bridge — connecting the worker

**Status:** IMPLEMENTED and exercised against the real Claude Code binary. Not a
numbered task: the owner authorised this as the operational connector Task 014
was missing, and the Director was informed. Not approved by the Director.

> **The bridge can ask. It cannot decide.**

## 1. Why it exists

Phase 4B built the process boundary and the controlled tool protocol, and
Task 014 built the loop around them — but nothing spoke the protocol except a
test fake. `ORCHESTRATOR_CLAUDE_EXECUTABLE` pointed at `claude.exe` would have
launched Claude Code with a JSON payload as its prompt and refused every line
it printed. The docs said so (PHASE-4B1 §3: "the boundary, not an authenticated
session"). This is the missing program.

## 2. What it is

`src/bridge/claudeBridge.ts` (built to `dist/bridge/claudeBridge.js`) is the
executable the orchestrator launches. It:

1. reads the session payload from stdin (line 1);
2. starts a Claude Code session through `@anthropic-ai/claude-agent-sdk`, in
   the project's working directory, with **no built-in tools** — `Bash`,
   `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, web
   and sub-agent tools are all in `disallowedTools`, `canUseTool` denies
   anything else, and `settingSources: []` means the target repository's own
   `.claude` settings (hooks, MCP servers) are never loaded;
3. gives it exactly **four MCP tools** — `read_file`, `list_directory`,
   `write_file`, `delete_file` — each of which is forwarded, as a protocol
   request on fd 3, to the **orchestrator**, which authorises it against the
   human-approved grant (scope, capability, byte and count budgets, sensitive
   paths) and performs it;
4. prints a final `ORCHESTRATOR_REPORT:` line — a **claim** — and exits.

```
orchestrator ── payload ──▶ bridge ── prompt + 4 tools ──▶ Claude Code
orchestrator ◀─ requests ── bridge ◀─ tool calls ────────── Claude Code
      │
      └─ grant check → write → journal → (later) verification attributes it
```

The bridge holds no grant, opens no file, runs no command. `protocolClient.ts`
uses `node:fs` for exactly one call — writing to fd 3 — and a test asserts that.

## 3. Configuration

```
ORCHESTRATOR_CLAUDE_EXECUTABLE = C:\Program Files\nodejs\node.exe
ORCHESTRATOR_CLAUDE_ARGS       = C:\Users\<you>\dev-orchestrator\dist\bridge\claudeBridge.js
```

The executable must be absolute (the adapter refuses a bare name), and the
SDK ships its own `claude.exe` (`@anthropic-ai/claude-agent-sdk-win32-x64`), so
no PATH lookup happens. Claude Code authenticates with its own stored login
under the user profile, which the adapter passes through; **no API key is
forwarded** — the adapter's denylist would refuse one. `dev-agent tools`
reports `claude code adapter: configured` when both variables are set.

## 4. What was measured

Two real runs against a throwaway repository, through the real adapter:

| Run | What happened |
| --- | --- |
| 1 | Claude read `src/greet.ts` and wrote the change through the orchestrator in 9 s — then the bridge process **did not exit** (stdin listener and SDK child kept the event loop alive) and was killed at the adapter's 10-minute timeout. Verification still attributed the change correctly; the review withheld `pass` because the attempt ended `cancelled` and the claim was lost. |
| 2 | After the fix (explicit exit once the report is flushed; tools marked always-loaded so no discovery turn): plan → implement → verify → review in **12 s**, `VERIFIED`, 1 file modified, attributable, no drift, claim matches, review `pass`, human approval → `completed`. |

## 5. Limits, honestly

- **Not an OS sandbox.** The bridge removes Claude Code's tools; it does not
  remove the process's ability to be a process. Unchanged from Phase 4B.1.
  Verification observes the repository afterwards; out-of-scope change is a
  safety stop.
- **Four tools only.** No search, no shell, no test runner. Claude reads and
  writes whole files. Fine for bounded edits; slow for exploration. Adding a
  tool to the protocol is a security decision for the Director.
- **Cost.** Every implementation is a real Claude Code session on the owner's
  account.
- **Tests.** `tests/bridge.test.ts` covers the protocol client, the import
  boundary and the tool allow/deny lists deterministically. The SDK half is
  proven by the real runs above, on purpose — a fake would prove nothing about
  the real binary.
