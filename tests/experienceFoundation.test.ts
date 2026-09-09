import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  EpisodicExperience, PortableLesson, EXPERIENCE_LIMITS, FORBIDDEN_EXPERIENCE_KEYS,
  OutcomeSource, INDEPENDENT_SOURCES, provisionalConfidence, isIndependentlyVerified,
  EvidenceConfidence, LessonStatus, MemoryLayer, PROVISIONAL_THRESHOLDS,
  INTENDED_EXPERIENCE_PROVENANCE, INTENDED_EXPERIENCE_RANK,
} from "../src/domain/experience.js";
import {
  ContextProvenance, PROVENANCE_RANK,
} from "../src/domain/reasoningContext.js";
import { capabilityMatrix } from "../src/domain/capability.js";

/**
 * TASK 008-A - THE LEARNING FOUNDATION, ATTACKED BEFORE IT EXISTS.
 *
 * ---------------------------------------------------------------------------
 * TWO FALSE CLAIMS THESE TESTS NOW PIN DOWN
 * ---------------------------------------------------------------------------
 * The first version of this foundation asserted two things that were not true,
 * and the review caught both:
 *
 *   1. "No content field, therefore no cross-project leakage." Free text IS
 *      content - `planSummary` and `failures` can carry a diff, a prompt or a
 *      secret perfectly well. The absence of a field NAMED `content` prevented
 *      nothing.
 *
 *   2. "Confidence is derived, never invented." `confidence` and
 *      `independentlyVerified` were writable, so a record could claim
 *      `very_high` on the strength of an agent claim alone.
 *
 * Both are now structural, and the tests below try to violate them rather than
 * inspecting comments that say they cannot be violated.
 */

