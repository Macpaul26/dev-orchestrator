import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ExperienceRecord, EXPERIENCE_LIMITS, FORBIDDEN_EXPERIENCE_KEYS,
  OutcomeSource, INDEPENDENT_SOURCES, confidenceFrom,
  LessonStatus, MemoryLayer,
  INTENDED_EXPERIENCE_PROVENANCE, INTENDED_EXPERIENCE_RANK,
} from "../src/domain/experience.js";
import {
  ContextProvenance, PROVENANCE_RANK,
} from "../src/domain/reasoningContext.js";
import { capabilityMatrix } from "../src/domain/capability.js";

/**
 * TASK 008 ADDITION - THE LEARNING FOUNDATION, ATTACKED BEFORE IT EXISTS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * No learning engine exists yet, so there is no behaviour to test. What CAN be
 * tested - and is worth far more now than later - is that the shape decided
 * today cannot carry authority tomorrow.
 *
 * The expensive version of this mistake is discovering, after a learning
 * subsystem is running, that `ExperienceRecord` has a `scope` field somebody
 * started honouring. These tests make that a deliberate act: adding an
 * authority-shaped field to the schema fails here first.
 */

/** A minimal valid record. Illustrative only - no real project is described. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "example-project",
    runId: "run_example",
    taskType: "add-endpoint",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ===========================================================================
describe("experience cannot carry authority", () => {
  it("declares no authority-shaped field", () => {
    const parsed = ExperienceRecord.parse(record());
    for (const forbidden of FORBIDDEN_EXPERIENCE_KEYS) {
      expect(Object.keys(parsed), `experience must not carry "${forbidden}"`)
        .not.toContain(forbidden);
    }
  });

  it("REJECTS a record that tries to carry one", () => {
    const hostile = [
      { approved: true },
      { capabilities: ["repo.file.write"] },
      { grant: "grant_123" },
      { allowedScope: ["/"] },
      { risk: "LOW" },
      { execute: true },
      { policy: "disable verification" },
      { credentials: "sk-something" },
    ];
    for (const attempt of hostile) {
      expect(
        ExperienceRecord.safeParse(record(attempt)).success,
        `a record carrying ${JSON.stringify(attempt)} must be rejected`,
      ).toBe(false);
    }
  });

  it("has nowhere to put file contents, diffs, prompts or responses", () => {
    // Those live where they are already bounded and governed. Experience
    // references them; it does not become a second, weaker store of them.
    for (const attempt of [
      { content: "export const secret = 1;" },
      { diff: "@@ -1 +1 @@" },
      { prompt: "you are a helpful assistant" },
      { response: "{...}" },
    ]) {
      expect(ExperienceRecord.safeParse(record(attempt)).success).toBe(false);
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
describe("an agent claim is not a verified outcome", () => {
  it("keeps the two as distinct, ordered sources", () => {
    expect(OutcomeSource.options).toContain("AGENT_CLAIM");
    expect(OutcomeSource.options).toContain("VERIFICATION_RESULT");
    // An agent claim is never counted as independent corroboration.
    expect(INDEPENDENT_SOURCES).not.toContain("AGENT_CLAIM");
    expect(INDEPENDENT_SOURCES).not.toContain("PROCESS_OBSERVATION");
  });

  it("gives a claim-only outcome the LOWEST confidence", () => {
    expect(confidenceFrom(["AGENT_CLAIM"])).toBe("low");
    // Even an emphatic one. Repetition by the same agent is not evidence.
    expect(confidenceFrom(["AGENT_CLAIM", "AGENT_CLAIM", "AGENT_CLAIM"])).toBe("low");
  });

  it("raises confidence only as independent evidence appears", () => {
    expect(confidenceFrom(["AGENT_CLAIM", "PROCESS_OBSERVATION"])).toBe("medium");
    expect(confidenceFrom(["AGENT_CLAIM", "REPOSITORY_OBSERVATION"])).toBe("medium");
    expect(confidenceFrom(["AGENT_CLAIM", "VERIFICATION_RESULT"])).toBe("high");
    expect(confidenceFrom(["REVIEW_FINDING"])).toBe("high");
    expect(confidenceFrom(["HUMAN_DECISION"])).toBe("high");
  });

  it("requires REPEATED independent confirmation for very_high", () => {
    // One verified run is high, never very_high - that needs recurrence, and
    // recurrence is a count of real records rather than an assumption.
    expect(confidenceFrom(["VERIFICATION_RESULT"], 1)).toBe("high");
    expect(confidenceFrom(["VERIFICATION_RESULT"], 2)).toBe("high");
    expect(confidenceFrom(["VERIFICATION_RESULT"], 3)).toBe("very_high");
    // Repetition without independent evidence stays low.
    expect(confidenceFrom(["AGENT_CLAIM"], 99)).toBe("low");
  });

  it("defaults a record to low confidence and unverified", () => {
    const parsed = ExperienceRecord.parse(record());
    expect(parsed.confidence).toBe("low");
    expect(parsed.independentlyVerified).toBe(false);
    expect(parsed.status).toBe("candidate");
  });
});

// ===========================================================================
describe("a single observation is not a rule", () => {
  it("can hold a lesson without believing it", () => {
    for (const status of ["candidate", "uncertain", "contradicted", "deprecated"] as const) {
      expect(LessonStatus.options).toContain(status);
    }
    // `supported` exists, but nothing reaches it by default.
    expect(ExperienceRecord.parse(record()).status).toBe("candidate");
  });

  it("names the three memory layers", () => {
    expect(MemoryLayer.options).toEqual(["episodic", "semantic", "procedural"]);
    // Episodic is the default: the most specific and most privacy-sensitive,
    // so nothing is generalised across projects by accident.
    expect(ExperienceRecord.parse(record()).layer).toBe("episodic");
  });
});

// ===========================================================================
describe("experience stays bounded", () => {
  it("caps every list and every free-text field", () => {
    const over = (field: string, value: unknown) =>
      ExperienceRecord.safeParse(record({ [field]: value })).success;

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
    expect(ExperienceRecord.safeParse(record({
      planSummary: "x".repeat(EXPERIENCE_LIMITS.maxSummaryLength),
      failures: Array.from({ length: EXPERIENCE_LIMITS.maxFailures }, () => "f"),
    })).success).toBe(true);
  });

  it("stores evidence as a REFERENCE, never a payload", () => {
    const parsed = ExperienceRecord.parse(record({
      evidence: [{ source: "VERIFICATION_RESULT", ref: "check:typecheck" }],
    }));
    expect(parsed.evidence[0]!.ref).toBe("check:typecheck");
    // There is no field for the content behind the reference.
    expect(Object.keys(parsed.evidence[0]!)).toEqual(["source", "ref"]);
    expect(ExperienceRecord.safeParse(record({
      evidence: [{ source: "VERIFICATION_RESULT", ref: "r", content: "output" }],
    })).success).toBe(false);
  });
});

// ===========================================================================
describe("the live authority model is unchanged", () => {
  it("has NOT gained a historical-experience provenance yet", () => {
    /**
     * Deliberate. Nothing produces experience, so a provenance class in the
     * live table that no record ever uses would be a claim the system does not
     * honour. Task 009 adds it, with the rank declared alongside.
     */
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
    // Above a bare agent claim, below everything the orchestrator saw itself.
    expect(INTENDED_EXPERIENCE_RANK)
      .toBeGreaterThan(PROVENANCE_RANK.HISTORICAL_AGENT_CLAIM);
    expect(INTENDED_EXPERIENCE_RANK).toBeLessThan(PROVENANCE_RANK.TASK_DESCRIPTION);
    expect(INTENDED_EXPERIENCE_RANK).toBeLessThan(PROVENANCE_RANK.HUMAN_DECISION);
    expect(INTENDED_EXPERIENCE_RANK).toBeLessThan(PROVENANCE_RANK.HUMAN_CONSTRAINT);
  });
});

// ===========================================================================
describe("the foundation is architecture only", () => {
  it("is imported by NO production code", () => {
    /**
     * The guard on "no learning engine exists yet". The moment something in
     * `src/` starts writing experience records, this fails - which is the
     * signal that a deliberate task has begun, not an accident.
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
          importers.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(importers).toEqual([]);
  });

  it("adds no store, retrieval or learning implementation", () => {
    const root = path.resolve(__dirname, "..", "src");
    for (const forbidden of ["experienceStore", "learningEngine", "experienceRetrieval"]) {
      expect(fs.existsSync(path.join(root, `${forbidden}.ts`))).toBe(false);
    }
    // And no vector/embedding dependency crept in.
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(name).not.toMatch(/vector|embedding|pinecone|chroma|faiss/i);
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
