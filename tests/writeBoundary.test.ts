import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FsBoundary } from "../src/security/fsBoundary.js";
import { SafeWriteFs, WriteRefused } from "../src/security/writeBoundary.js";
import { resolveLimits } from "../src/security/limits.js";
import { tmpDir, rmDir, linkDir, linkFile, DIR_LINKS_SUPPORTED, FILE_LINKS_SUPPORTED } from "./helpers.js";

/**
 * THE WRITE BOUNDARY.
 *
 * Phase 3 proved the READ boundary against real symlinks and junctions. Writing
 * is strictly more dangerous, so the same attacks are re-run against the write
 * path - a containment bug here does not leak a file, it overwrites one.
 *
 * The boundary reuses `FsBoundary`, so these tests are also a guard against
 * someone later "simplifying" the write path onto its own string check.
 */

let parent: string;
let root: string;
let outside: string;
let writer: SafeWriteFs;

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

beforeEach(() => {
  parent = tmpDir("orch-wb-");
  root = path.join(parent, "project");
  outside = path.join(parent, "outside");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "victim.txt"), "ORIGINAL OUTSIDE CONTENT\n");
  writer = new SafeWriteFs(FsBoundary.create(root));
});

afterEach(() => rmDir(parent));

describe("ordinary writes", () => {
  it("creates a new file", () => {
    const outcome = writer.writeFile("src/new.ts", "export const a = 1;\n");
    expect(outcome.created).toBe(true);
    expect(outcome.atomic).toBe(true);
    expect(read("src/new.ts")).toBe("export const a = 1;\n");
  });

  it("replaces an existing file", () => {
    writer.writeFile("src/a.ts", "one\n");
    const outcome = writer.writeFile("src/a.ts", "two\n");
    expect(outcome.created).toBe(false);
    expect(read("src/a.ts")).toBe("two\n");
  });

  it("creates intermediate directories inside the boundary", () => {
    writer.writeFile("src/deep/deeper/x.ts", "x\n");
    expect(read("src/deep/deeper/x.ts")).toBe("x\n");
  });

  it("reports a content hash without keeping the content", () => {
    const outcome = writer.writeFile("src/a.ts", "hello\n");
    expect(outcome.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deletes a file", () => {
    writer.writeFile("src/gone.ts", "x\n");
    expect(writer.deleteFile("src/gone.ts").existed).toBe(true);
    expect(fs.existsSync(path.join(root, "src/gone.ts"))).toBe(false);
  });

  it("reports a delete of something absent rather than throwing", () => {
    expect(writer.deleteFile("src/never.ts").existed).toBe(false);
  });

  it("refuses to delete a directory", () => {
    expect(() => writer.deleteFile("src")).toThrow(WriteRefused);
  });

  it("leaves no temporary files behind", () => {
    writer.writeFile("src/a.ts", "x\n");
    const leftovers = fs.readdirSync(path.join(root, "src"))
      .filter((n) => n.includes("orchestrator-tmp"));
    expect(leftovers).toEqual([]);
  });

  it("writes the temporary file INSIDE the project, never in system temp", () => {
    // A temporary holding repository content must not sit outside every
    // guarantee this class makes. Proven by watching the target directory.
    let sawTemp = false;
    const dir = path.join(root, "src");
    const original = fs.renameSync;
    try {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
        sawTemp = path.dirname(path.resolve(from)) === path.resolve(dir);
        return original(from, to);
      }) as typeof fs.renameSync;
      writer.writeFile("src/a.ts", "x\n");
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = original;
    }
    expect(sawTemp).toBe(true);
  });
});

describe("traversal and absolute escapes", () => {
  const escapes = [
    "../outside/victim.txt",
    "src/../../outside/victim.txt",
    "..",
    "src/../..",
  ];

  for (const bad of escapes) {
    it(`refuses "${bad}"`, () => {
      expect(() => writer.writeFile(bad, "PWNED\n")).toThrow(WriteRefused);
      expect(read2(outside, "victim.txt")).toBe("ORIGINAL OUTSIDE CONTENT\n");
    });
  }

  it("refuses an absolute path outside the boundary", () => {
    expect(() => writer.writeFile(path.join(outside, "victim.txt"), "PWNED\n"))
      .toThrow(WriteRefused);
    expect(read2(outside, "victim.txt")).toBe("ORIGINAL OUTSIDE CONTENT\n");
  });

  it("refuses a sibling directory that shares a name prefix", () => {
    const sibling = path.join(parent, "project-evil");
    fs.mkdirSync(sibling, { recursive: true });
    expect(() => writer.writeFile(path.join(sibling, "x.ts"), "PWNED\n"))
      .toThrow(WriteRefused);
    expect(fs.existsSync(path.join(sibling, "x.ts"))).toBe(false);
  });

  it("refuses a different Windows drive or a UNC share", () => {
    const foreign = process.platform === "win32"
      ? ["Z:\\victim.txt", "\\\\server\\share\\victim.txt"]
      : ["/etc/victim.txt"];
    for (const target of foreign) {
      expect(() => writer.writeFile(target, "PWNED\n")).toThrow(WriteRefused);
    }
  });

  it("refuses to write the project root itself", () => {
    expect(() => writer.writeFile(".", "PWNED\n")).toThrow(WriteRefused);
  });

  it("refuses a NUL byte in the path", () => {
    expect(() => writer.writeFile("src/a.ts\0.png", "PWNED\n")).toThrow(WriteRefused);
  });
});

