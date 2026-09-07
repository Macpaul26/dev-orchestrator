import { Plan, type Plan as TPlan } from "../domain/approval.js";
import type { ReasoningProposal } from "../domain/reasoning.js";
import { normalisePath, containsTraversal } from "../domain/scope.js";

/**
 * TURNING AN UNTRUSTED PROPOSAL INTO A PLAN
 *
 * This is the whole trust boundary in one function. Above it, everything came
 * from a language model and may have been shaped by text in the repository.
 * Below it, a `Plan` is what a human will be asked to approve.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES, AND THEY ARE NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 * 1. THE PLAN IS BUILT FIELD BY FIELD, NEVER SPREAD.
 *    `{ ...proposal }` would copy whatever the proposal happened to carry. Every
 *    field below is named explicitly, so a key nobody anticipated cannot arrive
 *    in a `Plan` by accident. The schema already rejects unknown keys; this is
 *    the second lock on the same door.
 *
 * 2. RISK IS COMPUTED HERE, NEVER READ FROM THE MODEL.
 *    A model that could set `highestRisk: "LOW"` would be adjusting the gate
 *    that governs it. `ReasoningProposal` has no risk field at all, and this
 *    function derives risk from what the plan would DO.
 *
 * 3. PROPOSED SCOPE IS RE-CHECKED, NOT TRUSTED.
 *    Paths go through the same `normalisePath` and `containsTraversal` used
 *    everywhere else - not a second, friendlier implementation. Anything that
 *    escapes, is absolute, or is empty is DROPPED and reported, so a human sees
 *    that the model asked for something it did not get.
 *
 * What this function cannot do is make a bad plan good. A model can still
 * propose the wrong change, in the wrong place, for a plausible-sounding
 * reason. That is what the human gate and independent verification are for.
 */

export interface PlanFromProposal {
  plan: TPlan;
  /** Paths the model asked for that trusted code refused. Surfaced to a human. */
  rejectedPaths: { path: string; reason: string }[];
  /** Model questions and rationale, carried as context for the reviewer. */
  notes: string[];
}

/**
 * Decide the plan's risk from what it would do, not from what it says.
 *
 * Any plan proposing to change files leads to a grant that can write, so it is
 * HIGH.
 *
 * A plan whose paths were ALL refused is MEDIUM rather than LOW, and that
 * distinction is not cosmetic. A model that asked for `/` and got nothing has
 * produced a plan which cannot mint write authority - genuinely harmless in
 * effect - but the asking is itself a fact a human should weigh, and a LOW
 * badge on a refused escalation invites exactly the glance-and-approve this
 * gate exists to prevent.
 *
 * LOW is reserved for a plan that proposed no scope in the first place.
 *
 * There is deliberately no path by which model text moves any of this.
 */
function classifyRisk(
  scopePaths: readonly string[],
  refusedCount: number,
): "LOW" | "MEDIUM" | "HIGH" {
  if (scopePaths.length > 0) return "HIGH";
  return refusedCount > 0 ? "MEDIUM" : "LOW";
}

export function planFromProposal(
  proposal: ReasoningProposal,
  request: string,
): PlanFromProposal {
  const rejectedPaths: { path: string; reason: string }[] = [];
  const allowedScope: string[] = [];

  for (const raw of proposal.proposedScope.paths) {
    // Traversal first: `src/../../etc` is lexically inside `src/` until it is
    // not, and this is the check that catches it.
    if (containsTraversal(raw)) {
      rejectedPaths.push({ path: raw, reason: "contains a path traversal" });
      continue;
    }
    const normalised = normalisePath(raw);
    if (normalised.length === 0) {
      rejectedPaths.push({ path: raw, reason: "empty after normalisation" });
      continue;
    }
    if (normalised.startsWith("/") || /^[a-zA-Z]:/.test(normalised)) {
      rejectedPaths.push({ path: raw, reason: "absolute paths are not a project scope" });
      continue;
    }
    if (!allowedScope.includes(normalised)) allowedScope.push(normalised);
  }

  const highestRisk = classifyRisk(allowedScope, rejectedPaths.length);

  /**
   * Steps are renumbered by position rather than by the model's `order`.
   *
   * The model controls that number, and a duplicated or negative one would let
   * it influence how the plan reads to a human. Position is ours.
   */
  const steps = proposal.steps.map((step, index) => ({
    order: index,
    description: step.description,
    // Per-step risk is the plan's risk. The model does not supply one, and
    // nothing here invents a lower value for an individual step.
    risk: highestRisk,
  }));

  const notes: string[] = [];
  if (proposal.proposedScope.rationale) {
    notes.push(`scope rationale (model): ${proposal.proposedScope.rationale}`);
  }
  if (proposal.verification.checks.length > 0) {
    notes.push(
      `verification the model suggests (TEXT ONLY - it cannot add an executable ` +
      `check): ${proposal.verification.checks.join("; ")}`,
    );
  }
  for (const question of proposal.questions) notes.push(`model question: ${question}`);
  for (const rejected of rejectedPaths) {
    notes.push(`proposed path REFUSED (${rejected.reason}): ${rejected.path}`);
  }

  const plan = Plan.parse({
    // The summary is model text, and it is presented as such. It is a label on
    // a proposal a human is about to read, not an instruction to anything.
    summary: proposal.summary || `Plan for: ${request}`,
    steps,
    allowedScope,
    risks: [
      ...proposal.risks,
      // A refused path is promoted into `risks`, where a human reads it at the
      // gate, rather than left only in the notes further down the payload.
      ...(rejectedPaths.length > 0
        ? [
            `The model proposed ${rejectedPaths.length} path(s) that trusted code ` +
            `REFUSED: ${rejectedPaths.map((r) => `${r.path} (${r.reason})`).join("; ")}. ` +
            "They are not in the approved scope. Treat this proposal with care.",
          ]
        : []),
      "This plan was proposed by a language model and is UNVERIFIED. It may be " +
      "wrong, incomplete, or influenced by text inside the repository.",
    ],
    highestRisk,
  });

  return { plan, rejectedPaths, notes };
}
