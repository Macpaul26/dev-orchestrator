import { describe, it, expect } from "vitest";
import { classifyScope, scopeDrift, normalisePath } from "../src/domain/scope.js";

/**
 * SCOPE DRIFT MUST BE DETERMINISTIC.
 *
 * These tests are pure: no filesystem, no git, no model. If scope drift is
 * going to be treated as evidence at a human approval gate, it has to be
 * reproducible from the same two lists every time.
 */

describe("path normalisation", () => {
  it("normalises separators, leading ./ and trailing /", () => {
    expect(normalisePath("src\\auth\\service.ts")).toBe("src/auth/service.ts");
    expect(normalisePath("./src/index.ts")).toBe("src/index.ts");
    expect(normalisePath("src/auth/")).toBe("src/auth");
    expect(normalisePath("src//auth//x.ts")).toBe("src/auth/x.ts");
  });
});

describe("exact file scope", () => {
  it("authorises exactly that file", () => {
    const verdict = classifyScope(["src/a.ts"], ["src/a.ts"]);
    expect(verdict.inScope).toEqual(["src/a.ts"]);
    expect(verdict.drift).toEqual([]);
  });

  it("does not authorise a different file in the same directory", () => {
    expect(scopeDrift(["src/b.ts"], ["src/a.ts"])).toEqual(["src/b.ts"]);
  });
});

describe("directory scope", () => {
  it("authorises a file directly inside", () => {
    expect(scopeDrift(["src/index.ts"], ["src/"])).toEqual([]);
  });

  it("authorises a NESTED file", () => {
    expect(scopeDrift(["src/components/Button.tsx"], ["src/"])).toEqual([]);
    expect(scopeDrift(["src/a/b/c/d.ts"], ["src"])).toEqual([]);
  });

  it("treats a trailing slash as optional", () => {
    expect(scopeDrift(["src/a.ts"], ["src"])).toEqual([]);
    expect(scopeDrift(["src/a.ts"], ["src/"])).toEqual([]);
  });

  it("does NOT authorise a sibling directory", () => {
    // The brief's example: src/ must not authorise tests/.
    expect(scopeDrift(["tests/Button.test.ts"], ["src/"])).toEqual(["tests/Button.test.ts"]);
  });

  it("does NOT authorise a directory that merely shares a name prefix", () => {
    // This is the naive-substring bug. `src` must not authorise `src-generated`.
    expect(scopeDrift(["src-generated/x.ts"], ["src/"])).toEqual(["src-generated/x.ts"]);
    expect(scopeDrift(["srcfoo.ts"], ["src"])).toEqual(["srcfoo.ts"]);
  });

  it("authorises the directory entry itself", () => {
    expect(scopeDrift(["src"], ["src/"])).toEqual([]);
  });
});

describe("wildcard scope", () => {
  it("matches within a single segment only", () => {
    expect(scopeDrift(["src/main.ts"], ["src/*.ts"])).toEqual([]);
    expect(scopeDrift(["src/deep/main.ts"], ["src/*.ts"])).toEqual(["src/deep/main.ts"]);
  });

  it("supports ** across segments", () => {
    expect(scopeDrift(["src/a/b/c.ts"], ["src/**"])).toEqual([]);
    expect(scopeDrift(["src/a/b/c.ts"], ["src/**/*.ts"])).toEqual([]);
    expect(scopeDrift(["other/a.ts"], ["src/**"])).toEqual(["other/a.ts"]);
  });

  it("supports ? for exactly one character", () => {
    expect(scopeDrift(["src/a.ts"], ["src/?.ts"])).toEqual([]);
    expect(scopeDrift(["src/ab.ts"], ["src/?.ts"])).toEqual(["src/ab.ts"]);
  });

  it("does not treat regex metacharacters as patterns", () => {
    // A `.` in a pattern is a literal dot, not "any character".
    expect(scopeDrift(["srcXts"], ["src.ts"])).toEqual(["srcXts"]);
    expect(scopeDrift(["src.ts"], ["src.ts"])).toEqual([]);
  });
});

describe("windows path separators", () => {
  it("matches regardless of which separator either side uses", () => {
    expect(scopeDrift(["src\\auth\\service.ts"], ["src/auth/"])).toEqual([]);
    expect(scopeDrift(["src/auth/service.ts"], ["src\\auth"])).toEqual([]);
  });

  it("stays case-sensitive", () => {
    // git reports paths case-sensitively; lowercasing would let SRC/ authorise src/.
    expect(scopeDrift(["src/a.ts"], ["SRC/"])).toEqual(["src/a.ts"]);
  });
});

describe("mixed and empty scopes", () => {
  it("separates authorised from unauthorised in one pass", () => {
    const verdict = classifyScope(
      ["src/a.ts", "src/deep/b.ts", "tests/c.test.ts", "package.json"],
      ["src/", "package.json"],
    );
    expect(verdict.inScope).toEqual(["package.json", "src/a.ts", "src/deep/b.ts"]);
    expect(verdict.drift).toEqual(["tests/c.test.ts"]);
  });

  it("FAILS CLOSED: an empty scope authorises nothing", () => {
    const verdict = classifyScope(["src/a.ts"], []);
    expect(verdict.emptyScope).toBe(true);
    expect(verdict.drift).toEqual(["src/a.ts"]);
    expect(verdict.inScope).toEqual([]);
  });

  it("reports an empty scope with no changes as no drift", () => {
    expect(classifyScope([], []).drift).toEqual([]);
  });

  it("reports scope entries that matched nothing", () => {
    const verdict = classifyScope(["src/a.ts"], ["src/", "docs/"]);
    expect(verdict.unusedScope).toEqual(["docs/"]);
  });

  it("is deterministic and order-independent", () => {
    const a = classifyScope(["b.ts", "a.ts"], ["a.ts"]);
    const b = classifyScope(["a.ts", "b.ts"], ["a.ts"]);
    expect(a).toEqual(b);
    expect(classifyScope(["a.ts", "a.ts"], ["a.ts"]).inScope).toEqual(["a.ts"]);
  });

  it("does not let a scope entry escape upward", () => {
    // A pattern that tries to authorise the parent must not match a sibling.
    expect(scopeDrift(["../outside.ts"], ["src/"])).toEqual(["../outside.ts"]);
  });
});
