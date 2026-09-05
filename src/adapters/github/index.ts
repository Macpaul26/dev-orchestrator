/**
 * Boundary for GitHub access. INTENTIONALLY UNIMPLEMENTED IN PHASE 1+2.
 *
 * Reads and writes are split into separate interfaces on purpose: reads are
 * LOW risk and ungated, every write is HIGH risk and must pass a human gate.
 * Only `GitHubReader` will be implemented first; `GitHubWriter` has no
 * implementation and no call site anywhere in the system.
 */
export interface GitHubReader {
  getFile(input: { owner: string; repo: string; path: string; ref?: string }): Promise<string>;
  listCommits(input: { owner: string; repo: string; perPage?: number }): Promise<unknown[]>;
}

/** No implementation exists. Declared to fix the read/write split in the design. */
export interface GitHubWriter {
  readonly _neverImplementedInPhase1: never;
}
