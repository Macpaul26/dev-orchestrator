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
 * Resolve a caller-supplied path and PROVE it stays inside `root`.
 *
 * This is the containment primitive the future tool layer is built on. It is
 * implemented now, with tests, so no later phase has to invent it under time
 * pressure. Rejects `..` traversal, absolute escapes, and (on Windows)
 * cross-drive paths.
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
