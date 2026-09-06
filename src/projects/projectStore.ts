import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Project,
  Task,
  Decision,
  WorkflowRun,
  type Project as TProject,
  type Task as TTask,
  type Decision as TDecision,
  type WorkflowRun as TWorkflowRun,
} from "../domain/index.js";
import { projectsRoot, resolveWithin } from "../persistence/paths.js";
import { ImplementationGrant, type ImplementationGrant as TGrant } from "../domain/grant.js";
import {
  ImplementationRun, type ImplementationRun as TImplementationRun,
} from "../domain/implementation.js";

/**
 * File-backed project store.
 *
 *   projects/<project-id>/
 *     project.json      identity, repo, working dir, checks
 *     context.md        long-form context (human-authored)
 *     decisions.md      durable decisions, human-readable mirror
 *     status.md         human-readable snapshot
 *     decisions/        one JSON per decision (machine-readable)
 *     tasks/            one JSON per task
 *     runs/             one JSON per workflow run
 *     history/          one JSONL per run (see events/)
 *     grants/           one JSON per implementation grant (Phase 4A)
 *                       plus <grantId>.claim - the one-shot consumption marker
 *     implementations/  one JSON per implementation run (Phase 4A)
 *     activity/         one JSONL per implementation run (Phase 4A)
 *     implementation.lock  present while a mutating run holds the project
 *
 * Deliberately files, not a database: human-readable, diffable, git-friendly,
 * and editable by hand. Entirely independent of the LangGraph checkpoint DB.
 */
export class ProjectStore {
  /**
   * Readable so the runner can name it as a directory the agent must never be
   * pointed at. Exposing the path is not exposing the contents - nothing an
   * agent can reach accepts a path from here.
   */
  constructor(readonly root: string = projectsRoot()) {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Project directories are addressed by id, and the id is contained. */
  dir(projectId: string): string {
    return resolveWithin(this.root, projectId);
  }

  private sub(projectId: string, ...parts: string[]): string {
    return path.join(this.dir(projectId), ...parts);
  }

  private readJson<T>(file: string): T | null {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  // ---- Projects -----------------------------------------------------------

  listProjects(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => fs.existsSync(path.join(this.root, e.name, "project.json")))
      .map((e) => e.name)
      .sort();
  }

  createProject(input: Omit<TProject, "createdAt"> & { createdAt?: string }): TProject {
    const project = Project.parse({
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    const dir = this.dir(project.id);
    fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "history"), { recursive: true });

    this.writeJson(this.sub(project.id, "project.json"), project);
    this.seedIfAbsent(project.id, "context.md", `# ${project.name} — Context\n`);
    this.seedIfAbsent(project.id, "decisions.md", `# ${project.name} — Decisions\n`);
    this.seedIfAbsent(project.id, "status.md", `# ${project.name} — Status\n`);
    return project;
  }

  private seedIfAbsent(projectId: string, file: string, body: string): void {
    const target = this.sub(projectId, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, body, "utf8");
  }

  getProject(projectId: string): TProject | null {
    const raw = this.readJson<unknown>(this.sub(projectId, "project.json"));
    return raw ? Project.parse(raw) : null;
  }

  requireProject(projectId: string): TProject {
    const p = this.getProject(projectId);
    if (!p) throw new Error(`Unknown project "${projectId}".`);
    return p;
  }

  // ---- Tasks --------------------------------------------------------------

  saveTask(task: TTask): TTask {
    const parsed = Task.parse(task);
    this.writeJson(this.sub(parsed.projectId, "tasks", `${parsed.id}.json`), parsed);
    return parsed;
  }

  getTask(projectId: string, taskId: string): TTask | null {
    const raw = this.readJson<unknown>(this.sub(projectId, "tasks", `${taskId}.json`));
    return raw ? Task.parse(raw) : null;
  }

  listTasks(projectId: string): TTask[] {
    const dir = this.sub(projectId, "tasks");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => Task.parse(this.readJson<unknown>(path.join(dir, f))));
  }

  // ---- Decisions ----------------------------------------------------------

  saveDecision(decision: TDecision): TDecision {
    const parsed = Decision.parse(decision);
    this.writeJson(
      this.sub(parsed.projectId, "decisions", `${parsed.id}.json`),
      parsed,
    );
    return parsed;
  }

