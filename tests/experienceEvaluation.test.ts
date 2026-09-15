import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ExperienceStore } from "../src/experience/experienceStore.js";
import {
  ExperienceEvaluator, recurrenceKey,
} from "../src/experience/experienceEvaluator.js";
import {
  EVALUATION_LIMITS, EvaluationRequest, EvaluationArtifact,
  FORBIDDEN_EVALUATION_KEYS,
} from "../src/domain/experienceEvaluation.js";
import { EXPERIENCE_STORAGE_LIMITS } from "../src/domain/experienceStorage.js";
import { tmpDir, rmDir } from "./helpers.js";

/**
 * TASK 011 - THE EVALUATOR, ATTACKED.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY BEING DEFENDED
 * ---------------------------------------------------------------------------
 * Task 010 chose which records to surface. This one puts a NUMBER on history,
 * and a number is the most portable thing in the system - it survives being
 * copied into a summary, a prompt or a decision long after the reasoning behind
 * it is gone. So:
 *
 *   a confidence must never be supplied by a caller, only derived;
 *   recurrence must never be mistaken for corroboration;
 *   contradiction must move the score, and absence of evidence must not;
 *   a bounded scan must never score like a complete one;
 *   provenance labels must not become an authority ladder inside the formula;
 *   one project's history must never reach another's evaluation;
 *   the same corpus must give the same number on any machine.
 */

let tmp: string;
let store: ExperienceStore;
let evaluator: ExperienceEvaluator;

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

let sequence = 0;
/** Write a record, failing loudly if the store refused the fixture. */
function write(projectId: string, overrides: Record<string, unknown> = {}): string {
  sequence += 1;
  const result = store.write(projectId, record({
    projectId,
    runId: `run_${String(sequence)}`,
    createdAt: new Date(Date.parse(ISO) + sequence * 1000).toISOString(),
    ...overrides,
  }));
  if (!result.ok) throw new Error(`fixture write refused: ${result.failure.code}`);
  return result.id;
}

/** The subject under evaluation: succeeded with approach "cache warming". */
function subject(projectId = "alpha"): string {
  return write(projectId, { successfulPatterns: ["cache warming"] });
}

function supportRecord(projectId = "alpha"): string {
  return write(projectId, { successfulPatterns: ["cache warming"] });
}

function contradictRecord(projectId = "alpha"): string {
  return write(projectId, { failedPatterns: ["cache warming"] });
}

function evaluate(request: unknown) {
  return evaluator.evaluate(request);
}

/** The happy path, unwrapped, so a failure surfaces as a failure. */
function artifact(projectId: string, experienceId: string) {
  const result = evaluate({ projectId, experienceId });
  if (!result.ok) throw new Error(`evaluation failed: ${result.failure.code}`);
  return result.evaluation;
}

/** The score, or null when the evaluator declined to state one. */
function score(projectId: string, id: string): number | null {
  const confidence = artifact(projectId, id).confidence;
  return confidence.kind === "assessed" ? confidence.score : null;
}

beforeEach(() => {
  tmp = tmpDir("orch-eval-");
  store = new ExperienceStore(tmp);
  evaluator = new ExperienceEvaluator(store);
  sequence = 0;
});

afterEach(() => { rmDir(tmp); });

// ===========================================================================
describe("schema validation", () => {
  it("accepts only a project and an experience id", () => {
    expect(EvaluationRequest.safeParse({
      projectId: "alpha", experienceId: "0".repeat(32),
    }).success).toBe(true);

    for (const attempt of [
      { unexpected: true }, { confidence: 100 }, { verified: true },
      { trusted: true }, { authority: "HUMAN_DECISION" }, { weights: [1, 2] },
      { formula: "custom" }, { crossProject: true }, { path: "/etc/passwd" },
      { projectIds: ["alpha", "beta"] },
    ]) {
      expect(EvaluationRequest.safeParse({
        projectId: "alpha", experienceId: "0".repeat(32), ...attempt,
      }).success, `${JSON.stringify(attempt)} must be refused`).toBe(false);
    }
  });

  it("refuses a malformed request rather than guessing", () => {
    for (const bad of [
      {}, null, "a string", 42,
      { projectId: "alpha" },
      { experienceId: "0".repeat(32) },
      { projectId: "alpha", experienceId: "not-hex" },
      { projectId: "alpha", experienceId: "ABCDEF".repeat(5) + "AB" },
    ]) {
      expect(evaluate(bad).ok, `${JSON.stringify(bad)} must be refused`).toBe(false);
    }
  });

  it("refuses a project id that tries to leave the store", () => {
    for (const bad of [
      "../alpha", "..", "alpha/../beta", "/alpha", "C:/alpha",
      "\\\\server\\share", "alpha\\beta", "./alpha", "ALPHA", "*",
    ]) {
      const result = evaluate({ projectId: bad, experienceId: "0".repeat(32) });
      expect(result.ok, `${bad} must be refused`).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("invalid_project_id");
    }
  });
});

