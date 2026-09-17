import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProjectStore } from "../src/projects/projectStore.js";
import { WorkflowRunner } from "../src/graph/runner.js";
import { buildWorkflow, WORKFLOW_EDGES } from "../src/graph/workflow.js";
import { implement } from "../src/graph/nodes/index.js";
import type { NodeContext } from "../src/graph/context.js";
import type { OrchestratorStateType } from "../src/graph/state.js";
import { createCheckpointer, closeCheckpointer } from "../src/persistence/checkpointer.js";
import { ExperienceStore } from "../src/experience/experienceStore.js";
import { HumanDecision, approvalIdFor, type Plan } from "../src/domain/approval.js";
import { issueGrant, grantIdFor } from "../src/domain/grant.js";
import { WorkflowPhase, WORKFLOW_PHASES, RunStatus } from "../src/domain/workflow.js";
import { machineTransition, InvariantViolation, type Task } from "../src/domain/task.js";
import {
  ITERATION_LIMITS, IterationLimit, resolveIterationLimit, iterationIdFor,
  decideNextIteration, assessCompletion, detectSafetyConditions, planDigest, reviewDigest,
  IterationRecord, FORBIDDEN_ITERATION_KEYS, mergeIterationRecords,
} from "../src/domain/iteration.js";
import { VerificationOutcome } from "../src/domain/verification.js";
import { ReviewReport } from "../src/domain/reports.js";
import { experienceFromIteration } from "../src/experience/outcomeRecorder.js";
import { orchestratorRoot, selfBoundaryVerdict, SelfModificationRefused } from "../src/security/selfBoundary.js";
import { DisabledCheckRunner } from "../src/verification/checks.js";
import { VerificationCheckPhase } from "../src/verification/checkPhase.js";
import { FakeImplementationAgent } from "./fakeAgent.js";
import { FakeReasoningModel, validProposalJson } from "./fakeReasoningModel.js";
import type { ReasoningModel } from "../src/models/reasoningModel.js";
import { tmpDir, rmDir, git, initRepo } from "./helpers.js";

/**
 * TASK 014 - BOUNDED AUTONOMOUS WORKFLOW ITERATION UNDER MANDATORY HUMAN
 * AUTHORIZATION.
 *
 * The graph may now go round: implement, verify, review, and - when a human
 * asks for changes - plan again. Everything below is about the difference
 * between the two words in that sentence:
 *
 *     the ORCHESTRATOR may repeat the PROCESS
 *     it may not repeat the HUMAN
 *
 * Each scenario drives the real graph through the real runner with a real
 * repository, a deterministic fake agent and - where a model is needed - a
 * fake model whose output goes through the same extraction and strict schema
 * a real provider's would. A NEW runner and a NEW checkpointer connection are
 * opened for every step, so every step is also a restart.
 */

let tmp: string;
let repo: string;
let store: ProjectStore;
let experience: ExperienceStore;
let dbPath: string;
const openSavers: unknown[] = [];
const iso = () => new Date().toISOString();

interface RunnerOptions {
  agent?: FakeImplementationAgent;
  model?: ReasoningModel;
  maxIterations?: number;
  experience?: ExperienceStore | null;
}

/** A fresh runner on a fresh checkpointer connection: every call is a restart. */
function newRunner(options: RunnerOptions = {}): WorkflowRunner {
  const saver = createCheckpointer(dbPath);
  openSavers.push(saver);
  return new WorkflowRunner(new ProjectStore(path.join(tmp, "projects")), saver, {
    agent: options.agent ?? null,
    reasoningModel: options.model ?? null,
    experienceStore: options.experience === undefined ? experience : options.experience,
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
  });
}

/** An agent that writes one in-scope file, honestly. */
function honestAgent(contents = "export const a = 2;\n"): FakeImplementationAgent {
  return new FakeImplementationAgent({
    steps: [{ kind: "write", path: "src/a.ts", contents }],
    repoRoot: repo,
  });
}

const decide = (approvalId: string, kind: "approve" | "reject" | "feedback", extra: Record<string, unknown> = {}) =>
  HumanDecision.parse({
    approvalId, kind, decidedBy: "the-owner", decidedAt: iso(),
    ...(kind === "approve" ? {} : { comment: `${kind} by the owner` }),
    ...extra,
  });

/** Approve a plan gate, NARROWED to `scope` by edit - the human's authority. */
const approvePlanWithScope = (pending: { approvalId: string; proposedPlan?: Plan | null }, scope: string[]) =>
  HumanDecision.parse({
    approvalId: pending.approvalId, kind: "edit", decidedBy: "the-owner", decidedAt: iso(),
    editedPlan: { ...pending.proposedPlan!, allowedScope: scope },
  });

