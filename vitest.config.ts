import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The restart/resume test spawns real child processes.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each test uses its own temp dir + checkpoint db; run serially so the
    // shared better-sqlite3 native handle is not contended.
    fileParallelism: false,
  },
});