// ===========================================================================
describe("basic evaluation", () => {
  it("reports insufficient evidence for a lone experience", () => {
    /**
     * An experience is not evidence for itself. A single record therefore has
     * NO score at all rather than a confident one - and "no score" is a
     * different shape from zero, not a smaller number.
     */
    const id = subject();
    const found = artifact("alpha", id);

    expect(found.confidence).toEqual({ kind: "insufficient_evidence" });
    expect(found.status).toBe("insufficient_evidence");
    expect(found.recurrence.cohort).toBe(0);
    expect(found.coverage).toEqual({ kind: "complete", examined: 1 });
  });

  it("reports the subject by id and the derived pattern, never the record", () => {
    const id = subject();
    const found = artifact("alpha", id);

    expect(found.subject).toBe(id);
    expect(found.pattern).toEqual({
      taskType: "add endpoint", approaches: ["cache warming"],
    });
    // The artifact carries no record, so it cannot carry record content.
    expect(JSON.stringify(found)).not.toContain("run_1");
  });

  it("fails closed on a subject that is not there", () => {
    const result = evaluate({ projectId: "alpha", experienceId: "0".repeat(32) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("subject_missing");
  });

  it("does not report a storage failure as an absent subject", () => {
    const id = subject();
    const original = store.list.bind(store);
    try {
      (store as { list: unknown }).list = () => { throw new Error("disk on fire"); };
      const result = evaluate({ projectId: "alpha", experienceId: id });
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
describe("recurrence", () => {
  it("groups experiences describing the same approach to the same task", () => {
    const id = subject();
    supportRecord();
    supportRecord();

    const found = artifact("alpha", id);
    expect(found.recurrence.cohort).toBe(2);
    expect(found.recurrence.supporting).toBe(2);
  });

  it("is not defeated by the fields that differ on every record", () => {
    /**
     * runId, createdAt and evidence refs are unique per record by construction.
     * A recurrence identity built from serialization would make every
     * experience unique and silently find nothing, which is the failure this
     * projection exists to prevent.
     */
    const id = subject();
    write("alpha", {
      successfulPatterns: ["cache warming"],
      runId: "totally-different-run",
      createdAt: "2020-01-01T00:00:00.000Z",
      evidence: [{ source: "VERIFICATION_RESULT", ref: "check:typecheck" }],
      planSummary: "Entirely different prose describing the same approach.",
    });

    expect(artifact("alpha", id).recurrence.supporting).toBe(1);
  });

  it("does not group different approaches together", () => {
    const id = subject();
    write("alpha", { successfulPatterns: ["connection pooling"] });

    const found = artifact("alpha", id);
    // Comparable - same task type - but it neither supports nor contradicts.
    expect(found.recurrence.cohort).toBe(1);
    expect(found.recurrence.supporting).toBe(0);
    expect(found.recurrence.contradicting).toBe(0);
    expect(found.confidence.kind).toBe("insufficient_evidence");
  });

  it("does not group the same approach under a different task type", () => {
    const id = subject();
    write("alpha", { taskType: "fix-bug", successfulPatterns: ["cache warming"] });

    expect(artifact("alpha", id).recurrence.cohort).toBe(0);
  });

  it("excludes the subject from its own cohort", () => {
    const id = subject();
    const found = artifact("alpha", id);
    // The subject exists and was examined, but corroborates nothing.
    expect(found.coverage.examined).toBe(1);
    expect(found.recurrence.cohort).toBe(0);
    expect(found.recurrence.supporting).toBe(0);
  });

  it("counts recurrence without treating it as support", () => {
    /**
     * "We have seen this before" and "this worked before" are different facts.
     * A record sharing the pattern's identity but recording no outcome for it
     * is neutral, and neutral records must not move the score.
     */
    const id = subject();
    // A comparable run - same task type - that recorded a different approach
    // entirely. It recurs, and it says nothing about cache warming.
    write("alpha", { successfulPatterns: ["connection pooling"] });
    supportRecord();

    const found = artifact("alpha", id);
    expect(found.recurrence.cohort).toBe(2);
    expect(found.recurrence.supporting).toBe(1);
    expect(found.recurrence.neutral).toBe(1);
    // The silent record did not raise the score: two comparable runs, one vote.
    expect(found.confidence).toEqual({ kind: "assessed", score: 33 });
  });

  it("normalizes case, punctuation and compatibility forms", () => {
    const id = subject();
    write("alpha", { successfulPatterns: ["Cache-Warming!"] });
    write("alpha", { successfulPatterns: ["ｃａｃｈｅ　ｗａｒｍｉｎｇ"] });

    expect(artifact("alpha", id).recurrence.supporting).toBe(2);
  });

  it("derives the same key regardless of approach ordering", () => {
    expect(recurrenceKey("add-endpoint", ["alpha", "beta"]))
      .toBe(recurrenceKey("add-endpoint", ["alpha", "beta"]));
    expect(recurrenceKey("add-endpoint", ["alpha"]))
      .not.toBe(recurrenceKey("add-endpoint", ["beta"]));
  });
});

// ===========================================================================
describe("supporting, contradictory and mixed outcomes", () => {
  it("scores consistent success above mixed outcomes", () => {
    /**
     * The brief's example, as a test. Five successes and a three-two split are
     * not the same evidence, and a design that counted occurrences would have
     * scored them identically.
     */
    const consistent = subject();
    for (let i = 0; i < 5; i += 1) supportRecord();
    const consistentScore = score("alpha", consistent);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);

    const mixed = subject();
    for (let i = 0; i < 3; i += 1) supportRecord();
    for (let i = 0; i < 2; i += 1) contradictRecord();
    const mixedScore = score("alpha", mixed);

    expect(consistentScore).not.toBeNull();
    expect(mixedScore).not.toBeNull();
    expect(consistentScore!).toBeGreaterThan(mixedScore!);
  });

  it("scores four supporting above four supporting with four contradicting", () => {
    const clean = subject();
    for (let i = 0; i < 4; i += 1) supportRecord();
    const cleanScore = score("alpha", clean);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);

    const split = subject();
    for (let i = 0; i < 4; i += 1) supportRecord();
    for (let i = 0; i < 4; i += 1) contradictRecord();
    const splitScore = score("alpha", split);

    expect(cleanScore).toBe(100);
    expect(splitScore).toBe(50);
  });

  it("distinguishes NO evidence from evidence AGAINST", () => {
    /**
     * Both would bottom out at zero on a plain scale, which is exactly why the
     * confidence is a union rather than a number. Absence of support is not
     * contradiction, and the two must not be conflated.
     */
    const nothing = subject();
    const noEvidence = artifact("alpha", nothing);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);

    const opposed = subject();
    for (let i = 0; i < 4; i += 1) contradictRecord();
    const against = artifact("alpha", opposed);

    expect(noEvidence.confidence).toEqual({ kind: "insufficient_evidence" });
    expect(noEvidence.status).toBe("insufficient_evidence");

    expect(against.confidence).toEqual({ kind: "assessed", score: 0 });
    expect(against.status).toBe("contradicted");
    expect(against.recurrence.contradicting).toBe(4);

    // Different shapes, different statuses. Never the same finding.
    expect(noEvidence.confidence.kind).not.toBe(against.confidence.kind);
  });

  it("treats a failed approach as contradiction even when the record also succeeded elsewhere", () => {
    const id = subject();
    // Succeeded at something else, but failed at the approach under evaluation.
    write("alpha", {
      successfulPatterns: ["cache warming", "connection pooling"],
      failedPatterns: ["cache warming"],
    });

    const found = artifact("alpha", id);
    expect(found.recurrence.contradicting).toBe(1);
    expect(found.recurrence.supporting).toBe(0);
  });

  it("lowers confidence monotonically as contradictions accumulate", () => {
    const seen: number[] = [];
    for (const contradictions of [0, 1, 2, 4]) {
      rmDir(tmp);
      tmp = tmpDir("orch-eval-");
      store = new ExperienceStore(tmp);
      evaluator = new ExperienceEvaluator(store);
      sequence = 0;

      const id = subject();
      for (let i = 0; i < 4; i += 1) supportRecord();
      for (let i = 0; i < contradictions; i += 1) contradictRecord();
      seen.push(score("alpha", id)!);
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!, `${String(i)} must not exceed its predecessor`)
        .toBeLessThan(seen[i - 1]!);
    }
  });
});

// ===========================================================================
describe("the confidence scale", () => {
  it("reaches its maximum only on consistent, saturated evidence", () => {
    const id = subject();
    for (let i = 0; i < EVALUATION_LIMITS.volumeSaturation; i += 1) supportRecord();
    expect(score("alpha", id)).toBe(100);
  });

  it("reaches its minimum when every voter contradicts", () => {
    const id = subject();
    for (let i = 0; i < 3; i += 1) contradictRecord();
    expect(score("alpha", id)).toBe(0);
  });

  it("stays inside the documented range under a flood of records", () => {
    const id = subject();
    for (let i = 0; i < 60; i += 1) supportRecord();
    for (let i = 0; i < 30; i += 1) contradictRecord();

    const found = artifact("alpha", id);
    expect(found.confidence.kind).toBe("assessed");
    if (found.confidence.kind !== "assessed") return;
    expect(found.confidence.score).toBeGreaterThanOrEqual(0);
    expect(found.confidence.score).toBeLessThanOrEqual(100);
    // Schema-enforced, not merely asserted.
    expect(EvaluationArtifact.safeParse(found).success).toBe(true);
  }, 60_000);

  it("does not let volume alone raise confidence beyond saturation", () => {
    /**
     * A pattern is not more reliable for having been recorded more often by the
     * same process. Past the saturation point, repetition adds nothing.
     */
    const few = subject();
    for (let i = 0; i < EVALUATION_LIMITS.volumeSaturation; i += 1) supportRecord();
    const fewScore = score("alpha", few);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);

    const many = subject();
    for (let i = 0; i < EVALUATION_LIMITS.volumeSaturation * 10; i += 1) supportRecord();
    expect(score("alpha", many)).toBe(fewScore);
  });

  it("scores a single corroboration below a saturated one", () => {
    const one = subject();
    supportRecord();
    const oneScore = score("alpha", one);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);

    const saturated = subject();
    for (let i = 0; i < EVALUATION_LIMITS.volumeSaturation; i += 1) supportRecord();

    expect(oneScore!).toBeLessThan(score("alpha", saturated)!);
  });
});

// ===========================================================================
describe("coverage", () => {
  it("marks a bounded scan bounded, and scores it lower than a complete one", () => {
    /**
     * The requirement that five successes in the first five hundred records of
     * five thousand must not read as "all history supports this". The same
     * evidence, scored under a scan that could not finish, must score lower.
     */
    const id = subject();
    for (let i = 0; i < EVALUATION_LIMITS.volumeSaturation; i += 1) supportRecord();
    const complete = artifact("alpha", id);
    expect(complete.coverage.kind).toBe("complete");
    expect(complete.confidence).toEqual({ kind: "assessed", score: 100 });

    // Make the directory too large to enumerate.
    const dir = path.join(tmp, "alpha");
    for (let i = 0; i < EXPERIENCE_STORAGE_LIMITS.maxDirectoryEntries; i += 1) {
      fs.closeSync(fs.openSync(path.join(dir, `filler-${String(i)}.dat`), "w"));
    }

    const bounded = artifact("alpha", id);
    expect(bounded.coverage.kind).toBe("bounded");
    if (bounded.coverage.kind !== "bounded") return;
    expect(bounded.coverage.reason).toBe("scan_incomplete");
    expect(bounded.confidence.kind).toBe("assessed");
    if (bounded.confidence.kind !== "assessed") return;
    expect(bounded.confidence.score).toBeLessThan(100);
  }, 300_000);

  it("reports how many records it examined", () => {
    const id = subject();
    supportRecord();
    contradictRecord();
    expect(artifact("alpha", id).coverage.examined).toBe(3);
  });
});

// ===========================================================================
describe("project isolation", () => {
  it("never lets one project's history reach another's evaluation", () => {
    const id = subject("alpha");
    // Identical pattern, different project. It must count for nothing.
    for (let i = 0; i < 5; i += 1) supportRecord("beta");

    const found = artifact("alpha", id);
    expect(found.recurrence.cohort).toBe(0);
    expect(found.confidence).toEqual({ kind: "insufficient_evidence" });
    expect(JSON.stringify(found)).not.toContain("beta");
  });

  it("does not evaluate a subject belonging to another project", () => {
    const id = subject("beta");
    const result = evaluate({ projectId: "alpha", experienceId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("subject_missing");
  });

  it("rejects a record physically copied into the wrong project", () => {
    const id = subject("alpha");
    supportRecord("alpha");

    // A record from beta, planted in alpha's directory, claiming the same
    // approach. It must not become supporting evidence.
    const foreign = supportRecord("beta");
    const from = path.join(tmp, "beta");
    const name = fs.readdirSync(from).find((entry) => entry.includes(foreign))!;
    fs.copyFileSync(path.join(from, name), path.join(tmp, "alpha", name));

    const found = artifact("alpha", id);
    expect(found.recurrence.supporting).toBe(1); // the genuine alpha record only
    expect(found.rejected.map((d) => d.code)).toContain("project_mismatch");
  });
});

// ===========================================================================
describe("corrupt records are never evidence", () => {
  it("does not count a tampered record as support", () => {
    const id = subject();
    const good = supportRecord();
    const bad = supportRecord();

    const dir = path.join(tmp, "alpha");
    const name = fs.readdirSync(dir).find((entry) => entry.includes(bad))!;
    const file = path.join(dir, name);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      record: { planSummary: string };
    };
    stored.record.planSummary = "tampered";
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));

    const found = artifact("alpha", id);
    expect(found.recurrence.supporting).toBe(1);
    expect(found.rejected.map((d) => d.code)).toContain("integrity_mismatch");
    expect(JSON.stringify(found)).not.toContain("tampered");
    expect(good).not.toBe(bad);
  });

  it("refuses to evaluate a defective subject", () => {
    const id = subject();
    const dir = path.join(tmp, "alpha");
    const name = fs.readdirSync(dir).find((entry) => entry.includes(id))!;
    fs.writeFileSync(path.join(dir, name), '{"record": {"planSummary": "trunc');

    const result = evaluate({ projectId: "alpha", experienceId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("subject_defective");
  });

  it("reports a rejected candidate without quoting anything inside it", () => {
    const id = subject();
    const bad = supportRecord();
    const dir = path.join(tmp, "alpha");
    const name = fs.readdirSync(dir).find((entry) => entry.includes(bad))!;
    fs.writeFileSync(path.join(dir, name),
      '{"record":{"planSummary":"TEST_SECRET_VALUE"},"broken":');

    expect(JSON.stringify(artifact("alpha", id))).not.toContain("TEST_SECRET_VALUE");
  });
});

// ===========================================================================
describe("determinism", () => {
  it("produces an identical artifact on repeated evaluation", () => {
    const id = subject();
    for (let i = 0; i < 3; i += 1) supportRecord();
    contradictRecord();

    const first = JSON.stringify(artifact("alpha", id));
    for (let run = 0; run < 5; run += 1) {
      expect(JSON.stringify(artifact("alpha", id))).toBe(first);
    }
  });

  it("does not depend on the order records were written", () => {
    const forward = subject();
    supportRecord();
    supportRecord();
    contradictRecord();
    const a = artifact("alpha", forward);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);
    sequence = 0;

    // The same corpus, written in a different order.
    contradictRecord();
    supportRecord();
    const reverse = subject();
    supportRecord();
    const b = artifact("alpha", reverse);

    expect(b.confidence).toEqual(a.confidence);
    expect(b.recurrence.supporting).toBe(a.recurrence.supporting);
    expect(b.recurrence.contradicting).toBe(a.recurrence.contradicting);
    expect(b.recurrence.key).toBe(a.recurrence.key);
  });

  it("normalizes without consulting a locale", () => {
    /**
     * Locale-aware lower-casing maps "I" differently under a Turkish locale, so
     * an identical corpus would group into different cohorts on different
     * machines. Task 010 shipped that defect in its comparator; this pins the
     * rule here.
     */
    expect(recurrenceKey("INDEX-REBUILD", ["INDEX"]))
      .toBe(recurrenceKey("index-rebuild", ["index"]));
    // Order and duplication do not change the identity either.
    expect(recurrenceKey("t", ["b", "a", "a"])).toBe(recurrenceKey("t", ["a", "b"]));

    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    try {
      const expected = recurrenceKey("add-endpoint", ["cache warming"]);
      for (const locale of ["tr-TR.UTF-8", "de-DE.UTF-8", "C", "en-US.UTF-8"]) {
        process.env.LANG = locale;
        process.env.LC_ALL = locale;
        expect(recurrenceKey("add-endpoint", ["cache warming"]), locale)
          .toBe(expected);
      }
    } finally {
      if (saved.LANG === undefined) delete process.env.LANG;
      else process.env.LANG = saved.LANG;
      if (saved.LC_ALL === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = saved.LC_ALL;
    }
  });

  it("does not consult the clock", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "experience", "experienceEvaluator.ts"),
      "utf8",
    );
    // No wall-clock reading: the artifact is a function of the corpus, so two
    // runs a week apart over unchanged records give the same answer.
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("new Date(");
  });
});

