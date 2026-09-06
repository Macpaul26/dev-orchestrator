import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import type { RepositoryInspector } from "../domain/inspector.js";

/**
 * READ-ONLY REPOSITORY CAPABILITIES
 *
 * Every tool here is `readOnly: true` and `risk: "LOW"`, and each declaration
 * is honest: none of them can write, because the only thing they can reach is a
 * `RepositoryInspector`, whose interface has no write method.
 *
 * Two properties are worth stating explicitly, because they are what keeps
 * these safe to expose to a model later:
 *
 *   1. NO COMMAND STRINGS. No input schema below accepts a command, a flag, an
 *      argument list, or a git subcommand. A caller chooses a TOOL; it never
 *      composes an invocation. There is deliberately no `repo.git` tool.
 *
 *   2. NO LIMIT OVERRIDES. No input schema accepts a size, depth or count
 *      limit. Those come from trusted configuration only (security/limits.ts),
 *      so a caller cannot ask to read a bigger file or walk deeper.
 *
 * Paths supplied here are untrusted, and are contained by the inspector's
 * FsBoundary - not by anything in this file.
 */

const PathInput = z.object({
  /** Repository-relative path. Containment is enforced by the FsBoundary. */
  path: z.string().min(1).max(4096),
});

export function repositoryTools(
  inspector: RepositoryInspector,
): ToolDefinition<never, unknown>[] {
  const tools: ToolDefinition<never, unknown>[] = [
    {
      name: "repo.status",
      description:
        "Structured git state: branch, HEAD, staged/unstaged/untracked files, " +
        "diff and recent commits. Read-only.",
      input: z.object({}),
      risk: "LOW",
      readOnly: true,
      async run() {
        return inspector.inspect();
      },
    },
    {
      name: "repo.stat",
      description:
        "Metadata for one path: kind, size, and whether the sensitive-file " +
        "policy forbids reading it. Never opens the file. Read-only.",
      input: PathInput,
      async run(input: { path: string }) {
        return inspector.statPath(input.path);
      },
      risk: "LOW",
      readOnly: true,
    },
    {
      name: "repo.readFile",
      description:
        "Read one text file, subject to the sensitive-file policy and the " +
        "configured size limit. Read-only.",
      input: PathInput,
      async run(input: { path: string }) {
        return inspector.readFile(input.path);
      },
      risk: "LOW",
      readOnly: true,
    },
    {
      name: "repo.listDirectory",
      description: "List one directory level, bounded by the entry limit. Read-only.",
      input: z.object({ path: z.string().max(4096).default(".") }),
      async run(input: { path: string }) {
        return inspector.listDirectory(input.path);
      },
      risk: "LOW",
      readOnly: true,
    },
    {
      name: "repo.commitExists",
      description:
        "Does this commit SHA actually exist in the repository? The check that " +
        "makes a claimed commit verifiable. Read-only.",
      input: z.object({ sha: z.string().min(4).max(64) }),
      async run(input: { sha: string }) {
        return { sha: input.sha, exists: await inspector.commitExists(input.sha) };
      },
      risk: "LOW",
      readOnly: true,
    },
  ] as unknown as ToolDefinition<never, unknown>[];

  return tools;
}
