import { z } from "zod";
import type { RiskLevel } from "./risk.js";

/**
 * THE CAPABILITY MODEL
 *
 * "Write access" is not one permission. Treating it as one is how a system that
 * was allowed to edit a file ends up allowed to run a command, because both got
 * filed under "the agent needs to do things".
 *
 * So each distinct power is named separately, and three properties are kept
 * apart deliberately:
 *
 *   DECLARED     the capability exists in this enum
 *   IMPLEMENTED  the orchestrator has code that can actually perform it
 *   GRANTED      a human authorised it, for one run, within a scope
 *
 * A capability being DECLARED gives nothing. `git.mutate` appears below and is
 * unusable: there is no implementation, and `assertGrantable` refuses to put it
 * in a grant. The enum exists so the shape of the eventual system is visible and
 * so a later phase adds an implementation rather than inventing a new concept.
 */
export const Capability = z.enum([
  /** Read file contents inside the project boundary. */
  "repo.read",
  /** Read paths, sizes, git status - no file contents. */
  "repo.metadata.read",
  /** Create or replace a file inside the approved scope. */
  "repo.file.write",
  /** Delete a file inside the approved scope. */
  "repo.file.delete",
  /** Commit, branch, reset, push. NOT IMPLEMENTED. */
  "git.mutate",
  /** Run a program - ANY program, chosen at call time. NOT IMPLEMENTED. */
  "process.execute",
  /**
   * Run a PREDEFINED verification check from trusted project configuration.
   *
   * Deliberately a separate capability from `process.execute`, and the
   * separation is the entire security argument for Task 005. The two differ in
   * WHO CHOOSES WHAT RUNS:
   *
   *   process.execute       the caller supplies the program and its arguments
   *   verification.execute  both are fixed by configuration captured before the
   *                         untrusted agent ran, and neither can be influenced
   *                         from inside the run
   *
   * Granting this does NOT grant the other, and no code path widens one into
   * the other. `process.execute` stays unimplemented.
   */
  "verification.execute",
  /** Open a socket. NOT IMPLEMENTED. */
  "network.access",
]);
export type Capability = z.infer<typeof Capability>;

/**
 * Capabilities the orchestrator can actually perform in this phase.
 *
 * THE LIST IS THE ENFORCEMENT POINT. A capability absent from here cannot enter
 * a grant, so no code path can reach an implementation that does not exist -
 * and adding one later is a deliberate edit to this file, reviewable on its own.
 */
export const IMPLEMENTED_CAPABILITIES: readonly Capability[] = [
  "repo.read",
  "repo.metadata.read",
  "repo.file.write",
  "repo.file.delete",
  "verification.execute",
] as const;

/**
 * Declared but deliberately absent, with the reason kept next to the name so
 * "why can't it do X" is answered by reading this file.
 */
export const UNIMPLEMENTED_CAPABILITIES: Readonly<Record<string, string>> = {
  "git.mutate":
    "Phase 4A does not commit, branch, reset or push. Repository history is " +
    "changed by a human, and the read-only git boundary stays intact.",
  "process.execute":
    "No arbitrary process execution. The processes this system starts are " +
    "read-only git from a fixed allowlist (adapters/repository/gitExec.ts) and " +
    "verification checks fixed by trusted configuration - neither lets a " +
    "caller choose what runs, which is what this capability would mean.",
  "network.access":
    "No network access. No model API, no GitHub, no package registry.",
};

/** Static risk, declared next to the capability - never computed at call time. */
export const CAPABILITY_RISK: Readonly<Record<Capability, RiskLevel>> = {
  "repo.read": "LOW",
  "repo.metadata.read": "LOW",
  "repo.file.write": "HIGH",
  "repo.file.delete": "HIGH",
  "git.mutate": "HIGH",
  "process.execute": "HIGH",
  "verification.execute": "HIGH",
  "network.access": "HIGH",
};

/** Capabilities that mutate the repository. Used to decide when a lock is needed. */
export const MUTATING_CAPABILITIES: readonly Capability[] = [
  "repo.file.write",
  "repo.file.delete",
  "git.mutate",
] as const;

export function isImplemented(capability: Capability): boolean {
  return IMPLEMENTED_CAPABILITIES.includes(capability);
}

export function isMutating(capability: Capability): boolean {
  return MUTATING_CAPABILITIES.includes(capability);
}

export class CapabilityNotAvailable extends Error {
  constructor(
    readonly capability: Capability,
    reason: string,
  ) {
    super(`Capability "${capability}" is not available: ${reason}`);
    this.name = "CapabilityNotAvailable";
  }
}

/**
 * Refuse to treat an unimplemented capability as usable.
 *
 * Called when a grant is issued AND again when a capability is exercised. The
 * second check is the one that matters: a grant loaded from disk, written by an
 * older version or edited by hand, still cannot activate something that has no
 * implementation.
 */
export function assertGrantable(capability: Capability): void {
  if (!isImplemented(capability)) {
    throw new CapabilityNotAvailable(
      capability,
      UNIMPLEMENTED_CAPABILITIES[capability] ?? "not implemented in this phase",
    );
  }
}

/** A capability with everything a human needs to judge it. For `tools`. */
export interface CapabilityStatus {
  capability: Capability;
  risk: RiskLevel;
  implemented: boolean;
  mutating: boolean;
  /** What must be true before it can be exercised. */
  requires: string;
  note: string | null;
}

export function capabilityMatrix(): CapabilityStatus[] {
  return Capability.options.map((capability) => {
    const implemented = isImplemented(capability);
    return {
      capability,
      risk: CAPABILITY_RISK[capability],
      implemented,
      mutating: isMutating(capability),
      requires: !implemented
        ? "not implemented"
        : capability === "verification.execute"
          ? "a human-approved grant, and checks fixed by trusted configuration " +
            "captured before the run"
          : isMutating(capability)
            ? "a human-approved implementation grant, bound to this run and scope"
            : "nothing - read-only",
      note: UNIMPLEMENTED_CAPABILITIES[capability] ?? null,
    };
  });
}
