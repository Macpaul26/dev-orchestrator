/**
 * SENSITIVE-FILE POLICY
 *
 * Repository inspection writes what it sees into workflow state, SQLite
 * checkpoints and the JSONL audit trail - all of them unencrypted, all of them
 * long-lived. A single unguarded `readFile(".env")` would put a live credential
 * in every one of those places permanently.
 *
 * So the inspector draws a hard line between:
 *
 *   METADATA about a file  - path, size, type, "changed"   -> always allowed
 *   CONTENTS of a file     - bytes, diff hunks             -> blocked when sensitive
 *
 * This is a CONSERVATIVE BASELINE, not a secret detector. It matches on
 * location and name, never on content, and it is expected to grow. It does not
 * attempt to find a secret pasted into an ordinary source file - nothing here
 * claims that guarantee.
 *
 * Matching is case-insensitive: Windows filesystems are, and `.ENV` is `.env`.
 */

export type SensitiveReason =
  | "dotenv"
  | "private_key"
  | "credential_file"
  | "credential_directory"
  | "package_registry_auth";

export interface SensitivityVerdict {
  sensitive: boolean;
  reason: SensitiveReason | null;
  /** Human-readable explanation, surfaced in evidence instead of the contents. */
  detail: string | null;
}

const NOT_SENSITIVE: SensitivityVerdict = { sensitive: false, reason: null, detail: null };

/**
 * Files that LOOK like secrets but exist precisely to be committed and read.
 * Checked first, so `.env.example` stays inspectable.
 */
const TEMPLATE_SUFFIXES = [
  ".example", ".sample", ".template", ".dist", ".defaults",
];

/** Directories whose entire contents are credential material. */
const CREDENTIAL_DIRECTORIES = [".ssh", ".aws", ".gnupg", ".docker", ".kube"];

/** Exact filenames that are credential stores. */
const CREDENTIAL_FILENAMES = new Set([
  "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml",
  ".netrc", "_netrc", ".git-credentials", ".htpasswd", "htpasswd",
  ".pgpass", "auth.json", ".dockercfg",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);

/** Registry/auth dotfiles that carry tokens. */
const REGISTRY_AUTH_FILENAMES = new Set([".npmrc", ".pypirc", ".yarnrc.yml", ".gem/credentials"]);

/** Extensions that are key material by definition. */
const PRIVATE_KEY_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".asc", ".ppk", ".gpg",
]);

/** Filename patterns for key and token material. */
const KEY_NAME_PATTERNS = [
  /(^|[._-])private[._-]?key([._-]|$)/,
  /(^|[._-])service[._-]?account([._-]|$)/,
  /(^|[._-])secret[._-]?key([._-]|$)/,
];

/** `terraform.tfvars` and friends routinely hold credentials. */
const TFVARS = /\.tfvars(\.json)?$/;

function isTemplate(name: string): boolean {
  return TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Classify a repository-relative, forward-slash path.
 *
 * Takes the PATH only - never the contents - so it is safe to call before
 * anything has been read.
 */
export function classifySensitivity(relativePath: string): SensitivityVerdict {
  const normalised = relativePath.replace(/[\\/]+/g, "/").toLowerCase();
  const segments = normalised.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "";

  // Committed templates are the point of exception, so they come first.
  if (isTemplate(name)) return NOT_SENSITIVE;

  for (const dir of CREDENTIAL_DIRECTORIES) {
    if (segments.slice(0, -1).includes(dir)) {
      return {
        sensitive: true,
        reason: "credential_directory",
        detail: `inside a credential directory ("${dir}/")`,
      };
    }
  }

  // .env, .env.local, .env.production - but not .env.example (handled above).
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) {
    return { sensitive: true, reason: "dotenv", detail: "environment file" };
  }

  if (CREDENTIAL_FILENAMES.has(name)) {
    return { sensitive: true, reason: "credential_file", detail: "known credential file" };
  }

  if (REGISTRY_AUTH_FILENAMES.has(name)) {
    return {
      sensitive: true,
      reason: "package_registry_auth",
      detail: "package-registry authentication file",
    };
  }

  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  if (PRIVATE_KEY_EXTENSIONS.has(extension)) {
    return { sensitive: true, reason: "private_key", detail: `key material ("${extension}")` };
  }

  if (TFVARS.test(name)) {
    return { sensitive: true, reason: "credential_file", detail: "terraform variables file" };
  }

  if (KEY_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return { sensitive: true, reason: "private_key", detail: "filename indicates key material" };
  }

  return NOT_SENSITIVE;
}

export function isSensitivePath(relativePath: string): boolean {
  return classifySensitivity(relativePath).sensitive;
}