  listDecisions(projectId: string): TDecision[] {
    const dir = this.sub(projectId, "decisions");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => Decision.parse(this.readJson<unknown>(path.join(dir, f))));
  }

  // ---- Workflow runs ------------------------------------------------------

  saveRun(run: TWorkflowRun): TWorkflowRun {
    const parsed = WorkflowRun.parse(run);
    this.writeJson(this.sub(parsed.projectId, "runs", `${parsed.id}.json`), parsed);
    return parsed;
  }

  getRun(projectId: string, runId: string): TWorkflowRun | null {
    const raw = this.readJson<unknown>(this.sub(projectId, "runs", `${runId}.json`));
    return raw ? WorkflowRun.parse(raw) : null;
  }

  listRuns(projectId: string): TWorkflowRun[] {
    const dir = this.sub(projectId, "runs");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => WorkflowRun.parse(this.readJson<unknown>(path.join(dir, f))))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Runs suspended at an approval, across every project. */
  findAwaitingApproval(): TWorkflowRun[] {
    return this.listProjects()
      .flatMap((id) => this.listRuns(id))
      .filter((r) => r.status === "awaiting_approval");
  }

  /** Locate a run by id without knowing its project. */
  findRun(runId: string): TWorkflowRun | null {
    for (const projectId of this.listProjects()) {
      const run = this.getRun(projectId, runId);
      if (run) return run;
    }
    return null;
  }

  historyFile(projectId: string, runId: string): string {
    return this.sub(projectId, "history", `${runId}.jsonl`);
  }

  // ---- Implementation grants (Phase 4A) -----------------------------------

  /**
   * Persist an issued grant.
   *
   * THE STORED COPY IS AUTHORITATIVE. A caller presenting a grant is checked
   * against this record, which is what stops an agent widening its own scope by
   * editing the object it was handed.
   */
  saveGrant(grant: TGrant): TGrant {
    const parsed = ImplementationGrant.parse(grant);
    this.writeJson(this.sub(parsed.projectId, "grants", `${parsed.grantId}.json`), parsed);
    return parsed;
  }

  /**
   * Read a grant, with the CLAIM MARKER treated as authoritative over the JSON.
   *
   * Consumption is committed by creating `<grantId>.claim` exclusively, and the
   * status field in the JSON is updated immediately afterwards - but those are
   * two operations, and a process can die between them. If the JSON were the
   * source of truth, that crash would leave a claimed grant reading `active`
   * and a second attempt could use it.
   *
   * So the marker decides. It is created by a single atomic syscall, which makes
   * "has this grant been claimed?" answerable by one indivisible fact rather
   * than by a two-step write that can be interrupted halfway.
   */
  getGrant(projectId: string, grantId: string): TGrant | null {
    const raw = this.readJson<unknown>(this.sub(projectId, "grants", `${grantId}.json`));
    if (!raw) return null;
    const grant = ImplementationGrant.parse(raw);
    if (grant.status === "active" && this.isGrantClaimed(projectId, grantId)) {
      return { ...grant, status: "consumed" };
    }
    return grant;
  }

  private grantClaimFile(projectId: string, grantId: string): string {
    return this.sub(projectId, "grants", `${grantId}.claim`);
  }

  /** Has an implementation attempt already claimed this grant? */
  isGrantClaimed(projectId: string, grantId: string): boolean {
    return fs.existsSync(this.grantClaimFile(projectId, grantId));
  }

  /**
   * CLAIM A GRANT FOR ONE IMPLEMENTATION ATTEMPT. Atomic, and one-shot.
   *
   *   > One human approval produces one bounded implementation grant, and that
   *   > grant authorises at most one implementation attempt.
   *
   * `open(..., "wx")` creates the marker exclusively: on both POSIX and Windows
   * exactly one caller can succeed, and every other gets EEXIST. Two processes
   * racing for the same grant therefore cannot both proceed, and the loser is
   * refused rather than queued - the failure direction is closed.
   *
   * This does NOT lean on the project lock. The lock serialises mutation of a
   * project; this makes the grant itself single-use, including for a read-only
   * grant that never takes a lock at all.
   *
   * @returns the consumed grant, or null if it was already claimed.
   */
  claimGrant(projectId: string, grantId: string): TGrant | null {
    const claimFile = this.grantClaimFile(projectId, grantId);
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });

    let handle: number;
    try {
      handle = fs.openSync(claimFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }

    // The claim is already committed by the open above. Everything below is
    // record-keeping; if it fails, the grant stays consumed - which is the
    // conservative direction.
    try {
      fs.writeFileSync(
        handle,
        `${JSON.stringify(
          { grantId, claimedAt: new Date().toISOString(), pid: process.pid, hostname: os.hostname() },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } finally {
      fs.closeSync(handle);
    }

    const grant = this.getGrant(projectId, grantId);
    if (!grant) return null;
    return this.saveGrant({ ...grant, status: "consumed" });
  }

  listGrants(projectId: string): TGrant[] {
    const dir = this.sub(projectId, "grants");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ImplementationGrant.parse(this.readJson<unknown>(path.join(dir, f))));
  }

  // ---- Implementation runs (Phase 4A) -------------------------------------

  saveImplementation(run: TImplementationRun): TImplementationRun {
    const parsed = ImplementationRun.parse(run);
    this.writeJson(
      this.sub(parsed.projectId, "implementations", `${parsed.runId}.json`),
      parsed,
    );
    return parsed;
  }

  getImplementation(projectId: string, runId: string): TImplementationRun | null {
    const raw = this.readJson<unknown>(
      this.sub(projectId, "implementations", `${runId}.json`),
    );
    return raw ? ImplementationRun.parse(raw) : null;
  }

  listImplementations(projectId: string): TImplementationRun[] {
    const dir = this.sub(projectId, "implementations");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ImplementationRun.parse(this.readJson<unknown>(path.join(dir, f))));
  }

  /** Per-operation journal, deliberately separate from the workflow history. */
  activityFile(projectId: string, runId: string): string {
    return this.sub(projectId, "activity", `${runId}.jsonl`);
  }
}
