import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import {
  CONTEXT_LIMITS, fieldLimitFor, isCritical, ContextProvenance,
} from "../src/domain/reasoningContext.js";
import { assembleContext, type ContextInput } from "../src/reasoning/context.js";
import {
  taskDescription, repositoryObservations, humanConstraints,
} from "../src/reasoning/contextSources.js";
import {
  buildUserPrompt, renderContext, TRANSPORT_LIMIT_CHARS,
} from "../src/reasoning/prompt.js";
import { FakeReasoningModel, validProposalJson } from "./fakeReasoningModel.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * TASK 007 CORRECTION - WHERE THE CONTEXT BUDGET ACTUALLY LIVES.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS EXIST FOR
 * ---------------------------------------------------------------------------
 * `contextSources.taskDescription` used to trim the request to fit before the
 * assembler ever saw it. The assembler then reported a complete, successful
 * assembly - of a request it had only been shown part of. Nothing anywhere said
 * so. That is precisely the "critical context is never silently discarded" rule
 * being broken by the component that was supposed to enforce it.
 *
 * A second, quieter version of the same fault lived in the prompt renderer,
 * which `.slice()`d the fenced body and could therefore cut a human constraint
 * the assembler had deliberately preserved.
 *
 * These tests pin down that the ASSEMBLER is the one semantic authority, that
 * the transport limit is a separate and explicitly fail-closed concern, and
 * that neither can shorten anything ever again.
 */

let tmp: string;
let repo: string;
let store: ProjectStore;
let dbPath: string;
const openSavers: unknown[] = [];

function ctx(provenance: ContextProvenance, key: string, text: string): ContextInput {
  return { provenance, key, text };
}

beforeEach(() => {
  tmp = tmpDir("orch-bounds-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  store = new ProjectStore(path.join(tmp, "projects"));
  dbPath = path.join(tmp, "checkpoints.sqlite");
});

afterEach(() => {
  for (const saver of openSavers.splice(0)) closeCheckpointer(saver);
  rmDir(tmp);
});

// ===========================================================================
describe("the task description bound is enforced by the assembler", () => {
  it("accepts a task description exactly at the permitted limit", () => {
    const exact = "t".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength);
    const result = assembleContext(taskDescription(exact));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const task = result.context.records.find((r) => r.provenance === "TASK_DESCRIPTION")!;
      // Present IN FULL - not shortened, not ellipsised.
      expect(task.text).toHaveLength(CONTEXT_LIMITS.maxTaskDescriptionLength);
      expect(task.text).toBe(exact);
    }
  });

  it("FAILS CLOSED one character over the limit", () => {
    const over = "t".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength + 1);
    const result = assembleContext(taskDescription(over));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("task_description_invalid");
      expect(result.failure.provenance).toBe("TASK_DESCRIPTION");
    }
  });

  it("does not echo the oversized task text into the failure", () => {
    const secretish = `SUPER-DISTINCTIVE-MARKER-${"t".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength)}`;
    const result = assembleContext(taskDescription(secretish));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialised = JSON.stringify(result.failure);
      expect(serialised).not.toContain("SUPER-DISTINCTIVE-MARKER");
      // The category and the bound are named; the content is not.
      expect(serialised).toContain("TASK_DESCRIPTION");
    }
  });

  it("has NO upstream helper that trims the task before the assembler", () => {
    // The source is the assertion: a slice or a trim reintroduced here would
    // make every bound below unenforceable and this test would catch it.
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "reasoning", "contextSources.ts"), "utf8",
    );
    // TEXT truncation specifically. The one remaining `.slice` in that file
    // caps how many historical runs are SELECTED, which is a relevance
    // decision made where the timestamps are - it shortens no record.
    expect(source).not.toContain("[truncated]");
    expect(source).not.toContain("function bounded");
    expect(source).not.toContain("slice(0, CONTEXT_LIMITS.maxTextLength");
    expect(source).not.toContain("slice(0, CONTEXT_LIMITS.maxTaskDescriptionLength");

    // And the mapper really does pass the request through untouched.
    const long = "x".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength + 500);
    expect(taskDescription(long)[0]!.text).toHaveLength(long.length);
  });

  it("keeps the two field bounds explicit and distinct", () => {
    expect(fieldLimitFor("TASK_DESCRIPTION")).toBe(CONTEXT_LIMITS.maxTaskDescriptionLength);
    expect(fieldLimitFor("REPOSITORY_OBSERVATION")).toBe(CONTEXT_LIMITS.maxTextLength);
    // The task bound must actually be reachable - it was not, before this fix:
    // the record schema capped text at the smaller limit, so the declared
    // 4,000-character task bound did not exist.
    expect(CONTEXT_LIMITS.maxTaskDescriptionLength)
      .toBeGreaterThan(CONTEXT_LIMITS.maxTextLength);
    const atTaskLimit = "t".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength);
    expect(assembleContext(taskDescription(atTaskLimit)).ok).toBe(true);
    // The same length under a non-task provenance is over ITS bound.
    expect(assembleContext([ctx("REPOSITORY_OBSERVATION", "o", atTaskLimit)]).ok).toBe(false);
  });
});