// ===========================================================================
describe("bounded work", () => {
  it("survives a flood of equivalent records without exceeding its budget", () => {
    const id = subject();
    for (let i = 0; i < 250; i += 1) supportRecord();

    const found = artifact("alpha", id);
    expect(found.recurrence.supporting)
      .toBeLessThanOrEqual(EVALUATION_LIMITS.maxCountedRecurrences);
    expect(found.coverage.examined)
      .toBeLessThanOrEqual(EVALUATION_LIMITS.maxCandidateRecords);
    expect(found.confidence).toEqual({ kind: "assessed", score: 100 });
  }, 120_000);

  it("survives a flood of contradictions the same way", () => {
    const id = subject();
    for (let i = 0; i < 250; i += 1) contradictRecord();

    const found = artifact("alpha", id);
    expect(found.recurrence.contradicting)
      .toBeLessThanOrEqual(EVALUATION_LIMITS.maxCountedRecurrences);
    expect(found.confidence).toEqual({ kind: "assessed", score: 0 });
  }, 120_000);

  it("stops at the candidate ceiling and says so", () => {
    const id = subject();
    for (let i = 0; i < EVALUATION_LIMITS.maxCandidateRecords + 20; i += 1) {
      write("alpha", { successfulPatterns: ["unrelated approach"] });
    }

    const found = artifact("alpha", id);
    expect(found.coverage.kind).toBe("bounded");
    if (found.coverage.kind !== "bounded") return;
    expect(["candidate_limit", "page_limit"]).toContain(found.coverage.reason);
    expect(found.coverage.examined)
      .toBeLessThanOrEqual(EVALUATION_LIMITS.maxCandidateRecords);
  }, 300_000);

  it("bounds how many approaches one record contributes", () => {
    const many = Array.from({ length: 20 }, (_, i) => `approach ${String(i)}`);
    const id = write("alpha", { successfulPatterns: many });
    expect(artifact("alpha", id).pattern.approaches.length)
      .toBeLessThanOrEqual(EVALUATION_LIMITS.maxPatternItems);
  });
});