describe.skipIf(!DIR_LINKS_SUPPORTED)("symlink and junction escapes", () => {
  it("refuses to write THROUGH a link that leaves the project", () => {
    expect(linkDir(outside, path.join(root, "src", "escape"))).toBe(true);
    expect(() => writer.writeFile("src/escape/victim.txt", "PWNED\n")).toThrow(WriteRefused);
    expect(read2(outside, "victim.txt")).toBe("ORIGINAL OUTSIDE CONTENT\n");
  });

  it("refuses to CREATE a new file through an escaping link", () => {
    expect(linkDir(outside, path.join(root, "src", "escape"))).toBe(true);
    expect(() => writer.writeFile("src/escape/planted.txt", "PWNED\n")).toThrow(WriteRefused);
    expect(fs.existsSync(path.join(outside, "planted.txt"))).toBe(false);
  });

  it("refuses a NESTED link escape", () => {
    const hop = path.join(parent, "hop");
    expect(linkDir(outside, hop)).toBe(true);
    expect(linkDir(hop, path.join(root, "src", "hop2"))).toBe(true);
    expect(() => writer.writeFile("src/hop2/victim.txt", "PWNED\n")).toThrow(WriteRefused);
    expect(read2(outside, "victim.txt")).toBe("ORIGINAL OUTSIDE CONTENT\n");
  });

  it("refuses an escape through an INTERMEDIATE link segment", () => {
    fs.mkdirSync(path.join(outside, "deep"), { recursive: true });
    expect(linkDir(outside, path.join(root, "src", "mid"))).toBe(true);
    expect(() => writer.writeFile("src/mid/deep/x.ts", "PWNED\n")).toThrow(WriteRefused);
    expect(fs.existsSync(path.join(outside, "deep", "x.ts"))).toBe(false);
  });

  it("refuses to DELETE through an escaping link", () => {
    expect(linkDir(outside, path.join(root, "src", "escape"))).toBe(true);
    expect(() => writer.deleteFile("src/escape/victim.txt")).toThrow(WriteRefused);
    expect(fs.existsSync(path.join(outside, "victim.txt"))).toBe(true);
  });

  it("ALLOWS a link that stays inside the project", () => {
    // The boundary must not ban links outright, only ones that leave.
    const insideTarget = path.join(root, "shared");
    fs.mkdirSync(insideTarget);
    expect(linkDir(insideTarget, path.join(root, "src", "inner"))).toBe(true);

    const outcome = writer.writeFile("src/inner/util.ts", "export const b = 2;\n");
    // Reported at its REAL location, so it cannot be counted under two names.
    expect(outcome.path).toBe("shared/util.ts");
    expect(read("shared/util.ts")).toContain("export const b");
  });
});

describe.skipIf(!FILE_LINKS_SUPPORTED)("file link escapes", () => {
  it("refuses to write through a file link pointing outside", () => {
    expect(linkFile(path.join(outside, "victim.txt"), path.join(root, "src", "s.txt"))).toBe(true);
    expect(() => writer.writeFile("src/s.txt", "PWNED\n")).toThrow(WriteRefused);
    expect(read2(outside, "victim.txt")).toBe("ORIGINAL OUTSIDE CONTENT\n");
  });

  it("refuses a DANGLING link pointing outside", () => {
    expect(linkFile(path.join(outside, "not-created.txt"), path.join(root, "src", "d.txt"))).toBe(true);
    expect(() => writer.writeFile("src/d.txt", "PWNED\n")).toThrow(WriteRefused);
    expect(fs.existsSync(path.join(outside, "not-created.txt"))).toBe(false);
  });
});

describe("sensitive files cannot be written at all", () => {
  const sensitive = [".env", ".env.production", "src/id_rsa", "certs/server.pem", ".npmrc"];

  for (const target of sensitive) {
    it(`refuses to write "${target}"`, () => {
      try {
        writer.writeFile(target, "TOKEN=planted\n");
        expect.unreachable("a sensitive path must not be writable");
      } catch (error) {
        expect((error as WriteRefused).code).toBe("sensitive_path");
      }
      expect(fs.existsSync(path.join(root, target))).toBe(false);
    });
  }

  it("refuses to DELETE a sensitive file", () => {
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=existing\n");
    expect(() => writer.deleteFile(".env")).toThrow(WriteRefused);
    expect(fs.existsSync(path.join(root, ".env"))).toBe(true);
  });

  it("still allows a committed template", () => {
    expect(() => writer.writeFile(".env.example", "TOKEN=\n")).not.toThrow();
  });
});

describe("size limits", () => {
  it("refuses a file larger than the configured limit", () => {
    const small = new SafeWriteFs(FsBoundary.create(root), resolveLimits({ maxFileBytes: 16 }));
    try {
      small.writeFile("src/big.ts", "x".repeat(1000));
      expect.unreachable("should have been refused");
    } catch (error) {
      expect((error as WriteRefused).code).toBe("file_too_large");
    }
    expect(fs.existsSync(path.join(root, "src/big.ts"))).toBe(false);
  });
});

describe("the write surface is deliberately tiny", () => {
  it("exposes only writeFile and deleteFile", () => {
    const surface = Object.getOwnPropertyNames(SafeWriteFs.prototype)
      .filter((n) => n !== "constructor" && !n.startsWith("resolve"));
    expect(surface.sort()).toEqual(["deleteFile", "root", "writeFile"]);
  });

  it("has no move, chmod, chown or symlink method", () => {
    const surface = Object.getOwnPropertyNames(SafeWriteFs.prototype);
    for (const forbidden of ["rename", "move", "chmod", "chown", "symlink", "link", "rmdir", "exec"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

function read2(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8");
}
