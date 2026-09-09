import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ExperienceStore } from "../src/experience/experienceStore.js";
import {
  ExperienceRetrieval, tokenize, compareForOrdering,
} from "../src/experience/experienceRetrieval.js";
import {
  RETRIEVAL_LIMITS, ExperienceRetrievalRequest, RetrievedExperience,
  FORBIDDEN_RETRIEVAL_KEYS,
} from "../src/domain/experienceRetrieval.js";
import { EXPERIENCE_STORAGE_LIMITS } from "../src/domain/experienceStorage.js";
import { EXPERIENCE_LIMITS } from "../src/domain/experience.js";
import { tmpDir, rmDir } from "./helpers.js";

/**
 * TASK 010 - EXPERIENCE RETRIEVAL, ATTACKED.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY BEING DEFENDED
 * ---------------------------------------------------------------------------
 * Retrieval is the first thing in the learning architecture that CHOOSES. Every
 * layer before it either stored what it was given or handed back what it was
 * asked for; this one decides which historical material is worth surfacing, and
 * that is exactly where "relevant" quietly becomes "true".
 *
 *   a match is not evidence, and no result may carry a confidence;
 *   one project can never see another's history;
 *   a corrupt record is never returned as a valid memory;
 *   the same corpus and request always produce the same ordering;
 *   nothing here can reach the filesystem, a capability, or a model;
 *   "found nothing" and "could not look properly" never share a shape.
 */

let tmp: string;
let store: ExperienceStore;
let retrieval: ExperienceRetrieval;

const ISO = "2026-09-08T12:00:00.000Z";

function record(overrides: Record<string, unknown> = {}) {
  return {
    scope: "project",
    layer: "episodic",
    projectId: "alpha",
    runId: "run_1",
    taskType: "add-endpoint",
    createdAt: ISO,
    ...overrides,
  };
}

/** Write a record and return its id, failing loudly if the write was refused. */
function write(projectId: string, overrides: Record<string, unknown> = {}): string {
  const result = store.write(projectId, record({ projectId, ...overrides }));
  if (!result.ok) throw new Error(`fixture write refused: ${result.failure.code}`);
  return result.id;
}

function retrieve(request: unknown) {
  return retrieval.retrieve(request);
}

/** The happy path, unwrapped, so a failure surfaces as a failure. */
function outcome(request: unknown) {
  const result = retrieve(request);
  if (!result.ok) throw new Error(`retrieval failed: ${result.failure.code}`);
  return result.retrieval;
}

beforeEach(() => {
  tmp = tmpDir("orch-retr-");
  store = new ExperienceStore(tmp);
  retrieval = new ExperienceRetrieval(store);
});

afterEach(() => { rmDir(tmp); });

// ===========================================================================
describe("basic retrieval", () => {
  it("finds a record whose text matches the query", () => {
    write("alpha", {
      runId: "run_1",
      planSummary: "Added a rate limiter to the checkout endpoint.",
    });

    const found = outcome({ projectId: "alpha", query: "rate limiter checkout" });
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.experience.runId).toBe("run_1");
    expect(found.coverage).toEqual({ kind: "complete", examined: 1 });
  });

  it("finds a partial match", () => {
    write("alpha", { planSummary: "Migrated the session store to Redis." });

    const found = outcome({ projectId: "alpha", query: "redis migration plan" });
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.relevance.matchedTerms).toContain("redis");
  });

  it("returns several matches, most relevant first", () => {
    write("alpha", { runId: "weak", planSummary: "Touched the cache." });
    write("alpha", {
      runId: "strong",
      planSummary: "Rewrote the cache eviction policy for the session cache.",
      successfulPatterns: ["cache eviction is tested with a fake clock"],
    });

    const found = outcome({ projectId: "alpha", query: "cache eviction policy" });
    expect(found.results).toHaveLength(2);
    expect(found.results[0]!.experience.runId).toBe("strong");
    expect(found.results[0]!.relevance.score)
      .toBeGreaterThan(found.results[1]!.relevance.score);
  });

  it("returns nothing when nothing matches, and says the search was complete", () => {
    write("alpha", { planSummary: "Added a rate limiter." });

    const found = outcome({ projectId: "alpha", query: "kubernetes ingress" });
    expect(found.results).toEqual([]);
    expect(found.matched).toBe(0);
    // NOT the same as "could not look". See the empty-versus-incomplete suite.
    expect(found.coverage).toEqual({ kind: "complete", examined: 1 });
  });

  it("returns nothing for a project with no history at all", () => {
    const found = outcome({ projectId: "alpha", query: "anything" });
    expect(found.results).toEqual([]);
    expect(found.coverage).toEqual({ kind: "complete", examined: 0 });
  });
});

