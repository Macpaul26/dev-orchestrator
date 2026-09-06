/**
 * CLAUDE CODE ADAPTER (Phase 4B.1)
 *
 * Replaces the Phase 1+2 `CodingAgent` placeholder, which declared a shape
 * before there was a lifecycle to hang it on. The live contract is Phase 4A's
 * `ImplementationAgent`, so this adapter implements that rather than carrying a
 * second, competing notion of what an agent is.
 *
 * The standing statement about this integration:
 *
 *   > Claude Code is an untrusted implementation agent. Its claims are not
 *   > observations. Repository state and verification results are established
 *   > independently by the orchestrator.
 *
 * See docs/PHASE-4B1.md for what the boundary actually guarantees - and, just as
 * importantly, what it does not.
 */
export { ClaudeCodeAgent } from "./agent.js";
export {
  ClaudeCodeConfig, ClaudeCodeConfigError,
  validateConfig, configFromEnvironment, buildAgentEnvironment,
  BASE_ENV_PASSTHROUGH, ENV_EXECUTABLE, ENV_ARGS, ENV_ALLOWED_ENV,
} from "./config.js";
export {
  launchAgentProcess, AgentProcessHandle, AgentLaunchRefused,
  parseClaimedReport, REPORT_MARKER,
  type AgentProcessOutcome, type AgentRequestPayload, type LaunchOptions,
} from "./processBoundary.js";
