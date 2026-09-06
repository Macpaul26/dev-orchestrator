#!/usr/bin/env node
import { Command as CliCommand } from "commander";
import path from "node:path";
import { ProjectStore } from "../projects/projectStore.js";
import { WorkflowRunner } from "../graph/runner.js";
import { HumanDecision, Plan, type HumanDecisionKind } from "../domain/approval.js";
import { createRegistry, describeCapabilities } from "../tools/registry.js";
import { ImplementationLock } from "../implementation/lock.js";
import { ActivityJournal } from "../activity/journal.js";
import { EventLog } from "../events/log.js";
import { renderApproval, renderRun, renderRuns, renderInspection, line } from "./render.js";
import { createInspectorForProject } from "../adapters/repository/index.js";

const program = new CliCommand();
program
  .name("dev-agent")
  .description(
    "AI Development Orchestrator (Phase 4A - bounded, human-granted repository " +
    "writes; no coding agent, no shell, no git mutation, no network)",
  )
  .version("0.1.0");

const store = new ProjectStore();

// ---------------------------------------------------------------- projects ---
program
  .command("project:create")
  .description("Register a project")
  .requiredOption("--id <id>", "kebab-case project id")
  .requiredOption("--name <name>", "display name")
  .requiredOption("--dir <dir>", "absolute path to the working copy")
  .option(
    "--repo-root <dir>",
    "EXPLICITLY widen the security boundary to this directory (must contain --dir)",
  )
  .action((opts: { id: string; name: string; dir: string; repoRoot?: string }) => {
    const project = store.createProject({
      id: opts.id,
      name: opts.name,
      workingDir: path.resolve(opts.dir),
      repoRoot: opts.repoRoot ? path.resolve(opts.repoRoot) : null,
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

// ---------------------------------------------------------------- inspect ----
program
  .command("inspect")
  .description("Run one read-only repository inspection for a project and print it")
  .requiredOption("--project <id>")
  .action(async (opts: { project: string }) => {
    const project = store.getProject(opts.project);
    if (!project) { line(`unknown project ${opts.project}`); process.exitCode = 1; return; }
    const outcome = await createInspectorForProject(project).inspect();
    renderInspection(outcome);
    if (!outcome.ok) process.exitCode = 1;
  });

// --------------------------------------------------------- implementation ----
program
  .command("implementation:status")
  .description("Show implementation runs and the project lock")
  .requiredOption("--project <id>")
  .action((opts: { project: string }) => {
    const project = store.getProject(opts.project);
    if (!project) { line(`unknown project ${opts.project}`); process.exitCode = 1; return; }

    const { holder, alive } = ImplementationLock.forProject(store.dir(project.id)).describe();
    if (!holder) {
      line("lock     (none)");
    } else {
      const liveness =
        alive === true ? "process running"
        : alive === false ? "process NOT running - lock is stale"
        : "liveness unknown (different host)";
      line(`lock     held by run ${holder.runId} (pid ${holder.pid} on ${holder.hostname}); ${liveness}`);
    }

    const runs = store.listImplementations(project.id);
    if (runs.length === 0) return line("no implementation runs");
    for (const run of runs) {
      const partial = run.partialChangesPossible ? "  PARTIAL CHANGES POSSIBLE" : "";
      line(
        `${run.runId}  ${run.status.padEnd(17)} writes ${run.writes} deletes ${run.deletes} ` +
        `denials ${run.denials}${partial}`,
      );
    }
  });

program
  .command("implementation:unlock")
  .description("Clear a stale implementation lock. FOR HUMAN USE - never automatic.")
  .requiredOption("--project <id>")
  .action((opts: { project: string }) => {
    const project = store.getProject(opts.project);
    if (!project) { line(`unknown project ${opts.project}`); process.exitCode = 1; return; }

    const lock = ImplementationLock.forProject(store.dir(project.id));
    const { holder, alive } = lock.describe();
    if (!holder) return line("no lock to clear");
    if (alive === true) {
      line(`refusing: run ${holder.runId} (pid ${holder.pid}) still appears to be running.`);
      line("Stop it first, or clear the lock manually if you are certain.");
      process.exitCode = 1;
      return;
    }
    lock.forceRelease();
    line(`cleared the lock held by run ${holder.runId}`);
    line("NOTE: that run may have written partial changes. Inspect the repository:");
    line(`      dev-agent inspect --project ${project.id}`);
  });

program
  .command("activity")
  .description("Print the implementation activity journal for a run")
  .requiredOption("--run <runId>")
  .action((opts: { run: string }) => {
    const run = store.findRun(opts.run);
    if (!run) { line(`unknown run ${opts.run}`); process.exitCode = 1; return; }
    const journal = new ActivityJournal(store.activityFile(run.projectId, run.id));
    const records = journal.read();
    if (records.length === 0) return line("no implementation activity recorded for this run");
    for (const record of records) line(JSON.stringify(record));
  });

// ------------------------------------------------------------------ tools ----
program
  .command("tools")
  .description("List registered tools and their static risk")
  .option("--project <id>", "include the repository tools bound to this project")
  .action((opts: { project?: string }) => {
    const project = opts.project ? store.getProject(opts.project) : null;
    const registry = createRegistry(
      project ? createInspectorForProject(project) : undefined,
    );
    for (const tool of registry.list()) {
      const access = tool.readOnly ? "read-only" : "WRITE";
      line(`${tool.name.padEnd(24)} ${tool.risk.padEnd(6)} ${access.padEnd(10)} ${registry.gate(tool.name)}`);
    }
    line("");
    line("CAPABILITIES");
    for (const status of describeCapabilities()) {
      const state = status.implemented ? "available" : "NOT IMPLEMENTED";
      line(`  ${status.capability.padEnd(22)} ${status.risk.padEnd(5)} ${state.padEnd(16)} ${status.requires}`);
    }
    line("");
    line(`write capabilities registered: ${registry.hasWriteCapability()}`);
    line("  (a registry gains write tools only from a human-approved implementation");
    line("   grant bound to one run and one scope; this listing has none)");
    line("shell execution available: false");
    line("process execution available: false");
    line("git mutation available: false");
    line("network access available: false");
    line("coding agent connected: false");
    line("check execution enabled: false");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  line(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
