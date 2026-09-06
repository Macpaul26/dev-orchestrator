import { z } from "zod";

/**
 * WHY AN OPERATION WAS REFUSED
 *
 * One closed vocabulary for every refusal the implementation substrate can
 * produce, shared by the grant checks, the write boundary and the activity
 * journal.
 *
 * It is a single enum on purpose. The first version had the journal record a
 * `GrantDenialReason` while the write boundary produced its own codes, and the
 * four codes only the boundary knew about - `symlink_escape` among them - would
 * have failed schema validation at the moment they mattered most. A refusal that
 * cannot be written down is a refusal nobody can audit.
 *
 * Free-form error text never becomes a reason. The category is one of these; the
 * accompanying detail is a short sentence this codebase wrote.
 */
export const DenialReason = z.enum([
  // ---- authorisation --------------------------------------------------
  "no_grant",
  "unknown_grant",
  "tampered",
  "wrong_project",
  "wrong_run",
  "not_yet_valid",
  "expired",
  "revoked",
  "consumed",
  "capability_not_granted",
  "capability_not_implemented",

  // ---- bounds ----------------------------------------------------------
  "out_of_scope",
  "write_budget_exhausted",
  "file_too_large",

  // ---- filesystem boundary --------------------------------------------
  "path_escape",
  "symlink_escape",
  "sensitive_path",
  "not_a_file",
  "missing",
  "io_error",

  // ---- lifecycle -------------------------------------------------------
  "cancelled",
  "locked",
  "internal_error",
]);
export type DenialReason = z.infer<typeof DenialReason>;
