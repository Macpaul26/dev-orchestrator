import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * TRUSTED CONFIGURATION FOR THE CLAUDE CODE ADAPTER
 *
 * The single place an executable path can come from, and it is deliberately
 * nowhere near the request path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------------------------------------------------------
 * "Which program do we run?" must not be answerable by anything that flows in
 * from a plan, a request, a session or an agent. Keeping the answer in a module
 * that takes no request-derived input at all makes that structural rather than
 * a rule someone has to remember: `ImplementationRequest` has no executable
 * field, `ClaudeCodeAgent` never accepts one, and this resolver reads only the
 * process environment or an explicit argument supplied by the operator.
 *
 * ---------------------------------------------------------------------------
 * NOT CONFIGURED MEANS NOT AVAILABLE
 * ---------------------------------------------------------------------------
 * There is no default executable, no PATH lookup, no "try `claude` and see".
 * A PATH lookup would let whatever happens to be earliest on PATH become the
 * implementation agent. Absent configuration, the adapter refuses to launch -
 * which is also why the orchestrator's default posture is unchanged: no agent
 * is connected unless somebody deliberately connected one.
 */

export const ENV_EXECUTABLE = "ORCHESTRATOR_CLAUDE_EXECUTABLE";
export const ENV_ARGS = "ORCHESTRATOR_CLAUDE_ARGS";
export const ENV_ALLOWED_ENV = "ORCHESTRATOR_CLAUDE_ENV_ALLOWLIST";

/**
 * Environment variables the child ALWAYS receives, and their justification.
 *
 * Deliberately the same shape as `gitExec.safeEnv`: a fixed passthrough list of
 * things a program needs merely to start, and nothing that identifies or
 * authenticates anybody. No credential name appears here, and none can be added
 * without editing this file.
 */
export const BASE_ENV_PASSTHROUGH: readonly string[] = [
  "PATH", "Path",           // find the interpreter and linked libraries
  "SystemRoot", "windir",   // Windows needs these to load core DLLs
  "COMSPEC",                // Windows process creation
  "TEMP", "TMP", "TMPDIR",  // a place to put scratch files
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", // config discovery
  "LANG", "LC_ALL",         // text encoding
] as const;

/**
 * Names that may NEVER be allowlisted, however the operator configures things.
 *
 * The allowlist exists so a deployment can pass the one variable its agent
 * genuinely needs. It is not a hole for bulk credential forwarding, so the
 * obviously-dangerous families are refused outright and the refusal says so.
 * An operator who truly needs one of these has to change this file, which is a
 * reviewable act rather than an environment tweak.
 */
const NEVER_ALLOWLISTABLE = [
  // Cloud and forge credentials, by vendor prefix.
  /^AWS_/i, /^AZURE_/i, /^GOOGLE_/i, /^GCP_/i,
  /^GH_/i, /^GITHUB_/i,
  // Model-provider credentials. The whole prefix, not just the obvious names -
  // ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are both credentials.
  /^ANTHROPIC_/i, /^OPENAI_/i,
  /**
   * Credential-shaped tokens anywhere in the name.
   *
   * `KEY` is here because the first version of this list did not include it,
   * and every `*_API_KEY` in existence sailed straight through - the single
   * most common shape of the exact thing the list exists to stop.
   *
   * Matching is on whole underscore-delimited segments, so `KEYBOARD_LAYOUT`
   * and `MONKEY_MODE` are unaffected. Over-blocking a legitimate setting costs
   * an operator one line in this file; under-blocking hands a credential to an
   * untrusted process.
   */
  /(^|_)(KEY|KEYS|APIKEY|API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|SESSION|COOKIE)($|_)/i,
  /^NPM_TOKEN$/i, /^DATABASE_URL$/i, /^DB_/i,
  /^ORCHESTRATOR_/i, // the orchestrator's own configuration is not the agent's
];

