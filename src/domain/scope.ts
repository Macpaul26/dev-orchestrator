import { z } from "zod";

/**
 * SCOPE SEMANTICS
 *
 * `Plan.allowedScope` is what a human authorised at the plan gate. This module
 * decides, deterministically, whether an observed changed path falls inside it.
 * It is the foundation for `ReviewReport.scopeDrift`.
 *
 * ---------------------------------------------------------------------------
 * SUPPORTED PATTERNS - the complete list
 * ---------------------------------------------------------------------------
 *
 *   src/auth/service.ts   EXACT FILE. Matches that path and nothing else.
 *
 *   src/auth/            DIRECTORY. Matches `src/auth/service.ts` and anything
 *   src/auth             nested beneath. A trailing slash is optional and
 *                        changes nothing.
 *
 *   src/*.ts             SINGLE SEGMENT WILDCARD. `*` matches any run of
 *                        characters WITHIN one path segment, never across `/`.
 *                        So `src/*.ts` matches `src/main.ts` but NOT
 *                        `src/deep/main.ts`.
 *
 *   src/**               RECURSIVE WILDCARD. `**` as a whole segment matches
 *   src/**\/*.ts         any number of segments, including none.
 *
 *   ?                    Matches exactly one character within a segment.
 *
 * Anything else is treated as a literal path. There is no brace expansion, no
 * character class, no negation - a bigger glob engine is a bigger attack
 * surface, and nothing in the system has needed one.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT SUBSTRING MATCHING
 * ---------------------------------------------------------------------------
 * `"tests/Button.test.ts".includes("src/")` is false, but
 * `"src-generated/x.ts".startsWith("src")` is TRUE - which would silently
 * authorise a directory nobody approved. Matching here is segment-aware: a
 * directory pattern only matches when the next character is a separator.
 *
 * ---------------------------------------------------------------------------
 * WINDOWS
 * ---------------------------------------------------------------------------
 * Both patterns and paths are normalised to forward slashes before matching, so
 * `src\auth\service.ts` and `src/auth/service.ts` are the same path. Matching
 * is case-sensitive: git reports paths case-sensitively even on Windows, and
 * lowercasing would let `SRC/` authorise `src/`.
 *
 * ---------------------------------------------------------------------------
 * THE EMPTY SCOPE
 * ---------------------------------------------------------------------------
 * An empty `allowedScope` authorises NOTHING, so every changed file is drift.
 * The alternative - empty means "anything" - would turn a plan that forgot to
 * declare its scope into an unrestricted one. Failing closed is the only safe
 * reading.
 */

export const ScopeVerdict = z.object({
  /** Observed paths that the approved scope authorises. */
  inScope: z.array(z.string()).default([]),
  /** Observed paths it does not. This IS the scope drift. */
  drift: z.array(z.string()).default([]),
  /** Scope entries that matched nothing. Useful signal, never an error. */
  unusedScope: z.array(z.string()).default([]),
  /** True when the plan authorised no paths at all. */
  emptyScope: z.boolean().default(false),
});
export type ScopeVerdict = z.infer<typeof ScopeVerdict>;

/**
 * Does this path contain a `..` SEGMENT?
 *
 * Scope matching is prefix-based, so without this check a path could satisfy an
 * authorised prefix and then climb straight back out of it:
 *
 *     "src/../../etc/passwd".startsWith("src/")   ->  true
 *
 * That string is lexically "inside src/" and physically nowhere near it. Any
 * path containing a traversal segment therefore matches NO scope entry and is
 * always reported as drift - the safe direction.
 *
 * (The filesystem boundary rejects such a path independently. This is the
 * second of the two checks, not the only one - but a scope layer that says
 * "authorised" about a traversal string is wrong on its own terms.)
 */
export function containsTraversal(input: string): boolean {
  return input
    .replace(/[\\/]+/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

/** Forward slashes, no leading `./`, no trailing slash, no duplicate slashes. */
export function normalisePath(input: string): string {
  let value = input.replace(/[\\/]+/g, "/").trim();
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/") && value.length > 1) value = value.slice(0, -1);
  return value;
}

/** Escape everything regex-special, then re-introduce `*` and `?` deliberately. */
function segmentToRegex(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * Compile one scope entry into a matcher.
 *
 * A pattern with no wildcard is both an exact-file match and a directory
 * prefix, which is what makes `src/auth` behave the way a human means it.
 */
function compile(pattern: string): (candidate: string) => boolean {
  const normalised = normalisePath(pattern);
  if (normalised === "" || normalised === ".") {
    return () => true; // the whole project root
  }

  const hasWildcard = normalised.includes("*") || normalised.includes("?");
  if (!hasWildcard) {
    const prefix = `${normalised}/`;
    return (candidate) => candidate === normalised || candidate.startsWith(prefix);
  }

  const segments = normalised.split("/");
  let source = "^";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // Matches any number of segments, including none.
      source += last ? "(?:.*)?" : "(?:[^/]+/)*";
      return;
    }
    source += segmentToRegex(segment);
    if (!last) source += "/";
  });
  // A directory-shaped wildcard pattern also authorises what is nested in it.
  source += "(?:/.*)?$";
  const regex = new RegExp(source);
  return (candidate) => regex.test(candidate);
}

/**
 * Classify observed changed paths against an approved scope.
 *
 * Pure and deterministic: same inputs, same verdict, no filesystem, no git, no
 * model. That is what lets scope drift be evidence rather than an opinion.
 */
export function classifyScope(
  observedFiles: readonly string[],
  allowedScope: readonly string[],
): ScopeVerdict {
  const observed = [...new Set(observedFiles.map(normalisePath))].filter(Boolean).sort();
  const patterns = [...new Set(allowedScope.map((s) => s.trim()))].filter(Boolean);

  if (patterns.length === 0) {
    return ScopeVerdict.parse({
      inScope: [], drift: observed, unusedScope: [], emptyScope: true,
    });
  }

  // A pattern that climbs out of the project authorises nothing.
  const matchers = patterns
    .filter((pattern) => !containsTraversal(pattern))
    .map((pattern) => ({ pattern, test: compile(pattern) }));
  const used = new Set<string>();
  const inScope: string[] = [];
  const drift: string[] = [];

  for (const file of observed) {
    // Traversal short-circuits every pattern: see `containsTraversal`.
    const matched = containsTraversal(file) ? [] : matchers.filter((m) => m.test(file));
    if (matched.length > 0) {
      inScope.push(file);
      for (const m of matched) used.add(m.pattern);
    } else {
      drift.push(file);
    }
  }

  return ScopeVerdict.parse({
    inScope,
    drift,
    unusedScope: patterns.filter((p) => !used.has(p)).sort(),
    emptyScope: false,
  });
}

/** Convenience for callers that only want the drift list. */
export function scopeDrift(
  observedFiles: readonly string[],
  allowedScope: readonly string[],
): string[] {
  return classifyScope(observedFiles, allowedScope).drift;
}
