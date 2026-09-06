import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FsBoundary, SymlinkEscapeError, BoundaryRootError,
} from "../src/security/fsBoundary.js";
import { PathEscapeError } from "../src/persistence/paths.js";
import { SafeFs } from "../src/security/safeFs.js";
import { classifySensitivity, isSensitivePath } from "../src/security/sensitive.js";
import { resolveLimits, CEILINGS, DEFAULT_LIMITS } from "../src/security/limits.js";
import {
  tmpDir, rmDir, linkDir, linkFile, DIR_LINKS_SUPPORTED, FILE_LINKS_SUPPORTED,
} from "./helpers.js";

/**
 * THE POINT OF PHASE 3's SECURITY WORK.
 *
 * Phase 1+2 checked containment lexically, which stops `../` and absolute
 * escapes but NOT a symlink or junction that points out of the root. These
 * tests create real links on the real filesystem and prove the escape fails.
 */

let root: string;
let outside: string;
let parent: string;

beforeEach(() => {
  parent = tmpDir("orch-sec-");
  root = path.join(parent, "project");
  outside = path.join(parent, "outside");
  fs.mkdirSync(path.join(root, "allowed"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "SUPER SECRET VALUE\n");
  fs.writeFileSync(path.join(root, "allowed", "ok.ts"), "export const a = 1;\n");
});

afterEach(() => rmDir(parent));

describe("boundary root validation", () => {
  it("refuses a relative root", () => {
    expect(() => FsBoundary.create("relative/path")).toThrow(BoundaryRootError);
  });

  it("refuses a root that does not exist", () => {
    try {
      FsBoundary.create(path.join(parent, "nope"));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as BoundaryRootError).code).toBe("missing");
    }
  });

  it("refuses a root that is a file", () => {
    const file = path.join(root, "allowed", "ok.ts");
    try {
      FsBoundary.create(file);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as BoundaryRootError).code).toBe("not_a_directory");
    }
  });
});

describe("lexical containment", () => {
  it("resolves ordinary paths inside the root", () => {
    const boundary = FsBoundary.create(root);
    expect(boundary.resolve("allowed/ok.ts").absolute).toBe(
      path.join(root, "allowed", "ok.ts"),
    );
    expect(boundary.resolve("allowed/ok.ts").relative).toBe("allowed/ok.ts");
  });

  it("resolves the root itself", () => {
    const boundary = FsBoundary.create(root);
    expect(boundary.resolve(".").absolute).toBe(root);
    expect(boundary.resolve(".").relative).toBe("");
  });

  it("rejects .. traversal", () => {
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("../outside/secret.txt")).toThrow(PathEscapeError);
    expect(() => boundary.resolve("allowed/../../outside/secret.txt")).toThrow(PathEscapeError);
    expect(() => boundary.resolve("..")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve(path.join(outside, "secret.txt"))).toThrow(PathEscapeError);
  });

  it("accepts an absolute path that is inside the root", () => {
    const boundary = FsBoundary.create(root);
    expect(boundary.resolve(path.join(root, "allowed", "ok.ts")).relative).toBe("allowed/ok.ts");
  });

  it("normalises redundant separators and dot segments", () => {
    const boundary = FsBoundary.create(root);
    expect(boundary.resolve("./allowed/./ok.ts").relative).toBe("allowed/ok.ts");
    expect(boundary.resolve("allowed//ok.ts").relative).toBe("allowed/ok.ts");
  });

  it("rejects a NUL byte in the path", () => {
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("allowed/ok.ts\0.png")).toThrow(PathEscapeError);
  });

  it("rejects a sibling directory that merely shares a name prefix", () => {
    // `project-evil` starts with `project` but is NOT inside it. A naive
    // startsWith check would let this through.
    const sibling = path.join(parent, "project-evil");
    fs.mkdirSync(sibling, { recursive: true });
    const boundary = FsBoundary.create(root);
    expect(boundary.contains(path.join(sibling, "x.ts"))).toBe(false);
  });

  it("rejects a path on a different Windows drive", () => {
    const boundary = FsBoundary.create(root);
    // On POSIX this is just a relative-looking name; on Windows it is another
    // volume. Either way it must not resolve inside the root.
    const other = process.platform === "win32" ? "Z:\\secret.txt" : "/etc/passwd";
    expect(boundary.contains(other)).toBe(false);
  });

  it("allows a non-existent child path (needed to answer 'does this exist?')", () => {
    const boundary = FsBoundary.create(root);
    const resolved = boundary.resolve("allowed/not-created-yet.ts");
    expect(resolved.relative).toBe("allowed/not-created-yet.ts");
    expect(fs.existsSync(resolved.absolute)).toBe(false);
  });

  it("rejects a non-existent path that traverses out", () => {
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("allowed/../../nowhere/x.ts")).toThrow(PathEscapeError);
  });
});

