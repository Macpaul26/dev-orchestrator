import type { GrantAuthority } from "./session.js";
import type { ProjectStore } from "../projects/projectStore.js";
import { GrantDenied, type ImplementationGrant } from "../domain/grant.js";

/**
 * THE STORE-BACKED GRANT AUTHORITY
 *
 * Answers, on every capability use: *is the authority that created this session
 * still in force?*
 *
 * That is a different question from the ones the session can answer itself. The
 * session holds a frozen grant, so it can prove the grant has not been altered
 * and has not expired - but a frozen copy cannot notice that the record on disk
 * was revoked, deleted, or claimed by a different attempt in the meantime.
 *
 * ---------------------------------------------------------------------------
 * WHY "CONSUMED" IS NOT SIMPLY A DENIAL
 * ---------------------------------------------------------------------------
 * A grant is consumed the instant its own attempt claims it - BEFORE the agent
 * runs. Denying on `consumed` would therefore deny the very attempt the claim
 * authorised, and no implementation could ever write anything.
 *
 * So the question is not "is it consumed?" but "is the claim that authorised ME
 * still the claim in force?". A session records the claim id it was created
 * under; if the stored claim id differs - because somebody else claimed it, or
 * because the claim was made after this session was built - authority is gone
 * and everything fails closed.
 *
 * A session created with `claimId: null` (no claim taken) is denied the moment
 * any claim appears, which is the correct reading: it never held the grant.
 */
export class StoredGrantAuthority implements GrantAuthority {
  constructor(
    private readonly store: ProjectStore,
    private readonly grant: ImplementationGrant,
    /** The claim this session was created under, or null if it took none. */
    private readonly claimId: string | null,
  ) {}

  revalidate(): void {
    const stored = this.store.getGrant(this.grant.projectId, this.grant.grantId);

    if (!stored) {
      throw new GrantDenied(
        "unknown_grant",
        `Grant ${this.grant.grantId} is no longer present in the project store.`,
      );
    }
    if (stored.fingerprint !== this.grant.fingerprint) {
      throw new GrantDenied(
        "tampered",
        `Grant ${this.grant.grantId} no longer matches the record this session was created from.`,
      );
    }
    if (stored.status === "revoked") {
      throw new GrantDenied("revoked", `Grant ${this.grant.grantId} was revoked.`);
    }

    const currentClaim = this.store.grantClaimId(this.grant.projectId, this.grant.grantId);
    if (currentClaim !== this.claimId) {
      throw new GrantDenied(
        "consumed",
        `Grant ${this.grant.grantId} is held by a different implementation attempt.`,
      );
    }
  }
}
