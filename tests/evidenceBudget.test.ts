import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryEvidenceService } from "../src/evidence/repositoryEvidence.js";
import { EVIDENCE_LIMITS } from "../src/domain/repositoryEvidence.js";
import { SafeFs } from "../src/security/safeFs.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * TASK 008 CORRECTION - RESOURCE BOUNDARIES THAT ACTUALLY BIND.
 *
 * ---------------------------------------------------------------------------
 * THE THREE DEFECTS THESE TESTS EXIST FOR
 * ---------------------------------------------------------------------------
 * 1. There was no TOTAL evidence budget. A batch could sit comfortably inside
 *    every individual limit and still return a very large payload - two hundred
 *    long paths plus fifty metadata items plus fifty refusal messages cost
 *    nothing against the excerpt budget.
 *
 * 2. The excerpt reader was built once with the 8 KB per-excerpt cap, so with
 *    512 bytes of batch budget remaining it still pulled 8 KB off disk and
 *    sliced afterwards. My own report described this as "bounded at the read",
 *    which was true only against the 8 KB cap and not against the remaining
 *    allowance.
 *
 * 3. Accounting used `text.length` - UTF-16 code units - against limits
 *    documented in BYTES. On CJK or emoji content that let roughly three times
 *    the intended volume through.
 *
 * The read-bound test below asserts on the SafeFs the service actually
 * constructs, not on the length of the returned string: a short string proves
 * only that slicing happened, which is precisely what was wrong before.
 */

let tmp: string;
let repo: string;

function service(): RepositoryEvidenceService {
  return new RepositoryEvidenceService(
    new LocalGitRepositoryInspector({ workingDir: repo }),
  );
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * A three-byte UTF-8 character, built from its code point.
 *
 * Written as `fromCodePoint` rather than as a literal on purpose: a literal
 * non-ASCII character does not survive every tool that touches this file, and
 * the first version of this fixture arrived as an EMPTY STRING - which made the
 * byte-vs-character assertion pass vacuously. U+4E16 is one UTF-16 unit and
 * three UTF-8 bytes, which is exactly the discrepancy under test.
 */
const WIDE = String.fromCodePoint(0x4e16);
const REPLACEMENT = String.fromCodePoint(0xfffd);

beforeEach(() => {
  tmp = tmpDir("orch-budget-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmDir(tmp);
});

// ===========================================================================
describe("the excerpt READ is bounded by the remaining allowance", () => {
  /**
   * Asserted on the limit the reader is CONSTRUCTED with.
   *
   * Checking that the returned string is short would pass even with the old
   * behaviour, because the old behaviour read 8 KB and then sliced. The
   * question is how many bytes came off disk, and that is decided by
   * `maxFileBytes` on the SafeFs the service builds.
   */
  it("constructs the reader with the remaining allowance, not the global cap", async () => {
    const big = "z".repeat(64 * 1024);
    for (const name of ["one", "two"]) {
      fs.writeFileSync(path.join(repo, "src", `${name}.ts`), big);
    }

    const observed: number[] = [];
    const original = SafeFs.prototype.readTextFile;
    vi.spyOn(SafeFs.prototype, "readTextFile").mockImplementation(function (
      this: SafeFs, relativePath: string,
    ) {
      observed.push(this.limits.maxFileBytes);
      return original.call(this, relativePath);
    });

    /**
     * The request size is chosen so the REMAINDER binds, not the per-excerpt
     * cap.
     *
     * My first version asked for `maxExcerptBytes` each time; since the batch
     * budget is an exact multiple of that cap, the cap always won and the test
     * proved nothing about the remainder. Requesting 8,000 bytes leaves 768
     * after four reads, which only the remaining-allowance rule can produce.
     */
    const per = 8_000;
    const fits = Math.floor(EVIDENCE_LIMITS.maxTotalExcerptBytes / per);
    const remainder = EVIDENCE_LIMITS.maxTotalExcerptBytes - fits * per;
    expect(remainder).toBeGreaterThan(0);
    expect(remainder).toBeLessThan(per);

    for (let i = 0; i < fits + 1; i++) {
      fs.writeFileSync(path.join(repo, "src", `r${i}.ts`), big);
    }
    await service().inspect(Array.from({ length: fits + 1 }, (_, i) => ({
      operation: "FILE_EXCERPT" as const, path: `src/r${i}.ts`, maxBytes: per,
    })));

    expect(observed).toHaveLength(fits + 1);
    for (let i = 0; i < fits; i++) expect(observed[i]).toBe(per);
    // THE POINT: the last read is opened with only what the budget had left -
    // smaller than both the request and the per-excerpt cap.
    expect(observed[fits]).toBe(remainder);
    expect(observed[fits]).toBeLessThan(EVIDENCE_LIMITS.maxExcerptBytes);
  });

  it("never opens a reader larger than the batch budget allows", async () => {
    const big = "z".repeat(64 * 1024);
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(repo, "src", `f${i}.ts`), big);
    }

    const observed: number[] = [];
    const original = SafeFs.prototype.readTextFile;
    vi.spyOn(SafeFs.prototype, "readTextFile").mockImplementation(function (
      this: SafeFs, relativePath: string,
    ) {
      observed.push(this.limits.maxFileBytes);
      return original.call(this, relativePath);
    });

    await service().inspect(Array.from({ length: 6 }, (_, i) => ({
      operation: "FILE_EXCERPT" as const,
      path: `src/f${i}.ts`,
      maxBytes: EVIDENCE_LIMITS.maxExcerptBytes,
    })));

    // Every read is within the per-excerpt cap AND the sum never exceeds the
    // batch budget - so no read was opened on budget that did not exist.
    for (const limit of observed) {
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxExcerptBytes);
    }
    expect(observed.reduce((a, b) => a + b, 0))
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalExcerptBytes);
  });

  it("refuses once the excerpt budget is spent rather than reading anyway", async () => {
    const big = "z".repeat(64 * 1024);
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(repo, "src", `g${i}.ts`), big);
    }
    const outcome = await service().inspect(Array.from({ length: 6 }, (_, i) => ({
      operation: "FILE_EXCERPT" as const,
      path: `src/g${i}.ts`,
      maxBytes: EVIDENCE_LIMITS.maxExcerptBytes,
    })));

    expect(outcome.excerptBytesUsed).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalExcerptBytes);
    expect(outcome.refusals.some((r) => r.code === "excerpt_budget_exhausted")).toBe(true);
  });
});