// ===========================================================================
describe("evaluation is not authority", () => {
  it("produces no field that could be mistaken for trust or permission", () => {
    const id = subject();
    supportRecord();
    const serialized = JSON.stringify(artifact("alpha", id));

    for (const forbidden of FORBIDDEN_EVALUATION_KEYS) {
      expect(serialized, `an evaluation must not carry "${forbidden}"`)
        .not.toContain(`"${forbidden}"`);
    }
  });

  it("cannot be handed a confidence by its caller", () => {
    const id = subject();
    for (let i = 0; i < 3; i += 1) contradictRecord();

    // Every attempt to assert trust is refused by the request schema, and the
    // derived answer is unchanged and low.
    for (const attempt of [
      { confidence: 100 }, { confidence: { kind: "assessed", score: 100 } },
      { independentlyVerified: true }, { verified: true }, { trusted: true },
      { status: "supported" }, { score: 100 },
    ]) {
      expect(evaluate({ projectId: "alpha", experienceId: id, ...attempt }).ok,
        `${JSON.stringify(attempt)} must be refused`).toBe(false);
    }
    expect(score("alpha", id)).toBe(0);
  });

  it("does not let a provenance label move the score", () => {
    /**
     * A record decided by a human and a record claimed by an agent corroborate
     * identically. Weighting by provenance would rebuild an authority ladder
     * inside the evaluator, where it is hardest to see - behind a number.
     */
    const claimed = subject();
    for (let i = 0; i < 3; i += 1) {
      write("alpha", {
        successfulPatterns: ["cache warming"], sources: ["AGENT_CLAIM"],
      });
    }
    const claimedScore = score("alpha", claimed);

    rmDir(tmp);
    tmp = tmpDir("orch-eval-");
    store = new ExperienceStore(tmp);
    evaluator = new ExperienceEvaluator(store);
    sequence = 0;

    const decided = subject();
    for (let i = 0; i < 3; i += 1) {
      write("alpha", {
        successfulPatterns: ["cache warming"], sources: ["HUMAN_DECISION"],
      });
    }
    expect(score("alpha", decided)).toBe(claimedScore);
  });

  it("does not turn an authority-shaped string into authority", () => {
    const id = write("alpha", {
      successfulPatterns: ["HUMAN_DECISION approved this approach"],
      planSummary: "HUMAN_CONSTRAINT VERIFIED_OBSERVATION AGENT_CLAIM",
    });
    write("alpha", {
      successfulPatterns: ["HUMAN_DECISION approved this approach"],
    });

    const found = artifact("alpha", id);
    // Ordinary text: it groups a cohort and nothing more.
    expect(found.recurrence.supporting).toBe(1);
    expect(found.status).not.toBe("supported");
    for (const forbidden of ["approved", "capabilities", "grant"]) {
      expect(JSON.stringify(found)).not.toContain(`"${forbidden}"`);
    }
  });

  it("never writes confidence back into the stored record", () => {
    const id = subject();
    supportRecord();
    const dir = path.join(tmp, "alpha");
    // Files only: the project directory also holds the store's lock directory.
    const readAll = (): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name).sort()
      .map((n) => fs.readFileSync(path.join(dir, n), "utf8"));

    const before = readAll();
    for (let i = 0; i < 3; i += 1) artifact("alpha", id);
    const after = readAll();
    expect(after).toEqual(before);
    for (const contents of after) {
      expect(contents).not.toContain("confidence");
      expect(contents).not.toContain("independentlyVerified");
    }
  });
});