// ===========================================================================
describe("task overflow does not reach the model or the workflow", () => {
  async function runWithRequest(request: string) {
    store.createProject({
      id: "proj", name: "Proj", workingDir: repo,
      repoRoot: null, repo: null, checks: [], contextFiles: [], constraints: [],
    });
    const saver = createCheckpointer(dbPath);
    openSavers.push(saver);
    const model = new FakeReasoningModel({ kind: "raw", text: validProposalJson() });
    const runner = new WorkflowRunner(
      new ProjectStore(path.join(tmp, "projects")), saver, { reasoningModel: model },
    );
    return { model, started: await runner.start("proj", request) };
  }

  it("makes no model call, grants nothing, and stops at the human gate", async () => {
    const { model, started } = await runWithRequest(
      "o".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength + 1),
    );

    expect(model.prompts).toHaveLength(0);
    expect(started.run.status).toBe("awaiting_approval");
    expect(started.pendingApproval?.kind).toBe("plan");
    // The property that matters: the plan authorises NOTHING, so approving it
    // could mint no write authority. The placeholder keeps the conservative
    // HIGH label it has carried since Task 006, which is not a scope.
    expect(started.pendingApproval!.proposedPlan!.allowedScope).toEqual([]);
    expect(store.listGrants("proj")).toHaveLength(0);
    expect(store.getImplementation("proj", started.run.id)).toBeNull();
  });

  it("tells the human why, without quoting the oversized request", async () => {
    const marker = `DISTINCTIVE-${"z".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength)}`;
    const { started } = await runWithRequest(marker);
    const shown = JSON.stringify(started.pendingApproval);

    expect(shown).toContain("task_description_invalid");
    expect(shown).not.toContain("DISTINCTIVE-");
  });

  it("still plans normally for a request just inside the limit", async () => {
    const { model, started } = await runWithRequest(
      "o".repeat(CONTEXT_LIMITS.maxTaskDescriptionLength),
    );
    expect(model.prompts).toHaveLength(1);
    expect(started.pendingApproval!.proposedPlan!.allowedScope).toEqual(["src/greet.ts"]);
  });
});

// ===========================================================================
describe("the transport limit is a separate, fail-closed concern", () => {
  it("is above the semantic budget, so it does not bind in normal operation", () => {
    expect(TRANSPORT_LIMIT_CHARS).toBeGreaterThan(CONTEXT_LIMITS.maxTotalChars);
  });

  it("renders an in-budget context completely, with nothing cut", () => {
    const records = Array.from({ length: 40 }, (_, i) =>
      ctx("REPOSITORY_OBSERVATION", `o.${String(i).padStart(3, "0")}`,
        `observation ${i} ${"detail ".repeat(20)}`),
    );
    const result = assembleContext([
      ctx("HUMAN_CONSTRAINT", "c.0", "Do not modify authentication behavior."),
      ...records,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const built = buildUserPrompt({ assembled: result.context });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Every kept record is present in full.
    for (const record of result.context.records) {
      expect(built.text).toContain(record.text);
    }
    expect(built.text).toContain("Do not modify authentication behavior.");
  });

  it("FAILS rather than slicing when the rendered prompt is too large", () => {
    // Constructed directly, bypassing the assembler, to reach the transport
    // limit - which the semantic budget would otherwise prevent.
    const huge = {
      records: Array.from({ length: 60 }, (_, i) => ({
        provenance: "REPOSITORY_OBSERVATION" as const,
        key: `o.${String(i).padStart(3, "0")}`,
        text: "y".repeat(1_500),
        at: null,
      })),
      truncated: false,
      warnings: [],
      totalChars: 90_000,
      assembledAt: new Date().toISOString(),
    };
    const built = buildUserPrompt({ assembled: huge });

    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.limit).toBe(TRANSPORT_LIMIT_CHARS);
      expect(built.renderedChars).toBeGreaterThan(TRANSPORT_LIMIT_CHARS);
    }
  });

  it("has no silent slice left in the renderer", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "reasoning", "prompt.ts"), "utf8",
    );
    // The fence escaper must not shorten; only the explicit limit check may
    // reject, and it rejects rather than trimming.
    expect(source).not.toContain(".slice(0, MAX_SECTION_CHARS)");
    expect(source).not.toContain("MAX_SECTION_CHARS");
  });

  it("keeps critical records intact right through rendering", () => {
    const result = assembleContext([
      ctx("HUMAN_DECISION", "d.1", "Use PostgreSQL and nothing else."),
      ctx("HUMAN_CONSTRAINT", "c.1", "Never touch the authentication module."),
      ctx("TASK_DESCRIPTION", "t.1", "Add a health endpoint."),
      ...Array.from({ length: 60 }, (_, i) =>
        ctx("REPOSITORY_OBSERVATION", `o.${String(i).padStart(3, "0")}`,
          `noise ${i} ${"pad ".repeat(60)}`)),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = renderContext(result.context);
    // Whatever was dropped, it was not one of these.
    expect(rendered).toContain("Use PostgreSQL and nothing else.");
    expect(rendered).toContain("Never touch the authentication module.");
    expect(rendered).toContain("Add a health endpoint.");
  });
});