function history(runId: string): Record<string, unknown>[] {
  return fs.readFileSync(store.historyFile("proj", runId), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function createProject(id = "proj", workingDir = repo): void {
  store.createProject({
    id, name: id, workingDir, repoRoot: null, repo: null,
    checks: [], constraints: [], contextFiles: [],
  });
}

/**
 * Run one full iteration: plan gate (edit to scope) -> implement -> verify ->
 * review, returning the run suspended at the review gate.
 */
async function iterateToReviewGate(
  runId: string, pendingPlan: { approvalId: string; proposedPlan?: Plan | null },
  options: RunnerOptions,
) {
  const atReview = await newRunner(options).resume(runId, approvePlanWithScope(pendingPlan, ["src"]));
  expect(atReview.run.status).toBe("awaiting_approval");
  expect(atReview.pendingApproval?.kind).toBe("review");
  return atReview;
}

beforeEach(() => {
  tmp = tmpDir("orch-loop-");
  repo = path.join(tmp, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  store = new ProjectStore(path.join(tmp, "projects"));
  experience = new ExperienceStore(path.join(tmp, "experience"));
  dbPath = path.join(tmp, "checkpoints.sqlite");
  createProject();
});

afterEach(() => {
  for (const saver of openSavers.splice(0)) closeCheckpointer(saver);
  rmDir(tmp);
}, 120_000);

// ===========================================================================
describe("the topology is explicit: the loop is an edge, not a while", () => {
  it("compiles to exactly the documented nodes and edges, with ONE edge back into the graph", async () => {
    const saver = createCheckpointer(dbPath);
    openSavers.push(saver);
    const ctx = {
      store, inspector: null, checkRunner: new DisabledCheckRunner(),
      checkPhase: new VerificationCheckPhase(), reasoningModel: null, evidenceService: null,
      experienceStore: null, agent: null,
      emit: () => {}, onApprovalRequested: () => {}, onApprovalReceived: () => {}, onFinalise: () => {},
    } as unknown as NodeContext;
    const graph = await buildWorkflow(ctx, saver).getGraphAsync({});
    const edges = graph.edges
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(edges).toEqual(WORKFLOW_EDGES.map(([s, t]) => `${s}->${t}`).sort());

    // Every node is a declared phase; the loop target is inspect and only inspect.
    const nodeIds = Object.keys(graph.nodes).filter((n) => !n.startsWith("__"));
    expect(nodeIds.sort()).toEqual([...WORKFLOW_PHASES].sort());
    const back = WORKFLOW_EDGES.filter(([s]) => s === "next_iteration").map(([, t]) => t).sort();
    expect(back).toEqual(["inspect", "update_state"]);
    // No edge from the loop node, or from anywhere after the plan gate, into implement.
    const intoImplement = WORKFLOW_EDGES.filter(([, t]) => t === "implement").map(([s]) => s);
    expect(intoImplement).toEqual(["approve_plan"]);
    // plan -> approve_plan is the only edge out of plan.
    expect(WORKFLOW_EDGES.filter(([s]) => s === "plan").map(([, t]) => t)).toEqual(["approve_plan"]);
  });

  it("declares learn and next_iteration as phases, in order, and an incomplete run status", () => {
    expect(WorkflowPhase.options).toEqual(WORKFLOW_PHASES);
    expect(WORKFLOW_PHASES.indexOf("approve_review")).toBeLessThan(WORKFLOW_PHASES.indexOf("learn"));
    expect(WORKFLOW_PHASES.indexOf("learn")).toBeLessThan(WORKFLOW_PHASES.indexOf("next_iteration"));
    expect(WORKFLOW_PHASES.indexOf("next_iteration")).toBeLessThan(WORKFLOW_PHASES.indexOf("update_state"));
    expect(RunStatus.options).toContain("incomplete");
  });
});

// ===========================================================================
describe("Scenario A - one successful iteration", () => {
  it("plan -> human -> implement -> verify -> review -> human -> APPROVED", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    expect(started.run.iteration).toBe(1);
    expect(started.run.iterationLimit).toBe(ITERATION_LIMITS.defaultMaxIterations);
    expect(started.pendingApproval?.kind).toBe("plan");
    expect(started.pendingApproval?.iteration).toBe(1);
    expect(started.pendingApproval?.subjectDigest).toBe(planDigest(started.pendingApproval!.proposedPlan!));

    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    const review = atReview.pendingApproval!;
    expect(review.iteration).toBe(1);
    expect(review.subjectDigest).toMatch(/^[0-9a-f]{64}$/);
    const it = review.payload["iteration"] as Record<string, unknown>;
    expect(it["iteration"]).toBe(1);
    expect(it["anotherIterationPossible"]).toBe(true);
    expect((it["completion"] as { blockers: string[] }).blockers).toEqual([]);

    const done = await newRunner({ agent }).resume(atReview.run.id, decide(review.approvalId, "approve"));
    expect(done.run.status).toBe("completed");
    expect(done.run.outcome).toBe("approved");
    expect(done.run.stopReason).toBe("human_approved");
    expect(done.run.iteration).toBe(1);

    const records = done.state.iterations!;
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.iterationId).toBe(iterationIdFor(done.run.id, 1));
    expect(r.planApprovalId).toBe(started.pendingApproval!.approvalId);
    expect(r.grantId).toBe(grantIdFor(done.run.id, 0, 1));
    expect(r.verificationVerdict).toBe("verified");
    expect(r.independentlyVerified).toBe(true);
    expect(r.reviewVerdict).toBe("pass");
    expect(r.reviewApprovalId).toBe(review.approvalId);
    expect(r.reviewDecision).toBe("approve");
    expect(r.loop).toEqual({
      kind: "stop", reason: "human_approved", decidedBy: "the-owner",
      detail: expect.stringContaining("approved by a human"),
    });
    expect(r.experience?.recorded).toBe(true);

    const types = history(done.run.id).map((e) => e["type"]);
    expect(types.filter((t) => t === "iteration_started")).toHaveLength(1);
    expect(types).toContain("experience_recorded");
    expect(types[types.indexOf("iteration_ended") - 0]).toBe("iteration_ended");
    expect(history(done.run.id).find((e) => e["type"] === "iteration_ended")!["decision"]).toBe("human_approved");
  });

  it("the learn step wrote one record built from trusted evidence, with the human decision as a source", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    await newRunner({ agent }).resume(atReview.run.id, decide(atReview.pendingApproval!.approvalId, "approve"));

    const listed = experience.list("proj");
    expect(listed.records).toHaveLength(1);
    const rec = listed.records[0]!.record;
    expect(rec.runId).toBe(iterationIdFor(started.run.id, 1));
    expect(rec.sources).toContain("HUMAN_DECISION");
    expect(rec.sources).toContain("REPOSITORY_OBSERVATION");
    expect(rec.sources).toContain("REVIEW_FINDING");
    expect(rec.sources).not.toContain("AGENT_CLAIM");
    expect(rec.successfulPatterns.length).toBeGreaterThan(0);
    expect(rec.failedPatterns).toEqual([]);
    // Not a word of the agent's account.
    expect(JSON.stringify(rec)).not.toContain("wrote 1 file");
  });
});

