import fs from "node:fs";
import path from "node:path";
import { OrchestratorEvent } from "./types.js";

/**
 * Append-only JSONL event history, one file per run.
 *
 * Append-only on purpose: the audit trail of who approved what must not be
 * rewritable by the thing being audited.
 */
export class EventLog {
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(event: OrchestratorEvent): OrchestratorEvent {
    const parsed = OrchestratorEvent.parse(event);
    fs.appendFileSync(this.file, `${JSON.stringify(parsed)}\n`, "utf8");
    return parsed;
  }

  read(): OrchestratorEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => OrchestratorEvent.parse(JSON.parse(l)));
  }
}

export function now(): string {
  return new Date().toISOString();
}
