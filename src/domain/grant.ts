import { z } from "zod";
import crypto from "node:crypto";
import { Capability, assertGrantable, isMutating } from "./capability.js";
import { classifyScope, normalisePath } from "./scope.js";
import { DenialReason } from "./denial.js";

/**
 * THE IMPLEMENTATION GRANT
 *
 * The object that turns "a human approved this plan" into "this specific run may
 * write these specific paths, until this specific time".
 *
 * The invariant it exists to enforce:
 *
 *   > A grant authorises ONE bounded implementation run, not the orchestrator
 *   > forever.
 *
 * There is deliberately no global "implementation enabled" flag anywhere in the
 * system. Without a grant, the write path is not merely refused - the session
 * that would perform it is never constructed.
 *
 * ---------------------------------------------------------------------------
 * WHAT "TAMPER-EVIDENT" HONESTLY MEANS HERE
 * ---------------------------------------------------------------------------
 * `fingerprint` is a SHA-256 over the grant's binding fields. It is NOT a
 * signature - there is no key, and this file deliberately holds no secret.
 *
 * The real defence is that THE STORED GRANT IS AUTHORITATIVE, not the copy a
 * caller presents. Validation re-reads the issued grant from the project store
 * and compares. An agent that edits its own copy - widening `allowedScope`,
 * adding `git.mutate`, pushing out `expiresAt` - fails against the stored
 * record. The fingerprint additionally makes an edit to the STORE detectable.
 *
 * What this does NOT defend against: a process that can already write to the
 * orchestrator's own project store can rewrite both the grant and its
 * fingerprint. That is a real limitation, it is stated in docs/PHASE-4A.md, and
 * it is not papered over here.
 */

/**
 * THE GRANT LIFECYCLE
 *
 *   active    issued by a human approval, never yet claimed
 *   consumed  an implementation attempt has CLAIMED it - permanently unusable
 *   revoked   withdrawn
 *   expired   past `expiresAt`
 *
 * `consumed` is terminal and irreversible. It is reached by claiming the grant,
 * not by finishing successfully: a run that failed, was cancelled, or whose
 * process died has still used up its one authorisation. See `ProjectStore.claimGrant`.
 */
export const GrantStatus = z.enum(["active", "consumed", "revoked", "expired"]);
export type GrantStatus = z.infer<typeof GrantStatus>;

/**
 * ABSOLUTE MUTATION BOUNDS.
 *
 * A human approving a plan is authorising a bounded edit, not a rewrite. These
 * are the most any grant may ever carry, whatever the caller asks for; raising
 * them is an edit to this file, reviewable on its own.
 *
 * Chosen for Phase 4A, where no coding agent exists yet and every write is a
 * deliberate, in-scope file edit. They are intentionally well below what a
 * repository-wide operation would need.
 */
export const MAX_GRANT_WRITES = 1_000;
export const MAX_GRANT_WRITE_BYTES = 4 * 1024 * 1024;

export const ImplementationGrant = z.object({
  grantId: z.string().min(1),

  // ---- binding: a grant is meaningless outside exactly this context --------
  projectId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  /** The human approval this grant descends from. Never machine-minted alone. */
  approvalId: z.string().min(1),

  // ---- provenance ---------------------------------------------------------
  /** A person. `applyHumanDecision` is the only thing that produces one. */
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),

  // ---- bounds -------------------------------------------------------------
  /** Paths the implementation may touch. Empty authorises NOTHING. */
  allowedScope: z.array(z.string()).default([]),
  capabilities: z.array(Capability).default([]),
  /** Not usable before this instant. */
  notBefore: z.string().datetime(),
  /** Not usable after this instant. A grant always expires. */
  expiresAt: z.string().datetime(),
  /**
   * Mutation budget, so a looping agent cannot rewrite a repository.
   *
   * `.max()` is the point: without it a caller could ask for `Number.MAX_SAFE_INTEGER`
   * and the "ceiling" would be decoration. Enforcing it in the SCHEMA rather than
   * only in `issueGrant` means a hand-edited grant file above the limit fails to
   * parse - it cannot be smuggled in through the store either.
   *
   * `.int()` additionally rejects `Infinity` and `NaN`, since neither is an
   * integer, so no floating-point value can slip past the comparison.
   */
  maxWrites: z.number().int().positive().max(MAX_GRANT_WRITES).default(200),
  /** Ceiling on the size of any single written file. Same reasoning. */
  maxWriteBytes: z.number().int().positive().max(MAX_GRANT_WRITE_BYTES).default(1024 * 1024),

  status: GrantStatus.default("active"),
  /** SHA-256 over the binding fields. Detects edits to the stored record. */
  fingerprint: z.string().min(1),
});
export type ImplementationGrant = z.infer<typeof ImplementationGrant>;

