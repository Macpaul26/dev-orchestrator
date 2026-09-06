import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { toPosix, type FsBoundary } from "./fsBoundary.js";
import { classifySensitivity } from "./sensitive.js";
import { type InspectionLimits, DEFAULT_LIMITS } from "./limits.js";
import { FileFingerprint, type FileFingerprint as TFileFingerprint } from "../domain/attribution.js";
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

  /**
   * A content fingerprint for one path, for CHANGE ATTRIBUTION.
   *
   * The point is to answer "is this the same file it was five minutes ago?"
   * without keeping the file. Two properties make that safe:
   *
   *   1. The hash is computed by STREAMING fixed-size chunks, so memory stays
   *      constant no matter how large the file is, and the bytes are discarded
   *      immediately. Only 32 bytes of digest survive.
   *
   *   2. A SENSITIVE file is NEVER hashed. A digest of a low-entropy secret,
   *      stored permanently in an audit log, is a real disclosure risk - it can
   *      be attacked by guessing. So sensitive files fall back to size, mtime
   *      and git status, and the fingerprint records `basis: "metadata_only"`
   *      so every downstream verdict carries that caveat with it.
   *
   * This is why attribution never requires relaxing the sensitive-file rule.
   */
  fingerprint(relativePath: string): TFileFingerprint {
    const { absolute, relative } = this.boundary.resolve(relativePath);

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absolute);
    } catch {
      return FileFingerprint.parse({ path: relative, present: false, kind: "absent" });
    }

    const base = {
      path: relative,
      present: true,
      kind: kindOf(stats),
      size: stats.isFile() ? stats.size : 0,
      mtimeMs: Math.round(stats.mtimeMs),
    };

    if (!stats.isFile()) {
      return FileFingerprint.parse({
        ...base, contentHash: null, basis: "metadata_only",
        withheldReason: "not a regular file",
      });
    }

    const verdict = classifySensitivity(relative);
    if (verdict.sensitive) {
      return FileFingerprint.parse({
        ...base, contentHash: null, basis: "metadata_only",
        withheldReason: `sensitive: ${verdict.detail ?? "policy"}`,
      });
    }

    if (stats.size > this.limits.maxFingerprintBytes) {
      return FileFingerprint.parse({
        ...base, contentHash: null, basis: "metadata_only",
        withheldReason: `larger than the ${this.limits.maxFingerprintBytes}-byte hash limit`,
      });
    }

    try {
      const digests = hashFile(absolute, stats.size);
      return FileFingerprint.parse({
        ...base,
        contentHash: digests.sha256,
        blobSha: digests.gitBlobSha,
        basis: "content_hash",
      });
    } catch (error) {
      return FileFingerprint.parse({
        ...base, contentHash: null, basis: "metadata_only",
        withheldReason: `unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
      });
    }
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

/**
 * Digest a file in one streamed pass, producing two identifiers.
 *
 * Deliberately chunked rather than `readFileSync`: fingerprinting exists to
 * detect change, not to read the file, so it must not be possible for it to
 * pull a large file into memory - or into evidence.
 *
 *   sha256       change detection. Preferred, because an implementation agent
 *                is not a trusted party and SHA-1 is collision-attackable.
 *   gitBlobSha   `sha1("blob <bytes>\0" + contents)`, exactly what git stores.
 *                Computed so a file that APPEARED can be matched against one
 *                that VANISHED using git's own id for the vanished content -
 *                identifying a rename without reading anything back out of git.
 */
function hashFile(absolute: string, size: number): { sha256: string; gitBlobSha: string } {
  const sha256 = crypto.createHash("sha256");
  const blob = crypto.createHash("sha1");
  blob.update(`blob ${size}\0`);

  const buffer = Buffer.alloc(64 * 1024);
  const handle = fs.openSync(absolute, "r");
  try {
    let position = 0;
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      sha256.update(chunk);
      blob.update(chunk);
      position += read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { sha256: sha256.digest("hex"), gitBlobSha: blob.digest("hex") };
}

/** A NUL byte in the first 8KB is the conventional binary heuristic. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export { toPosix };
