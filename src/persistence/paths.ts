import path from "node:path";
import fs from "node:fs";

/**
 * Where orchestrator machine state lives. Deliberately separate from the
 * project store: this directory is disposable, the project store is not.
 */
export function orchestratorHome(): string {
  const home = process.env.ORCHESTRATOR_HOME ?? path.join(process.cwd(), ".orchestrator");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function checkpointDbPath(): string {
  return path.join(orchestratorHome(), "checkpoints.sqlite");
}

/** Root of the human-readable project store. */
export function projectsRoot(): string {
  const root = process.env.ORCHESTRATOR_PROJECTS ?? path.join(process.cwd(), "projects");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export class PathEscapeError extends Error {
  constructor(requested: string, root: string) {
    super(`Path "${requested}" resolves outside the project root "${root}".`);
    this.name = "PathEscapeError";
  }
}

/**
 * LEXICAL containment only. Resolve a path and prove it stays inside `root`
 * on the basis of the path string alone.
 *
 * Rejects `..` traversal, absolute escapes, and (on Windows) cross-drive paths.
 *
 * !! THIS IS NOT SUFFICIENT FOR UNTRUSTED CONTENT. !!
 *
 * A symlink - or, on Windows, a directory junction, which any user can create
 * without privilege - can make a lexically perfect path resolve somewhere else
 * entirely:
 *
 *     project/allowed/link  ->  /somewhere/else
 *
 * For anything touching a PROJECT's repository, use `FsBoundary` in
 * security/fsBoundary.ts, which performs this check AND resolves symlinks
 * before checking again.
 *
 * This function remains in use for the orchestrator's OWN store, where the
 * root is a directory the orchestrator itself created and the "untrusted"
 * input is a validated kebab-case project id.
 */
export function resolveWithin(root: string, requested: string): string {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, requested);

  const rel = path.relative(absoluteRoot, candidate);
  const escapes =
    rel.startsWith("..") ||
    path.isAbsolute(rel) ||
    (rel === ".." );

  if (escapes) throw new PathEscapeError(requested, absoluteRoot);
  return candidate;
}

export function isWithin(root: string, requested: string): boolean {
  try {
    resolveWithin(root, requested);
    return true;
  } catch {
    return false;
  }
}
