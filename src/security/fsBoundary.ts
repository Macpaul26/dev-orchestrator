import fs from "node:fs";
import path from "node:path";
import { PathEscapeError } from "../persistence/paths.js";

/**
 * THE FILESYSTEM SECURITY BOUNDARY
 *
 * Every filesystem path the orchestrator touches on a project's behalf passes
 * through here. This is the one place path containment is decided, so auditing
 * it means reading this file.
 *
 * Containment is checked TWICE, because the two checks catch different attacks:
 *
 *   1. LEXICAL containment - `path.resolve` + `path.relative`. Catches `..`
 *      traversal, absolute-path escapes and, on Windows, a different drive.
 *      This is what `resolveWithin` in persistence/paths.ts does, and it is
 *      necessary but NOT sufficient.
 *
 *   2. PHYSICAL containment - resolve every symlink in the chain, then check
 *      containment again. A lexically perfect path can still land outside the
 *      root:
 *
 *          project/allowed/link  ->  /somewhere/else
 *          "allowed/link/file.ts"      lexically inside; physically outside
 *
 *      On Windows the same escape is available through directory JUNCTIONS,
 *      which - unlike symlinks - need no special privilege to create. Both are
 *      resolved by `fs.realpathSync`, and both are rejected here.
 *
 * The invariant this class exists to enforce:
 *
 *   > No repository operation exposed by the orchestrator may resolve outside
 *   > its declared repository/working directory.
 */

/** Raised when a path escapes only after symlinks/junctions are resolved. */
export class SymlinkEscapeError extends PathEscapeError {
  constructor(
    requested: string,
    root: string,
    readonly resolvedTo: string,
  ) {
    super(requested, root);
    this.name = "SymlinkEscapeError";
    this.message =
      `Path "${requested}" is lexically inside "${root}" but resolves through a ` +
      `symlink or junction to "${resolvedTo}", which is outside it.`;
  }
}

/** Raised when the declared root itself is unusable. */
export class BoundaryRootError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_absolute"
      | "missing"
      | "not_a_directory"
      | "unreadable",
  ) {
    super(message);
    this.name = "BoundaryRootError";
  }
}

/** Guards against symlink cycles among dangling links. */
const MAX_SYMLINK_HOPS = 40;

/** True when `candidate` is `root` or lives underneath it, lexically. */
function lexicallyWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true; // the root itself
  if (path.isAbsolute(rel)) return false; // different drive / UNC share
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Fully resolve symlinks in `target`, whether or not it exists.
 *
 * `fs.realpathSync` only works on paths that exist, but containment must be
 * decided for paths that do NOT yet exist too - otherwise "does this file
 * exist?" becomes an unguarded question. So: resolve the deepest existing
 * ancestor with `realpathSync`, then re-attach the missing tail, following a
 * dangling symlink at the leaf by hand.
 */
function resolveThroughLinks(target: string, hops = 0): string {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new Error(`Too many symbolic links resolving "${target}".`);
  }
  try {
    return fs.realpathSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: does not exist. ENOTDIR: an ancestor is a file. Both mean "walk up".
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }

  const parent = path.dirname(target);
  if (parent === target) return target; // filesystem root

  const realParent = resolveThroughLinks(parent, hops + 1);
  const leaf = path.join(realParent, path.basename(target));

  // The leaf may itself be a symlink whose target does not exist. realpathSync
  // reports ENOENT for that, so follow it explicitly rather than treating a
  // dangling link as an ordinary absent file.
  try {
    if (fs.lstatSync(leaf).isSymbolicLink()) {
      const link = fs.readlinkSync(leaf);
      return resolveThroughLinks(path.resolve(realParent, link), hops + 1);
    }
  } catch {
    // Genuinely absent - `leaf` is already the resolved location.
  }
  return leaf;
}

export interface ResolvedPath {
  /** Absolute, symlink-resolved path. Use THIS for filesystem calls. */
  absolute: string;
  /** Forward-slash path relative to the boundary root. Use this for reporting. */
  relative: string;
}

export class FsBoundary {
  /** Canonical, symlink-resolved root. All containment is decided against it. */
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /**
   * Validate a declared root and build a boundary for it.
   *
   * The root must be absolute, must exist, and must be a directory - checked
   * eagerly so a misconfigured project fails with a clear reason instead of
   * producing confusing containment errors later.
   */
  static create(root: string): FsBoundary {
    if (!path.isAbsolute(root)) {
      throw new BoundaryRootError(`Root "${root}" is not an absolute path.`, "not_absolute");
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new BoundaryRootError(`Root "${root}" does not exist.`, "missing");
      }
      throw new BoundaryRootError(`Root "${root}" is not readable: ${code}.`, "unreadable");
    }
    if (!stat.isDirectory()) {
      throw new BoundaryRootError(`Root "${root}" is not a directory.`, "not_a_directory");
    }
    // Canonicalise once. If the root is itself reached through a symlink, every
    // later comparison is made against its real location.
    return new FsBoundary(fs.realpathSync(path.resolve(root)));
  }

  /**
   * Resolve a caller-supplied path and prove it stays inside the root - both
   * lexically and after symlink resolution.
   *
   * @throws PathEscapeError    traversal, absolute escape, wrong drive
   * @throws SymlinkEscapeError lexically fine, physically outside
   */
  resolve(requested: string): ResolvedPath {
    if (requested.includes("\0")) {
      throw new PathEscapeError(requested, this.root);
    }

    // ---- 1. lexical ------------------------------------------------------
    const candidate = path.resolve(this.root, requested);
    if (!lexicallyWithin(this.root, candidate)) {
      throw new PathEscapeError(requested, this.root);
    }

    // ---- 2. physical -----------------------------------------------------
    const physical = resolveThroughLinks(candidate);
    if (!lexicallyWithin(this.root, physical)) {
      throw new SymlinkEscapeError(requested, this.root, physical);
    }

    return { absolute: physical, relative: toPosix(path.relative(this.root, physical)) };
  }

  /** Non-throwing form, for callers that only need a yes/no. */
  contains(requested: string): boolean {
    try {
      this.resolve(requested);
      return true;
    } catch {
      return false;
    }
  }

  /** A boundary for a subdirectory, which can only ever narrow this one. */
  scopedTo(relative: string): FsBoundary {
    const { absolute } = this.resolve(relative);
    return FsBoundary.create(absolute);
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