describe.skipIf(!DIR_LINKS_SUPPORTED)("physical containment - directory link escapes", () => {
  it("rejects a lexically-inside path that links OUT of the root", () => {
    // project/allowed/link -> outside
    expect(linkDir(outside, path.join(root, "allowed", "link"))).toBe(true);
    const boundary = FsBoundary.create(root);

    // Lexically "allowed/link/secret.txt" is inside the project. It is not.
    expect(() => boundary.resolve("allowed/link/secret.txt")).toThrow(SymlinkEscapeError);
    expect(boundary.contains("allowed/link/secret.txt")).toBe(false);
  });

  it("names where the escape actually led", () => {
    expect(linkDir(outside, path.join(root, "escape"))).toBe(true);
    const boundary = FsBoundary.create(root);
    try {
      boundary.resolve("escape/secret.txt");
      expect.unreachable("escape should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(SymlinkEscapeError);
      expect((error as SymlinkEscapeError).resolvedTo).toContain("secret.txt");
    }
  });

  it("rejects a NESTED link escape (link -> link -> outside)", () => {
    // hop1 -> outside, then project/allowed/hop2 -> hop1
    const hop1 = path.join(parent, "hop1");
    expect(linkDir(outside, hop1)).toBe(true);
    expect(linkDir(hop1, path.join(root, "allowed", "hop2"))).toBe(true);

    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("allowed/hop2/secret.txt")).toThrow(SymlinkEscapeError);
  });

  it("rejects an escape through an INTERMEDIATE link segment", () => {
    // The link is in the middle of the path, not at the leaf.
    fs.mkdirSync(path.join(outside, "deep", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(outside, "deep", "deeper", "key.pem"), "-----BEGIN\n");
    expect(linkDir(outside, path.join(root, "allowed", "mid"))).toBe(true);

    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("allowed/mid/deep/deeper/key.pem")).toThrow(SymlinkEscapeError);
  });

  it("ALLOWS a legitimate link that stays inside the root", () => {
    // The boundary must not simply ban links - only ones that leave.
    const insideTarget = path.join(root, "shared");
    fs.mkdirSync(insideTarget);
    fs.writeFileSync(path.join(insideTarget, "util.ts"), "export const b = 2;\n");
    expect(linkDir(insideTarget, path.join(root, "allowed", "inner"))).toBe(true);

    const boundary = FsBoundary.create(root);
    const resolved = boundary.resolve("allowed/inner/util.ts");
    expect(resolved.relative).toBe("shared/util.ts"); // reported at its real location
    expect(fs.readFileSync(resolved.absolute, "utf8")).toContain("export const b");
  });

  it("rejects a NON-EXISTENT path underneath an escaping link", () => {
    // Nothing exists at the end of this path, so realpathSync alone would say
    // ENOENT. The link still has to be followed to decide containment.
    expect(linkDir(outside, path.join(root, "allowed", "link"))).toBe(true);
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("allowed/link/does-not-exist.ts")).toThrow(SymlinkEscapeError);
  });

  it("stops SafeFs from reading through an escaping link", () => {
    expect(linkDir(outside, path.join(root, "allowed", "link"))).toBe(true);
    const safe = new SafeFs(FsBoundary.create(root));
    expect(() => safe.readTextFile("allowed/link/secret.txt")).toThrow(SymlinkEscapeError);
    expect(() => safe.stat("allowed/link/secret.txt")).toThrow(SymlinkEscapeError);
    expect(() => safe.exists("allowed/link/secret.txt")).toThrow(SymlinkEscapeError);
  });
});

describe.skipIf(!FILE_LINKS_SUPPORTED)("physical containment - file link escapes", () => {
  it("rejects a file link pointing out of the root", () => {
    expect(linkFile(path.join(outside, "secret.txt"), path.join(root, "allowed", "s.txt"))).toBe(true);
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("allowed/s.txt")).toThrow(SymlinkEscapeError);
  });

  it("rejects a DANGLING file link pointing out of the root", () => {
    // The target does not exist, so realpathSync reports ENOENT rather than the
    // escape. The link must still be followed by hand.
    expect(linkFile(path.join(outside, "never-created.txt"), path.join(root, "dangling"))).toBe(true);
    const boundary = FsBoundary.create(root);
    expect(() => boundary.resolve("dangling")).toThrow(SymlinkEscapeError);
  });
});

