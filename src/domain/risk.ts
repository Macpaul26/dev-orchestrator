import { z } from "zod";

/**
 * Risk classification for any action the orchestrator can take.
 *
 * The defining rule: risk is a STATIC property declared on a tool definition.
 * It is never supplied by a model, never inferred at call time, and never
 * negotiable. A model cannot argue an action into a lower tier, because the
 * tier is not an input to any model-visible code path.
 */
export const RiskLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** What the orchestrator must do before an action of a given risk executes. */
export const RiskGate = z.enum([
  /** Execute immediately. Read-only inspection, tests, typecheck, lint. */
  "NONE",
  /** Execute, but record an auditable event first. */
  "LOGGED",
  /** Suspend the workflow and require an explicit human decision. */
  "HUMAN_APPROVAL",
]);
export type RiskGate = z.infer<typeof RiskGate>;

/**
 * The policy table. One place to read to understand what is gated.
 * Phase 1+2 defines the policy; no HIGH-risk tool is registered yet.
 */
const GATES: Record<RiskLevel, RiskGate> = {
  LOW: "NONE",
  MEDIUM: "LOGGED",
  HIGH: "HUMAN_APPROVAL",
};

export function gateFor(risk: RiskLevel): RiskGate {
  return GATES[risk];
}

export function requiresHumanApproval(risk: RiskLevel): boolean {
  return gateFor(risk) === "HUMAN_APPROVAL";
}