/** Fields that define what the grant permits. Changing any changes the id. */
function bindingMaterial(grant: Omit<ImplementationGrant, "fingerprint">): string {
  return JSON.stringify([
    grant.grantId,
    grant.projectId,
    grant.runId,
    grant.taskId,
    grant.approvalId,
    grant.approvedBy,
    grant.approvedAt,
    [...grant.allowedScope].sort(),
    [...grant.capabilities].sort(),
    grant.notBefore,
    grant.expiresAt,
    grant.maxWrites,
    grant.maxWriteBytes,
  ]);
}

export function fingerprintGrant(
  grant: Omit<ImplementationGrant, "fingerprint">,
): string {
  return crypto.createHash("sha256").update(bindingMaterial(grant)).digest("hex");
}

export function newGrantId(): string {
  return `grn_${crypto.randomUUID()}`;
}

/**
 * Deterministic grant id, derived from (run, attempt).
 *
 * Same reasoning as `approvalIdFor`: a LangGraph node body replays from the top
 * on resume, so anything minted with a random id there produces a different
 * value on every replay - orphaning the previous grant in the store and making
 * the audit trail impossible to follow. Deriving it keeps one grant per
 * (run, plan revision).
 */
export function grantIdFor(runId: string, attempt: number): string {
  return `grn_${runId}_${attempt}`;
}

export interface IssueGrantInput {
  projectId: string;
  runId: string;
  approvalId: string;
  approvedBy: string;
  allowedScope: readonly string[];
  capabilities: readonly Capability[];
  taskId?: string | null;
  /** How long the grant stays usable. Bounded by MAX_GRANT_LIFETIME_MS. */
  lifetimeMs?: number;
  maxWrites?: number;
  maxWriteBytes?: number;
  now?: Date;
  /** Supply a deterministic id where the caller replays. See `grantIdFor`. */
  grantId?: string;
}

/** A grant may never outlive this, whatever the caller asks for. */
export const MAX_GRANT_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_GRANT_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Mint a grant.
 *
 * Every unimplemented capability is rejected here rather than quietly dropped:
 * a caller asking for `process.execute` has misunderstood something, and
 * silently issuing a lesser grant would hide that.
 */
