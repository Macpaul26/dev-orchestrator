import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import type { ImplementationSession } from "../implementation/session.js";

/**
 * BOUNDED WRITE CAPABILITIES
 *
 * These are the only tools in the system that are not read-only, and the shape
 * of their definition is the point.
 *
 * ---------------------------------------------------------------------------
 * NOT A GENERIC `filesystem.write`
 * ---------------------------------------------------------------------------
 * A tool called `filesystem.write` taking an arbitrary path would be a hole
 * regardless of what checked it afterwards, because its NAME and SCHEMA would
 * describe unrestricted power and the restriction would live somewhere else.
 *
 * Instead these tools are manufactured against ONE `ImplementationSession`,
 * which is itself bound to one grant, one project, one run and one approved
 * scope. The bounds are not a parameter and are not in the input schema:
 *
 *   - no project id      the session has one
 *   - no run id          the session has one
 *   - no scope           the grant has one
 *   - no capability      the grant has them
 *   - no root, no cwd, no encoding, no mode, no flags
 *
 * A caller supplies a path and content. Everything that decides whether it is
 * allowed is fixed at the moment the human approved the plan.
 *
 * `risk: "HIGH"` and `readOnly: false` are declared honestly. That is why
 * `hasWriteCapability()` returns true for a registry built with a session - and
 * false for every registry built without one, which is what `dev-agent tools`
 * shows.
 */

const WritableFile = z.object({
  /** Repository-relative. Containment and scope are enforced by the session. */
  path: z.string().min(1).max(4096),
  /** UTF-8 text. Size is bounded by the grant, not by the caller. */
  contents: z.string(),
});

const TargetFile = z.object({
  path: z.string().min(1).max(4096),
});

export function implementationTools(
  session: ImplementationSession,
): ToolDefinition<never, unknown>[] {
  return [
    {
      name: "impl.writeFile",
      description:
        "Create or replace one file inside the approved scope of the current " +
        "implementation grant. Refused for any path outside that scope, outside " +
        "the project boundary, or covered by the sensitive-file policy.",
      input: WritableFile,
      risk: "HIGH",
      readOnly: false,
      async run(input: { path: string; contents: string }) {
        return session.writeFile(input.path, input.contents);
      },
    },
    {
      name: "impl.deleteFile",
      description:
        "Delete one file inside the approved scope of the current implementation " +
        "grant. Directories cannot be deleted.",
      input: TargetFile,
      risk: "HIGH",
      readOnly: false,
      async run(input: { path: string }) {
        return session.deleteFile(input.path);
      },
    },
  ] as unknown as ToolDefinition<never, unknown>[];
}