export const ClaudeCodeConfig = z.object({
  /** Absolute path. Never derived from a request, never looked up on PATH. */
  executable: z.string().min(1),
  /** Fixed arguments from trusted configuration. The request supplies none. */
  baseArgs: z.array(z.string()).default([]),
  /**
   * Exact environment variable names the operator explicitly permits.
   *
   * Default EMPTY. A real Claude Code session needs credentials to authenticate,
   * and this phase does not hand them over by default - see docs/PHASE-4B1.md.
   * Connecting a genuinely authenticated agent is a deliberate configuration
   * decision, not something that happens because a demo needed it.
   */
  environmentAllowlist: z.array(z.string()).default([]),
  /** Wall-clock ceiling for one agent run. */
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).default(10 * 60 * 1000),
  /** How long a terminating process gets before it is killed outright. */
  gracefulTerminationMs: z.number().int().positive().max(60_000).default(5_000),
  /** Cap on captured output. Beyond this, bytes are counted and discarded. */
  maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024).default(256 * 1024),
  /**
   * Retain a bounded excerpt of agent output in the durable record.
   *
   * OFF by default, and that is a security decision rather than a tidiness one.
   * Agent output is attacker-influenced text: it can carry secrets the agent
   * read, and in later phases it becomes model context, where retained text is
   * an injection surface. Counts and a hash describe it without reproducing it.
   */
  retainOutputExcerpt: z.boolean().default(false),
  excerptBytes: z.number().int().positive().max(8 * 1024).default(2 * 1024),
});
export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfig>;

export class ClaudeCodeConfigError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "executable_not_absolute"
      | "executable_missing"
      | "executable_not_a_file"
      | "forbidden_env_allowlist",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeCodeConfigError";
  }
}

/**
 * Validate a configuration and prove the executable exists right now.
 *
 * Checked at configuration time AND again immediately before each launch: a
 * path that was valid when the orchestrator started may have been replaced by
 * the time it is used.
 */
export function validateConfig(input: unknown): ClaudeCodeConfig {
  const config = ClaudeCodeConfig.parse(input);

  if (!path.isAbsolute(config.executable)) {
    throw new ClaudeCodeConfigError(
      "executable_not_absolute",
      `Claude Code executable "${config.executable}" must be an absolute path. ` +
        "A bare name would be resolved through PATH, which would let whatever " +
        "happens to be earliest on PATH become the implementation agent.",
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(config.executable);
  } catch {
    throw new ClaudeCodeConfigError(
      "executable_missing",
      `Claude Code executable "${config.executable}" does not exist.`,
    );
  }
  if (!stats.isFile()) {
    throw new ClaudeCodeConfigError(
      "executable_not_a_file",
      `Claude Code executable "${config.executable}" is not a file.`,
    );
  }

  for (const name of config.environmentAllowlist) {
    const forbidden = NEVER_ALLOWLISTABLE.find((pattern) => pattern.test(name));
    if (forbidden) {
      throw new ClaudeCodeConfigError(
        "forbidden_env_allowlist",
        `Environment variable "${name}" cannot be allowlisted for the agent ` +
          "process: it matches a credential or orchestrator-configuration " +
          "pattern. Bulk credential forwarding is not what the allowlist is for.",
      );
    }
  }

  return config;
}

/**
 * Read configuration from the orchestrator's own environment.
 *
 * Returns null when unconfigured - the normal state. Nothing here reads a
 * request, a project record, or anything an agent could influence.
 */
export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCodeConfig | null {
  const executable = env[ENV_EXECUTABLE];
  if (!executable || executable.trim().length === 0) return null;

  const split = (value: string | undefined): string[] =>
    (value ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);

  return validateConfig({
    executable: executable.trim(),
    baseArgs: split(env[ENV_ARGS]),
    environmentAllowlist: split(env[ENV_ALLOWED_ENV]),
  });
}

/**
 * Build the child's environment: the fixed base, plus explicitly allowlisted
 * names, plus a few hard-coded settings that keep the child non-interactive.
 *
 * BUILT, never inherited. A variable absent from both lists cannot reach the
 * child no matter what the orchestrator process happens to be holding.
 */
export function buildAgentEnvironment(
  config: ClaudeCodeConfig,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const name of BASE_ENV_PASSTHROUGH) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of config.environmentAllowlist) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }

  // Nothing interactive: the child has no terminal and nobody to answer a prompt.
  env["CI"] = "1";
  env["TERM"] = "dumb";
  env["NO_COLOR"] = "1";
  env["GIT_TERMINAL_PROMPT"] = "0";

  return env;
}
