import { describe, it, expect } from "vitest";
import {
  Task, TaskStatus, machineTransition, applyHumanDecision, canMachineTransition,
  InvariantViolation, HUMAN_ONLY_STATUSES,
} from "../src/domain/task.js";
import { HumanDecision, Plan, ApprovalRequest, approvalIdFor } from "../src/domain/approval.js";
import { Project } from "../src/domain/project.js";
import { ImplementationReport, ReviewReport } from "../src/domain/reports.js";
import { gateFor, requiresHumanApproval } from "../src/domain/risk.js";

const iso = () => new Date().toISOString();

const task = (status: TaskStatus): Task =>
  Task.parse({
    id: "t1", projectId: "p1", title: "T", status,
    createdAt: iso(), updatedAt: iso(),
  });

describe("schema validation", () => {
  it("accepts a valid project and rejects a non-kebab id", () => {
    expect(() =>
      Project.parse({ id: "alpha-one", name: "A", workingDir: "/tmp/a", createdAt: iso() }),
    ).not.toThrow();
    expect(() =>
      Project.parse({ id: "Alpha One", name: "A", workingDir: "/tmp/a", createdAt: iso() }),
    ).toThrow();
  });

  it("requires editedPlan when the decision kind is edit", () => {
    const base = { approvalId: "a1", decidedBy: "me", decidedAt: iso() };
    expect(() => HumanDecision.parse({ ...base, kind: "edit" })).toThrow();
    expect(() =>
      HumanDecision.parse({
        ...base, kind: "edit",
        editedPlan: Plan.parse({ summary: "s", allowedScope: ["src/"] }),
      }),
    ).not.toThrow();
  });

  it("requires a comment when the decision kind is feedback", () => {
    const base = { approvalId: "a1", decidedBy: "me", decidedAt: iso() };
    expect(() => HumanDecision.parse({ ...base, kind: "feedback" })).toThrow();
    expect(() =>
      HumanDecision.parse({ ...base, kind: "feedback", comment: "narrow the scope" }),
    ).not.toThrow();
  });

  it("validates an approval request", () => {
    expect(() =>
      ApprovalRequest.parse({
        approvalId: approvalIdFor("r1", "plan", 0), workflowRunId: "r1", projectId: "p1",
        kind: "plan", summary: "s", risk: "HIGH", createdAt: iso(),
      }),
    ).not.toThrow();
    // unknown kind
    expect(() =>
      ApprovalRequest.parse({
        approvalId: "a", workflowRunId: "r1", projectId: "p1",
        kind: "deploy", summary: "s", risk: "HIGH", createdAt: iso(),
      }),
    ).toThrow();
  });
});

describe("approval id determinism", () => {
  it("returns the same id for the same (run, gate, attempt)", () => {
    expect(approvalIdFor("run_1", "plan", 0)).toBe(approvalIdFor("run_1", "plan", 0));
  });
  it("differs per gate and per attempt", () => {
    expect(approvalIdFor("run_1", "plan", 0)).not.toBe(approvalIdFor("run_1", "review", 0));
    expect(approvalIdFor("run_1", "plan", 0)).not.toBe(approvalIdFor("run_1", "plan", 1));
  });
});

describe("risk model", () => {
  it("gates HIGH behind human approval and leaves LOW ungated", () => {
    expect(gateFor("LOW")).toBe("NONE");
    expect(gateFor("MEDIUM")).toBe("LOGGED");
    expect(gateFor("HIGH")).toBe("HUMAN_APPROVAL");
    expect(requiresHumanApproval("HIGH")).toBe(true);
    expect(requiresHumanApproval("LOW")).toBe(false);
  });
});

describe("APPROVED invariant", () => {
  it("permits the machine to walk PLANNED -> REVIEW", () => {
    let t = task("PLANNED");
    t = machineTransition(t, "IN_PROGRESS");
    t = machineTransition(t, "IMPLEMENTED");
    t = machineTransition(t, "REVIEW");
    expect(t.status).toBe("REVIEW");
  });

  it("REFUSES any automatic transition into APPROVED", () => {
    expect(() => machineTransition(task("REVIEW"), "APPROVED")).toThrow(InvariantViolation);
    expect(canMachineTransition("REVIEW", "APPROVED")).toBe(false);
  });

  it("refuses an automatic transition into APPROVED from every status", () => {
    for (const from of TaskStatus.options) {
      for (const to of HUMAN_ONLY_STATUSES) {
        expect(canMachineTransition(from, to)).toBe(false);
        expect(() => machineTransition(task(from), to)).toThrow(InvariantViolation);
      }
    }
  });

  it("leaves REVIEW with no outgoing machine edge at all", () => {
    for (const to of TaskStatus.options) {
      expect(canMachineTransition("REVIEW", to)).toBe(false);
    }
  });

  it("reaches APPROVED only via a human decision carrying an approvalId", () => {
    const decision = HumanDecision.parse({
      approvalId: "apr_1", kind: "approve", decidedBy: "owner", decidedAt: iso(),
    });
    expect(applyHumanDecision(task("REVIEW"), decision).status).toBe("APPROVED");
  });

  it("rejects a malformed decision rather than approving", () => {
    expect(() =>
      applyHumanDecision(task("REVIEW"), { kind: "approve" } as never),
    ).toThrow();
  });

  it("only finalises a task that is in REVIEW", () => {
    const decision = HumanDecision.parse({
      approvalId: "apr_1", kind: "approve", decidedBy: "owner", decidedAt: iso(),
    });
    expect(() => applyHumanDecision(task("IN_PROGRESS"), decision)).toThrow(InvariantViolation);
  });

  it("maps reject to REJECTED and leaves feedback/edit non-final", () => {
    const mk = (kind: "reject" | "feedback") =>
      HumanDecision.parse({
        approvalId: "apr_1", kind, decidedBy: "owner", decidedAt: iso(),
        comment: "because",
      });
    expect(applyHumanDecision(task("REVIEW"), mk("reject")).status).toBe("REJECTED");
    expect(applyHumanDecision(task("REVIEW"), mk("feedback")).status).toBe("REVIEW");
  });
});

describe("implementation report", () => {
  it("keeps claimed and observed fields distinct and unverified by default", () => {
    const report = ImplementationReport.parse({
      runId: "r1", claimedSummary: "I changed everything", createdAt: iso(),
    });
    expect(report.claimedSummary).toBe("I changed everything");
    expect(report.observedFiles).toEqual([]);
    expect(report.observedDiff).toBeNull();
    expect(report.verifiedIndependently).toBe(false);
  });

  it("models scope drift on the review report", () => {
    const review = ReviewReport.parse({
      runId: "r1", verdict: "changes_requested",
      scopeDrift: ["src/unexpected.ts"], createdAt: iso(),
    });
    expect(review.scopeDrift).toContain("src/unexpected.ts");
  });
});
