import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ActivityRecord } from "../domain/activity.js";

/**
 * Append-only activity journal, one file per implementation run.
 *
 * Same shape as `events/EventLog`, kept as a SEPARATE file on purpose:
 *
 *   history/<run>.jsonl    workflow milestones and human approvals
 *   activity/<run>.jsonl   per-operation record of what the substrate did
 *
 * They are different in volume and in audience. A run makes a handful of
 * workflow events and can make hundreds of activity records, and conflating
 * them would bury the approval trail - the thing a human most needs to read -
 * under write traffic. They correlate by `runId`.
 *
 * Append-only for the same reason as the event log: the record of what a
 * capability did must not be rewritable by the thing being audited.
 */
export class ActivityJournal {
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(record: ActivityRecord): ActivityRecord {
    const parsed = ActivityRecord.parse(record);
    fs.appendFileSync(this.file, `${JSON.stringify(parsed)}\n`, "utf8");
    return parsed;
  }

  read(): ActivityRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ActivityRecord.parse(JSON.parse(line)));
  }

  /** Records of one logical operation, in order. */
  forCorrelation(correlationId: string): ActivityRecord[] {
    return this.read().filter((r) => r.correlationId === correlationId);
  }

  count(type: ActivityRecord["type"]): number {
    return this.read().filter((r) => r.type === type).length;
  }
}

/** A fresh correlation id for one logical operation. */
export function newCorrelationId(): string {
  return `op_${crypto.randomBytes(6).toString("hex")}`;
}
