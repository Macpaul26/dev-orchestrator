import { z } from "zod";

/**
 * THE FRONT DESK'S INTERPRETER - English in, one command out.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MODEL MAY DO HERE, AND WHAT IT MAY NOT
 * ---------------------------------------------------------------------------
 * A person speaks or types a sentence. A model turns it into ONE of a closed
 * set of intents below. That is translation, not authority: the intent is
 * validated by a strict schema, and a DECISION intent is executed only when
 * the person's own words contain an explicit decision word - see
 * `guardDecision`. The model cannot turn "hmm, looks fine I guess" into an
 * approval; the guard refuses it, and the desk asks again.
 *
 *     THE MODEL TRANSLATES. THE HUMAN DECIDES. THE ORCHESTRATOR CHECKS.
 *
 * The model sees the sentence and a short list of what is waiting (run ids,
 * gate kinds). It never sees repository text, plans, findings or history.
 */

export const Intent = z.discriminatedUnion("kind", [
  /** Start a new run with this request text (the person's words, tidied). */
  z.object({
    kind: z.literal("start"),
    request: z.string().min(3).max(2000),
    maxIterations: z.number().int().min(1).max(10).nullable().default(null),
  }).strict(),
  /** Answer the gate a run is waiting at. */
  z.object({
    kind: z.literal("decide"),
    decision: z.enum(["approve", "reject", "feedback"]),
    /** Only meaningful with approve: narrow what may be touched. */
    scope: z.array(z.string().min(1).max(200)).max(20).default([]),
    comment: z.string().max(2000).nullable().default(null),
  }).strict(),
  /** "What's going on?" */
  z.object({ kind: z.literal("status") }).strict(),
  /** The desk could not tell; ask this back. */
  z.object({ kind: z.literal("unclear"), question: z.string().min(1).max(500) }).strict(),
]);
export type Intent = z.infer<typeof Intent>;

const APPROVE_WORDS = /\b(approve|approved|yes|yeah|yep|go ahead|proceed|accept|accepted|okay|ok|confirm|confirmed|do it|looks good|lgtm|ship it)\b/i;
const REJECT_WORDS = /\b(reject|rejected|no|nope|stop|cancel|abort|don't|do not|decline|refuse)\b/i;
const CHANGE_WORDS = /\b(change|changes|instead|rather|but|not like that|redo|again|fix|adjust|feedback|revise)\b/i;

/**
 * THE GUARD. A decision is executed only if the person's own words say so.
 *
 *   approve   needs an approval word AND no rejection word
 *   reject    needs a rejection word
 *   feedback  needs a change word, or a rejection word with a comment
 *
 * Deterministic and independent of the model. Returns the reason when it
 * refuses, so the desk can ask a plain question instead of guessing.
 */
export function guardDecision(
  utterance: string,
  intent: Extract<Intent, { kind: "decide" }>,
): { ok: true } | { ok: false; reason: string } {
  const text = utterance.trim();
  const approves = APPROVE_WORDS.test(text);
  const rejects = REJECT_WORDS.test(text);
  const wantsChanges = CHANGE_WORDS.test(text);
  switch (intent.decision) {
    case "approve":
      if (!approves) return { ok: false, reason: "I did not hear an approval word, so I have not approved anything." };
      if (rejects && !/\bno(pe)?\b.*\b(problem|issue|worries)\b/i.test(text)) {
        return { ok: false, reason: "I heard both a yes and a no, so I have not approved anything." };
      }
      return { ok: true };
    case "reject":
      if (!rejects) return { ok: false, reason: "I did not hear a rejection word, so I have not rejected anything." };
      return { ok: true };
    case "feedback":
      if (!wantsChanges && !rejects) return { ok: false, reason: "I could not tell what you want changed." };
      if (!intent.comment || intent.comment.trim().length === 0) {
        return { ok: false, reason: "Tell me what to change, and I will send that back as feedback." };
      }
      return { ok: true };
  }
}

/** Scope paths a person named: relative, no traversal, no absolute paths. */
export function cleanScope(scope: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of scope) {
    const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.split("/").includes("..")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export interface WaitingSummary {
  runId: string;
  gate: "plan" | "review";
  summary: string;
}

/** What the model is told, and nothing more. */
export function interpreterPrompt(utterance: string, waiting: readonly WaitingSummary[]): string {
  const list = waiting.length
    ? waiting.map((w) => `- run ${w.runId} is waiting at the ${w.gate} gate: ${w.summary}`).join("\n")
    : "- nothing is waiting";
  return (
    "You translate one sentence from the owner of a software project into exactly one JSON command " +
    "for a development orchestrator. Reply with ONLY the JSON object, no prose, no code fence.\n\n" +
    "Commands:\n" +
    '{"kind":"start","request":"<the change they want, in one clear paragraph, their words tidied>","maxIterations":null}\n' +
    '{"kind":"decide","decision":"approve","scope":["<folder or file they said it may touch>"],"comment":null}\n' +
    '{"kind":"decide","decision":"reject","scope":[],"comment":"<why, if they said>"}\n' +
    '{"kind":"decide","decision":"feedback","scope":[],"comment":"<what they want changed>"}\n' +
    '{"kind":"status"}\n' +
    '{"kind":"unclear","question":"<one short question to ask them>"}\n\n' +
    "Rules: a decision only when something is waiting and they are clearly answering it. " +
    "If they describe work to be done, it is a start. If unsure, use unclear. Never invent scope; " +
    "only list folders or files they actually named. Do not add anything they did not say.\n\n" +
    `Currently waiting:\n${list}\n\n` +
    `Their sentence: """${utterance.replace(/"""/g, '"')}"""`
  );
}

/** Parse the model's reply strictly. Anything odd becomes `unclear`. */
export function parseIntent(reply: string): Intent {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { kind: "unclear", question: "Could you say that another way?" };
  }
  try {
    return Intent.parse(JSON.parse(reply.slice(start, end + 1)));
  } catch {
    return { kind: "unclear", question: "Could you say that another way?" };
  }
}

/**
 * A no-model fallback for the handful of things a person says most, so the
 * desk still answers "yes", "no" and "what's waiting" if the model is
 * unavailable. Anything richer needs the model.
 */
export function interpretLocally(utterance: string, waiting: readonly WaitingSummary[]): Intent | null {
  const text = utterance.trim();
  if (/^(status|what'?s (waiting|going on|happening)|anything waiting\??|where are we\??)$/i.test(text)) {
    return { kind: "status" };
  }
  if (waiting.length === 0) return null;
  if (/^(yes|yeah|yep|approve|approved|ok|okay|go ahead|proceed|accept|confirm|do it|looks good)[.!]?$/i.test(text)) {
    return { kind: "decide", decision: "approve", scope: [], comment: null };
  }
  if (/^(no|nope|reject|rejected|stop|cancel|abort)[.!]?$/i.test(text)) {
    return { kind: "decide", decision: "reject", scope: [], comment: text };
  }
  return null;
}