// ===========================================================================
describe("Scenario B - review requests changes: a second bounded iteration", () => {
  it("feedback at the review gate opens iteration 2 at the PLAN gate, with its own approval and grant", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    const planA = started.pendingApproval!;
    const atReview1 = await iterateToReviewGate(started.run.id, planA, { agent });

    // The human asks for changes.
    const atPlan2 = await newRunner({ agent }).resume(
      atReview1.run.id, decide(atReview1.pendingApproval!.approvalId, "feedback"),
    );
    // Not implemented again. Not approved. Suspended at the PLAN gate of iteration 2.
    expect(atPlan2.run.status).toBe("awaiting_approval");
    expect(atPlan2.run.phase).toBe("approve_plan");
    expect(atPlan2.pendingApproval?.kind).toBe("plan");
    expect(atPlan2.pendingApproval?.iteration).toBe(2);
    expect(atPlan2.run.iteration).toBe(2);
    expect(atPlan2.run.iterationLimit).toBe(ITERATION_LIMITS.defaultMaxIterations);
    const planB = atPlan2.pendingApproval!;
    expect(planB.approvalId).not.toBe(planA.approvalId);
    expect(planB.approvalId).toBe(approvalIdFor(started.run.id, "plan", 0, 2));
    // Iteration 1's grant is consumed; iteration 2 has none yet.
    expect(atPlan2.state.grant).toBeNull();
    expect(store.listGrants("proj")).toHaveLength(1);
    expect(store.listGrants("proj")[0]!.status).toBe("consumed");
    // The loop is in the history, as nodes and as an explicit decision.
    const types = history(started.run.id).map((e) => e["type"]);
    expect(types.filter((t) => t === "iteration_started")).toHaveLength(2);
    const ended = history(started.run.id).filter((e) => e["type"] === "iteration_ended");
    expect(ended[0]!["decision"]).toBe("continue");
    const nodesAfterLoop = history(started.run.id)
      .slice(history(started.run.id).findIndex((e) => e["type"] === "iteration_started" && e["iteration"] === 2))
      .filter((e) => e["type"] === "node_started").map((e) => e["node"]);
    expect(nodesAfterLoop).toEqual(["inspect", "plan", "approve_plan"]);

    // Iteration 2, all the way.
    const agent2 = honestAgent("export const a = 3;\n");
    const atReview2 = await iterateToReviewGate(started.run.id, planB, { agent: agent2 });
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
    expect(atReview2.pendingApproval?.iteration).toBe(2);
    expect(atReview2.pendingApproval?.approvalId).toBe(approvalIdFor(started.run.id, "review", 0, 2));
    expect(atReview2.pendingApproval?.approvalId).not.toBe(atReview1.pendingApproval?.approvalId);
    // Different reviewed state, different digest.
    expect(atReview2.pendingApproval?.subjectDigest).not.toBe(atReview1.pendingApproval?.subjectDigest);

    const grants = store.listGrants("proj").sort((a, b) => (a.grantId < b.grantId ? -1 : 1));
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.grantId).sort()).toEqual(
      [grantIdFor(started.run.id, 0, 1), grantIdFor(started.run.id, 0, 2)].sort(),
    );
    expect(grants.find((g) => g.grantId === grantIdFor(started.run.id, 0, 2))!.approvalId).toBe(planB.approvalId);

    const done = await newRunner({ agent: agent2 }).resume(
      atReview2.run.id, decide(atReview2.pendingApproval!.approvalId, "approve"),
    );
    expect(done.run.status).toBe("completed");
    expect(done.run.outcome).toBe("approved");
    expect(done.run.iteration).toBe(2);
    expect(done.state.iterations).toHaveLength(2);
    expect(done.state.iterations![0]!.loop?.kind).toBe("continue");
    expect(done.state.iterations![1]!.loop).toMatchObject({ kind: "stop", reason: "human_approved" });
    expect(done.state.iterations![1]!.planApprovalId).toBe(planB.approvalId);
    expect(done.state.iterations![1]!.grantId).toBe(grantIdFor(started.run.id, 0, 2));
    // One experience record per iteration.
    expect(experience.list("proj").records).toHaveLength(2);
  });
});

// ===========================================================================
describe("Scenario C - a changed plan cannot reuse the old approval", () => {
  it("the runner refuses iteration 1's plan decision at iteration 2's plan gate", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    const planA = started.pendingApproval!;
    const atReview1 = await iterateToReviewGate(started.run.id, planA, { agent });
    const atPlan2 = await newRunner({ agent }).resume(
      atReview1.run.id, decide(atReview1.pendingApproval!.approvalId, "feedback"),
    );
    expect(atPlan2.pendingApproval?.iteration).toBe(2);

    // Replaying Plan A's approval - same id, same edited plan - against Plan B's gate.
    await expect(
      newRunner({ agent }).resume(started.run.id, approvePlanWithScope(planA, ["src"])),
    ).rejects.toThrow(/waiting on approval .*_i2_plan_0.*but the decision answers .*_i1_plan_0/);

    // Nothing moved: still at the plan gate of iteration 2, no second grant, file untouched.
    const run = store.findRun(started.run.id)!;
    expect(run.status).toBe("awaiting_approval");
    expect(run.pendingApprovalId).toBe(atPlan2.pendingApproval!.approvalId);
    expect(store.listGrants("proj")).toHaveLength(1);
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("the implement node refuses a grant that does not descend from THIS iteration's plan approval", async () => {
    // A real grant, minted from iteration 1's approval, presented in iteration 2.
    const runId = "run_binding";
    const grant = store.saveGrant(issueGrant({
      grantId: grantIdFor(runId, 0, 1), projectId: "proj", runId,
      approvalId: approvalIdFor(runId, "plan", 0, 1), approvedBy: "owner",
      allowedScope: ["src"], capabilities: ["repo.read", "repo.file.write"],
    }));
    const agent = honestAgent();
    const ctx = {
      store, inspector: null, checkRunner: new DisabledCheckRunner(),
      checkPhase: new VerificationCheckPhase(), reasoningModel: null, evidenceService: null,
      experienceStore: null, agent,
      emit: () => {}, onApprovalRequested: () => {}, onApprovalReceived: () => {}, onFinalise: () => {},
    } as unknown as NodeContext;
    const state = {
      runId, projectId: "proj", request: "x", iteration: 2, revisions: 0,
      proposedPlan: { summary: "B", steps: [], allowedScope: ["src"], risks: [], highestRisk: "HIGH" },
      grant, decisions: [], iterations: [], observations: [],
    } as unknown as OrchestratorStateType;

    const update = await implement(ctx)(state);
    expect(update.implementation?.claimedSummary).toMatch(/does not authorise a new plan/);
    expect(update.grant).toBeNull();
    expect(update.phase).toBe("verify");
    expect(agent.results).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    // The grant was never even claimed.
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("active");
  });

  it("scope is NOT inherited: iteration 2's grant carries exactly what the human approved for plan B", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview1 = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    const atPlan2 = await newRunner({ agent }).resume(
      atReview1.run.id, decide(atReview1.pendingApproval!.approvalId, "feedback"),
    );
    // Plan B approved with a DIFFERENT, narrower scope.
    const agent2 = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: "src/a.ts", contents: "export const a = 9;\n" },   // plan A's scope
        { kind: "write", path: "docs/b.md", contents: "b\n" },                     // plan B's scope
      ],
      repoRoot: repo,
    });
    await newRunner({ agent: agent2 }).resume(
      started.run.id, approvePlanWithScope(atPlan2.pendingApproval!, ["docs"]),
    );
    const grant2 = store.getGrant("proj", grantIdFor(started.run.id, 0, 2))!;
    expect(grant2.allowedScope).toEqual(["docs"]);
    expect(agent2.results.map((r) => r.ok)).toEqual([false, true]);
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(fs.existsSync(path.join(repo, "docs", "b.md"))).toBe(true);
  });
});