describe("safe file inspection", () => {
  let safe: SafeFs;
  beforeEach(() => {
    safe = new SafeFs(FsBoundary.create(root), resolveLimits({ maxFileBytes: 64 }));
  });

  it("reads a normal text file", () => {
    const result = safe.readTextFile("allowed/ok.ts");
    expect(result.available).toBe(true);
    expect(result.content).toContain("export const a");
    expect(result.truncated).toBe(false);
  });

  it("reports a missing file rather than throwing", () => {
    const result = safe.readTextFile("allowed/absent.ts");
    expect(result.available).toBe(false);
    expect(result.withheldReason).toBe("missing");
    expect(result.content).toBeNull();
  });

  it("refuses to read a directory as a file", () => {
    const result = safe.readTextFile("allowed");
    expect(result.available).toBe(false);
    expect(result.withheldReason).toBe("not_a_file");
  });

  it("truncates an oversized file and says so", () => {
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(5000));
    const result = safe.readTextFile("big.txt");
    expect(result.available).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(5000);
    expect(result.content!.length).toBe(64); // only the limit was ever read
    expect(result.detail).toContain("truncated");
  });

  it("WITHHOLDS a sensitive file's contents but still reports it exists", () => {
    fs.writeFileSync(path.join(root, ".env"), "ANTHROPIC_API_KEY=sk-live-do-not-leak\n");

    const meta = safe.stat(".env");
    expect(meta?.sensitive).toBe(true);
    expect(meta?.size).toBeGreaterThan(0); // metadata is fine

    const result = safe.readTextFile(".env");
    expect(result.available).toBe(false);
    expect(result.withheldReason).toBe("sensitive");
    expect(result.content).toBeNull();
    expect(JSON.stringify(result)).not.toContain("sk-live-do-not-leak");
  });

  it("does not capture binary content", () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const result = safe.readTextFile("blob.bin");
    expect(result.available).toBe(false);
    expect(result.withheldReason).toBe("binary");
  });

  it("refuses any path outside the root", () => {
    expect(() => safe.readTextFile("../outside/secret.txt")).toThrow(PathEscapeError);
    expect(() => safe.listDirectory("../outside")).toThrow(PathEscapeError);
  });

  it("bounds a directory listing", () => {
    const many = new SafeFs(FsBoundary.create(root), resolveLimits({ maxDirectoryEntries: 2 }));
    fs.mkdirSync(path.join(root, "many"));
    for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(root, "many", `f${i}.ts`), "");
    const listing = many.listDirectory("many");
    expect(listing.entries).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("bounds a recursive listing by count", () => {
    const bounded = new SafeFs(FsBoundary.create(root), resolveLimits({ maxListedFiles: 3 }));
    fs.mkdirSync(path.join(root, "tree", "a", "b"), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(path.join(root, "tree", "a", "b", `f${i}.ts`), "");
    }
    const listed = bounded.listFiles(".");
    expect(listed.files.length).toBeLessThanOrEqual(3);
    expect(listed.truncated).toBe(true);
  });

  it("has no method that can write, delete or rename", () => {
    // The read-only guarantee is structural, not a runtime check.
    const surface = Object.getOwnPropertyNames(SafeFs.prototype);
    for (const forbidden of ["write", "writeFile", "delete", "unlink", "rename", "mkdir", "chmod"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

describe("sensitive-file policy", () => {
  it("flags environment files", () => {
    for (const file of [".env", ".env.local", ".env.production", "config/.env.staging"]) {
      expect(isSensitivePath(file)).toBe(true);
    }
  });

  it("does NOT flag committed templates", () => {
    for (const file of [".env.example", ".env.sample", ".env.template"]) {
      expect(isSensitivePath(file)).toBe(false);
    }
  });

  it("flags key material by extension and by name", () => {
    for (const file of [
      "certs/server.pem", "deploy.key", "keystore.jks", "id_rsa",
      "config/private-key.json", "gcp-service-account.json",
    ]) {
      expect(isSensitivePath(file)).toBe(true);
    }
  });

  it("flags credential files and credential directories", () => {
    for (const file of [
      ".npmrc", ".netrc", ".git-credentials", "secrets.json",
      ".aws/config", ".ssh/known_hosts", "terraform.tfvars",
    ]) {
      expect(isSensitivePath(file)).toBe(true);
    }
  });

  it("leaves ordinary source files alone", () => {
    for (const file of [
      "src/index.ts", "README.md", "package.json", "src/keyboard.ts",
      "docs/monkey.md", "src/environment.ts",
    ]) {
      expect(isSensitivePath(file)).toBe(false);
    }
  });

  it("is case-insensitive and separator-insensitive", () => {
    expect(isSensitivePath(".ENV")).toBe(true);
    expect(isSensitivePath("config\\.env.local")).toBe(true);
  });

  it("explains why, so evidence can report it without the contents", () => {
    const verdict = classifySensitivity("app/.env.production");
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reason).toBe("dotenv");
    expect(verdict.detail).toBeTruthy();
  });
});

describe("inspection limits", () => {
  it("applies documented defaults", () => {
    expect(DEFAULT_LIMITS.maxFileBytes).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxFileBytes).toBeLessThanOrEqual(CEILINGS.maxFileBytes);
  });

  it("CLAMPS an over-large override rather than honouring it", () => {
    const limits = resolveLimits({
      maxFileBytes: CEILINGS.maxFileBytes * 100,
      maxDepth: 9999,
      maxListedFiles: 10_000_000,
    });
    expect(limits.maxFileBytes).toBe(CEILINGS.maxFileBytes);
    expect(limits.maxDepth).toBe(CEILINGS.maxDepth);
    expect(limits.maxListedFiles).toBe(CEILINGS.maxListedFiles);
  });

  it("honours an override that TIGHTENS a limit", () => {
    expect(resolveLimits({ maxFileBytes: 10 }).maxFileBytes).toBe(10);
  });

  it("rejects a nonsensical limit", () => {
    expect(() => resolveLimits({ maxFileBytes: -1 })).toThrow();
    expect(() => resolveLimits({ maxDepth: 0 })).toThrow();
  });
});
