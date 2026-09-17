import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE ORCHESTRATOR DOES NOT DEVELOP ITSELF (Task 014)
 *
 * ---------------------------------------------------------------------------
 * TARGET-PROJECT AUTONOMY  !=  ORCHESTRATOR SELF-MODIFICATION
 * ---------------------------------------------------------------------------
 * The autonomous loop may implement, verify and review changes to the project
 * it was pointed at. Every control that makes that safe - the grant authority,
 * the write boundary, the check policy, the task-status table, the provenance
 * ranks, this file - is code in the orchestrator's own installation. A run
 * whose working directory is that installation would be a run in which the
 * thing being changed is the thing doing the checking.
 *
 * So a project whose working directory IS the orchestrator's installation, is
 * INSIDE it, or ENCLOSES it is refused before a run is created. Not marked as
 * high risk, not gated behind an extra approval: refused. If the orchestrator
 * is ever to develop itself, that needs a separately designed authority model,
 * and the first step of that design is deleting this refusal on purpose.
 *
 * The installation root is derived from THIS module's location at runtime, so
 * it is correct for `src/` under tsx and for `dist/` after a build, and cannot
 * be pointed elsewhere by configuration.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The orchestrator's own installation root (the directory holding package.json). */
export function orchestratorRoot(): string {
  return canonical(path.resolve(here, "..", ".."));
}

/**
 * Canonical form for comparison: real path where it exists, resolved where it
 * does not, and case-folded because the filesystems this runs on are.
 */
function canonical(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Not on disk yet. Compare the resolved form; a directory that does not
    // exist cannot be the installation, but it could still enclose it.
  }
  return resolved.toLowerCase();
}

export type SelfBoundaryVerdict =
  | { refused: false }
  | { refused: true; relation: "is" | "inside" | "encloses"; installation: string };

/** Would operating on `workingDir` be operating on the orchestrator itself? */
export function selfBoundaryVerdict(workingDir: string): SelfBoundaryVerdict {
  const root = orchestratorRoot();
  const target = canonical(workingDir);
  if (target === root) return { refused: true, relation: "is", installation: root };
  if (target.startsWith(root + path.sep)) {
    return { refused: true, relation: "inside", installation: root };
  }
  // A filesystem root ("c:\\", "/") already ends with the separator.
  const prefix = target.endsWith(path.sep) ? target : target + path.sep;
  if (root.startsWith(prefix)) {
    return { refused: true, relation: "encloses", installation: root };
  }
  return { refused: false };
}

export class SelfModificationRefused extends Error {
  constructor(readonly verdict: Extract<SelfBoundaryVerdict, { refused: true }>, workingDir: string) {
    super(
      `Refused: the project's working directory "${workingDir}" ${
        verdict.relation === "is" ? "is"
        : verdict.relation === "inside" ? "is inside"
        : "encloses"
      } the orchestrator's own installation. The orchestrator does not develop ` +
      "itself; that would need a separately designed authority model.",
    );
    this.name = "SelfModificationRefused";
  }
}

/** Throw unless the working directory is clear of the installation. */
export function assertNotSelfTarget(workingDir: string): void {
  const verdict = selfBoundaryVerdict(workingDir);
  if (verdict.refused) throw new SelfModificationRefused(verdict, workingDir);
}