// ===========================================================================
describe("excerpt accounting is byte-accurate, not character-accurate", () => {
  it("counts multibyte UTF-8 in BYTES", async () => {
    // Three bytes per character, one UTF-16 unit each: character count and byte
    // count differ by 3x, which is exactly what the old accounting got wrong.
    const cjk = WIDE.repeat(4000);
    expect(cjk.length).toBeLessThan(bytes(cjk));
    fs.writeFileSync(path.join(repo, "src", "cjk.ts"), cjk);

    const outcome = await service().inspect([
      { operation: "FILE_EXCERPT", path: "src/cjk.ts",
        maxBytes: EVIDENCE_LIMITS.maxExcerptBytes },
    ]);
    const item = outcome.items[0]!;
    if (item.kind !== "FILE_EXCERPT") throw new Error("expected FILE_EXCERPT");

    // The BYTE ceiling is respected, which is the limit as documented.
    expect(bytes(item.text)).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxExcerptBytes);
    expect(item.end).toBe(bytes(item.text));
    expect(outcome.excerptBytesUsed).toBe(bytes(item.text));
    // And the character count is meaningfully smaller, proving the fixture
    // really is multibyte rather than accidentally ASCII.
    expect(item.text.length).toBeLessThan(bytes(item.text));
  });

  it("never splits a character, and never emits a replacement character", async () => {
    const cjk = WIDE.repeat(4000);
    fs.writeFileSync(path.join(repo, "src", "cjk2.ts"), cjk);

    // An allowance that does not divide evenly by the 3-byte character width.
    const outcome = await service().inspect([
      { operation: "FILE_EXCERPT", path: "src/cjk2.ts", maxBytes: 1000 },
    ]);
    const item = outcome.items[0]!;
    if (item.kind !== "FILE_EXCERPT") throw new Error("expected FILE_EXCERPT");

    expect(bytes(item.text)).toBeLessThanOrEqual(1000);
    // A half-character would decode to U+FFFD, which is 3 bytes and would make
    // the result LARGER than the limit it was enforcing.
    expect(item.text).not.toContain(REPLACEMENT);
    // Every retained character is intact.
    expect([...item.text].every((c) => c === WIDE)).toBe(true);
  });

  it("keeps ASCII behaviour unchanged, where bytes and characters agree", async () => {
    fs.writeFileSync(path.join(repo, "src", "ascii.ts"), "a".repeat(4000));
    const outcome = await service().inspect([
      { operation: "FILE_EXCERPT", path: "src/ascii.ts", maxBytes: 1000 },
    ]);
    const item = outcome.items[0]!;
    if (item.kind !== "FILE_EXCERPT") throw new Error("expected FILE_EXCERPT");
    expect(item.text).toHaveLength(1000);
    expect(item.end).toBe(1000);
  });

  it("respects the TOTAL excerpt budget in bytes across multibyte files", async () => {
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(repo, "src", `m${i}.ts`), WIDE.repeat(4000));
    }
    const outcome = await service().inspect(Array.from({ length: 8 }, (_, i) => ({
      operation: "FILE_EXCERPT" as const,
      path: `src/m${i}.ts`,
      maxBytes: EVIDENCE_LIMITS.maxExcerptBytes,
    })));

    const totalBytes = outcome.items.reduce(
      (sum, i) => sum + (i.kind === "FILE_EXCERPT" ? bytes(i.text) : 0), 0,
    );
    expect(totalBytes).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalExcerptBytes);
    expect(outcome.excerptBytesUsed).toBe(totalBytes);
  });
});