export function issueGrant(input: IssueGrantInput): ImplementationGrant {
  for (const capability of input.capabilities) assertGrantable(capability);

  const now = input.now ?? new Date();
  const lifetime = Math.min(
    input.lifetimeMs ?? DEFAULT_GRANT_LIFETIME_MS,
    MAX_GRANT_LIFETIME_MS,
  );

  const base = {
    grantId: input.grantId ?? newGrantId(),
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId ?? null,
    approvalId: input.approvalId,
    approvedBy: input.approvedBy,
    approvedAt: now.toISOString(),
    // Normalised once, so scope matching is not sensitive to how it was typed.
    allowedScope: [...new Set(input.allowedScope.map(normalisePath))].filter(Boolean).sort(),
    capabilities: [...new Set(input.capabilities)].sort(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + lifetime).toISOString(),
    // Clamped, not rejected - consistent with `resolveLimits` in
    // security/limits.ts. Clamping can only ever produce a NARROWER grant, so
    // a mistaken caller gets less authority than it asked for, never more.
    maxWrites: Math.min(input.maxWrites ?? 200, MAX_GRANT_WRITES),
    maxWriteBytes: Math.min(input.maxWriteBytes ?? 1024 * 1024, MAX_GRANT_WRITE_BYTES),
    status: "active" as const,
  };

  return ImplementationGrant.parse({ ...base, fingerprint: fingerprintGrant(base) });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Grant refusals draw from the shared denial vocabulary (domain/denial.ts) so
 * that a reason produced here, a reason produced by the write boundary, and a
 * reason recorded in the activity journal are all the same closed set.
 */
export type GrantDenialReason = DenialReason;
export const GrantDenialReason = DenialReason;

export class GrantDenied extends Error {
  constructor(
    readonly reason: DenialReason,
    message: string,
  ) {
    super(message);
    this.name = "GrantDenied";
  }
}

export interface GrantCheckContext {
  projectId: string;
  runId: string;
  now?: Date;
}

/**
 * Does the PRESENTED grant describe the same authorisation as the ISSUED one?
 *
 * Compares fingerprints rather than the whole object, because the fingerprint
 * covers exactly the binding fields - and `status` is deliberately NOT one of
 * them. A deep-equality check breaks the moment the stored grant is marked
 * `consumed`, reporting "tampered" for what is really a reuse attempt and
 * hiding the actual reason from whoever has to read the denial.
 */
export function assertSameGrant(
  presented: ImplementationGrant,
  stored: ImplementationGrant,
): void {
  if (fingerprintGrant(presented) !== presented.fingerprint) {
    throw new GrantDenied(
      "tampered",
      `Grant ${presented.grantId} does not match its own fingerprint; it has been modified.`,
    );
  }
  if (presented.fingerprint !== stored.fingerprint) {
    throw new GrantDenied(
      "tampered",
      `Grant ${presented.grantId} does not match the issued record; the copy supplied ` +
        "to the runner authorises something different from what was approved.",
    );
  }
}

/**
 * Validate a grant's own integrity and binding.
 *
 * Called at CAPABILITY USE TIME, not once at the start. A run that has been
 * going for an hour re-checks expiry on every write, so a grant cannot be
 * validated while fresh and then used indefinitely.
 */
export function assertGrantUsable(
  grant: ImplementationGrant | null | undefined,
  context: GrantCheckContext,
): asserts grant is ImplementationGrant {
  if (!grant) {
    throw new GrantDenied("no_grant", "No implementation grant was supplied.");
  }

  // Integrity first: everything below trusts these fields.
  if (fingerprintGrant(grant) !== grant.fingerprint) {
    throw new GrantDenied(
      "tampered",
      `Grant ${grant.grantId} does not match its own fingerprint; it has been modified.`,
    );
  }

  if (grant.projectId !== context.projectId) {
    throw new GrantDenied(
      "wrong_project",
      `Grant ${grant.grantId} is for project "${grant.projectId}", not "${context.projectId}".`,
    );
  }
  if (grant.runId !== context.runId) {
    throw new GrantDenied(
      "wrong_run",
      `Grant ${grant.grantId} is for run "${grant.runId}", not "${context.runId}".`,
    );
  }
  if (grant.status === "revoked") {
    throw new GrantDenied("revoked", `Grant ${grant.grantId} was revoked.`);
  }
  if (grant.status === "consumed") {
    throw new GrantDenied("consumed", `Grant ${grant.grantId} has already been used.`);
  }

  const now = (context.now ?? new Date()).getTime();
  if (now < Date.parse(grant.notBefore)) {
    throw new GrantDenied("not_yet_valid", `Grant ${grant.grantId} is not yet valid.`);
  }
  if (now >= Date.parse(grant.expiresAt)) {
    throw new GrantDenied(
      "expired",
      `Grant ${grant.grantId} expired at ${grant.expiresAt}.`,
    );
  }
}

/** Does this grant carry the capability, and does the capability exist at all? */
export function assertCapability(
  grant: ImplementationGrant,
  capability: Capability,
): void {
  if (!grant.capabilities.includes(capability)) {
    throw new GrantDenied(
      "capability_not_granted",
      `Grant ${grant.grantId} does not carry "${capability}".`,
    );
  }
  // Re-checked even though issueGrant refused it: a grant read back from disk,
  // or written by an older build, must not activate a missing implementation.
  try {
    assertGrantable(capability);
  } catch (error) {
    throw new GrantDenied(
      "capability_not_implemented",
      (error as Error).message,
    );
  }
}

/**
 * Is this path inside what the human authorised?
 *
 * Reuses `classifyScope`, so the rules that decide scope DRIFT after the fact
 * are the same rules that decide what may be written in the first place. Two
 * implementations would eventually disagree, and the disagreement would be a
 * security hole.
 */
export function assertInScope(grant: ImplementationGrant, relativePath: string): void {
  const verdict = classifyScope([relativePath], grant.allowedScope);
  if (verdict.drift.length > 0) {
    throw new GrantDenied(
      "out_of_scope",
      verdict.emptyScope
        ? `Grant ${grant.grantId} authorises no paths at all, so "${relativePath}" is denied.`
        : `"${relativePath}" is outside the approved scope [${grant.allowedScope.join(", ")}].`,
    );
  }
}

/** True when the grant permits any repository mutation, so a lock is required. */
export function grantIsMutating(grant: ImplementationGrant): boolean {
  return grant.capabilities.some(isMutating);
}