// ===========================================================================
describe("ranking", () => {
  it("ranks broader term coverage above sheer repetition", () => {
    /**
     * The ranking policy's central choice, stated as a test. A record repeating
     * one query term many times is a worse answer than one mentioning several
     * of them, and a naive frequency sum would order these the other way round.
     */
    write("alpha", {
      runId: "repetitive",
      planSummary: Array.from({ length: 40 }, () => "cache").join(" "),
    });
    write("alpha", {
      runId: "broad",
      planSummary: "cache invalidation across the reporting boundary",
    });

    const found = outcome({
      projectId: "alpha", query: "cache invalidation reporting boundary",
    });
    expect(found.results[0]!.experience.runId).toBe("broad");
  });

  it("caps how much one repeated term can contribute", () => {
    write("alpha", {
      runId: "spam",
      planSummary: Array.from({ length: 200 }, () => "widget").join(" "),
    });
    const found = outcome({ projectId: "alpha", query: "widget" });
    // One matched term, plus occurrences capped at maxTermHits.
    expect(found.results[0]!.relevance.score)
      .toBe(1000 + RETRIEVAL_LIMITS.maxTermHits);
  });

  it("breaks ties deterministically, newest first then by id", () => {
    // Same text, so the same score. Only the tiebreak can separate them.
    const older = write("alpha", {
      runId: "older", createdAt: "2026-09-07T12:00:00.000Z",
      planSummary: "identical text about widgets",
    });
    const newer = write("alpha", {
      runId: "newer", createdAt: "2026-09-08T12:00:00.000Z",
      planSummary: "identical text about widgets",
    });

    const found = outcome({ projectId: "alpha", query: "widgets" });
    expect(found.results).toHaveLength(2);
    expect(found.results[0]!.relevance.score).toBe(found.results[1]!.relevance.score);
    expect(found.results.map((r) => r.id)).toEqual([newer, older]);
  });

  it("orders equal scores and equal timestamps by id, a total order", () => {
    const ids = [
      write("alpha", { runId: "a", planSummary: "same words here" }),
      write("alpha", { runId: "b", planSummary: "same words here" }),
      write("alpha", { runId: "c", planSummary: "same words here" }),
    ];
    const found = outcome({ projectId: "alpha", query: "same words" });
    expect(found.results.map((r) => r.id)).toEqual([...ids].sort());
  });

  it("orders by the documented total order, not by insertion order", () => {
    /**
     * ADDED AFTER MUTATION TESTING, WHICH FOUND THIS GAP.
     *
     * Deleting the tie-breaking rules entirely left every other test in this
     * file passing. The store hands candidates over in `createdAt DESC, id ASC`
     * order already, so a stable sort reproduces the required ordering by
     * accident - and no black-box retrieval test can distinguish "ordered
     * correctly" from "happened to arrive correctly ordered".
     *
     * That accidental agreement IS the dependence on insertion order the
     * ordering rule exists to remove. So the comparator is tested directly,
     * against input deliberately arranged in the wrong order.
     */
    const shuffled = [
      { score: 10, createdAt: "2026-01-01T00:00:00.000Z", id: "aaa" },
      { score: 90, createdAt: "2026-01-01T00:00:00.000Z", id: "zzz" },
      { score: 90, createdAt: "2026-03-01T00:00:00.000Z", id: "mmm" },
      { score: 90, createdAt: "2026-01-01T00:00:00.000Z", id: "bbb" },
      { score: 50, createdAt: "2026-05-01T00:00:00.000Z", id: "ccc" },
    ];

    expect([...shuffled].sort(compareForOrdering).map((c) => c.id)).toEqual([
      "mmm", // highest score, newest of the three that share it
      "bbb", // same score and timestamp as zzz, lower id
      "zzz",
      "ccc", // middle score, regardless of being the newest overall
      "aaa",
    ]);

    // A total order: no two distinct candidates ever compare equal, so the
    // result cannot depend on whether the sort itself is stable.
    for (const a of shuffled) {
      for (const b of shuffled) {
        if (a.id === b.id) continue;
        expect(compareForOrdering(a, b)).not.toBe(0);
      }
    }

    // And reversing the input cannot change the answer.
    expect([...shuffled].reverse().sort(compareForOrdering).map((c) => c.id))
      .toEqual([...shuffled].sort(compareForOrdering).map((c) => c.id));
  });

  it("orders by code unit, not by locale-sensitive collation", () => {
    /**
     * ADDED AFTER REVIEW FOUND A DETERMINISM DEFECT.
     *
     * The comparator used the locale-aware string collation method. Its answer
     * depends on the host locale and on the ICU data the runtime was built
     * with, so two machines could order the same corpus differently while every
     * test passed on both - a determinism claim resting on a property of the
     * machine rather than of the code.
     *
     * The pair below is where the two primitives genuinely disagree: under
     * en-US collation "a" sorts BEFORE "B", while by code unit "B" (0x42) sorts
     * before "a" (0x61). So this is a BEHAVIOURAL test, not a stylistic one -
     * reintroducing collation flips these assertions regardless of what the
     * source happens to look like.
     */
    const lower = "a";
    const upper = "B";
    const byCodeUnit = lower < upper ? -1 : 1;
    expect(
      lower.localeCompare(upper) !== byCodeUnit,
      "this fixture only proves anything where the two primitives disagree",
    ).toBe(true);

    // id ASCENDING by code unit: "B" precedes "a", so "a" compares AFTER "B".
    expect(compareForOrdering(
      { score: 1, createdAt: "2026-01-01T00:00:00.000Z", id: "a" },
      { score: 1, createdAt: "2026-01-01T00:00:00.000Z", id: "B" },
    )).toBeGreaterThan(0);

    // createdAt DESCENDING by code unit: "a" is the greater, so it comes first.
    expect(compareForOrdering(
      { score: 1, createdAt: "a", id: "x" },
      { score: 1, createdAt: "B", id: "x" },
    )).toBeLessThan(0);
  });

  it("keeps locale-sensitive collation out of the ordering path", () => {
    /**
     * The structural half. The behavioural test above proves the CURRENT
     * comparator is code-unit; this one stops collation returning anywhere in
     * the ordering path, including the store sort the retrieval cursor depends
     * on agreeing with.
     *
     * The token is assembled rather than written literally, so this file does
     * not trip its own scan.
     */
    const collate = "locale" + "Compare";
    for (const file of [
      path.resolve(__dirname, "..", "src", "experience", "experienceRetrieval.ts"),
      path.resolve(__dirname, "..", "src", "experience", "experienceStore.ts"),
    ]) {
      expect(fs.readFileSync(file, "utf8"), `${path.basename(file)} must not collate`)
        .not.toContain(collate);
    }
  });

  it("orders the same way under any ambient locale", () => {
    /**
     * A test that only passes on the machine that wrote it is not evidence.
     * Code-unit comparison is a language property and consults no locale, so
     * changing the ambient locale environment must change nothing.
     */
    const sample = [
      { score: 90, createdAt: "2026-03-01T00:00:00.000Z", id: "mmm" },
      { score: 90, createdAt: "2026-01-01T00:00:00.000Z", id: "bbb" },
      { score: 10, createdAt: "2026-09-01T00:00:00.000Z", id: "aaa" },
    ];
    const expected = [...sample].sort(compareForOrdering).map((c) => c.id);

    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    try {
      for (const locale of ["tr-TR.UTF-8", "de-DE.UTF-8", "C", "en-US.UTF-8"]) {
        process.env.LANG = locale;
        process.env.LC_ALL = locale;
        expect([...sample].sort(compareForOrdering).map((c) => c.id), locale)
          .toEqual(expected);
      }
    } finally {
      if (saved.LANG === undefined) delete process.env.LANG;
      else process.env.LANG = saved.LANG;
      if (saved.LC_ALL === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = saved.LC_ALL;
    }
  });

  it("produces identical results across repeated retrievals", () => {
    for (let i = 0; i < 12; i += 1) {
      write("alpha", {
        runId: `run_${String(i)}`,
        createdAt: new Date(Date.parse(ISO) + i * 1000).toISOString(),
        planSummary: `deploy pipeline step ${String(i % 3)} cache`,
      });
    }

    const first = outcome({ projectId: "alpha", query: "deploy pipeline cache" });
    for (let run = 0; run < 5; run += 1) {
      const again = outcome({ projectId: "alpha", query: "deploy pipeline cache" });
      expect(again.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
      expect(again.results.map((r) => r.relevance.score))
        .toEqual(first.results.map((r) => r.relevance.score));
    }
  });

  it("does not let storage order decide relevance order", () => {
    /**
     * The distinction between pagination and retrieval, tested rather than
     * asserted. The store returns newest first; the best match here is the
     * OLDEST record, and it must still come back first.
     */
    write("alpha", {
      runId: "newest-but-weak", createdAt: "2026-09-08T12:00:00.000Z",
      planSummary: "unrelated work on logging",
    });
    write("alpha", {
      runId: "oldest-but-strong", createdAt: "2026-09-01T12:00:00.000Z",
      planSummary: "postgres connection pool exhaustion during nightly reindex",
    });

    const found = outcome({
      projectId: "alpha", query: "postgres connection pool exhaustion",
    });
    expect(found.results[0]!.experience.runId).toBe("oldest-but-strong");
  });
});

// ===========================================================================
describe("bounds", () => {
  it("refuses an oversized query", () => {
    const result = retrieve({
      projectId: "alpha",
      query: "a".repeat(RETRIEVAL_LIMITS.maxQueryChars + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_query");
  });

  it("refuses a limit above the ceiling rather than silently clamping", () => {
    const result = retrieve({
      projectId: "alpha", query: "anything",
      limit: RETRIEVAL_LIMITS.maxResults + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_request");
  });

  it("never returns more than maxResults", () => {
    for (let i = 0; i < RETRIEVAL_LIMITS.maxResults + 12; i += 1) {
      write("alpha", {
        runId: `run_${String(i)}`,
        createdAt: new Date(Date.parse(ISO) + i * 1000).toISOString(),
        planSummary: "shared matching term widget",
      });
    }
    const found = outcome({ projectId: "alpha", query: "widget" });
    expect(found.results).toHaveLength(RETRIEVAL_LIMITS.maxResults);
    // The caller learns how many matched, without being handed all of them.
    expect(found.matched).toBe(RETRIEVAL_LIMITS.maxResults + 12);
  });

  it("honours a smaller caller limit", () => {
    for (let i = 0; i < 8; i += 1) {
      write("alpha", {
        runId: `run_${String(i)}`,
        createdAt: new Date(Date.parse(ISO) + i * 1000).toISOString(),
        planSummary: "shared matching term widget",
      });
    }
    expect(outcome({ projectId: "alpha", query: "widget", limit: 3 }).results)
      .toHaveLength(3);
  });

  it("bounds the bytes one retrieval returns", () => {
    const filler = "widget ".repeat(Math.floor(EXPERIENCE_LIMITS.maxSummaryLength / 7));
    for (let i = 0; i < RETRIEVAL_LIMITS.maxResults; i += 1) {
      write("alpha", {
        runId: `run_${String(i)}`,
        createdAt: new Date(Date.parse(ISO) + i * 1000).toISOString(),
        planSummary: filler, implementationOutcome: filler,
        verificationOutcome: filler, reviewOutcome: filler,
      });
    }
    const found = outcome({ projectId: "alpha", query: "widget" });
    expect(found.bytesReturned).toBeLessThanOrEqual(RETRIEVAL_LIMITS.maxResultBytes);
  });

  it("bounds the terms one query contributes", () => {
    const terms = Array.from({ length: RETRIEVAL_LIMITS.maxQueryTerms + 40 },
      (_, i) => `term${String(i)}`);
    expect(tokenize(terms.join(" "), RETRIEVAL_LIMITS.maxQueryTerms))
      .toHaveLength(RETRIEVAL_LIMITS.maxQueryTerms);
  });

  it("bounds the searchable text taken from one record", () => {
    /**
     * A record may legitimately hold far more text than the projection reads -
     * four summaries plus four lists is tens of thousands of characters. A term
     * placed past the per-field bound must not be findable, or the "bounded"
     * claim is decorative.
     */
    // Comfortably inside the record's own summary ceiling, and comfortably
    // past the projection's per-field bound - which is the thing under test.
    const head = "alpha ".repeat(RETRIEVAL_LIMITS.maxFieldChars / 5);
    expect(head.length).toBeGreaterThan(RETRIEVAL_LIMITS.maxFieldChars);
    expect(head.length + 20).toBeLessThan(EXPERIENCE_LIMITS.maxSummaryLength);
    write("alpha", { planSummary: `${head}NEEDLEBEYONDTHEBOUND` });

    const found = outcome({ projectId: "alpha", query: "needlebeyondthebound" });
    expect(found.results).toEqual([]);
    // The same record IS findable by text inside the bound.
    expect(outcome({ projectId: "alpha", query: "alpha" }).results).toHaveLength(1);
  });

  it("bounds items read from a list field", () => {
    const items = Array.from({ length: EXPERIENCE_LIMITS.maxPatterns },
      (_, i) => `pattern number ${String(i)} marker${String(i)}`);
    write("alpha", { successfulPatterns: items });

    // Inside the item bound.
    expect(outcome({ projectId: "alpha", query: "marker0" }).results).toHaveLength(1);
    // Past it.
    const late = `marker${String(RETRIEVAL_LIMITS.maxFieldItems + 2)}`;
    expect(outcome({ projectId: "alpha", query: late }).results).toEqual([]);
  });
});

// ===========================================================================
describe("project isolation", () => {
  it("never returns another project's experience", () => {
    write("alpha", { runId: "alpha_run", planSummary: "shared vocabulary widget" });
    write("beta", { runId: "beta_run", planSummary: "shared vocabulary widget" });

    const fromAlpha = outcome({ projectId: "alpha", query: "shared vocabulary widget" });
    expect(fromAlpha.results).toHaveLength(1);
    expect(fromAlpha.results[0]!.experience.runId).toBe("alpha_run");
    expect(JSON.stringify(fromAlpha)).not.toContain("beta_run");

    // And in reverse, so this is not an artefact of which was written first.
    const fromBeta = outcome({ projectId: "beta", query: "shared vocabulary widget" });
    expect(fromBeta.results).toHaveLength(1);
    expect(fromBeta.results[0]!.experience.runId).toBe("beta_run");
    expect(JSON.stringify(fromBeta)).not.toContain("alpha_run");
  });

  it("rejects a record copied into the wrong project rather than returning it", () => {
    /**
     * Physical relocation, not a schema trick: the file is moved on disk into
     * another project's directory. Task 009 refuses it on read, and retrieval
     * must consume that refusal rather than work around it.
     */
    const id = write("beta", { runId: "beta_run", planSummary: "portable widget text" });
    const from = path.join(tmp, "beta");
    const name = fs.readdirSync(from).find((entry) => entry.includes(id));
    fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true });
    fs.copyFileSync(path.join(from, name!), path.join(tmp, "alpha", name!));

    const found = outcome({ projectId: "alpha", query: "portable widget text" });
    expect(found.results).toEqual([]);
    expect(found.rejected.map((d) => d.code)).toContain("project_mismatch");
    expect(JSON.stringify(found)).not.toContain("beta_run");
  });

  it("offers no API that takes more than one project", () => {
    expect(Object.getOwnPropertyNames(ExperienceRetrieval.prototype).sort())
      .toEqual(["constructor", "retrieve"]);

    // A request naming several projects is not merely ignored, it is refused.
    for (const attempt of [
      { projectIds: ["alpha", "beta"], query: "x" },
      { projectId: ["alpha", "beta"], query: "x" },
      { projectId: "alpha", query: "x", crossProject: true },
      { projectId: "alpha", query: "x", allProjects: true },
      { projectId: "*", query: "x" },
      { projectId: "", query: "x" },
    ]) {
      expect(retrieve(attempt).ok, `${JSON.stringify(attempt)} must be refused`)
        .toBe(false);
    }
  });

  it("refuses a project id that tries to leave the store", () => {
    write("alpha", { planSummary: "widget" });
    for (const bad of [
      "../alpha", "..", "alpha/../beta", "/alpha", "C:/alpha",
      "\\\\server\\share", "alpha\\beta", "./alpha", "ALPHA", "alpha ",
    ]) {
      const result = retrieve({ projectId: bad, query: "widget" });
      expect(result.ok, `${bad} must be refused`).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("invalid_project_id");
    }
  });
});

// ===========================================================================
describe("integrity", () => {
  it("never returns a tampered record as a result", () => {
    const id = write("alpha", { planSummary: "the original widget text" });
    const dir = path.join(tmp, "alpha");
    const name = fs.readdirSync(dir).find((entry) => entry.includes(id))!;
    const file = path.join(dir, name);

    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      record: { planSummary: string };
    };
    stored.record.planSummary = "the tampered widget text";
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));

    const found = outcome({ projectId: "alpha", query: "widget text" });
    expect(found.results).toEqual([]);
    expect(found.rejected.map((d) => d.code)).toContain("integrity_mismatch");
    expect(JSON.stringify(found)).not.toContain("tampered");
  });

  it("never returns an unparseable record, and keeps searching the rest", () => {
    write("alpha", { runId: "good", planSummary: "healthy widget record" });
    const id = write("alpha", {
      runId: "bad", createdAt: "2026-09-07T12:00:00.000Z",
      planSummary: "corrupt widget record",
    });
    const dir = path.join(tmp, "alpha");
    const name = fs.readdirSync(dir).find((entry) => entry.includes(id))!;
    fs.writeFileSync(path.join(dir, name), '{"record": {"planSummary": "wid');

    const found = outcome({ projectId: "alpha", query: "widget record" });
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.experience.runId).toBe("good");
    expect(found.rejected).not.toHaveLength(0);
  });

  it("reports a rejected candidate without quoting anything inside it", () => {
    const id = write("alpha", { planSummary: "TEST_SECRET_VALUE widget" });
    const dir = path.join(tmp, "alpha");
    const name = fs.readdirSync(dir).find((entry) => entry.includes(id))!;
    fs.writeFileSync(path.join(dir, name),
      '{"record":{"planSummary":"TEST_SECRET_VALUE"},"broken":');

    const found = outcome({ projectId: "alpha", query: "widget" });
    expect(JSON.stringify(found)).not.toContain("TEST_SECRET_VALUE");
  });
});

// ===========================================================================
describe("empty is not the same as incomplete", () => {
  it("says bounded when the directory could not be enumerated", () => {
    write("alpha", { planSummary: "findable widget" });
    const dir = path.join(tmp, "alpha");
    for (let i = 0; i < EXPERIENCE_STORAGE_LIMITS.maxDirectoryEntries; i += 1) {
      fs.closeSync(fs.openSync(path.join(dir, `filler-${String(i)}.dat`), "w"));
    }

    const found = outcome({ projectId: "alpha", query: "findable widget" });
    expect(found.coverage.kind).toBe("bounded");
    if (found.coverage.kind !== "bounded") return;
    expect(found.coverage.reason).toBe("scan_incomplete");
    /**
     * A generous ceiling, on purpose. Creating twenty thousand files is the only
     * way to reach the directory bound, and its cost is dominated by the host's
     * filesystem rather than by anything under test - measured here at 9s idle
     * and 218s while the machine was busy, a 24x spread with no code change
     * between them. A limit tight enough to catch a hang would report ordinary
     * background load as a product defect.
     */
  }, 300_000);

  it("says complete when it examined everything and found nothing", () => {
    write("alpha", { planSummary: "findable widget" });
    const found = outcome({ projectId: "alpha", query: "absent vocabulary" });
    expect(found.results).toEqual([]);
    expect(found.coverage.kind).toBe("complete");
  });

  it("does not report a storage failure as an empty result", () => {
    write("alpha", { planSummary: "widget" });
    const original = store.list.bind(store);
    try {
      (store as { list: unknown }).list = () => { throw new Error("disk on fire"); };
      const result = retrieve({ projectId: "alpha", query: "widget" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("storage_failure");
      expect(result.failure.message).not.toContain(tmp);
    } finally {
      (store as { list: unknown }).list = original;
    }
  });
});

// ===========================================================================
describe("candidate acquisition is bounded and paged", () => {
  it("examines beyond a single storage page", () => {
    /**
     * The reason `list` gained a cursor. A retrieval that could only see the
     * newest page would be pagination wearing retrieval's name, and the match
     * below sits well past the first page.
     */
    const pageSize = EXPERIENCE_STORAGE_LIMITS.maxListResults;
    for (let i = 0; i < pageSize + 20; i += 1) {
      write("alpha", {
        runId: `filler_${String(i)}`,
        createdAt: new Date(Date.parse(ISO) + (i + 100) * 1000).toISOString(),
        planSummary: "ordinary unrelated work",
      });
    }
    // Oldest, so it sorts last in storage order - on the second page.
    write("alpha", {
      runId: "buried",
      createdAt: "2026-01-01T00:00:00.000Z",
      planSummary: "distinctive marmalade telemetry incident",
    });

    const found = outcome({ projectId: "alpha", query: "marmalade telemetry" });
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.experience.runId).toBe("buried");
    expect(found.coverage.kind).toBe("complete");
    expect(found.coverage.examined).toBe(pageSize + 21);
  }, 60_000);

  it("stops at the candidate ceiling and says so", () => {
    const over = RETRIEVAL_LIMITS.maxCandidateRecords + 25;
    for (let i = 0; i < over; i += 1) {
      write("alpha", {
        runId: `run_${String(i)}`,
        createdAt: new Date(Date.parse(ISO) + i * 1000).toISOString(),
        planSummary: "widget",
      });
    }

    const found = outcome({ projectId: "alpha", query: "widget" });
    expect(found.coverage.kind).toBe("bounded");
    if (found.coverage.kind !== "bounded") return;
    expect(["candidate_limit", "page_limit"]).toContain(found.coverage.reason);
    expect(found.coverage.examined)
      .toBeLessThanOrEqual(RETRIEVAL_LIMITS.maxCandidateRecords);
  }, 110_000);
});

// ===========================================================================
describe("relevance is not confidence, and retrieval is not authority", () => {
  it("exposes a score and nothing that resembles trust", () => {
    write("alpha", { planSummary: "widget", sources: ["AGENT_CLAIM"] });
    const found = outcome({ projectId: "alpha", query: "widget" });
    const serialized = JSON.stringify(found);

    for (const forbidden of FORBIDDEN_RETRIEVAL_KEYS) {
      /**
       * `scope` is on the forbidden list because a field like `allowedScope`
       * would mean REACH. The retrieved record carries `scope: "project"`,
       * which is the opposite - the literal that confines an episodic record to
       * one project. Task 008-A's foundation suite makes the same exception for
       * the same reason, and the assertion below checks the value rather than
       * waving the field through.
       */
      if (forbidden === "scope") continue;
      expect(serialized, `a retrieval result must not carry "${forbidden}"`)
        .not.toContain(`"${forbidden}"`);
    }
    expect(found.results[0]!.experience.scope).toBe("project");
    expect(Object.keys(found.results[0]!.relevance).sort())
      .toEqual(["matchedTerms", "score"]);
  });

  it("refuses a request that tries to supply trust or a ranking function", () => {
    for (const attempt of [
      { confidence: "very_high" }, { verified: true }, { trust: 1 },
      { independentlyVerified: true }, { authority: "HUMAN_DECISION" },
      { capabilities: ["repo.file.write"] }, { approved: true },
      { ranker: "custom" }, { strategy: "semantic" }, { path: "/etc/passwd" },
    ]) {
      const result = retrieve({ projectId: "alpha", query: "widget", ...attempt });
      expect(result.ok, `${JSON.stringify(attempt)} must be refused`).toBe(false);
    }
  });

  it("does not upgrade provenance by selecting a record", () => {
    write("alpha", { planSummary: "widget", sources: ["AGENT_CLAIM"] });
    const found = outcome({ projectId: "alpha", query: "widget" });
    const retrieved = found.results[0]!;

    // Still an agent claim, still episodic, still project-scoped.
    expect(retrieved.experience.sources).toEqual(["AGENT_CLAIM"]);
    expect(retrieved.experience.sources).not.toContain("VERIFICATION_RESULT");
    expect(retrieved.experience.sources).not.toContain("HUMAN_DECISION");
    expect(retrieved.experience.layer).toBe("episodic");
    expect(retrieved.experience.scope).toBe("project");
    expect(retrieved.experience.status).toBe("candidate");

    // And it still parses as exactly what it was before retrieval touched it.
    expect(RetrievedExperience.safeParse(retrieved).success).toBe(true);
  });

  it("cannot rank a record higher for carrying an authority label", () => {
    /**
     * Provenance is not searchable text. If it were, a query mentioning a
     * source name would surface records for their LABEL rather than their
     * content - authority semantics leaking into relevance.
     */
    write("alpha", { runId: "claimed", sources: ["AGENT_CLAIM"], planSummary: "widget" });
    write("alpha", {
      runId: "decided", createdAt: "2026-09-07T12:00:00.000Z",
      sources: ["HUMAN_DECISION"], planSummary: "widget",
    });

    const found = outcome({ projectId: "alpha", query: "HUMAN_DECISION human decision" });
    expect(found.results).toEqual([]);
  });

  it("does not make a portable lesson or enable cross-project use", async () => {
    const { PortableLesson } = await import("../src/domain/experience.js");
    expect(PortableLesson.safeParse({
      layer: "semantic", taskType: "add-endpoint", statement: "A lesson.",
      crossProjectEligible: true, createdAt: ISO,
    }).success).toBe(false);
  });
});

// ===========================================================================
describe("adversarial queries", () => {
  it("treats path traversal in a query as ordinary words", () => {
    write("alpha", { planSummary: "etc passwd handling in the importer" });

    const found = outcome({ projectId: "alpha", query: "../../../etc/passwd" });
    // Tokenized to words and matched as text. Nothing opened a path.
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.relevance.matchedTerms.sort()).toEqual(["etc", "passwd"]);
  });

  it("refuses a whitespace or punctuation-only query", () => {
    for (const empty of ["   ", "\t\n", "!!! ??? ...", "- - -", "a", " x "]) {
      const result = retrieve({ projectId: "alpha", query: empty });
      expect(result.ok, `${JSON.stringify(empty)} must be refused`).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("invalid_query");
    }
  });

  it("does not multiply work for a query that repeats one term", () => {
    write("alpha", { planSummary: "widget" });
    // Inside the query ceiling: the point is de-duplication, not the size bound,
    // which the oversized-query test covers separately.
    const repeated = Array.from({ length: 100 }, () => "widget").join(" ");
    expect(repeated.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.maxQueryChars);

    // De-duplicated to a single term, so the score matches the plain query.
    const spam = outcome({ projectId: "alpha", query: repeated });
    const plain = outcome({ projectId: "alpha", query: "widget" });
    expect(spam.results[0]!.relevance.score).toBe(plain.results[0]!.relevance.score);
  });

  it("matches across Unicode compatibility forms", () => {
    write("alpha", { planSummary: "deployment checklist" });
    // Fullwidth Latin normalizes onto ordinary Latin under NFKC.
    const found = outcome({ projectId: "alpha", query: "ＤＥＰＬＯＹＭＥＮＴ" });
    expect(found.results).toHaveLength(1);
  });

  it("lower-cases without a locale, so the same query behaves everywhere", () => {
    // Turkish locale rules would map this "I" to a dotless form and break the
    // match. `toLowerCase` is deliberately locale-independent.
    expect(tokenize("INDEX", 8)).toEqual(["index"]);
    expect(tokenize("Index", 8)).toEqual(["index"]);
  });

  it("is not confused by unrelated files in the project directory", () => {
    write("alpha", { planSummary: "findable widget" });
    const dir = path.join(tmp, "alpha");
    for (let i = 0; i < 40; i += 1) {
      fs.writeFileSync(path.join(dir, `noise-${String(i)}.txt`), "widget widget");
    }
    fs.writeFileSync(path.join(dir, "records.json"), '{"planSummary":"widget"}');

    const found = outcome({ projectId: "alpha", query: "findable widget" });
    expect(found.results).toHaveLength(1);
    expect(found.coverage).toEqual({ kind: "complete", examined: 1 });
  });

  it("returns the same ordering when the filesystem hands entries back differently", () => {
    /**
     * Storage order must not reach the result order. The records are written in
     * one sequence and the assertion is against an ordering derived only from
     * score, timestamp and id.
     */
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(write("alpha", {
        runId: `run_${String(i)}`,
        createdAt: ISO, // identical, so only the id tiebreak can order them
        planSummary: "equally matching widget text",
      }));
    }
    const found = outcome({ projectId: "alpha", query: "equally matching widget" });
    expect(found.results.map((r) => r.id)).toEqual([...ids].sort());
  });
});

