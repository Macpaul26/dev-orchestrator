import { z } from "zod";

/** A verification command the project declares. NEVER model-supplied. */
export const CheckDefinition = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  /** Working directory relative to the project root. */
  cwd: z.string().default("."),
});
export type CheckDefinition = z.infer<typeof CheckDefinition>;

export const RepoRef = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().default("main"),
});
export type RepoRef = z.infer<typeof RepoRef>;

/**
 * A managed project. Nothing here is specific to any one project - a project
 * is a configuration directory, not a class in the core.
 */
export const Project = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case"),
  name: z.string().min(1),
  /** Absolute path to the working copy. All file access is contained here. */
  workingDir: z.string().min(1),
  repo: RepoRef.nullish(),
  /** Verification commands. The allowlist - the only shell the system may run. */
  checks: z.array(CheckDefinition).default([]),
  /** Durable constraints a plan must respect. */
  constraints: z.array(z.string()).default([]),
  /** Context files to load, relative to workingDir. */
  contextFiles: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type Project = z.infer<typeof Project>;

/** A durable, human-authored project decision. */
export const Decision = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Short stable code, e.g. "D011". */
  code: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().default(""),
  supersedes: z.string().nullish(),
  /** Decisions are made by humans. */
  decidedBy: z.string().min(1),
  decidedAt: z.string().datetime(),
});
export type Decision = z.infer<typeof Decision>;

export const Requirement = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  text: z.string().min(1),
  source: z.string().default("owner"),
  acceptanceCriteria: z.array(z.string()).default([]),
});
export type Requirement = z.infer<typeof Requirement>;

export const Milestone = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  taskIds: z.array(z.string()).default([]),
  targetDate: z.string().nullish(),
});
export type Milestone = z.infer<typeof Milestone>;
