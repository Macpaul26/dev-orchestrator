import {
  ReasoningProposal, ReasoningRecord, ReasoningFailure,
  type ReasoningFailureCode,
} from "../src/domain/reasoning.js";
import type {
  ReasoningModel, ReasoningRequest, ReasoningResult,
} from "../src/models/reasoningModel.js";
import { extractJson } from "../src/reasoning/prompt.js";

/**
 * A DETERMINISTIC FAKE REASONING MODEL - TESTS ONLY.
 *
 * Lives in `tests/` on purpose: nothing in `src/` imports it, and a test
 * asserts that stays true.
 *
 * The suite must run with no API key and no network, and it must be able to
 * produce responses a real provider would only produce by accident or by
 * attack - an approval field, a capability grant, a scope of `/`, a response
 * larger than the ceiling, a hostile string echoed out of repository content.
 *
 * ---------------------------------------------------------------------------
 * IT RETURNS RAW TEXT, NOT A PROPOSAL
 * ---------------------------------------------------------------------------
 * The important part. A fake that returned an already-validated
 * `ReasoningProposal` would skip the extraction and schema validation that are
 * the actual security controls, and every test would then be asserting against
 * a boundary it never crossed. So this fake emits a STRING and runs it through
 * the same `extractJson` + strict-schema path the real provider uses.
 */
export class FakeReasoningModel implements ReasoningModel {
  readonly provider = "fake";
  readonly model = "fake-reasoning-model";

  /** Prompts it was given, so tests can assert what was and was not sent. */
  readonly prompts: ReasoningRequest[] = [];

  constructor(
    private readonly behaviour:
      | { kind: "raw"; text: string }
      | { kind: "failure"; code: ReasoningFailureCode; message?: string }
      | { kind: "hang" },
  ) {}

  async generate(request: ReasoningRequest): Promise<ReasoningResult> {
    this.prompts.push(request);
    const started = Date.now();
    const record = (extra: Record<string, unknown>): ReasoningRecord =>
      ReasoningRecord.parse({
        provider: this.provider, model: this.model,
        operation: request.operation, runId: request.runId,
        at: new Date().toISOString(), durationMs: Date.now() - started, ...extra,
      });
    const fail = (code: ReasoningFailureCode, message: string): ReasoningResult => ({
      ok: false,
      failure: ReasoningFailure.parse({ code, message }),
      record: record({ ok: false, failure: { code, message } }),
    });

    if (request.signal?.aborted) return fail("cancelled", "cancelled before send");

    if (this.behaviour.kind === "failure") {
      return fail(this.behaviour.code, this.behaviour.message ?? "fake provider failure");
    }

    if (this.behaviour.kind === "hang") {
      // Resolves only when the run is cancelled, so a test can prove that a
      // cancelled reasoning call approves nothing and starts nothing.
      return await new Promise<ReasoningResult>((resolve) => {
        const onAbort = (): void => resolve(fail("cancelled", "cancelled in flight"));
        if (request.signal) request.signal.addEventListener("abort", onAbort, { once: true });
        else setTimeout(() => resolve(fail("timeout", "no signal supplied")), 50);
      });
    }

    // ---- the real path: raw text through extraction and strict validation --
    const raw = this.behaviour.text;
    const responseBytes = Buffer.byteLength(raw, "utf8");

    const extracted = extractJson(raw);
    if (!extracted.ok) {
      return {
        ok: false,
        failure: ReasoningFailure.parse({
          code: extracted.reason,
          message: extracted.reason === "response_too_large"
            ? "response exceeded the ceiling"
            : "response was not a single JSON object",
        }),
        record: record({
          ok: false,
          failure: { code: extracted.reason, message: "extraction refused" },
          responseBytes,
        }),
      };
    }

    const parsed = ReasoningProposal.safeParse(extracted.value);
    if (!parsed.success) {
      return {
        ok: false,
        failure: ReasoningFailure.parse({
          code: "schema_invalid",
          message: "response did not match the proposal schema",
        }),
        record: record({
          ok: false,
          failure: { code: "schema_invalid", message: "schema rejected" },
          responseBytes,
        }),
      };
    }

    return {
      ok: true,
      proposal: parsed.data,
      record: record({ ok: true, responseBytes }),
    };
  }
}

/** A well-formed proposal, as JSON text. */
export function validProposalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "Add a greeting helper and cover it with a test.",
    objectives: ["Add the helper"],
    requirements: ["It must be covered by a test"],
    steps: [
      { order: 0, description: "Read the existing helpers" },
      { order: 1, description: "Add the new helper" },
    ],
    proposedScope: { paths: ["src/greet.ts"], rationale: "the helper lives here" },
    verification: { checks: ["unit tests"], rationale: "the helper is unit-testable" },
    risks: ["The helper name may clash"],
    questions: ["Should it be exported from the index?"],
    ...overrides,
  });
}
