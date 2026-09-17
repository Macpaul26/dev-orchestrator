import type { HistoricalSignal, HistoricalItem } from "../domain/historicalSignal.js";
import {
  StrategyProposal, STRATEGY_LIMITS,
  type StrategyProposal as TStrategyProposal,
  type StrategyPosture,
} from "../domain/strategy.js";

/**
 * STRATEGY DERIVATION - A PURE FUNCTION OVER THE HISTORICAL SIGNAL
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * `deriveStrategy` takes the Task 012 signal and returns a proposal. It reads
 * nothing else: no store, no retrieval, no evaluator, no filesystem, no clock,
 * no model. It is deterministic because it is a function of its argument and
 * of constants.
 *
 * ---------------------------------------------------------------------------
 * WHY THAT IS THE WHOLE SAFETY CASE
 * ---------------------------------------------------------------------------
 * Every hard property Task 013 must hold - no historical text reaches the
 * model, no other project's history is used, no inadmissible evidence counts -
 * is a property of the INPUT, established by Tasks 009 through 012 and tested
 * there. A function that cannot reach past its input cannot violate them. The
 * strategy layer therefore adds no new trust boundary: it adds a summary of
 * evidence that already crossed one.
 *
 * ---------------------------------------------------------------------------
 * NOT A SECOND REASONING MODEL, AND NOT A SECOND CONFIDENCE FORMULA
 * ---------------------------------------------------------------------------
 * No model is consulted. No score is computed. Each pattern's status and
 * confidence are Task 011's, carried verbatim. The only thing derived here is
 * the posture, by counting statuses under the documented precedence.
 */

/** Code-unit ordering. Never locale collation. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * THE TOTAL ORDERING OF PATTERNS IN A PROPOSAL.
 *
 *     status precedence (contradicted, contested-relevant first)
 *       -> confidence DESC
 *       -> patternKey ASC
 *
 * Contradicted patterns lead, so the thing a proposal most needs to surface is
 * never pushed past a bound by a run of successes. Confidence orders within a
 * status. The pattern key makes the order total: keys are unique per pattern,
 * so no two entries compare equal and the sort cannot depend on its own
 * stability or on the order the signal happened to list them in.
 *
 * Exported so it can be tested directly - the same lesson as Task 010's
 * comparator, where a tie-break that only ever agreed with insertion order was
 * unobservable through the public API.
 */
const STATUS_ORDER: Readonly<Record<HistoricalItem["status"], number>> = {
  contradicted: 0,
  uncertain: 1,
  supported: 2,
  insufficient_evidence: 3,
};

export function comparePatterns(a: HistoricalItem, b: HistoricalItem): number {
  const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (status !== 0) return status;
  const ac = a.confidence ?? -1;
  const bc = b.confidence ?? -1;
  if (ac !== bc) return bc - ac;
  return byCodeUnit(a.patternKey, b.patternKey);
}

/**
 * THE POSTURE, BY PRECEDENCE. See `DERIVATION_POLICY`.
 *
 * Contradiction is checked first, on purpose: repeated success must never
 * erase an independently supported failure.
 */
function postureOf(supported: number, contradicted: number): StrategyPosture {
  if (contradicted > 0 && supported > 0) return "contested";
  if (contradicted > 0) return "cautionary";
  if (supported > 0) return "established";
  return "inconclusive";
}

export function deriveStrategy(signal: HistoricalSignal): TStrategyProposal {
  if (signal.kind === "unavailable") {
    return StrategyProposal.parse({ kind: "unavailable", reason: signal.reason });
  }
  if (signal.kind === "none") {
    return StrategyProposal.parse({ kind: "none", retrievalBounded: signal.retrievalBounded });
  }

  /**
   * `present` with no items: relevant history exists but nothing in it was
   * independently assessed. There is no evidence to take a posture on, and
   * saying so is more useful than manufacturing one.
   */
  if (signal.items.length === 0) {
    return StrategyProposal.parse({
      kind: "insufficient",
      unassessed: signal.retrieved,
      retrievalBounded: signal.retrievalBounded,
    });
  }

  const patterns = [...signal.items].sort(comparePatterns).slice(0, STRATEGY_LIMITS.maxPatterns);

  let supported = 0;
  let contradicted = 0;
  let uncertain = 0;
  let supportingVotes = 0;
  let contradictingVotes = 0;
  for (const pattern of patterns) {
    if (pattern.status === "supported") supported += 1;
    else if (pattern.status === "contradicted") contradicted += 1;
    else if (pattern.status === "uncertain") uncertain += 1;
    supportingVotes += pattern.supporting;
    contradictingVotes += pattern.contradicting;
  }

  return StrategyProposal.parse({
    kind: "proposal",
    posture: postureOf(supported, contradicted),
    patterns,
    supported,
    contradicted,
    uncertain,
    supportingVotes,
    contradictingVotes,
    // Any bound anywhere underneath makes the proposal bounded. A partial look
    // must never present as a complete one.
    bounded: signal.retrievalBounded || signal.evaluationsBounded > 0,
    retrievalStop: signal.retrievalStop,
    evaluationsBounded: signal.evaluationsBounded,
    omitted: signal.omitted,
  });
}

/**
 * THE TEXT THE MODEL SEES.
 *
 * Every interpolated value is a number, an enum member or a hex digest. There
 * is no free text to escape because there is no free text. No sentence
 * instructs; the closing one says what the proposal is and what it is not, so
 * a model that ignored the provenance label would still be told.
 *
 * Deterministic: a pure function of the proposal. Sized against
 * `maxRenderedChars` by the builder that emits it.
 */
export function renderStrategy(proposal: TStrategyProposal): string | null {
  if (proposal.kind !== "proposal") return null;

  const handles = proposal.patterns
    .map((p) => `${p.patternKey.slice(0, 12)}:${p.status}`)
    .join(", ");
  const bounded = proposal.bounded
    ? " The underlying look at the project's history was BOUNDED, not complete."
    : "";

  return (
    `Derived strategy posture from this project's evaluated history: ` +
    `${proposal.posture.toUpperCase()}. ` +
    `Relevant patterns with independent evidence: ${String(proposal.supported)} supported, ` +
    `${String(proposal.contradicted)} contradicted, ${String(proposal.uncertain)} uncertain ` +
    `(${String(proposal.supportingVotes)} supporting and ` +
    `${String(proposal.contradictingVotes)} contradicting independent records in total). ` +
    `Pattern handles: ${handles}.${bounded} ` +
    // No authority-shaped word anywhere, even negated - Task 012's lesson. A
    // test forbids the family of them in this text.
    "This is a derived summary of what happened before in this project. It " +
    "describes the past only: it is not advice, not permission, not an " +
    "instruction and not a requirement."
  );
}
