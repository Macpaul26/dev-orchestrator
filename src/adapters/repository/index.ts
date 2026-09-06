import { LocalGitRepositoryInspector } from "./localGit.js";
import type { RepositoryInspector } from "../../domain/inspector.js";
import type { Project } from "../../domain/project.js";
import type { InspectionLimits } from "../../security/limits.js";

export { LocalGitRepositoryInspector, type LocalInspectorConfig } from "./localGit.js";
export {
  runGit, GitCommandNotPermitted, GitUnavailable,
  GIT_READ_ONLY_SUBCOMMANDS, GIT_DENIED_SUBCOMMANDS,
} from "./gitExec.js";

/**
 * Build the inspector for a project.
 *
 * Everything security-relevant comes from the PROJECT RECORD - a human-edited
 * file on disk - and nothing from the workflow, the request text, or a model:
 *
 *   workingDir     the security boundary
 *   repoRoot       the only way to widen it, and it must contain workingDir
 *   contextFiles   which files may be read into context
 *   checks         recorded as evidence; never executed in this phase
 *
 * `limits` is an argument rather than a project field so that trusted callers
 * (tests, the CLI) can tighten it. It is clamped to CEILINGS regardless.
 */
export function createInspectorForProject(
  project: Project,
  limits?: Partial<InspectionLimits>,
): RepositoryInspector {
  return new LocalGitRepositoryInspector({
    workingDir: project.workingDir,
    repoRoot: project.repoRoot ?? null,
    contextFiles: project.contextFiles,
    checks: project.checks.map((c) => ({ name: c.name, command: c.command })),
    ...(limits ? { limits } : {}),
  });
}