// ===========================================================================
describe("Scenario D - the iteration limit", () => {
  it("stops INCOMPLETE when changes are requested after the last permitted iteration", async () => {
    const agent = honestAgent();
    const opts = { agent, maxIterations: 2 };
    const started = await newRunner(opts).start("proj", "bump a");
    expect(started.run.iterationLimit).toBe(2);

    const atReview1 = await iterateToReviewGate(started.run.id, started.pendingApproval!, opts);
    const atPlan2 = await newRunner(opts).resume(
      atReview1.run.id, decide(atReview1.pendingApproval!.approvalId, "feedback"),
    );
    expect(atPlan2.run.iteration).toBe(2);
    const review2 = (await iterateToReviewGate(started.run.id, atPlan2.pendingApproval!, opts)).pendingApproval!;
    expect((review2.payload["iteration"] as Record<string, unknown>)["anotherIterationPossible"]).toBe(false);

    const stopped = await newRunner(opts).resume(started.run.id, decide(review2.approvalId, "feedback"));
    expect(stopped.run.status).toBe("incomplete");
    expect(stopped.run.outcome).toBe("incomplete:iteration_limit_reached");
    expect(stopped.run.stopReason).toBe("iteration_limit_reached");
    expect(stopped.pendingApproval).toBeNull();
    expect(stopped.run.iteration).toBe(2);
    expect(store.listGrants("proj")).toHaveLength(2);
    expect(stopped.state.iterations).toHaveLength(2);
    expect(stopped.state.stop).toMatchObject({ kind: "stop", reason: "iteration_limit_reached" });
    const ended = history(started.run.id).filter((e) => e["type"] === "iteration_ended");
    expect(ended.map((e) => e["decision"])).toEqual(["continue", "iteration_limit_reached"]);
  });

  it("a limit of 1 permits exactly one implementation", async () => {
    const agent = honestAgent();
    const opts = { agent, maxIterations: 1 };
    const started = await newRunner(opts).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, opts);
    const stopped = await newRunner(opts).resume(
      started.run.id, decide(atReview.pendingApproval!.approvalId, "feedback"),
    );
    expect(stopped.run.status).toBe("incomplete");
    expect(stopped.run.outcome).toBe("incomplete:iteration_limit_reached");
    expect(store.listGrants("proj")).toHaveLength(1);
  });

  it("the runner refuses an invalid bound at construction", () => {
    for (const bad of [0, -1, ITERATION_LIMITS.ceiling + 1, 1_000_000, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => newRunner({ maxIterations: bad })).toThrow();
    }
    expect(resolveIterationLimit(undefined)).toBe(ITERATION_LIMITS.defaultMaxIterations);
    expect(resolveIterationLimit(ITERATION_LIMITS.ceiling)).toBe(ITERATION_LIMITS.ceiling);
    expect(IterationLimit.safeParse(ITERATION_LIMITS.ceiling + 1).success).toBe(false);
  });
});

// ===========================================================================
describe("Scenario E - verification failure never approves", () => {
  it("an out-of-scope side effect: review withholds pass, the human sees blockers, and a change request is a SAFETY STOP", async () => {
    const agent = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: "src/a.ts", contents: "export const a = 2;\n" },
        { kind: "sideEffect", path: "secret/outside.txt", contents: "written around the boundary\n" },
      ],
      repoRoot: repo,
    });
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    const review = atReview.pendingApproval!;
    const payload = review.payload["review"] as { verdict: string };
    expect(payload.verdict).toBe("changes_requested");
    const it = review.payload["iteration"] as Record<string, unknown>;
    expect(it["safetyConditions"]).toContain("scope_drift");
    expect(it["anotherIterationPossible"]).toBe(false);
    expect((it["completion"] as { blockers: string[] }).blockers.join("\n")).toMatch(/outside the approved scope/);
    // Not approved by anything.
    expect(atReview.run.status).toBe("awaiting_approval");
    expect(store.findRun(started.run.id)!.outcome ?? null).toBeNull();

    const stopped = await newRunner({ agent }).resume(started.run.id, decide(review.approvalId, "feedback"));
    expect(stopped.run.status).toBe("incomplete");
    expect(stopped.run.outcome).toBe("incomplete:safety_stop");
    expect(stopped.run.stopReason).toBe("safety_stop");
    expect(stopped.state.stop?.detail).toMatch(/scope_drift/);
    expect(store.listGrants("proj")).toHaveLength(1);
  });

  it("a false claim: review withholds pass, and a change request may open iteration 2 only through the plan gate", async () => {
    const agent = new FakeImplementationAgent({
      steps: [{ kind: "write", path: "src/a.ts", contents: "export const a = 2;\n" }],
      repoRoot: repo,
      claimFiles: ["src/a.ts", "src/ghost.ts"],
    });
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    expect((atReview.pendingApproval!.payload["review"] as { verdict: string }).verdict).toBe("changes_requested");
    const next = await newRunner({ agent }).resume(
      started.run.id, decide(atReview.pendingApproval!.approvalId, "feedback"),
    );
    expect(next.run.status).toBe("awaiting_approval");
    expect(next.pendingApproval?.kind).toBe("plan");
    expect(next.run.iteration).toBe(2);
    expect(next.run.outcome ?? null).toBeNull();
  });
});

