import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ProjectStore } from "../projects/projectStore.js";
import { WorkflowRunner, type RunResult } from "../graph/runner.js";
import { HumanDecision, Plan } from "../domain/approval.js";
import type { WorkflowRun } from "../domain/workflow.js";
import { guardDecision, cleanScope, type Intent, type WaitingSummary } from "./interpret.js";
import { ClaudeTranslator, type Translator } from "./translator.js";
import { describeApproval, describeRun, describeWaiting } from "./describe.js";
import { PAGE } from "./page.js";

/**
 * THE FRONT DESK - a local page you talk to.
 *
 * A small HTTP server on 127.0.0.1 that serves one page and three JSON
 * endpoints. It drives the orchestrator IN-PROCESS exactly as the CLI does -
 * same ProjectStore, same WorkflowRunner, same checkpoints - and adds nothing
 * to what the orchestrator can do. What it adds is a way in that needs no
 * syntax: a sentence, spoken or typed.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 * The desk never decides. A decision is executed only when the person's own
 * words pass `guardDecision`, and the HumanDecision it records carries their
 * name, not "desk" and not a model. A model translates sentences to commands
 * and does nothing else (translator.ts). Everything the person hears at a
 * gate is narrated by code from trusted state (describe.ts).
 *
 * Bound to the loopback address only. There is no authentication because
 * there is no network: the page is reachable from this machine and nowhere
 * else.
 */

const Say = z.object({ text: z.string().min(1).max(4000) }).strict();

export interface DeskOptions {
  store: ProjectStore;
  projectId: string;
  decidedBy: string;
  translator?: Translator;
  /** Passed to every WorkflowRunner; the orchestrator validates it. */
  maxIterations?: number;
  port?: number;
}

export interface DeskReply {
  /** What to show and read out. */
  say: string;
  /** What the desk understood. For the transcript. */
  understood: string;
  /** Current state, for the sidebar. */
  state: DeskState;
}

export interface DeskState {
  project: string;
  waiting: { runId: string; gate: "plan" | "review"; request: string; iteration: number; limit: number; narration: string }[];
  recent: { runId: string; status: string; outcome: string | null; request: string; iteration: number; narration: string }[];
}

export class Desk {
  private readonly translator: Translator;
  constructor(private readonly options: DeskOptions) {
    this.translator = options.translator ?? new ClaudeTranslator(os.tmpdir());
  }

  private runner(): WorkflowRunner {
    return new WorkflowRunner(this.options.store, undefined, {
      ...(this.options.maxIterations !== undefined ? { maxIterations: this.options.maxIterations } : {}),
    });
  }

