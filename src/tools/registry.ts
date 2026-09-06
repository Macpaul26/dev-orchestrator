import { z } from "zod";
import { gateFor, type RiskLevel, type RiskGate } from "../domain/risk.js";
import type { RepositoryInspector } from "../domain/inspector.js";
import { repositoryTools } from "./repositoryTools.js";
import { implementationTools } from "./implementationTools.js";
import type { ImplementationSession } from "../implementation/session.js";
import { capabilityMatrix, type CapabilityStatus } from "../domain/capability.js";

/**
 * A typed tool definition.
 *
 * `risk` is declared HERE, statically, next to the implementation. It is not a
 * parameter, not model-supplied, and not recomputed at call time - so reviewing
 * the risk posture of the system means reading this file, and a model cannot
 * influence the gate that applies to it.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  risk: RiskLevel;
  readOnly: boolean;
  run(input: I): Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never, unknown>>();

  register<I, O>(tool: ToolDefinition<I, O>): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool "${tool.name}".`);
    if (tool.risk === "HIGH" && tool.readOnly) {
      throw new Error(`Tool "${tool.name}" cannot be both HIGH risk and read-only.`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition<never, unknown>);
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()];
  }

  gate(name: string): RiskGate {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool "${name}".`);
    return gateFor(tool.risk);
  }

  /** Standing guarantee: nothing that can modify a repository is registered. */
  hasWriteCapability(): boolean {
    return this.list().some((t) => !t.readOnly);
  }
}

/**
 * The registry.
 *
 * Phase 3 adds repository INSPECTION - reading a repository's real state - and
 * nothing else. Every tool registered below is read-only and LOW risk. There is
 * still no filesystem write tool, no git mutation tool, no GitHub tool and no
 * shell tool, and `hasWriteCapability()` still returns false.
 *
 * Repository tools appear only when an inspector is supplied, so a registry
 * built without a project (`createRegistry()`) exposes introspection alone.
 */
export interface RegistryOptions {
  /** Enables the read-only repository tools. */
  inspector?: RepositoryInspector;
  /**
   * Enables the WRITE tools - and only for this session.
   *
   * A session exists only where a human-approved grant exists, so write tools
   * are not something that can be switched on. There is no configuration flag,
   * no environment variable and no default that produces one; the absence of a
   * grant means the session was never constructed and these tools are simply
   * not in the registry.
   */
  session?: ImplementationSession;
}

/**
 * The registry.
 *
 * Read-only inspection is always available. Write tools appear ONLY when a
 * bound implementation session is supplied, which requires a human-approved
 * grant. `createRegistry()` with no arguments - what `dev-agent tools` uses -
 * therefore reports no write capability, which is the truth: without a grant
 * there is none.
 *
 * Still absent in every configuration: shell, arbitrary process execution, git
 * mutation, network, GitHub, and any model API.
 */
export function createRegistry(
  optionsOrInspector?: RegistryOptions | RepositoryInspector,
): ToolRegistry {
  const options: RegistryOptions =
    optionsOrInspector && "inspect" in optionsOrInspector
      ? { inspector: optionsOrInspector as RepositoryInspector }
      : ((optionsOrInspector as RegistryOptions | undefined) ?? {});

  const registry = new ToolRegistry();

  registry.register({
    name: "orchestrator.describe",
    description: "Describe the orchestrator's own capabilities. Read-only.",
    input: z.object({}),
    risk: "LOW",
    readOnly: true,
    async run() {
      return {
        phase: "4A",
        repositoryInspection: options.inspector !== undefined,
        boundedWrite: options.session !== undefined,
        writeRequiresGrant: true,
        // Every one of these is false in every configuration of this phase.
        shellExecution: false,
        processExecution: false,
        gitMutation: false,
        networkAccess: false,
        checkExecution: false,
        codingAgent: false,
        modelApi: false,
      };
    },
  });

  if (options.inspector) {
    for (const tool of repositoryTools(options.inspector)) registry.register(tool);
  }
  if (options.session) {
    for (const tool of implementationTools(options.session)) registry.register(tool);
  }

  return registry;
}

/**
 * The capability matrix, for a human asking "what can this thing actually do?".
 *
 * Reports what is IMPLEMENTED and what it REQUIRES, independently of whether a
 * grant happens to exist right now - so an empty tool list is not mistaken for
 * "writing is impossible", nor a populated one for "writing is unrestricted".
 */
export function describeCapabilities(): CapabilityStatus[] {
  return capabilityMatrix();
}