// ===========================================================================
describe("Scenario F / G - human rejection", () => {
  it("F. rejecting the plan implements nothing and stops the run", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    const done = await newRunner({ agent }).resume(
      started.run.id, decide(started.pendingApproval!.approvalId, "reject"),
    );
    expect(done.run.status).toBe("rejected");
    expect(done.run.outcome).toBe("rejected_at_plan");
    expect(done.run.stopReason).toBe("human_rejected");
    expect(store.listGrants("proj")).toHaveLength(0);
    expect(agent.results).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(done.state.iterations![0]!.loop).toMatchObject({ kind: "stop", reason: "human_rejected" });
  });

  it("G. rejecting the review stops the run without approval and without another iteration", async () => {
    const agent = honestAgent();
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    const done = await newRunner({ agent }).resume(
      started.run.id, decide(atReview.pendingApproval!.approvalId, "reject"),
    );
    expect(done.run.status).toBe("rejected");
    expect(done.run.outcome).toBe("rejected_at_review");
    expect(done.run.stopReason).toBe("human_rejected");
    expect(done.run.iteration).toBe(1);
    expect(store.listGrants("proj")).toHaveLength(1);
    const listed = experience.list("proj");
    expect(listed.records).toHaveLength(1);
    expect(listed.records[0]!.record.failedPatterns.length).toBeGreaterThan(0);
    expect(listed.records[0]!.record.sources).toContain("HUMAN_DECISION");
  });
});

// ===========================================================================
describe("Scenario H - process restart between iterations", () => {
  it("iteration identity, limit, records and the pending approval survive a fresh runner on a fresh connection", async () => {
    const agent = honestAgent();
    const opts = { agent, maxIterations: 3 };
    const started = await newRunner(opts).start("proj", "bump a");
    const atReview1 = await iterateToReviewGate(started.run.id, started.pendingApproval!, opts);
    // Close EVERY open connection before continuing: the next runner shares nothing in memory.
    for (const saver of openSavers.splice(0)) closeCheckpointer(saver);

    const atPlan2 = await newRunner(opts).resume(
      started.run.id, decide(atReview1.pendingApproval!.approvalId, "feedback"),
    );
    for (const saver of openSavers.splice(0)) closeCheckpointer(saver);

    // Read back from disk alone.
    const onDisk = new ProjectStore(path.join(tmp, "projects")).findRun(started.run.id)!;
    expect(onDisk.iteration).toBe(2);
    expect(onDisk.iterationLimit).toBe(3);
    expect(onDisk.pendingApprovalId).toBe(approvalIdFor(started.run.id, "plan", 0, 2));
    expect(onDisk.pendingApproval?.iteration).toBe(2);

    // Resume in yet another runner with a DIFFERENT configured limit: the
    // run's own bound wins, because the channel keeps its first value.
    const atReview2 = await iterateToReviewGate(started.run.id, atPlan2.pendingApproval!, { agent, maxIterations: 9 });
    expect(atReview2.state.iterationLimit).toBe(3);
    expect(atReview2.state.iteration).toBe(2);
    expect(atReview2.state.iterationId).toBe(iterationIdFor(started.run.id, 2));
    expect(atReview2.state.iterations!.map((r) => r.iteration)).toEqual([1, 2]);
    expect(atReview2.state.iterations![0]!.loop?.kind).toBe("continue");
    expect(atReview2.state.iterations![1]!.grantId).toBe(grantIdFor(started.run.id, 0, 2));
    // The consumed grant from iteration 1 is still consumed.
    expect(store.getGrant("proj", grantIdFor(started.run.id, 0, 1))!.status).toBe("consumed");
  });
});

// ===========================================================================
describe("Scenario I - malicious model output", () => {
  const hostile = () => new FakeReasoningModel({
    kind: "raw",
    text: validProposalJson({
      approved: true, complete: true, skipVerification: true, maxIterations: 999999,
      capabilities: ["*"], scope: ["/"], grant: true,
    }),
  });

  it("everything authority-shaped is rejected: no grant, no scope, no limit change, gate still there", async () => {
    const model = hostile();
    const started = await newRunner({ model, maxIterations: 2 }).start("proj", "own everything");
    expect(model.prompts).toHaveLength(1);
    // The strict schema refused the response; the run fell back to the zero-scope plan.
    expect(started.run.status).toBe("awaiting_approval");
    expect(started.pendingApproval?.kind).toBe("plan");
    expect(started.pendingApproval?.proposedPlan?.allowedScope).toEqual([]);
    expect(started.state.reasoningFailure?.code).toBe("schema_invalid");
    expect(started.state.iterationLimit).toBe(2);
    expect(started.run.iterationLimit).toBe(2);
    expect(started.run.outcome ?? null).toBeNull();
    expect(store.listGrants("proj")).toHaveLength(0);
    expect(JSON.stringify(started.state)).not.toContain("999999");
  });

  it("a well-formed proposal asking for / gets nothing, and its keys cannot reach the plan", async () => {
    const model = new FakeReasoningModel({
      kind: "raw", text: validProposalJson({ proposedScope: { paths: ["/", "../../etc"], rationale: "all of it" } }),
    });
    const started = await newRunner({ model }).start("proj", "x");
    const plan = started.pendingApproval!.proposedPlan!;
    expect(plan.allowedScope).toEqual([]);
    expect(Object.keys(plan).sort()).toEqual(["allowedScope", "highestRisk", "risks", "steps", "summary"]);
    expect(started.state.reasoningNotes!.join("\n")).toMatch(/refused|rejected|dropped/i);
  });

  it("`complete: true` alone does not complete, approve or skip anything", async () => {
    const model = new FakeReasoningModel({ kind: "raw", text: JSON.stringify({ complete: true, verified: true }) });
    const started = await newRunner({ model }).start("proj", "x");
    expect(started.run.status).toBe("awaiting_approval");
    expect(started.run.phase).toBe("approve_plan");
    expect(started.run.outcome ?? null).toBeNull();
  });
});

