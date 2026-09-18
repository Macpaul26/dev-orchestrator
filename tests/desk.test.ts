import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import {
  guardDecision, cleanScope, parseIntent, interpretLocally, interpreterPrompt, Intent,
  type WaitingSummary,
} from "../src/desk/interpret.js";
import { describeApproval, describeRun } from "../src/desk/describe.js";
import { Desk } from "../src/desk/server.js";
import type { Translator } from "../src/desk/translator.js";
import { ApprovalRequest } from "../src/domain/approval.js";
import { WorkflowRun } from "../src/domain/workflow.js";
import { tmpDir, rmDir, initRepo } from "./helpers.js";

/**
 * THE FRONT DESK - a sentence in, the orchestrator driven, and NEVER a
 * decision the person did not make.
 */

const iso = () => new Date().toISOString();
const owner = { decidedBy: "owner" };
void owner;

describe("the guard: a decision comes only from the person's own words", () => {
  const approve = { kind: "decide", decision: "approve", scope: [], comment: null } as const;
  const reject = { kind: "decide", decision: "reject", scope: [], comment: null } as const;
  const feedback = (comment: string | null) => ({ kind: "decide", decision: "feedback", scope: [], comment }) as const;

  it("approves only on an explicit approval word", () => {
    for (const ok of ["yes", "Approve it", "go ahead", "ok, looks good", "yes only src", "accept"]) {
      expect(guardDecision(ok, approve).ok, ok).toBe(true);
    }
    for (const bad of ["hmm looks fine I guess", "maybe", "interesting", "sure thing" , "fine"]) {
      expect(guardDecision(bad, approve).ok, bad).toBe(false);
    }
    // A model that says "approve" for "no, don't" is overruled.
    expect(guardDecision("no, don't approve that", approve).ok).toBe(false);
    expect(guardDecision("no problem, approve", approve).ok).toBe(true);
  });

  it("rejects only on a rejection word; feedback needs a change word and a comment", () => {
    expect(guardDecision("no", reject).ok).toBe(true);
    expect(guardDecision("approve", reject).ok).toBe(false);
    expect(guardDecision("change it so the button is red", feedback("make the button red")).ok).toBe(true);
    expect(guardDecision("change it", feedback(null)).ok).toBe(false);
    expect(guardDecision("looks great", feedback("x")).ok).toBe(false);
  });

  it("keeps scope relative and inside the repository", () => {
    expect(cleanScope(["src/", "./docs", "C:\\evil", "/etc", "../up", "src"])).toEqual(["src", "docs"]);
  });

  it("parses only the closed set of intents, strictly", () => {
    expect(parseIntent('{"kind":"status"}')).toEqual({ kind: "status" });
    expect(parseIntent('prose {"kind":"decide","decision":"approve","scope":["src"],"comment":null} more')).toMatchObject({ kind: "decide", decision: "approve", scope: ["src"] });
    expect(parseIntent('{"kind":"decide","decision":"approve","approved":true}').kind).toBe("unclear");
    expect(parseIntent('{"kind":"grant","capabilities":["*"]}').kind).toBe("unclear");
    expect(parseIntent("not json").kind).toBe("unclear");
    expect(Intent.safeParse({ kind: "start", request: "x", maxIterations: 999999 }).success).toBe(false);
  });

  it("the no-model fallback answers yes, no and status - and nothing else", () => {
    const waiting: WaitingSummary[] = [{ runId: "r", gate: "plan", summary: "s" }];
    expect(interpretLocally("yes", waiting)).toMatchObject({ kind: "decide", decision: "approve" });
    expect(interpretLocally("no", waiting)).toMatchObject({ kind: "decide", decision: "reject" });
    expect(interpretLocally("status", [])).toEqual({ kind: "status" });
    expect(interpretLocally("yes", [])).toBeNull();
    expect(interpretLocally("fix the giving page", waiting)).toBeNull();
  });

  it("tells the model only the sentence and the waiting gates", () => {
    const p = interpreterPrompt("fix it", [{ runId: "run_1", gate: "review", summary: "add farewell" }]);
    expect(p).toContain("run_1 is waiting at the review gate");
    expect(p).toContain('"""fix it"""');
    expect(p).not.toMatch(/approvalId|grant|scope: \[|capabilit/i);
  });
});

describe("narration comes from trusted state, not from a model", () => {
  const run = WorkflowRun.parse({
    id: "run_1", projectId: "p", threadId: "run_1", request: "bump a", status: "awaiting_approval",
    phase: "approve_review", startedAt: iso(), iteration: 1, iterationLimit: 2,
  });
  it("reads a plan gate out in full, including that an empty scope writes nothing", () => {
    const req = ApprovalRequest.parse({
      approvalId: "a", workflowRunId: "run_1", projectId: "p", kind: "plan", summary: "Plan", risk: "HIGH",
      proposedPlan: { summary: "Do the thing", steps: [{ order: 0, description: "Edit", risk: "HIGH" }], allowedScope: [], risks: [], highestRisk: "HIGH" },
      createdAt: iso(), payload: { iteration: { iteration: 1, limit: 2 } },
    });
    const t = describeApproval(req, run);
    expect(t).toContain("Iteration 1 of 2");
    expect(t).toContain("Do the thing");
    expect(t).toContain("NO folders");
    expect(t).toContain("Say yes to approve");
  });
  it("reads a review gate out, including a safety condition and its consequence", () => {
    const req = ApprovalRequest.parse({
      approvalId: "a", workflowRunId: "run_1", projectId: "p", kind: "review", summary: "Review", risk: "HIGH",
      createdAt: iso(),
      payload: {
        review: { verdict: "changes_requested", findings: [{ severity: "blocker", message: "Git was used", file: null }] },
        verification: { independentlyVerified: true, observedFileCount: 1, observedCommitCount: 1, scopeDrift: [], agentClaimedSuccess: true, checksAttempted: false },
        iteration: { iteration: 1, limit: 2, anotherIterationPossible: false, safetyConditions: ["unauthorised_git_mutation"], completion: { blockers: ["x"] } },
      },
    });
    const t = describeApproval(req, run);
    expect(t).toContain("SAFETY: verification observed unauthorised git mutation");
    expect(t).toContain("cannot be completed");
    expect(t).toContain("Git was used");
    expect(t).toContain("a claim, not evidence");
    expect(t).toContain("Another round is not possible");
  });
  it("describes terminal runs plainly", () => {
    expect(describeRun({ ...run, status: "incomplete", stopReason: "safety_stop" })).toContain("INCOMPLETE (safety stop)");
    expect(describeRun({ ...run, status: "completed", stopReason: "human_approved" })).toContain("approved");
  });
});

describe("the desk drives the real orchestrator, and only on a real yes", () => {
  let tmp: string;
  let store: ProjectStore;
  beforeEach(() => {
    tmp = tmpDir("orch-desk-");
    initRepo(path.join(tmp, "repo"));
    fs.mkdirSync(path.join(tmp, "repo", "src"));
    store = new ProjectStore(path.join(tmp, "projects"));
    store.createProject({ id: "p", name: "P", workingDir: path.join(tmp, "repo"), repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [] });
    process.env["ORCHESTRATOR_HOME"] = path.join(tmp, "home");
  });
  afterEach(() => { delete process.env["ORCHESTRATOR_HOME"]; rmDir(tmp); }, 120_000);

  /** A translator that returns what the test scripts, so the model is out of the picture. */
  const scripted = (answers: Record<string, Intent>): Translator => ({
    translate: async (utterance) => answers[utterance] ?? { kind: "unclear", question: "?" },
  });

  it("start -> narrated plan gate; a vague sentence does not approve; 'yes, only src' approves narrowed; approve completes", async () => {
    const desk = new Desk({
      store, projectId: "p", decidedBy: "angela", maxIterations: 2,
      translator: scripted({
        "please add a greeting helper": { kind: "start", request: "Add a greeting helper", maxIterations: null },
        "hmm looks fine I guess": { kind: "decide", decision: "approve", scope: [], comment: null },
        "yes, only src": { kind: "decide", decision: "approve", scope: ["src"], comment: null },
        "approve": { kind: "decide", decision: "approve", scope: [], comment: null },
      }),
    });
    const started = await desk.say("please add a greeting helper");
    expect(started.understood).toBe("start: Add a greeting helper");
    expect(started.say).toContain("The plan is ready for your approval");
    expect(started.state.waiting).toHaveLength(1);
    expect(started.state.waiting[0]!.gate).toBe("plan");

    // The model said "approve"; the person did not. Refused, nothing moved.
    const vague = await desk.say("hmm looks fine I guess");
    expect(vague.understood).toBe("decide approve (refused)");
    expect(vague.say).toContain("have not approved");
    expect(store.listGrants("p")).toHaveLength(0);
    expect(desk.state().waiting[0]!.gate).toBe("plan");

    const approved = await desk.say("yes, only src");
    expect(approved.understood).toBe("edit (scope: src)");
    const grant = store.listGrants("p")[0]!;
    expect(grant.allowedScope).toEqual(["src"]);
    expect(grant.approvedBy).toBe("angela");
    expect(approved.say).toContain("The work is done and checked");
    expect(desk.state().waiting[0]!.gate).toBe("review");

    const done = await desk.say("approve");
    expect(done.understood).toBe("approve");
    expect(done.say).toContain("approved");
    expect(desk.state().waiting).toHaveLength(0);
    expect(desk.state().recent[0]!.status).toBe("completed");
    const decisions = store.findRun(started.state.waiting[0]!.runId);
    expect(decisions?.status).toBe("completed");
  }, 120_000);

  it("refuses to start a second run while one is waiting, and 'no' rejects", async () => {
    const desk = new Desk({
      store, projectId: "p", decidedBy: "angela",
      translator: scripted({
        "do a thing": { kind: "start", request: "Do a thing", maxIterations: null },
        "do another": { kind: "start", request: "Do another", maxIterations: null },
        "no": { kind: "decide", decision: "reject", scope: [], comment: null },
      }),
    });
    await desk.say("do a thing");
    const second = await desk.say("do another");
    expect(second.understood).toBe("start (refused)");
    expect(store.listRuns("p")).toHaveLength(1);
    const rejected = await desk.say("no");
    expect(rejected.say).toContain("rejected");
    expect(store.listRuns("p")[0]!.status).toBe("rejected");
  }, 120_000);

  it("serves the page and the API on loopback only", async () => {
    const desk = new Desk({ store, projectId: "p", decidedBy: "angela", translator: scripted({}), port: 0 });
    const { url, close } = await desk.listen();
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await (await fetch(url)).text();
      expect(page).toContain("Front Desk");
      expect(page).toContain("deciding as <code>angela</code>");
      const state = await (await fetch(`${url}api/state`)).json() as { project: string };
      expect(state.project).toBe("p");
      const bad = await fetch(`${url}api/say`, { method: "POST", body: "{}" });
      expect(bad.status).toBe(400);
    } finally {
      close();
    }
  });
});