  state(): DeskState {
    const store = this.options.store;
    const runs = store.listRuns(this.options.projectId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const waiting = runs.filter((r) => r.status === "awaiting_approval").map((r) => ({
      runId: r.id,
      gate: (r.phase === "approve_plan" ? "plan" : "review") as "plan" | "review",
      request: r.request,
      iteration: r.iteration,
      limit: r.iterationLimit,
      narration: r.pendingApproval ? describeApproval(r.pendingApproval, r) : "Waiting.",
    }));
    const recent = runs.filter((r) => r.status !== "awaiting_approval").slice(0, 8).map((r) => ({
      runId: r.id, status: r.status, outcome: r.outcome ?? null, request: r.request,
      iteration: r.iteration, narration: describeRun(r),
    }));
    return { project: this.options.projectId, waiting, recent };
  }

  private waitingSummaries(): WaitingSummary[] {
    return this.state().waiting.map((w) => ({ runId: w.runId, gate: w.gate, summary: w.request.slice(0, 100) }));
  }

  async say(text: string): Promise<DeskReply> {
    const waiting = this.waitingSummaries();
    const intent = await this.translator.translate(text, waiting);
    const reply = await this.act(text, intent, waiting);
    return { ...reply, state: this.state() };
  }

  private async act(
    utterance: string, intent: Intent, waiting: readonly WaitingSummary[],
  ): Promise<Omit<DeskReply, "state">> {
    switch (intent.kind) {
      case "status": {
        const s = this.state();
        const runs = this.options.store.listRuns(this.options.projectId).filter((r) => r.status === "awaiting_approval");
        const latest = s.recent[0];
        return {
          understood: "status",
          say: `${describeWaiting(runs)}${latest ? ` Most recent finished run: ${latest.narration}` : ""}`,
        };
      }
      case "unclear":
        return { understood: "unclear", say: intent.question };
      case "start": {
        if (waiting.length > 0) {
          return {
            understood: "start (refused)",
            say: "Something is already waiting for your decision. Answer that first, or say reject to stop it.",
          };
        }
        let result: RunResult;
        const runner = this.runner();
        try {
          result = await runner.start(this.options.projectId, intent.request);
        } catch (error) {
          return { understood: "start", say: `I could not start that: ${error instanceof Error ? error.message : "error"}` };
        } finally {
          // The desk stays up; every drive must release its checkpoint handle.
          runner.close();
        }
        return { understood: `start: ${intent.request}`, say: this.afterRun(result) };
      }
      case "decide": {
        const guard = guardDecision(utterance, intent);
        if (!guard.ok) return { understood: `decide ${intent.decision} (refused)`, say: guard.reason };
        const target = waiting[0];
        if (!target) return { understood: `decide ${intent.decision}`, say: "Nothing is waiting for a decision." };
        const run = this.options.store.findRun(target.runId);
        if (!run?.pendingApprovalId) return { understood: "decide", say: "That run is no longer waiting." };

        const scope = cleanScope(intent.scope);
        const kind = intent.decision === "approve" && scope.length > 0 && run.pendingApproval?.kind === "plan"
          ? "edit" : intent.decision;
        let editedPlan: Plan | null = null;
        if (kind === "edit") {
          const original = run.pendingApproval?.proposedPlan;
          if (!original) return { understood: "edit", say: "This approval carries no plan to narrow." };
          editedPlan = Plan.parse({ ...original, allowedScope: scope });
        }
        const decision = HumanDecision.parse({
          approvalId: run.pendingApprovalId,
          kind,
          decidedBy: this.options.decidedBy,
          decidedAt: new Date().toISOString(),
          comment: intent.comment ?? (kind === "feedback" || kind === "reject" ? utterance : null),
          editedPlan,
        });
        let result: RunResult;
        const runner = this.runner();
        try {
          result = await runner.resume(run.id, decision);
        } catch (error) {
          return { understood: `decide ${kind}`, say: `That did not go through: ${error instanceof Error ? error.message : "error"}` };
        } finally {
          runner.close();
        }
        const understood = `${kind}${scope.length ? ` (scope: ${scope.join(", ")})` : ""}${decision.comment ? `: ${decision.comment}` : ""}`;
        return { understood, say: this.afterRun(result) };
      }
    }
  }

  private afterRun(result: RunResult): string {
    if (result.pendingApproval) return describeApproval(result.pendingApproval, result.run);
    return describeRun(result.run as WorkflowRun);
  }

  /** Serve the page and the API on the loopback address. */
  listen(): Promise<{ url: string; close: () => void }> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    const port = this.options.port ?? 4173;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ url: `http://127.0.0.1:${String(actual)}/`, close: () => server.close() });
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE.replace("__PROJECT__", this.options.projectId).replace("__WHO__", this.options.decidedBy));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") { json(200, this.state()); return; }
      if (req.method === "POST" && url.pathname === "/api/say") {
        const body = await readBody(req);
        const parsed = Say.safeParse(JSON.parse(body || "{}"));
        if (!parsed.success) { json(400, { error: "say what?" }); return; }
        json(200, await this.say(parsed.data.text));
        return;
      }
      json(404, { error: "not found" });
    } catch (error) {
      json(500, { error: error instanceof Error ? error.message : "error" });
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { data += chunk; if (data.length > 64 * 1024) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Entry point: `node dist/desk/server.js <projectId> [who]` */
export async function main(argv: readonly string[]): Promise<void> {
  const projectId = argv[0];
  if (!projectId) {
    process.stdout.write("usage: node dist/desk/server.js <projectId> [decidedBy]\n");
    process.exitCode = 2;
    return;
  }
  const store = new ProjectStore();
  store.requireProject(projectId);
  const desk = new Desk({ store, projectId, decidedBy: argv[1] ?? os.userInfo().username });
  const { url } = await desk.listen();
  process.stdout.write(`front desk for ${projectId}: ${url}\n`);
  process.stdout.write(`projects: ${path.resolve(store.dir(projectId), "..")}\n`);
}

if (process.argv[1] && /server\.js$/.test(process.argv[1])) {
  void main(process.argv.slice(2));
}
