import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { checkpointDbPath } from "./paths.js";

/**
 * Durable workflow checkpoints.
 *
 * SqliteSaver, not MemorySaver. The whole point of this phase is that a
 * workflow suspended at a human approval survives the process exiting - so the
 * checkpoint must be on disk, keyed by thread id, and readable by a completely
 * separate process.
 *
 * WHAT MUST NEVER GO IN HERE: secrets. The checkpoint serialises graph state,
 * so graph state must never carry credentials. See docs/SECURITY.md.
 */
export function createCheckpointer(dbPath: string = checkpointDbPath()): SqliteSaver {
  return SqliteSaver.fromConnString(dbPath);
}

/**
 * Release the underlying SQLite file handle.
 *
 * Needed on Windows, where an open handle keeps the file locked and a caller
 * cannot delete the database directory. Safe to call more than once.
 */
export function closeCheckpointer(saver: unknown): void {
  const db = (saver as { db?: { close?: () => void; open?: boolean } }).db;
  try {
    if (db?.open !== false) db?.close?.();
  } catch {
    // Already closed - nothing to release.
  }
}
