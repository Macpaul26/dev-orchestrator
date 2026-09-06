import { z } from "zod";
import { gateFor, type RiskLevel, type RiskGate } from "../domain/risk.js";
import type { RepositoryInspector } from "../domain/inspector.js";
import { repositoryTools } from "./repositoryTools.js";

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
export function createRegistry(inspector?: RepositoryInspector): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "orchestrator.describe",
    description: "Describe the orchestrator's own capabilities. Read-only.",
    input: z.object({}),
    risk: "LOW",
    readOnly: true,
    async run() {
      return {
        phase: "3",
        writeCapabilities: false,
        repositoryInspection: inspector !== undefined,
        checkExecution: false,
        shellExecution: false,
      };
    },
  });

  if (inspector) {
    for (const tool of repositoryTools(inspector)) registry.register(tool);
  }

  return registry;
}
