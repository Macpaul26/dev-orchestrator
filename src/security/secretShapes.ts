/**
 * CREDENTIAL-SHAPED VALUES
 *
 * A narrow, VALUE-shaped check: does this text look like it contains a live
 * secret?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM security/sensitive.ts
 * ---------------------------------------------------------------------------
 * That module classifies PATHS by name - `.env`, `deploy.pem`, anything under a
 * credential directory. It is the right tool for "may this file be opened at
 * all", and it runs before a single byte is read.
 *
 * This answers a different question that a path cannot: an ordinary,
 * perfectly-readable source file may still have an API key pasted into it. Two
 * questions, two mechanisms - rather than one stretched to cover both badly.
 *
 * ---------------------------------------------------------------------------
 * IT IS A BACKSTOP, NOT A GUARANTEE
 * ---------------------------------------------------------------------------
 * It catches recognisable formats. A secret that reads as ordinary prose - a
 * password in a sentence, an internal hostname, a customer name - passes
 * straight through, and nothing here should be relied on as though it did not.
 * The real protections remain the path policy, the bounds, and not sending file
 * contents where they are not needed.
 *
 * Lives in `security/` because it is shared: the reasoning context assembler
 * (Task 007) and the repository evidence service (Task 008) both use it, and a
 * second copy would eventually disagree with this one.
 */

const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /**
   * `NAME=value` where the name is credential-shaped and the value is long
   * enough to be real.
   *
   * Bounded deliberately: `PASSWORD_MIN_LENGTH is 12` must not trip it, or the
   * check becomes noise everyone learns to route around.
   */
  /(?:^|\s)[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)\s*[:=]\s*\S{8,}/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some((pattern) => pattern.test(text));
}