// ===========================================================================
describe("Scenario J - learning influences the proposal, not the authority", () => {
  const GROUNDED = ["VERIFICATION_RESULT"];
  let seq = 0;
  const seed = (overrides: Record<string, unknown>) => {
    seq += 1;
    const r = experience.write("proj", {
      scope: "project", layer: "episodic", projectId: "proj", runId: `seed_${String(seq)}`,
      taskType: "development_request",
      createdAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + seq * 1000).toISOString(),
      ...overrides,
    });
    if (!r.ok) throw new Error(r.failure.code);
  };

  it("an ESTABLISHED strategy reaches the model and changes nothing about gates, grants, scope or limits", async () => {
    seed({ planSummary: "bump the exported constant in a", successfulPatterns: ["edit the constant"], sources: GROUNDED });
    for (let i = 0; i < 3; i += 1) seed({ successfulPatterns: ["edit the constant"], sources: GROUNDED });

    const model = new FakeReasoningModel({ kind: "raw", text: validProposalJson({ proposedScope: { paths: ["src"], rationale: "r" } }) });
    const agent = honestAgent();
    const started = await newRunner({ model, agent, maxIterations: 2 }).start("proj", "bump the exported constant in a");
    // Learning reached reasoning.
    expect(started.state.strategySummary?.kind).toBe("proposal");
    const records = model.prompts[0]!.context.assembled.records;
    expect(records.some((r) => r.provenance === "HISTORICAL_STRATEGY")).toBe(true);
    // ...and nothing else.
    expect(started.run.status).toBe("awaiting_approval");
    expect(started.pendingApproval?.kind).toBe("plan");
    expect(store.listGrants("proj")).toHaveLength(0);
    expect(started.state.iterationLimit).toBe(2);
    expect(started.state.decisions).toEqual([]);
    expect(started.pendingApproval?.proposedPlan?.allowedScope).toEqual(["src"]);
    expect(started.pendingApproval?.risk).toBe("HIGH");

    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { model, agent, maxIterations: 2 });
    const grant = store.listGrants("proj")[0]!;
    expect(grant.allowedScope).toEqual(["src"]);
    expect(grant.capabilities).not.toContain("git.mutate");
    expect(atReview.pendingApproval?.kind).toBe("review");
    expect(atReview.run.iterationLimit).toBe(2);
  });
});

// ===========================================================================
describe("Scenario K - a HIGH-risk action keeps its existing authorization", () => {
  it("git used by the agent is detected as UNAUTHORISED in every iteration, blocks the review, and stops the loop", async () => {
    const agent = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: "src/a.ts", contents: "export const a = 2;\n" },
        { kind: "gitCommand", args: ["add", "-A"] },
        { kind: "gitCommand", args: ["commit", "-q", "-m", "agent commit"] },
      ],
      repoRoot: repo,
    });
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    const grant = store.listGrants("proj")[0]!;
    expect(grant.capabilities).not.toContain("git.mutate");
    const verification = atReview.pendingApproval!.payload["verification"] as Record<string, unknown>;
    expect(verification["gitMutationDetected"]).toBe(true);
    expect(verification["gitMutationAuthorised"]).toBe(false);
    const findings = (atReview.pendingApproval!.payload["review"] as ReviewReport).findings;
    expect(findings.some((f) => f.severity === "blocker" && /no granted capability authorised it/.test(f.message))).toBe(true);
    const it = atReview.pendingApproval!.payload["iteration"] as Record<string, unknown>;
    expect(it["safetyConditions"]).toContain("unauthorised_git_mutation");

    const stopped = await newRunner({ agent }).resume(
      started.run.id, decide(atReview.pendingApproval!.approvalId, "feedback"),
    );
    expect(stopped.run.status).toBe("incomplete");
    expect(stopped.run.stopReason).toBe("safety_stop");
  });

  it("no iteration can mint git.mutate, process.execute or network.access", () => {
    for (const capability of ["git.mutate", "process.execute", "network.access"] as const) {
      expect(() => issueGrant({
        projectId: "proj", runId: "r", approvalId: approvalIdFor("r", "plan", 0, 2),
        approvedBy: "owner", allowedScope: ["src"], capabilities: [capability],
      })).toThrow();
    }
  });
});

// ===========================================================================
describe("Scenario L - the orchestrator does not develop itself", () => {
  const root = orchestratorRoot();

  it("refuses to START a run whose project is, is inside, or encloses the installation", async () => {
    createProject("self", root);
    createProject("inside", path.join(root, "src"));
    createProject("encloses", path.dirname(root));
    for (const id of ["self", "inside", "encloses"]) {
      await expect(newRunner().start(id, "rewrite the grant authority")).rejects.toThrow(SelfModificationRefused);
      expect(store.listRuns(id)).toHaveLength(0);
    }
    expect(selfBoundaryVerdict(root)).toMatchObject({ refused: true, relation: "is" });
    expect(selfBoundaryVerdict(path.join(root, "src", "domain"))).toMatchObject({ refused: true, relation: "inside" });
    expect(selfBoundaryVerdict(path.parse(root).root)).toMatchObject({ refused: true, relation: "encloses" });
    expect(selfBoundaryVerdict(repo)).toEqual({ refused: false });
  });

  it("refuses to IMPLEMENT if the project is re-pointed at the installation after the plan was approved", async () => {
    /**
     * THIS TEST AIMS A WRITE AT THE REAL INSTALLATION. With the boundary in
     * place the write never happens. With the boundary mutated away it does -
     * the first mutation run of this task left `src/a.ts` in the orchestrator's
     * own tree, which is exactly the hazard the boundary exists for, proven on
     * the real thing. So the agent writes a PROBE path that nothing else uses,
     * and the probe is removed in `finally`, so a disabled boundary can be
     * caught without leaving debris behind.
     */
    const probe = "src/__self_modification_probe__.ts";
    const probeOnDisk = path.join(root, probe);
    const agent = new FakeImplementationAgent({
      steps: [{ kind: "write", path: probe, contents: "// must never exist\n" }], repoRoot: repo,
    });
    try {
      const started = await newRunner({ agent }).start("proj", "bump a");
      const before = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "src", "domain", "task.ts"))).digest("hex");
      // Between the gate and the resume, the project record is re-pointed.
      const project = store.getProject("proj")!;
      store.createProject({ ...project, workingDir: root });

      const after = await newRunner({ agent }).resume(started.run.id, approvePlanWithScope(started.pendingApproval!, ["src"]));
      expect(after.state.implementation?.claimedSummary).toMatch(/does not develop itself/);
      expect(agent.results).toHaveLength(0);
      expect(fs.existsSync(probeOnDisk)).toBe(false);
      expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "src", "domain", "task.ts"))).digest("hex")).toBe(before);
    } finally {
      fs.rmSync(probeOnDisk, { force: true });
    }
  }, 120_000);

  it("an agent inside a legitimate project cannot reach the orchestrator's sources through the session", async () => {
    const target = path.join(root, "src", "domain", "task.ts");
    const before = fs.readFileSync(target, "utf8");
    const rel = path.relative(repo, target).split(path.sep).join("/");
    const agent = new FakeImplementationAgent({
      steps: [
        { kind: "write", path: rel, contents: "// owned\n" },
        { kind: "write", path: target, contents: "// owned\n" },
        { kind: "delete", path: rel },
      ],
      repoRoot: repo,
    });
    const started = await newRunner({ agent }).start("proj", "bump a");
    await newRunner({ agent }).resume(started.run.id, approvePlanWithScope(started.pendingApproval!, ["src"]));
    expect(agent.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });
});