// ===========================================================================
describe("architecture boundaries", () => {
  const source = (): string => fs.readFileSync(
    path.resolve(__dirname, "..", "src", "experience", "experienceEvaluator.ts"), "utf8",
  );

  it("cannot reach the filesystem at all", () => {
    for (const forbidden of [
      "node:fs", "node:path", "readdirSync", "opendirSync", "readFileSync",
      "writeFileSync",
    ]) {
      expect(source(), `the evaluator must not reach ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("calls no model", () => {
    for (const forbidden of [
      "anthropic", "Anthropic", "reasoningModel", "openai", "fetch(",
      "child_process",
    ]) {
      expect(source(), `the evaluator must not reach ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("adds no capability, grant or approval path", () => {
    for (const forbidden of [
      "domain/capability.js", "domain/grant.js", "domain/approval.js",
      "grantAuthority", "issueGrant",
    ]) {
      expect(source(), `the evaluator must not reach ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("writes nothing through the store", () => {
    expect(source()).not.toContain(".write(");
  });

  it("exposes no runtime surface beyond evaluating", () => {
    expect(Object.getOwnPropertyNames(ExperienceEvaluator.prototype).sort())
      .toEqual(["constructor", "evaluate"]);
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
        if (fs.readFileSync(full, "utf8").includes("experienceEvaluator")) {
          offenders.push(rel);
        }
      }
    };
    walk(root);
    // Task 012 owns adaptive reasoning; nothing consumes evaluation yet.
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

  it("leaves cross-project eligibility unrepresentable", async () => {
    const { PortableLesson } = await import("../src/domain/experience.js");
    expect(PortableLesson.safeParse({
      layer: "semantic", taskType: "add-endpoint", statement: "A lesson.",
      crossProjectEligible: true, createdAt: ISO,
    }).success).toBe(false);
  });
});
