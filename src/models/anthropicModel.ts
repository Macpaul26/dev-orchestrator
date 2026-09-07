import Anthropic from "@anthropic-ai/sdk";
import {
  ReasoningProposal, ReasoningRecord, ReasoningFailure, REASONING_LIMITS,
  type ReasoningFailureCode,
} from "../domain/reasoning.js";
import type {
  ReasoningModel, ReasoningRequest, ReasoningResult,
} from "./reasoningModel.js";
import { systemPrompt, buildUserPrompt, extractJson } from "../reasoning/prompt.js";

/**
 * THE ANTHROPIC REASONING PROVIDER
 *
 * The only file in the orchestrator that knows a vendor SDK exists. Everything
 * else depends on `ReasoningModel`, so replacing or removing this provider
 * touches nothing but this file and the one place that constructs it.
 *
 * ---------------------------------------------------------------------------
 * CREDENTIALS
 * ---------------------------------------------------------------------------
 * The key is read from the environment at construction and is held only by the
 * SDK client. It is never written into workflow state, a checkpoint, a project
 * record, an event, a prompt, or a report - `ReasoningRecord` carries provider
 * and model names and bounded counts, and has no field a key could occupy.
 *
 * Unconfigured is the NORMAL state and is not an error: `fromEnvironment`
 * returns null and the workflow keeps using its deterministic plan. What must
 * never happen is a silent fallback to some other endpoint, so there is no
 * base-URL override, no local-model path, and no default key.
 */

export const ENV_API_KEY = "ANTHROPIC_API_KEY";
export const ENV_MODEL = "ORCHESTRATOR_REASONING_MODEL";
export const ENV_TIMEOUT_MS = "ORCHESTRATOR_REASONING_TIMEOUT_MS";

/** Sensible default. An operator may name a different model, not a different API. */
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_TOKENS = 8_000;

export class ReasoningConfigError extends Error {
  constructor(readonly code: ReasoningFailureCode, message: string) {
    super(message);
    this.name = "ReasoningConfigError";
  }
}

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class AnthropicReasoningModel implements ReasoningModel {
  readonly provider = "anthropic";
  readonly model: string;

  /** Native private: unreachable at runtime, not merely compile-time. */
  readonly #client: Anthropic;
  readonly #timeoutMs: number;

  constructor(options: AnthropicModelOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new ReasoningConfigError(
        "configuration_invalid",
        "a reasoning API key is required; the orchestrator will not fall back " +
        "to an unauthenticated or alternative endpoint",
      );
    }
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.#timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.#client = new Anthropic({ apiKey: options.apiKey, timeout: this.#timeoutMs });
  }

  /**
   * Build from the environment, or return null when unconfigured.
   *
   * Null is not a failure. It is how the orchestrator runs with no model at
   * all, which remains the default.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): AnthropicReasoningModel | null {
    const apiKey = env[ENV_API_KEY];
    if (!apiKey || apiKey.trim().length === 0) return null;

    const rawTimeout = Number.parseInt(env[ENV_TIMEOUT_MS] ?? "", 10);
    return new AnthropicReasoningModel({
      apiKey: apiKey.trim(),
      model: env[ENV_MODEL],
      timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined,
    });
  }

  async generate(request: ReasoningRequest): Promise<ReasoningResult> {
    const started = Date.now();
    const base = {
      provider: this.provider, model: this.model,
      operation: request.operation, runId: request.runId,
    };
    const record = (extra: Record<string, unknown>): ReasoningRecord =>
      ReasoningRecord.parse({
        ...base, at: new Date().toISOString(),
        durationMs: Date.now() - started, ...extra,
      });
    const fail = (code: ReasoningFailureCode, message: string, extra = {}): ReasoningResult => ({
      ok: false,
      failure: ReasoningFailure.parse({ code, message }),
      record: record({ ok: false, failure: { code, message }, ...extra }),
    });

    if (request.signal?.aborted) {
      return fail("cancelled", "the run was cancelled before the request was sent");
    }

    /**
     * Render BEFORE the network call, and refuse rather than shorten.
     *
     * Defence in depth: the plan node checks this too, so no provider can be
     * the only thing standing between an oversized context and a truncated
     * prompt. Either way the request is never sent.
     */
    const prompt = buildUserPrompt(request.context);
    if (!prompt.ok) {
      return fail(
        "context_too_large",
        `the rendered prompt is ${String(prompt.renderedChars)} characters, over ` +
        `the ${String(prompt.limit)}-character transport limit; nothing was sent`,
      );
    }

    let raw: string;
    let inputTokens: number | null;
    let outputTokens: number | null;
    try {
      const response = await this.#client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Trusted instructions live in `system`; untrusted project content
          // travels only in the user turn, fenced. See reasoning/prompt.ts -
          // and note that this separation helps, it does not guarantee.
          system: systemPrompt(),
          messages: [{ role: "user", content: prompt.text }],
          thinking: { type: "adaptive" },
        },
        { signal: request.signal },
      );

      inputTokens = response.usage?.input_tokens ?? null;
      outputTokens = response.usage?.output_tokens ?? null;
      raw = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    } catch (error) {
      return fail(...classifyProviderError(error));
    }

    const responseBytes = Buffer.byteLength(raw, "utf8");
    const usage = { inputTokens, outputTokens, responseBytes };

    // ---- bounded extraction, then strict validation ----------------------
    const extracted = extractJson(raw);
    if (!extracted.ok) {
      return fail(
        extracted.reason,
        extracted.reason === "response_too_large"
          ? "the response exceeded the size ceiling and was discarded unparsed"
          : "the response did not contain a single JSON object",
        usage,
      );
    }

    /**
     * `.strict()` does the security work here.
     *
     * A response carrying `approved`, `capabilities` or `execute` alongside an
     * otherwise perfect plan fails HERE, in full. The authority field is not
     * stripped and the rest kept - the whole proposal is refused, because a
     * model attempting to grant itself something is not a model whose plan
     * should then be shown to a human as ordinary.
     */
    const parsed = ReasoningProposal.safeParse(extracted.value);
    if (!parsed.success) {
      return fail(
        "schema_invalid",
        "the response did not match the required proposal schema (unexpected " +
        "or missing fields, or a bound exceeded)",
        usage,
      );
    }

    return {
      ok: true,
      proposal: parsed.data,
      record: record({ ok: true, ...usage }),
    };
  }
}

/**
 * Map a provider error onto a typed failure.
 *
 * The provider's message is NOT propagated: it can contain request detail, and
 * in some clients an echoed header. Only the classification travels.
 */
function classifyProviderError(error: unknown): [ReasoningFailureCode, string] {
  const name = error instanceof Error ? error.name : "";
  const status = (error as { status?: number } | undefined)?.status;

  if (name === "AbortError") return ["cancelled", "the request was cancelled"];
  if (status === 401 || status === 403) {
    return ["authentication_failed", "the reasoning provider rejected the credentials"];
  }
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
    return ["timeout", "the reasoning provider did not respond in time"];
  }
  return ["transport_failed", "the reasoning provider could not be reached or errored"];
}

/** Exported for the tools report. Never returns the key itself. */
export function reasoningConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = env[ENV_API_KEY];
  return typeof key === "string" && key.trim().length > 0;
}

export { REASONING_LIMITS };