// ===========================================================================
describe("idempotency - a replayed implement node cannot implement twice", () => {
  it("the second execution finds the grant consumed and touches nothing", async () => {
    const runId = "run_replay";
    const grant = store.saveGrant(issueGrant({
      grantId: grantIdFor(runId, 0, 1), projectId: "proj", runId,
      approvalId: approvalIdFor(runId, "plan", 0, 1), approvedBy: "owner",
      allowedScope: ["src"], capabilities: ["repo.read", "repo.file.write"],
    }));
    const agent = honestAgent();
    const ctx = {
      store, inspector: null, checkRunner: new DisabledCheckRunner(),
      checkPhase: new VerificationCheckPhase(), reasoningModel: null, evidenceService: null,
      experienceStore: null, agent,
      emit: () => {}, onApprovalRequested: () => {}, onApprovalReceived: () => {}, onFinalise: () => {},
    } as unknown as NodeContext;
    const state = {
      runId, projectId: "proj", request: "x", iteration: 1, revisions: 0,
      proposedPlan: { summary: "A", steps: [], allowedScope: ["src"], risks: [], highestRisk: "HIGH" },
      grant, decisions: [], iterations: [], observations: [],
    } as unknown as OrchestratorStateType;

    const first = await implement(ctx)(state);
    expect(first.implementationRun?.status).toBe("completed");
    expect(agent.results).toHaveLength(1);
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");

    const second = await implement(ctx)(state);
    expect(agent.results).toHaveLength(1);
    expect(second.implementation?.claimedSummary).toMatch(/GrantDenied/);
    expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });
});

// ===========================================================================
describe("failure never becomes success", () => {
  it("the task-status table still has no machine path to APPROVED", () => {
    const task = { id: "t", projectId: "proj", title: "t", brief: "", status: "IN_PROGRESS",
      milestoneId: null, runIds: [], createdAt: iso(), updatedAt: iso() } as Task;
    expect(() => machineTransition(task, "APPROVED")).toThrow(InvariantViolation);
    expect(() => machineTransition({ ...task, status: "IMPLEMENTED" }, "APPROVED")).toThrow(InvariantViolation);
    expect(() => machineTransition({ ...task, status: "REVIEW" }, "APPROVED")).toThrow(InvariantViolation);
  });

  it("an agent that throws yields evidence inconsistent with completion, and no approval", async () => {
    const agent = new FakeImplementationAgent({ steps: [{ kind: "throw" }], repoRoot: repo });
    const started = await newRunner({ agent }).start("proj", "bump a");
    const atReview = await iterateToReviewGate(started.run.id, started.pendingApproval!, { agent });
    expect(atReview.state.implementationRun?.status).toBe("failed");
    expect(atReview.run.outcome ?? null).toBeNull();
    // The record is completed when the gate is answered; at the gate the
    // human sees the same assessment in the request payload.
    const it = atReview.pendingApproval!.payload["iteration"] as {
      completion: { evidenceConsistentWithCompletion: boolean; blockers: string[] };
    };
    expect(it.completion.evidenceConsistentWithCompletion).toBe(false);
    expect(it.completion.blockers.join("\n")).toMatch(/implementation attempt ended as "failed"/);
    const done = await newRunner({ agent }).resume(started.run.id, decide(atReview.pendingApproval!.approvalId, "reject"));
    expect(done.state.iterations![0]!.completion).toEqual(it.completion);
    expect(done.run.status).toBe("rejected");
  });
});

// ===========================================================================
describe("the loop decision, as a pure function", () => {
  const owner = { decidedBy: "owner" } as const;
  it("follows the documented precedence", () => {
    expect(decideNextIteration({ iteration: 1, limit: 3, reviewDecision: { kind: "approve", ...owner }, safety: ["scope_drift"] }))
      .toMatchObject({ kind: "stop", reason: "human_approved" });
    expect(decideNextIteration({ iteration: 1, limit: 3, reviewDecision: { kind: "reject", ...owner }, safety: [] }))
      .toMatchObject({ kind: "stop", reason: "human_rejected" });
    expect(decideNextIteration({ iteration: 1, limit: 3, reviewDecision: { kind: "feedback", ...owner }, safety: ["check_policy_changed"] }))
      .toMatchObject({ kind: "stop", reason: "safety_stop" });
    expect(decideNextIteration({ iteration: 1, limit: 3, reviewDecision: { kind: "feedback", ...owner }, safety: [] }))
      .toEqual({ kind: "continue", nextIteration: 2, limit: 3 });
    expect(decideNextIteration({ iteration: 2, limit: 3, reviewDecision: { kind: "edit", ...owner }, safety: [] }))
      .toEqual({ kind: "continue", nextIteration: 3, limit: 3 });
    expect(decideNextIteration({ iteration: 3, limit: 3, reviewDecision: { kind: "feedback", ...owner }, safety: [] }))
      .toMatchObject({ kind: "stop", reason: "iteration_limit_reached" });
    expect(decideNextIteration({ iteration: 1, limit: 3, reviewDecision: null, safety: [] }))
      .toMatchObject({ kind: "stop", reason: "safety_stop" });
  });

  it("refuses an out-of-range limit rather than looping on it", () => {
    expect(() => decideNextIteration({ iteration: 1, limit: 1_000_000, reviewDecision: { kind: "feedback", ...owner }, safety: [] })).toThrow();
    expect(() => decideNextIteration({ iteration: 1, limit: 0, reviewDecision: { kind: "feedback", ...owner }, safety: [] })).toThrow();
  });

  it("has no input for anything a model or agent could say", () => {
    const params = decideNextIteration.toString().match(/\{[^}]*\}/)?.[0] ?? "";
    for (const word of ["complete", "approved", "verified", "claim", "proposal", "model"]) {
      expect(params.toLowerCase()).not.toContain(word);
    }
  });
});

