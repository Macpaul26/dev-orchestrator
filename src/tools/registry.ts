import { z } from "zod";
import { gateFor, type RiskLevel, type RiskGate } from "../domain/risk.js";

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

  /** Phase 1+2 guarantee: nothing that can modify a repository is registered. */
  hasWriteCapability(): boolean {
    return this.list().some((t) => !t.readOnly);
  }
}

/**
 * The Phase 1+2 registry.
 *
 * Deliberately contains only LOW-risk, read-only introspection. No filesystem
 * tool, no git tool, no GitHub tool, no shell. Those arrive with the phases
 * that need them, each carrying its own static risk classification.
 */
export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "orchestrator.describe",
    description: "Describe the orchestrator's own capabilities. Read-only.",
    input: z.object({}),
    risk: "LOW",
    readOnly: true,
    async run() {
      return { phase: "1+2", writeCapabilities: false };
    },
  });

  return registry;
}