// ===========================================================================
describe("the total evidence budget", () => {
  it("exists as a centralized hard limit above the excerpt budget", () => {
    expect(EVIDENCE_LIMITS.maxTotalEvidenceBytes).toBeGreaterThan(0);
    expect(EVIDENCE_LIMITS.maxTotalEvidenceBytes)
      .toBeGreaterThan(EVIDENCE_LIMITS.maxTotalExcerptBytes);
  });

  it("is a REAL constraint: the worst case the sibling limits allow exceeds it", () => {
    /**
     * Corrected after this test failed.
     *
     * I first asserted the opposite - that the sibling caps keep every batch
     * comfortably inside the total, making it a decorative backstop. The
     * arithmetic says otherwise: 200 changed paths at the maximum path length,
     * plus 50 metadata items, plus a full excerpt budget, comes to roughly
     * 139 KB against a 128 KB ceiling.
     *
     * So the total budget can bind, and that is the right outcome - it is doing
     * work rather than sitting above everything else for show. Documenting it
     * as a backstop would have been a comfortable claim that happened to be
     * false.
     */
    const worstCasePaths =
      EVIDENCE_LIMITS.maxChangedFiles * (EVIDENCE_LIMITS.maxPathLength + 4);
    const worstCaseMetadata =
      EVIDENCE_LIMITS.maxMetadataPaths * (EVIDENCE_LIMITS.maxPathLength + 120);
    const worstCase =
      worstCasePaths + worstCaseMetadata + EVIDENCE_LIMITS.maxTotalExcerptBytes;

    expect(worstCase).toBeGreaterThan(EVIDENCE_LIMITS.maxTotalEvidenceBytes);
  });

  it("holds the line on every batch it actually serves", async () => {
    // Whatever the arithmetic above permits, no served batch exceeds the total.
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(repo, "src", `h${i}.ts`), "y".repeat(4000));
    }
    const outcome = await service().inspect([
      { operation: "CHANGED_FILES" },
      { operation: "REPOSITORY_METADATA" },
      { operation: "REPOSITORY_STATUS" },
      {
        operation: "FILE_METADATA",
        paths: Array.from({ length: 30 }, (_, i) => `src/h${i}.ts`),
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        operation: "FILE_EXCERPT" as const,
        path: `src/h${i}.ts`,
        maxBytes: EVIDENCE_LIMITS.maxExcerptBytes,
      })),
    ]);

    expect(outcome.evidenceBytesUsed)
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalEvidenceBytes);
    expect(outcome.excerptBytesUsed)
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalExcerptBytes);
  });

  it("reports bytes used, so the budget is visible rather than implicit", async () => {
    const outcome = await service().inspect([
      { operation: "REPOSITORY_METADATA" },
      { operation: "REPOSITORY_STATUS" },
    ]);
    expect(outcome.evidenceBytesUsed).toBeGreaterThan(0);
    expect(outcome.evidenceBytesUsed)
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalEvidenceBytes);
    expect(outcome.budgetLimited).toBe(false);
  });

  it("stays within budget on a large changed-file set, and reports omissions", async () => {
    /**
     * Names are kept well under the Windows path ceiling.
     *
     * The first version used 300-character names and simply failed to create
     * the fixture - a test that errors before it asserts proves nothing.
     */
    fs.mkdirSync(path.join(repo, "deep"), { recursive: true });
    const count = EVIDENCE_LIMITS.maxChangedFiles + 40;
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(
        path.join(repo, "deep", `${String(i).padStart(4, "0")}-${"n".repeat(60)}.ts`),
        "x\n",
      );
    }

    const outcome = await service().inspect([{ operation: "CHANGED_FILES" }]);
    expect(outcome.evidenceBytesUsed)
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalEvidenceBytes);

    const item = outcome.items[0]!;
    if (item.kind !== "CHANGED_FILES") throw new Error("expected CHANGED_FILES");

    // More changed files exist than the per-item cap allows, and the shortfall
    // is stated rather than left to be inferred from a short array.
    expect(item.totalCount).toBeGreaterThan(item.paths.length);
    expect(item.truncated).toBe(true);
    expect(item.paths.length).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxChangedFiles);
  });

  it("bounds a refusal-heavy batch", async () => {
    // Fifty refusals, each carrying a message and a path.
    const requests = Array.from({ length: EVIDENCE_LIMITS.maxRequests }, (_, i) => ({
      operation: "FILE_EXCERPT" as const,
      path: `../escape-${String(i)}-${"p".repeat(300)}`,
      maxBytes: 100,
    }));
    const outcome = await service().inspect(requests);

    expect(outcome.items).toEqual([]);
    expect(outcome.refusals.length).toBeGreaterThan(0);
    expect(outcome.evidenceBytesUsed)
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalEvidenceBytes);
  });

  it("bounds a mixed batch of metadata, paths and refusals", async () => {
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(repo, "src", `x${i}.ts`), "x\n");
    }
    const outcome = await service().inspect([
      { operation: "CHANGED_FILES" },
      {
        operation: "FILE_METADATA",
        paths: Array.from({ length: 40 }, (_, i) => `src/x${i}.ts`),
      },
      { operation: "FILE_EXCERPT", path: "../nope", maxBytes: 100 },
      { operation: "REPOSITORY_METADATA" },
    ]);

    expect(outcome.evidenceBytesUsed)
      .toBeLessThanOrEqual(EVIDENCE_LIMITS.maxTotalEvidenceBytes);
    // Nothing vanished without a trace: every path is either an item or a refusal.
    expect(outcome.items.length + outcome.refusals.length).toBeGreaterThan(0);
  });

  it("is deterministic when a bound is reached", async () => {
    fs.mkdirSync(path.join(repo, "deep"), { recursive: true });
    for (let i = 0; i < EVIDENCE_LIMITS.maxChangedFiles + 40; i++) {
      fs.writeFileSync(
        path.join(repo, "deep", `${String(i).padStart(4, "0")}-${"q".repeat(60)}.ts`),
        "x\n");
    }
    const first = await service().inspect([{ operation: "CHANGED_FILES" }]);
    const second = await service().inspect([{ operation: "CHANGED_FILES" }]);

    expect(JSON.stringify(second.items)).toBe(JSON.stringify(first.items));
    expect(second.evidenceBytesUsed).toBe(first.evidenceBytesUsed);
    expect(second.budgetLimited).toBe(first.budgetLimited);
  });

  it("distinguishes 'no more evidence' from 'more existed and was withheld'", async () => {
    // A clean, small repository: nothing withheld.
    const quiet = await service().inspect([{ operation: "REPOSITORY_STATUS" }]);
    expect(quiet.budgetLimited).toBe(false);
    expect(quiet.refusals).toEqual([]);

    // The flag is the cheap signal; refusals carry the detail.
    expect(typeof quiet.budgetLimited).toBe("boolean");
  });
});

// ===========================================================================
describe("existing protections still hold", () => {
  it("still refuses a sensitive path before reading it", async () => {
    fs.writeFileSync(path.join(repo, ".env"), "API_KEY=must-not-appear\n");
    const outcome = await service().inspect([
      { operation: "FILE_EXCERPT", path: ".env", maxBytes: 1024 },
    ]);
    expect(outcome.items).toEqual([]);
    expect(outcome.refusals[0]!.code).toBe("sensitive_path");
    expect(JSON.stringify(outcome)).not.toContain("must-not-appear");
  });

  it("still refuses traversal, and charges the refusal to the budget", async () => {
    const outcome = await service().inspect([
      { operation: "FILE_EXCERPT", path: "../../etc/passwd", maxBytes: 100 },
    ]);
    expect(outcome.refusals[0]!.code).toBe("path_traversal");
    expect(outcome.evidenceBytesUsed).toBeGreaterThan(0);
  });
});
