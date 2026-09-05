#!/usr/bin/env node
import { Command as CliCommand } from "commander";
import path from "node:path";
import { ProjectStore } from "../projects/projectStore.js";
import { WorkflowRunner } from "../graph/runner.js";
import { HumanDecision, Plan, type HumanDecisionKind } from "../domain/approval.js";
import { createRegistry } from "../tools/registry.js";
import { EventLog } from "../events/log.js";
import { renderApproval, renderRun, renderRuns, line } from "./render.js";

const program = new CliCommand();
program
  .name("dev-agent")
  .description("AI Development Orchestrator (Phase 1+2 - walking graph, no coding agent)")
  .version("0.1.0");

const store = new ProjectStore();

// ---------------------------------------------------------------- projects ---
program
  .command("project:create")
  .description("Register a project")
  .requiredOption("--id <id>", "kebab-case project id")
  .requiredOption("--name <name>", "display name")
  .requiredOption("--dir <dir>", "absolute path to the working copy")
  .action((opts: { id: string; name: string; dir: string }) => {
    const project = store.createProject({
      id: opts.id,
      name: opts.name,
      workingDir: path.resolve(opts.dir),
      repo: null,
      checks: [],
      constraints: [],
      contextFiles: [],
    });
    line(`created project ${project.id} -> ${project.workingDir}`);
  });

program
  .command("project:list")
  .description("List registered projects")
  .action(() => {
    const ids = store.listProjects();
    if (ids.length === 0) return line("no projects registered");
    for (const id of ids) {
      const p = store.requireProject(id);
      line(`${p.id.padEnd(20)} ${p.name}`);
    }
  });

// --------------------------------------------------------------- workflow ----
program
  .command("start")
  .description("Start a workflow; runs until it suspends at an approval")
  .requiredOption("--project <id>")
  .requiredOption("--request <text>")
  .action(async (opts: { project: string; request: string }) => {
    const runner = new WorkflowRunner(store);
    const result = await runner.start(opts.project, opts.request);
    renderRun(result);
    if (result.pendingApproval) {
      renderApproval(result.pendingApproval);
      line("");
      line("The workflow is suspended and checkpointed. This process may now exit.");
      line(`Resume with:  dev-agent resume --run ${result.run.id} --decision approve`);
    }
  });

program
  .command("runs")
  .description("List workflow runs awaiting a human decision")
  .action(() => {
    renderRuns(store.findAwaitingApproval());
  });

program
  .command("resume")
  .description("Supply a human decision and continue a suspended workflow")
  .requiredOption("--run <runId>")
  .requiredOption("--decision <kind>", "approve | edit | reject | feedback")
  .option("--by <who>", "who is deciding", "cli-user")
  .option("--comment <text>", "required for feedback and reject")
  .option("--scope <paths>", "comma-separated allowedScope, used with --decision edit")
  .action(async (opts: {
    run: string; decision: string; by: string; comment?: string; scope?: string;
  }) => {
    const existing = store.findRun(opts.run);
    if (!existing) { line(`unknown run ${opts.run}`); process.exitCode = 1; return; }
    if (!existing.pendingApprovalId) {
      line(`run ${opts.run} is ${existing.status}, not awaiting approval`);
      process.exitCode = 1; return;
    }

    const kind = opts.decision as HumanDecisionKind;

    // `edit` rewrites the proposed plan before it is approved. This is the
    // cheapest safety control in the system: a human narrowing allowedScope
    // constrains what any later implementation phase is permitted to touch.
    let editedPlan: Plan | null = null;
    if (kind === "edit") {
      const original = existing.pendingApproval?.proposedPlan;
      if (!original) {
        line("cannot edit: this approval carries no plan");
        process.exitCode = 1; return;
      }
      const scope = (opts.scope ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      editedPlan = Plan.parse({ ...original, allowedScope: scope });
      line(`edited allowedScope -> ${scope.length ? scope.join(", ") : "(none)"}`);
    }

    const decision = HumanDecision.parse({
      approvalId: existing.pendingApprovalId,
      kind,
      decidedBy: opts.by,
      decidedAt: new Date().toISOString(),
      comment: opts.comment ?? null,
      editedPlan,
    });

    const runner = new WorkflowRunner(store);
    const result = await runner.resume(opts.run, decision);
    renderRun(result);
    if (result.pendingApproval) {
      renderApproval(result.pendingApproval);
      line(`Resume with:  dev-agent resume --run ${result.run.id} --decision approve`);
    }
  });

program
  .command("history")
  .description("Print the structured event history for a run")
  .requiredOption("--run <runId>")
  .action((opts: { run: string }) => {
    const run = store.findRun(opts.run);
    if (!run) { line(`unknown run ${opts.run}`); process.exitCode = 1; return; }
    const log = new EventLog(store.historyFile(run.projectId, run.id));
    for (const event of log.read()) line(JSON.stringify(event));
  });

// ------------------------------------------------------------------ tools ----
program
  .command("tools")
  .description("List registered tools and their static risk")
  .action(() => {
    const registry = createRegistry();
    for (const tool of registry.list()) {
      line(`${tool.name.padEnd(28)} ${tool.risk.padEnd(7)} ${registry.gate(tool.name)}`);
    }
    line("");
    line(`write capabilities registered: ${registry.hasWriteCapability()}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  line(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