// ===========================================================================
describe("architecture boundaries", () => {
  const source = (): string => fs.readFileSync(
    path.resolve(__dirname, "..", "src", "experience", "experienceRetrieval.ts"), "utf8",
  );

  it("cannot reach the filesystem at all", () => {
    /**
     * Not "does not currently"; cannot. Every candidate arrives through the
     * store, so Task 009's integrity, identity and ownership checks apply to
     * retrieval without being reimplemented - and there is no side door for a
     * corrupt record to arrive through.
     */
    for (const forbidden of [
      "node:fs", "node:path", "readdirSync", "opendirSync", "readFileSync",
      "writeFileSync", "createReadStream",
    ]) {
      expect(source(), `retrieval must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("adds no capability, grant, approval, process or network access", () => {
    for (const forbidden of [
      "domain/capability.js", "domain/grant.js", "domain/approval.js",
      "grantAuthority", "issueGrant", "child_process", "fetch(", "node:net",
    ]) {
      expect(source(), `retrieval must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("calls no model and imports no embedding machinery", () => {
    for (const forbidden of [
      "anthropic", "Anthropic", "reasoningModel", "embedding", "vector",
      "cosine", "openai",
    ]) {
      expect(source(), `retrieval must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never writes experience", () => {
    write("alpha", { planSummary: "widget" });
    const before = fs.readdirSync(path.join(tmp, "alpha")).sort();
    for (let i = 0; i < 5; i += 1) outcome({ projectId: "alpha", query: "widget" });
    expect(fs.readdirSync(path.join(tmp, "alpha")).sort()).toEqual(before);
    expect(source()).not.toContain(".write(");
  });

  it("is not reachable from the model, reasoning or tool layers", () => {
    const root = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (!/^(models|reasoning|tools|adapters|graph)\//.test(rel)) continue;
        if (fs.readFileSync(full, "utf8").includes("experienceRetrieval")) {
          offenders.push(rel);
        }
      }
    };
    walk(root);
    // Task 012 owns adaptive reasoning; nothing consumes retrieval yet.
    expect(offenders).toEqual([]);
  });

  it("adds no historical provenance to the live reasoning table", async () => {
    const { ContextProvenance, PROVENANCE_RANK } =
      await import("../src/domain/reasoningContext.js");
    expect(ContextProvenance.options).not.toContain("HISTORICAL_EXPERIENCE");
    expect(Object.keys(PROVENANCE_RANK)).not.toContain("HISTORICAL_EXPERIENCE");
  });

  it("adds no capability to the matrix", async () => {
    const { capabilityMatrix } = await import("../src/domain/capability.js");
    expect(capabilityMatrix().filter((c) => c.implemented)
      .map((c) => c.capability).sort()).toEqual([
      "repo.file.delete", "repo.file.write", "repo.metadata.read", "repo.read",
      "verification.execute",
    ]);
  });

  it("keeps the request shape closed", () => {
    expect(ExperienceRetrievalRequest.safeParse({
      projectId: "alpha", query: "widget", unexpected: true,
    }).success).toBe(false);
  });
});