describe("completion is observational", () => {
  const outcome = (over: Record<string, unknown> = {}) => VerificationOutcome.parse({
    runId: "r", verdict: "verified", claim: { summary: "done", files: [], claimsSuccess: true },
    observation: { inspected: true, headCommit: "abc", changedFiles: ["src/a.ts"] },
    checks: {}, independentlyVerified: true, createdAt: iso(), ...over,
  });
  const review = (over: Record<string, unknown> = {}) => ReviewReport.parse({
    runId: "r", verdict: "pass", findings: [], checkResults: [], scopeDrift: [], createdAt: iso(), ...over,
  });

  it("is consistent with completion only when every trusted fact agrees", () => {
    expect(assessCompletion({ verification: outcome(), review: review(), scopeDrift: [] }))
      .toEqual({ evidenceConsistentWithCompletion: true, blockers: [] });
    expect(assessCompletion({ verification: outcome({ verdict: "failed" }), review: review(), scopeDrift: [] }).blockers)
      .toContain('verification verdict is "failed"');
    expect(assessCompletion({ verification: outcome({ independentlyVerified: false, observation: { inspected: false } }), review: review(), scopeDrift: [] }).blockers)
      .toContain("safety condition: inspection_unavailable");
    expect(assessCompletion({ verification: outcome(), review: review({ verdict: "changes_requested" }), scopeDrift: ["x"] }).blockers.length)
      .toBeGreaterThanOrEqual(3);
    expect(assessCompletion({ verification: null, review: null, scopeDrift: [] }).evidenceConsistentWithCompletion).toBe(false);
  });

  it("a claim of success is not an input", () => {
    const claimed = outcome({ verdict: "failed", claim: { summary: "all done", files: ["src/a.ts"], claimsSuccess: true } });
    expect(assessCompletion({ verification: claimed, review: review(), scopeDrift: [] }).evidenceConsistentWithCompletion).toBe(false);
  });

  it("derives safety conditions from the observation only", () => {
    expect(detectSafetyConditions(outcome(), [])).toEqual([]);
    expect(detectSafetyConditions(null, [])).toEqual(["inspection_unavailable"]);
    expect(detectSafetyConditions(outcome({
      observation: { inspected: true, gitMutation: { detected: true, reasons: ["new commit"], newCommits: ["abc"] }, gitMutationAuthorised: false },
    }), ["src/z.ts"])).toEqual(["unauthorised_git_mutation", "scope_drift"]);
  });
});

describe("approval binding digests", () => {
  const plan = (over: Partial<Plan> = {}): Plan => ({
    summary: "A", steps: [{ order: 0, description: "do", risk: "LOW" }], allowedScope: ["src"], risks: [], highestRisk: "HIGH", ...over,
  });
  it("names the plan's content, not its object identity or field order", () => {
    expect(planDigest(plan())).toBe(planDigest({ ...plan() }));
    expect(planDigest(plan({ allowedScope: ["src", "docs"] }))).toBe(planDigest(plan({ allowedScope: ["docs", "src"] })));
    expect(planDigest(plan({ allowedScope: ["docs"] }))).not.toBe(planDigest(plan()));
    expect(planDigest(plan({ summary: "B" }))).not.toBe(planDigest(plan()));
    expect(planDigest(null)).not.toBe(planDigest(plan()));
  });
  it("a different reviewed repository state is a different review", () => {
    const v = (head: string) => VerificationOutcome.parse({
      runId: "r", verdict: "verified", claim: {}, observation: { inspected: true, headCommit: head },
      checks: {}, independentlyVerified: true, createdAt: iso(),
    });
    const r = ReviewReport.parse({ runId: "r", verdict: "pass", createdAt: iso() });
    expect(reviewDigest(r, v("a"))).toBe(reviewDigest(r, v("a")));
    expect(reviewDigest(r, v("a"))).not.toBe(reviewDigest(r, v("b")));
    expect(reviewDigest({ ...r, verdict: "changes_requested" }, v("a"))).not.toBe(reviewDigest(r, v("a")));
  });
});

describe("the iteration record", () => {
  it("cannot carry authority and is upserted by id in iteration order", () => {
    const record = IterationRecord.parse({ iteration: 1, iterationId: "run_x_it1", startedAt: iso() });
    for (const key of FORBIDDEN_ITERATION_KEYS) {
      expect(Object.keys(record)).not.toContain(key);
      expect(IterationRecord.safeParse({ ...record, [key]: true }).success).toBe(false);
    }
    const merged = mergeIterationRecords(
      [IterationRecord.parse({ iteration: 2, iterationId: "run_x_it2", startedAt: iso() }), record],
      [IterationRecord.parse({ iteration: 1, iterationId: "run_x_it1", startedAt: record.startedAt, grantId: "g" })],
    );
    expect(merged.map((r) => r.iteration)).toEqual([1, 2]);
    expect(merged[0]!.grantId).toBe("g");
  });
});

describe("the experience producer", () => {
  it("writes no agent text and no agent source, and records failure when trusted evidence says so", () => {
    const v = VerificationOutcome.parse({
      runId: "r", verdict: "failed", claim: { summary: "I DID EVERYTHING PERFECTLY", files: ["x"], claimsSuccess: true },
      observation: { inspected: true }, checks: {}, independentlyVerified: true, createdAt: iso(),
    });
    const r = ReviewReport.parse({
      runId: "r", verdict: "changes_requested",
      findings: [{ severity: "blocker", message: "Changed outside the approved scope.", file: "z" }], createdAt: iso(),
    });
    const rec = experienceFromIteration({
      projectId: "proj", iterationId: "run_x_it1", taskType: "development_request",
      approvedPlan: { summary: "S", steps: [{ description: "step one" }] },
      verification: v, review: r, reviewDecision: "feedback", completionBlockers: 2, now: iso(),
    });
    expect(JSON.stringify(rec)).not.toContain("PERFECTLY");
    expect(rec.sources).not.toContain("AGENT_CLAIM");
    expect(rec.failedPatterns).toEqual(["step one"]);
    expect(rec.successfulPatterns).toEqual([]);
    expect(rec.failures[0]).toMatch(/outside the approved scope/);
  });
});