/** A minimal valid episodic record. Illustrative - no real project described. */
function episodic(overrides: Record<string, unknown> = {}) {
  return {
    scope: "project",
    layer: "episodic",
    projectId: "example-project",
    runId: "run_example",
    taskType: "add-endpoint",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A minimal valid portable lesson. Illustrative only. */
function portable(overrides: Record<string, unknown> = {}) {
  return {
    layer: "semantic",
    taskType: "add-endpoint",
    statement: "Prefer adding a test before changing shared validation logic.",
    crossProjectEligible: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ===========================================================================
describe("experience cannot carry authority", () => {
  it("declares no authority-shaped field", () => {
    for (const parsed of [
      EpisodicExperience.parse(episodic()),
      PortableLesson.parse(portable()),
    ]) {
      for (const forbidden of FORBIDDEN_EXPERIENCE_KEYS) {
        // `scope` is a legitimate episodic field pinned to a literal; it is on
        // the forbidden list for the PORTABLE shape, where it would mean reach.
        if (forbidden === "scope" && "scope" in parsed) continue;
        expect(Object.keys(parsed), `must not carry "${forbidden}"`)
          .not.toContain(forbidden);
      }
    }
  });

  it("REJECTS a record that tries to carry authority", () => {
    for (const attempt of [
      { approved: true },
      { capabilities: ["repo.file.write"] },
      { grant: "grant_123" },
      { allowedScope: ["/"] },
      { risk: "LOW" },
      { execute: true },
      { policy: "disable verification" },
      { credentials: "placeholder" },
    ]) {
      expect(
        EpisodicExperience.safeParse(episodic(attempt)).success,
        `episodic carrying ${JSON.stringify(attempt)} must be rejected`,
      ).toBe(false);
      expect(
        PortableLesson.safeParse(portable(attempt)).success,
        `portable carrying ${JSON.stringify(attempt)} must be rejected`,
      ).toBe(false);
    }
  });

  it("adds no capability to the matrix", () => {
    const implemented = capabilityMatrix().filter((c) => c.implemented)
      .map((c) => c.capability).sort();
    expect(implemented).toEqual([
      "repo.file.delete", "repo.file.write", "repo.metadata.read", "repo.read",
      "verification.execute",
    ]);
    for (const c of capabilityMatrix()) {
      if (["git.mutate", "process.execute", "network.access"].includes(c.capability)) {
        expect(c.implemented, `${c.capability} must stay unimplemented`).toBe(false);
      }
    }
  });
});

// ===========================================================================
describe("the content boundary is structural, not a naming convention", () => {
  it("admits plainly that an EPISODIC record holds project content", () => {
    /**
     * Not a weakness being hidden - a truth being typed. These fields are free
     * text from a real run and can contain anything a repository can contain.
     * The protection is that `scope` cannot say anything but "project".
     */
    const parsed = EpisodicExperience.parse(episodic({
      planSummary: "Refactored the token parser in the auth module.",
      failures: ["The first attempt broke the refresh path."],
    }));
    expect(parsed.scope).toBe("project");
    expect(parsed.planSummary).toContain("token parser");
  });

  it("makes an episodic record STRUCTURALLY unable to claim wider scope", () => {
    for (const attempt of ["global", "cross-project", "shared", "any", ""]) {
      expect(
        EpisodicExperience.safeParse(episodic({ scope: attempt })).success,
        `scope "${attempt}" must be unrepresentable`,
      ).toBe(false);
    }
  });

  it("makes a PORTABLE lesson unable to carry a payload", () => {
    const payloads = [
      ["a file path", "See src/auth/token.ts for the fix."],
      ["a diff hunk", "@@ -1,4 +1,4 @@ const a = 1;"],
      ["JSON", 'Use {"retries": 3} as the default.'],
      ["a key assignment", "Set API_KEY=abcdefghijklmnop in the environment."],
      ["a base64-ish token", "The token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA works."],
      ["a newline", "First lesson.\nSecond lesson."],
      ["backticks", "Call `readFileSync` instead."],
      ["a URL", "See https://example.invalid/docs for details."],
    ] as const;

    for (const [label, statement] of payloads) {
      expect(
        PortableLesson.safeParse(portable({ statement })).success,
        `a portable lesson must not be able to carry ${label}`,
      ).toBe(false);
    }
  });

  it("still allows an ordinary prose lesson", () => {
    const parsed = PortableLesson.parse(portable({
      statement: "Adding a regression test before refactoring shared logic "
        + "has repeatedly caught breakage early.",
    }));
    expect(parsed.statement).toContain("regression test");
  });

  it("CANNOT mark anything eligible to cross a project boundary", () => {
    /**
     * The strongest guarantee this foundation actually makes. There is no value
     * meaning "yes", so no code written before the sanitisation design exists
     * can promote a lesson across projects - by accident or otherwise.
     */
    for (const attempt of [true, "true", 1, "yes"]) {
      expect(
        PortableLesson.safeParse(portable({ crossProjectEligible: attempt })).success,
        `crossProjectEligible=${JSON.stringify(attempt)} must be unrepresentable`,
      ).toBe(false);
    }
    expect(PortableLesson.parse(portable()).crossProjectEligible).toBe(false);
  });

  it("keeps evidence a REFERENCE, and refuses prose in the ref", () => {
    const parsed = EpisodicExperience.parse(episodic({
      evidence: [{ source: "VERIFICATION_RESULT", ref: "check:typecheck" }],
    }));
    expect(Object.keys(parsed.evidence[0]!)).toEqual(["source", "ref"]);

    for (const attempt of [
      { source: "VERIFICATION_RESULT", ref: "the check failed because x = 1" },
      { source: "VERIFICATION_RESULT", ref: "@@ -1 +1 @@ diff" },
      { source: "VERIFICATION_RESULT", ref: "line one\nline two" },
      { source: "VERIFICATION_RESULT", ref: "r", content: "output" },
    ]) {
      expect(
        EpisodicExperience.safeParse(episodic({ evidence: [attempt] })).success,
        `evidence ${JSON.stringify(attempt)} must be rejected`,
      ).toBe(false);
    }
  });
});

// ===========================================================================
describe("confidence cannot be asserted independently of its evidence", () => {
  it("REFUSES to store confidence at all", () => {
    /**
     * The correction. Storing a derived trust value beside the evidence it is
     * derived from is what let a record say `very_high` on an agent's say-so.
     * It is read from `sources`, never written next to them.
     */
    expect(EpisodicExperience.safeParse(
      episodic({ confidence: "very_high" })).success).toBe(false);
    expect(EpisodicExperience.safeParse(
      episodic({ confidence: "low" })).success).toBe(false);
    expect(Object.keys(EpisodicExperience.parse(episodic()))).not.toContain("confidence");
  });

  it("REFUSES to store independentlyVerified", () => {
    expect(EpisodicExperience.safeParse(
      episodic({ independentlyVerified: true })).success).toBe(false);
    expect(Object.keys(EpisodicExperience.parse(episodic())))
      .not.toContain("independentlyVerified");
  });

  it("cannot represent the dangerous state the review identified", () => {
    // sources: agent-only, confidence: very_high, independentlyVerified: true
    expect(EpisodicExperience.safeParse(episodic({
      sources: ["AGENT_CLAIM"],
      confidence: "very_high",
      independentlyVerified: true,
    })).success).toBe(false);
  });

  it("excludes the agent and the OS from what counts as independent", () => {
    /**
     * The constant, asserted directly rather than only through behaviour.
     * `PROCESS_OBSERVATION` is the subtle one: an exit code is a fact about a
     * program finishing, not corroboration that a repository is in the intended
     * state, so it must not count towards independence.
     */
    expect(INDEPENDENT_SOURCES).not.toContain("AGENT_CLAIM");
    expect(INDEPENDENT_SOURCES).not.toContain("PROCESS_OBSERVATION");
    expect([...INDEPENDENT_SOURCES].sort()).toEqual([
      "HUMAN_DECISION", "REPOSITORY_OBSERVATION", "REVIEW_FINDING",
      "VERIFICATION_RESULT",
    ]);
    // Every independent source is a real member of the source vocabulary.
    for (const source of INDEPENDENT_SOURCES) {
      expect(OutcomeSource.options).toContain(source);
    }
  });

  it("derives low confidence from an agent claim, however often repeated", () => {
    expect(provisionalConfidence(["AGENT_CLAIM"])).toBe("low");
    expect(provisionalConfidence(["AGENT_CLAIM", "AGENT_CLAIM", "AGENT_CLAIM"]))
      .toBe("low");
    expect(isIndependentlyVerified(["AGENT_CLAIM"])).toBe(false);
    // An exit code is not corroboration of repository state.
    expect(isIndependentlyVerified(["AGENT_CLAIM", "PROCESS_OBSERVATION"])).toBe(false);
  });

  it("raises confidence only as independent evidence appears", () => {
    expect(provisionalConfidence(["AGENT_CLAIM", "PROCESS_OBSERVATION"])).toBe("medium");
    expect(provisionalConfidence(["REPOSITORY_OBSERVATION"])).toBe("medium");
    expect(provisionalConfidence(["VERIFICATION_RESULT"])).toBe("high");
    expect(provisionalConfidence(["REVIEW_FINDING"])).toBe("high");
    expect(isIndependentlyVerified(["REPOSITORY_OBSERVATION"])).toBe(true);
  });

  it("CANNOT reach very_high from this module at all", () => {
    /**
     * Recurrence must be counted from attributable records, and no store exists
     * to count them in. The previous helper took the count from the caller,
     * which let anyone assert recurrence nobody had demonstrated.
     */
    const everySource = OutcomeSource.options;
    expect(provisionalConfidence(everySource)).toBe("high");
    // The vocabulary retains the value; nothing here produces it.
    expect(EvidenceConfidence.options).toContain("very_high");
  });

  it("marks the confirmation threshold as an UNVALIDATED assumption", () => {
    // Recorded so a future task cannot quietly treat it as established fact.
    expect(PROVISIONAL_THRESHOLDS.confirmationsForVeryHigh).toBe(3);
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "domain", "experience.ts"), "utf8",
    );
    expect(source).toContain("UNVALIDATED");
  });

  it("keeps the confidence vocabulary bounded and non-authoritative", () => {
    expect(EvidenceConfidence.options).toEqual(["low", "medium", "high", "very_high"]);
    expect(EvidenceConfidence.safeParse("certain").success).toBe(false);
    expect(EvidenceConfidence.safeParse(1).success).toBe(false);
    // It is a label, not a permission: no capability name is a valid value.
    expect(EvidenceConfidence.safeParse("repo.file.write").success).toBe(false);
  });
});

// ===========================================================================
describe("a single observation is not a rule", () => {
  it("can hold a lesson without believing it, and retire it without deleting it", () => {
    for (const status of
      ["candidate", "supported", "uncertain", "contradicted", "deprecated"] as const) {
      expect(LessonStatus.options).toContain(status);
    }
    expect(EpisodicExperience.parse(episodic()).status).toBe("candidate");
    expect(PortableLesson.parse(portable()).status).toBe("candidate");
  });

  it("names the three memory layers and pins each type to its own", () => {
    expect(MemoryLayer.options).toEqual(["episodic", "semantic", "procedural"]);
    // An episodic record cannot relabel itself as semantic to look portable.
    expect(EpisodicExperience.safeParse(episodic({ layer: "semantic" })).success)
      .toBe(false);
    expect(PortableLesson.safeParse(portable({ layer: "episodic" })).success)
      .toBe(false);
  });

  it("counts support and contradiction separately", () => {
    const parsed = PortableLesson.parse(portable({
      supportingRecords: 4, contradictingRecords: 2,
    }));
    expect(parsed.supportingRecords).toBe(4);
    expect(parsed.contradictingRecords).toBe(2);
    // Both default to zero: nothing is assumed supported.
    expect(PortableLesson.parse(portable()).supportingRecords).toBe(0);
  });
});

// ===========================================================================
describe("experience stays bounded", () => {
  it("caps every list and every free-text field", () => {
    const over = (field: string, value: unknown) =>
      EpisodicExperience.safeParse(episodic({ [field]: value })).success;

    expect(over("failures",
      Array.from({ length: EXPERIENCE_LIMITS.maxFailures + 1 }, () => "f"))).toBe(false);
    expect(over("successfulPatterns",
      Array.from({ length: EXPERIENCE_LIMITS.maxPatterns + 1 }, () => "p"))).toBe(false);
    expect(over("evidence",
      Array.from({ length: EXPERIENCE_LIMITS.maxEvidenceRefs + 1 },
        () => ({ source: "AGENT_CLAIM", ref: "r" })))).toBe(false);
    expect(over("planSummary",
      "x".repeat(EXPERIENCE_LIMITS.maxSummaryLength + 1))).toBe(false);
    expect(over("taskType",
      "t".repeat(EXPERIENCE_LIMITS.maxTaskTypeLength + 1))).toBe(false);
  });

  it("accepts a record exactly at the limits", () => {
    expect(EpisodicExperience.safeParse(episodic({
      planSummary: "x".repeat(EXPERIENCE_LIMITS.maxSummaryLength),
      failures: Array.from({ length: EXPERIENCE_LIMITS.maxFailures }, () => "f"),
    })).success).toBe(true);
  });

  it("keeps a portable lesson short", () => {
    expect(PortableLesson.safeParse(portable({
      statement: "a".repeat(EXPERIENCE_LIMITS.maxLessonStatementLength + 1),
    })).success).toBe(false);
    expect(PortableLesson.safeParse(portable({
      statement: "a".repeat(EXPERIENCE_LIMITS.maxLessonStatementLength),
    })).success).toBe(true);
  });
});

// ===========================================================================
describe("the live authority model is unchanged", () => {
  it("has NOT gained a historical-experience provenance yet", () => {
    expect(ContextProvenance.options).not.toContain(INTENDED_EXPERIENCE_PROVENANCE);
    expect(Object.keys(PROVENANCE_RANK)).not.toContain(INTENDED_EXPERIENCE_PROVENANCE);
  });

  it("keeps the six existing provenance classes and their order", () => {
    expect([...ContextProvenance.options].sort()).toEqual([
      "HISTORICAL_AGENT_CLAIM", "HUMAN_CONSTRAINT", "HUMAN_DECISION",
      "PROJECT_METADATA", "REPOSITORY_OBSERVATION", "TASK_DESCRIPTION",
    ]);
    expect(PROVENANCE_RANK.HUMAN_DECISION).toBeGreaterThan(PROVENANCE_RANK.HUMAN_CONSTRAINT);
    expect(PROVENANCE_RANK.HUMAN_CONSTRAINT).toBeGreaterThan(PROVENANCE_RANK.PROJECT_METADATA);
    expect(PROVENANCE_RANK.PROJECT_METADATA)
      .toBeGreaterThan(PROVENANCE_RANK.REPOSITORY_OBSERVATION);
    expect(PROVENANCE_RANK.REPOSITORY_OBSERVATION)
      .toBeGreaterThan(PROVENANCE_RANK.TASK_DESCRIPTION);
    expect(PROVENANCE_RANK.TASK_DESCRIPTION)
      .toBeGreaterThan(PROVENANCE_RANK.HISTORICAL_AGENT_CLAIM);
  });

  it("plans a rank for experience that outranks no human or observed source", () => {
    expect(INTENDED_EXPERIENCE_RANK)
      .toBeGreaterThan(PROVENANCE_RANK.HISTORICAL_AGENT_CLAIM);
    expect(INTENDED_EXPERIENCE_RANK).toBeLessThan(PROVENANCE_RANK.TASK_DESCRIPTION);
    expect(INTENDED_EXPERIENCE_RANK).toBeLessThan(PROVENANCE_RANK.HUMAN_DECISION);
    expect(INTENDED_EXPERIENCE_RANK).toBeLessThan(PROVENANCE_RANK.HUMAN_CONSTRAINT);
  });
});

// ===========================================================================
describe("the foundation is architecture only", () => {
  it("is imported ONLY by the experience store", () => {
    /**
     * UPDATED FOR TASK 009, DELIBERATELY.
     *
     * This guard previously asserted that NO production code imported the
     * foundation - the marker that it was architecture only. Task 009 adds the
     * first sanctioned consumer, the experience store, so the guard fired
     * exactly as designed: as the signal that a deliberate task had begun.
     *
     * It is NARROWED rather than deleted. The list stays exact, so a second
     * consumer - a retrieval layer, an evaluator, a workflow node quietly
     * writing experience - cannot appear without someone editing this line and
     * saying why.
     */
    const root = path.resolve(__dirname, "..", "src");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        if (full.endsWith(path.join("domain", "experience.ts"))) continue;
        if (fs.readFileSync(full, "utf8").includes("domain/experience.js")) {
          importers.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    };
    walk(root);
    /**
     * UPDATED AGAIN FOR TASK 010, DELIBERATELY.
     *
     * The retrieval layer is the second sanctioned consumer, so the guard fired
     * exactly as designed. The list stays EXACT: a third consumer - an
     * evaluator, a confidence engine, a workflow node quietly writing or reading
     * experience - still cannot appear without someone editing this line and
     * saying why.
     *
     * `experienceStorage.ts` and `experienceRetrieval.ts` in `domain/` sit
     * beside `experience.ts` and import it relatively, so they do not match this
     * specifier.
     */
    expect(importers.sort()).toEqual([
      "experience/experienceRetrieval.ts",
      "experience/experienceStore.ts",
    ]);
  });

  it("adds no evaluator or learning implementation", () => {
    /**
     * UPDATED FOR TASK 010, DELIBERATELY.
     *
     * `experienceRetrieval.ts` is removed because Task 010 IS retrieval, and it
     * was approved as retrieval only. Task 009 removed `experienceStore.ts` for
     * the same reason before it.
     *
     * Everything else stays forbidden: evaluation and confidence are Task 011,
     * and a learning engine is later still. Each remains a separate, separately
     * reviewed decision, and this list is what makes taking one early visible.
     */
    const root = path.resolve(__dirname, "..", "src");
    const forbidden = [
      "learningEngine.ts", "lessonEvaluator.ts", "confidenceEngine.ts",
    ];
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (forbidden.includes(entry.name)) found.push(entry.name);
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });

  it("adds no vector or embedding dependency", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const name of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]) {
      expect(name).not.toMatch(/vector|embedding|pinecone|chroma|faiss|weaviate|qdrant/i);
    }
  });

  it("reads no repository state and touches no filesystem", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "domain", "experience.ts"), "utf8",
    );
    for (const forbidden of [
      "node:fs", "readFileSync", "child_process", "fetch(", "spawn(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
