import fs from "node:fs";
import path from "node:path";
import { toPosix, type FsBoundary } from "./fsBoundary.js";
import { classifySensitivity } from "./sensitive.js";
import { type InspectionLimits, DEFAULT_LIMITS } from "./limits.js";
import {
  FileMetadata, FileContent, DirectoryListing,
  type FileMetadata as TFileMetadata,
  type FileContent as TFileContent,
  type DirectoryListing as TDirectoryListing,
  type FileKind,
} from "../domain/repository.js";

/**
 * SAFE, READ-ONLY FILESYSTEM INSPECTION
 *
 * Read capability without write capability. There is no write, create, delete,
 * rename or chmod method on this class, and adding one would be a phase
 * decision - not an implementation detail.
 *
 * Every public method begins with `this.boundary.resolve(...)`. That is the
 * only way a path becomes a filesystem call here, which is what keeps path
 * security centralised: individual tools never re-implement containment, they
 * are handed one of these.
 *
 * Three refusals are structured results rather than exceptions, because a
 * reviewer needs to know they happened:
 *   - sensitive file  -> metadata yes, contents no
 *   - oversized file  -> read up to the limit, flagged `truncated`
 *   - binary file     -> metadata yes, contents no
 * Only a containment violation throws, because that is not a normal outcome.
 */
export class SafeFs {
  constructor(
    readonly boundary: FsBoundary,
    readonly limits: InspectionLimits = DEFAULT_LIMITS,
  ) {}

  get root(): string {
    return this.boundary.root;
  }

  /** Does this path exist inside the boundary? Throws if it escapes it. */
  exists(relativePath: string): boolean {
    const { absolute } = this.boundary.resolve(relativePath);
    return fs.existsSync(absolute);
  }

  /**
   * Metadata for one path. Always safe - it never opens the file, so a
   * credential file can be reported as present and changed without any risk of
   * its contents being captured.
   */
  stat(relativePath: string): TFileMetadata | null {
    const { absolute, relative } = this.boundary.resolve(relativePath);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absolute);
    } catch {
      return null;
    }
    const verdict = classifySensitivity(relative);
    return FileMetadata.parse({
      path: relative,
      kind: kindOf(stats),
      size: stats.isFile() ? stats.size : 0,
      sensitive: verdict.sensitive,
      sensitivityDetail: verdict.detail,
    });
  }

  /**
   * Read a text file, subject to the sensitive-file policy and the size limit.
   *
   * Never throws for a file that simply cannot be shown - the caller gets a
   * `FileContent` with `available: false` and a reason, so "withheld" can never
   * be mistaken for "empty".
   */
  readTextFile(relativePath: string): TFileContent {
    const { absolute, relative } = this.boundary.resolve(relativePath);

    const verdict = classifySensitivity(relative);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return FileContent.parse({
        path: relative,
        available: false,
        withheldReason: code === "EACCES" || code === "EPERM" ? "unreadable" : "missing",
        detail: `stat failed (${code ?? "unknown"})`,
      });
    }

    if (!stats.isFile()) {
      return FileContent.parse({
        path: relative, available: false, withheldReason: "not_a_file",
        detail: "path is not a regular file",
      });
    }

    // The policy check happens BEFORE any byte is read.
    if (verdict.sensitive) {
      return FileContent.parse({
        path: relative, available: false, withheldReason: "sensitive",
        detail: `contents withheld: ${verdict.detail}`,
        bytes: stats.size,
      });
    }

    const limit = this.limits.maxFileBytes;
    const truncated = stats.size > limit;
    let buffer: Buffer;
    try {
      buffer = truncated ? readPrefix(absolute, limit) : fs.readFileSync(absolute);
    } catch (error) {
      return FileContent.parse({
        path: relative, available: false, withheldReason: "unreadable",
        detail: `read failed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
        bytes: stats.size,
      });
    }

    if (looksBinary(buffer)) {
      return FileContent.parse({
        path: relative, available: false, withheldReason: "binary",
        detail: "binary content not captured",
        bytes: stats.size,
      });
    }

    return FileContent.parse({
      path: relative,
      available: true,
      content: buffer.toString("utf8"),
      bytes: stats.size,
      truncated,
      detail: truncated ? `truncated to ${limit} bytes of ${stats.size}` : null,
    });
  }

  /** One directory level, bounded by `maxDirectoryEntries`. */
  listDirectory(relativePath = "."): TDirectoryListing {
    const { absolute, relative } = this.boundary.resolve(relativePath);
    const names = fs.readdirSync(absolute).sort();
    const capped = names.slice(0, this.limits.maxDirectoryEntries);

    const entries = capped.flatMap((name) => {
      const child = this.stat(path.join(relative, name));
      return child ? [child] : [];
    });

    return DirectoryListing.parse({
      path: relative === "" ? "." : relative,
      entries,
      truncated: names.length > capped.length,
    });
  }

  /**
   * Recursive listing, bounded by depth AND total count.
   *
   * `.git` is skipped: it is large, mostly binary, and object files are not
   * evidence a reviewer can use.
   */
  listFiles(relativePath = "."): { files: string[]; truncated: boolean } {
    const files: string[] = [];
    let truncated = false;

    const walk = (rel: string, depth: number): void => {
      if (truncated || depth > this.limits.maxDepth) return;
      let listing: TDirectoryListing;
      try {
        listing = this.listDirectory(rel);
      } catch {
        return; // unreadable directory - skipped, not fatal
      }
      if (listing.truncated) truncated = true;
      for (const entry of listing.entries) {
        if (files.length >= this.limits.maxListedFiles) {
          truncated = true;
          return;
        }
        const name = entry.path.split("/").pop() ?? "";
        if (entry.kind === "directory") {
          if (name === ".git" || name === "node_modules") continue;
          walk(entry.path, depth + 1);
        } else if (entry.kind === "file") {
          files.push(entry.path);
        }
        // Symlinks are listed by `stat` but not followed here: `resolve()`
        // would reject any that leave the boundary, and following ones that
        // stay inside risks duplicate or cyclic traversal.
      }
    };

    walk(relativePath, 0);
    return { files: files.sort(), truncated };
  }
}

function kindOf(stats: fs.Stats): FileKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/** Read only the first `limit` bytes - an oversized file is never fully loaded. */
function readPrefix(absolute: string, limit: number): Buffer {
  const handle = fs.openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const read = fs.readSync(handle, buffer, 0, limit, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

/** A NUL byte in the first 8KB is the conventional binary heuristic. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export { toPosix };