// ===========================================================================
describe("critical overflow of every critical category", () => {
  const cases = [
    ["HUMAN_DECISION", "decision"],
    ["HUMAN_CONSTRAINT", "constraint"],
  ] as const;

  for (const [provenance, label] of cases) {
    it(`fails closed when ${label} context cannot fit the total budget`, () => {
      const big = "q".repeat(CONTEXT_LIMITS.maxTextLength - 10);
      const records = Array.from({ length: 30 }, (_, i) =>
        ctx(provenance, `${label}.${String(i).padStart(4, "0")}`, `${big}-${i}`),
      );
      const result = assembleContext(records);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("critical_context_too_large");
        expect(result.failure.provenance).toBe(provenance);
      }
    });

    it(`fails closed when a single ${label} field is over its bound`, () => {
      const result = assembleContext([
        ctx(provenance, `${label}.0`, "w".repeat(CONTEXT_LIMITS.maxTextLength + 1)),
      ]);
      expect(result.ok).toBe(false);
    });
  }

  it("confirms every critical category is actually marked critical", () => {
    for (const provenance of ["HUMAN_DECISION", "HUMAN_CONSTRAINT", "TASK_DESCRIPTION"] as const) {
      expect(isCritical(provenance)).toBe(true);
    }
    expect(isCritical("REPOSITORY_OBSERVATION")).toBe(false);
    expect(isCritical("HISTORICAL_AGENT_CLAIM")).toBe(false);
  });

  it("drops NON-critical overflow with an explicit warning instead", () => {
    const result = assembleContext([
      ctx("TASK_DESCRIPTION", "t", "do the thing"),
      ...Array.from({ length: CONTEXT_LIMITS.maxRepositoryObservations + 20 }, (_, i) =>
        ctx("REPOSITORY_OBSERVATION", `o.${String(i).padStart(4, "0")}`, `obs ${i}`)),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.truncated).toBe(true);
    expect(result.context.warnings.join(" ")).toContain("REPOSITORY_OBSERVATION");
    expect(renderContext(result.context)).toContain("[CONTEXT INCOMPLETE]");
  });
});

// ===========================================================================
describe("observation identity is derived from content, not position", () => {
  it("gives the same observation the same key wherever it appears", () => {
    const a = repositoryObservations(["branch: main", "head: abc123", "tree: clean"]);
    const b = repositoryObservations(["tree: clean", "branch: main", "head: abc123"]);

    const keyOf = (list: ContextInput[], text: string) =>
      list.find((r) => r.text === text)!.key;

    for (const text of ["branch: main", "head: abc123", "tree: clean"]) {
      expect(keyOf(b, text), `${text} must keep its identity`).toBe(keyOf(a, text));
    }
  });

  it("produces an identical assembled context from reordered observations", () => {
    const observations = [
      "branch: main", "head: abc123", "working tree: clean",
      "tracked files: 42", "note: repository extends above the boundary",
    ];
    const forward = assembleContext(repositoryObservations(observations));
    const reversed = assembleContext(repositoryObservations([...observations].reverse()));
    const shuffled = assembleContext(repositoryObservations(
      [observations[2]!, observations[0]!, observations[4]!, observations[1]!, observations[3]!],
    ));

    expect(forward.ok && reversed.ok && shuffled.ok).toBe(true);
    if (!forward.ok || !reversed.ok || !shuffled.ok) return;

    expect(renderContext(reversed.context)).toBe(renderContext(forward.context));
    expect(renderContext(shuffled.context)).toBe(renderContext(forward.context));
  });

  it("does not use array position in an observation key", () => {
    const [first] = repositoryObservations(["only one"]);
    // A position-derived key would be observation.000 here.
    expect(first!.key).not.toBe("observation.000");
    expect(first!.key).toMatch(/^observation\.[0-9a-f]{16}$/);
  });

  it("keeps index keys for constraints, where the ORDER is the human's intent", () => {
    /**
     * Deliberately different from observations. `project.constraints` is a
     * human-authored array in project.json: its order is part of the stored
     * configuration rather than incidental enumeration, so the position IS the
     * stable identity - and reordering it is a human editing their own file.
     */
    const constraints = humanConstraints(["first", "second"]);
    expect(constraints.map((c) => c.key)).toEqual(["constraint.000", "constraint.001"]);
    // Same input, same keys, every time.
    expect(humanConstraints(["first", "second"]).map((c) => c.key))
      .toEqual(constraints.map((c) => c.key));
  });
});
