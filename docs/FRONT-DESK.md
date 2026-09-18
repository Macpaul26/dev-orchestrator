# The Front Desk — talk to the orchestrator

**Status:** IMPLEMENTED, owner-authorised. Not a numbered task. Not approved by
the Director.

> **The model translates. The human decides. The orchestrator checks.**

## What it is

A local page (`dist/desk/server.js`, bound to `127.0.0.1` only) with a
microphone and a text box. You say what you want in English; it becomes one
command for the orchestrator. When the orchestrator stops at a gate, the page
narrates the plan or the review in plain sentences — written by code from
trusted state, never by a model — and you answer: *yes*, *no*, *yes but only
src*, *change it so that…*.

It drives the orchestrator in-process exactly as the CLI does: same project
store, same runner, same checkpoints, same gates, same grants. It adds no
capability. It adds a way in that needs no syntax.

## The one rule

**The desk never decides.** A decision is executed only when the person's own
words pass `guardDecision` — an explicit approval word for approve, a
rejection word for reject, a change word plus a comment for feedback —
regardless of what the translating model said. "Hmm, looks fine I guess"
does not approve; the desk says so and asks again. The `HumanDecision`
carries the person's name.

## The translator

`src/desk/translator.ts` uses the same Claude login as the bridge (no API key),
through the Agent SDK, with every tool disallowed, one turn, no project
settings, a neutral working directory. It receives the sentence and the list
of waiting gates (run id, gate, request excerpt) and returns one JSON intent,
validated by a strict schema; anything else becomes "unclear". A no-model
fallback handles *yes*, *no* and *status* so the desk still answers if the
translator is unavailable.

Measured on real sentences: a request → `start`; "yes go ahead but only touch
the src folder" → `approve, scope [src]`; "no, not like that, the categories
should be tabs" → `feedback` with the comment; "what's waiting for me" →
`status`. 5–8 s each.

## Running it

`front-desk.cmd` (double-click) sets the orchestrator's environment, opens
`http://127.0.0.1:4173/` and starts the server for the `newbreed` project,
deciding as `angela`. Keep the window open; close it to stop. Voice input
needs Chrome or Edge; typing always works.

## Limits

- Loopback only, no authentication: anyone at this keyboard is the owner.
- One project per desk process.
- The translator costs a Claude call per sentence; the fallback covers the
  three most common words for free.
- Every implementation is still a real Claude Code session through the bridge.
