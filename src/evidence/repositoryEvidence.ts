import {
  EvidenceRequest, EvidenceOutcome, EvidenceRefusal, EVIDENCE_LIMITS,
  type EvidenceRequest as TEvidenceRequest,
  type EvidenceItem as TEvidenceItem,
  type EvidenceRefusal as TEvidenceRefusal,
  type EvidenceOutcome as TEvidenceOutcome,
  type EvidenceOperation,
  type EvidenceRefusalCode,
} from "../domain/repositoryEvidence.js";
import type { RepositoryInspector } from "../domain/inspector.js";
import { SafeFs } from "../security/safeFs.js";
import { FsBoundary } from "../security/fsBoundary.js";
import { resolveLimits } from "../security/limits.js";
import { containsTraversal, normalisePath } from "../domain/scope.js";
import { looksLikeSecret } from "../security/secretShapes.js";

/**
 * THE REPOSITORY EVIDENCE SERVICE
 *
 * Answers a closed set of read-only questions about a repository, for TRUSTED
 * ORCHESTRATOR CODE.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY CALL THIS, AND WHO MAY NOT
 * ---------------------------------------------------------------------------
 * Callers are workflow components. The reasoning model is NOT a caller and has
 * no way to become one: it has one method, it returns data, and nothing it
 * returns names an operation or a path. There is no serialized protocol, no
 * tool registry entry, and no dispatcher that turns a string from a model into
 * a call here. A test walks the source to keep it that way.
 *
 * What the model may eventually SEE is a bounded, provenance-labelled summary
 * of what this service found, assembled through the Task 007 context path like
 * every other fact. Seeing evidence is not requesting it.
 *
 * ---------------------------------------------------------------------------
 * IT REUSES THE EXISTING BOUNDARY, IT DOES NOT REBUILD IT
 * ---------------------------------------------------------------------------
 * Containment, symlink resolution, the sensitive-path policy and bounded
 * reading all come from the `RepositoryInspector` and the `SafeFs` beneath it -
 * the same code Phase 3 hardened. A second path-security implementation here
 * would eventually disagree with that one, and the disagreement would be the
 * vulnerability. What this file adds is the CLOSED OPERATION SET and the
 * EVIDENCE BUDGET, which are new concerns rather than duplicated ones.
 */


/** UTF-8 bytes, which is what every limit in EVIDENCE_LIMITS is expressed in. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Trim text to at most `maxBytes` UTF-8 bytes, never splitting a character.
 *
 * Cutting a UTF-8 sequence in half and decoding the remainder produces U+FFFD,
 * which is THREE bytes - so a naive truncation can end up larger than the limit
 * it was enforcing. This walks back over any trailing continuation bytes and
 * drops an incomplete sequence entirely rather than letting it decode.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;

  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  let end = buffer.length;
  // Continuation bytes are 0b10xxxxxx; walk back to the sequence's lead byte.
  let start = end;
  while (start > 0 && (buffer[start - 1]! & 0xc0) === 0x80) start--;
  if (start > 0) {
    const lead = buffer[start - 1]!;
    const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    // The sequence starts at start-1 and needs `needed` bytes; if the cut left
    // it short, drop it rather than decoding a replacement character.
    if (start - 1 + needed > end) end = start - 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * THE TOTAL EVIDENCE BUDGET.
 *
 * Charges each item and refusal by its serialized UTF-8 size BEFORE it is
 * admitted, so the service can never assemble a large result and discover
 * afterwards that it was over budget. Nothing accumulates unbounded on the way
 * to finding out.
 *
 * `limited` records that something was refused for budget reasons, so a caller
 * can distinguish "there was no more evidence" from "there was more and we
 * would not return it" without inspecting every refusal.
 */
class EvidenceBudget {
  #used = 0;
  #limited = false;

  constructor(private readonly limit: number) {}

  get used(): number { return this.#used; }
  get limited(): boolean { return this.#limited; }
  get remaining(): number { return Math.max(0, this.limit - this.#used); }

  /** Charge `value` if it fits. Returns false and records the limit if not. */
  admit(value: unknown): boolean {
    const cost = utf8Bytes(JSON.stringify(value) ?? "");
    if (this.#used + cost > this.limit) {
      this.#limited = true;
      return false;
    }
    this.#used += cost;
    return true;
  }

  /** Would `value` fit? Asked before building anything larger around it. */
  wouldFit(value: unknown): boolean {
    return this.#used + utf8Bytes(JSON.stringify(value) ?? "") <= this.limit;
  }

  markLimited(): void { this.#limited = true; }
}

export class RepositoryEvidenceService {
  constructor(
    private readonly inspector: RepositoryInspector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A SafeFs whose read limit IS this request's remaining allowance.
   *
   * The shared inspector reads a bounded prefix too, but its bound is the much
   * larger inspection limit - so going through it would pull up to 256 KB into
   * memory and then slice 8 KB out of it. That is the read-then-slice pattern
   * this task is explicitly told to avoid. Setting `maxFileBytes` to the
   * caller's remaining allowance bounds the READ ITSELF through exactly the
   * same Phase 3 code path: same containment, same symlink resolution, same
   * sensitive-path check before a single byte is opened.
   *
   * ---------------------------------------------------------------------------
   * BUILT AT USE, NEVER IN THE CONSTRUCTOR
   * ---------------------------------------------------------------------------
   * `FsBoundary.create` THROWS when the root does not exist, and doing that in
   * the constructor made the whole workflow fail for a project whose working
   * directory is missing - a case the inspector itself handles gracefully by
   * returning a structured failure. Constructing this service must never be
   * able to take down a run, so the boundary is resolved when an excerpt is
   * actually requested and a failure becomes a refusal like any other.
   *
   * Resolving at use is also more honest: a directory can appear or vanish
   * between constructing the service and reading from it.
   */
  private excerptFs(allowanceBytes: number): SafeFs | null {
    try {
      return new SafeFs(
        FsBoundary.create(this.inspector.boundaryRoot),
        // THE READ LIMIT IS THIS REQUEST'S REMAINING ALLOWANCE, not the global
        // per-excerpt cap. Reviewed and corrected: building it once with the
        // 8 KB cap meant that with 512 bytes of budget left the reader still
        // pulled 8 KB off disk and sliced afterwards, which is precisely the
        // read-then-slice pattern this design exists to avoid.
        resolveLimits({ maxFileBytes: allowanceBytes }),
      );
    } catch {
      return null;
    }
  }

  /**
   * Answer a batch of evidence requests.
   *
   * Never throws for a request it will not serve: the caller gets a refusal
   * with a reason, so "we would not read that" can never be mistaken for
   * "there was nothing there".
   */
  async inspect(requests: readonly unknown[]): Promise<TEvidenceOutcome> {
    const items: TEvidenceItem[] = [];
    const refusals: TEvidenceRefusal[] = [];
    const budget = new EvidenceBudget(EVIDENCE_LIMITS.maxTotalEvidenceBytes);
    let excerptBytesUsed = 0;

    /**
     * Refusals are charged too.
     *
     * They are part of the payload, and a batch of fifty long refusal messages
     * is as much data as a batch of fifty items. A refusal that will not fit is
     * dropped, but the budget still records that it happened - `budgetLimited`
     * survives even when nothing else can.
     */
    const refuse = (
      operation: EvidenceOperation,
      code: EvidenceRefusalCode,
      message: string,
      path: string | null = null,
    ): void => {
      if (refusals.length >= EVIDENCE_LIMITS.maxItems) { budget.markLimited(); return; }
      const record = EvidenceRefusal.parse({ operation, code, message, path });
      if (!budget.admit(record)) return;
      refusals.push(record);
    };

    // The batch itself is bounded, before anything is read.
    const batch = requests.slice(0, EVIDENCE_LIMITS.maxRequests);
    if (requests.length > batch.length) {
      refuse(
        "REPOSITORY_METADATA", "item_limit_exceeded",
        `only ${String(EVIDENCE_LIMITS.maxRequests)} requests are served per batch`,
      );
    }

    for (const raw of batch) {
      /**
       * UNKNOWN OPERATIONS FAIL CLOSED.
       *
       * The discriminated union has no fallback member, so a request naming an
       * operation that does not exist - or carrying a field that does not
       * belong to the one it names - is a parse error here rather than
       * something a dispatcher later decides how to handle.
       */
      const parsed = EvidenceRequest.safeParse(raw);
      if (!parsed.success) {
        const named = (raw as { operation?: unknown })?.operation;
        refuse(
          typeof named === "string"
            && (["REPOSITORY_METADATA", "REPOSITORY_STATUS", "CHANGED_FILES",
                 "FILE_METADATA", "FILE_EXCERPT"] as const)
              .includes(named as EvidenceOperation)
            ? (named as EvidenceOperation)
            : "REPOSITORY_METADATA",
          "invalid_request",
          "the request did not match any known evidence operation, or carried a " +
          "field that operation does not accept",
        );
        continue;
      }

      if (items.length >= EVIDENCE_LIMITS.maxItems) {
        refuse(parsed.data.operation, "item_limit_exceeded",
          "the evidence item limit for this batch was reached");
        continue;
      }

      const served = await this.serve(parsed.data, excerptBytesUsed, budget, refuse);
      for (const item of served.items) {
        if (items.length >= EVIDENCE_LIMITS.maxItems) {
          // Reported, never silently dropped.
          refuse(parsed.data.operation, "item_limit_exceeded",
            "the evidence item limit for this batch was reached");
          break;
        }
        /**
         * The item is charged HERE, on admission.
         *
         * `serve` has already reserved space for anything it built
         * incrementally, so in the normal case this succeeds. It is the final
         * gate for anything that did not, and an item that will not fit is
         * refused rather than quietly missing from the result.
         */
        if (!budget.admit(item)) {
          refuse(parsed.data.operation, "evidence_budget_exhausted",
            "the total evidence budget for this batch was reached; further " +
            "evidence exists but was not returned");
          break;
        }
        items.push(item);
      }
      excerptBytesUsed += served.excerptBytes;
    }

    return EvidenceOutcome.parse({
      items,
      refusals,
      excerptBytesUsed,
      evidenceBytesUsed: budget.used,
      budgetLimited: budget.limited,
      collectedAt: this.now().toISOString(),
    });
  }

  private async serve(
    request: TEvidenceRequest,
    excerptBytesUsed: number,
    budget: EvidenceBudget,
    refuse: (
      operation: EvidenceOperation, code: EvidenceRefusalCode,
      message: string, path?: string | null,
    ) => void,
  ): Promise<{ items: TEvidenceItem[]; excerptBytes: number }> {
    switch (request.operation) {
      case "REPOSITORY_METADATA":
      case "REPOSITORY_STATUS":
      case "CHANGED_FILES": {
        const outcome = await this.inspector.inspect();
        if (!outcome.ok) {
          refuse(request.operation, "inspection_failed",
            `the repository could not be inspected (${outcome.failure.code})`);
          return { items: [], excerptBytes: 0 };
        }
        const evidence = outcome.evidence;

        if (request.operation === "REPOSITORY_METADATA") {
          return {
            items: [{
              kind: "REPOSITORY_METADATA",
              isGitRepository: evidence.isGitRepository,
              branch: evidence.branch,
              detachedHead: evidence.detachedHead,
              headCommit: evidence.headCommit,
              repositoryRootWithinBoundary: evidence.repositoryRootWithinBoundary,
              trackedFileCount: evidence.trackedFileCount,
            }],
            excerptBytes: 0,
          };
        }
        if (request.operation === "REPOSITORY_STATUS") {
          return {
            items: [{
              kind: "REPOSITORY_STATUS",
              clean: evidence.clean,
              stagedCount: evidence.stagedFiles.length,
              unstagedCount: evidence.unstagedFiles.length,
              untrackedCount: evidence.untrackedFiles.length,
            }],
            excerptBytes: 0,
          };
        }

        /**
         * PATHS ONLY, SORTED.
         *
         * Never the diff: a diff is content, and content is what every other
         * control in this file exists to bound. Sorted so equivalent repository
         * state produces byte-identical evidence rather than whatever order the
         * inspector happened to return.
         */
        const all = [...evidence.changedFiles].map(normalisePath).sort();

        /**
         * BUILT WITHIN THE BUDGET, one path at a time.
         *
         * A repository with thousands of changed files would otherwise produce
         * a large array that is only then measured and rejected - an unbounded
         * intermediate on the way to discovering it was too big. Paths are
         * admitted while they fit, and the shortfall is reported.
         */
        const kept: string[] = [];
        let overBudget = false;
        for (const candidate of all.slice(0, EVIDENCE_LIMITS.maxChangedFiles)) {
          if (!budget.wouldFit([...kept, candidate])) { overBudget = true; break; }
          kept.push(candidate);
        }
        if (overBudget) {
          budget.markLimited();
          refuse("CHANGED_FILES", "evidence_budget_exhausted",
            `${String(all.length - kept.length)} further changed path(s) exist but ` +
            "did not fit the total evidence budget");
        }
        return {
          items: [{
            kind: "CHANGED_FILES",
            paths: kept,
            truncated: kept.length < all.length,
            totalCount: all.length,
          }],
          excerptBytes: 0,
        };
      }

      case "FILE_METADATA": {
        // Deterministic: sorted and de-duplicated, so the same set of paths in
        // any order produces the same evidence.
        const paths = [...new Set(request.paths.map(normalisePath))].sort();
        /**
         * ONE ITEM PER PATH. An unsafe path is refused individually and the
         * rest are still served - a single bad entry does not silently take
         * the others with it, and nothing is dropped without a refusal.
         */
        const results: TEvidenceItem[] = [];
        for (const path of paths) {
          const rejection = rejectUnsafePath(path);
          if (rejection) {
            refuse("FILE_METADATA", rejection.code, rejection.message, path);
            continue;
          }
          let metadata;
          try {
            metadata = await this.inspector.statPath(path);
          } catch {
            // Thrown by the boundary for a physical escape a lexical check
            // cannot see - a symlink or junction pointing outside.
            refuse("FILE_METADATA", "path_escapes_boundary",
              "the path resolves outside the repository boundary", path);
            continue;
          }
          const item = {
            kind: "FILE_METADATA" as const,
            path,
            exists: metadata !== null,
            fileKind: metadata?.kind ?? null,
            sizeBytes: metadata?.size ?? 0,
            // Reported, never resolved by opening the file.
            sensitive: metadata?.sensitive ?? false,
          };
          // Checked before it joins the batch, so the result set cannot grow
          // past the budget and be trimmed afterwards.
          if (!budget.wouldFit(item)) {
            budget.markLimited();
            refuse("FILE_METADATA", "evidence_budget_exhausted",
              "further file metadata exists but did not fit the total evidence " +
              "budget", path);
            break;
          }
          results.push(item);
        }
        return { items: results, excerptBytes: 0 };
      }

      case "FILE_EXCERPT": {
        const path = normalisePath(request.path);
        const rejection = rejectUnsafePath(path);
        if (rejection) {
          refuse("FILE_EXCERPT", rejection.code, rejection.message, path);
          return { items: [], excerptBytes: 0 };
        }

        /**
         * THE BUDGET IS CHECKED BEFORE THE READ, NOT AFTER.
         *
         * Reading first and discarding afterwards would mean the bytes had
         * already been in memory - and, on a failure path, potentially in a log.
         */
        const allowance = Math.min(
          request.maxBytes,
          EVIDENCE_LIMITS.maxExcerptBytes,
          EVIDENCE_LIMITS.maxTotalExcerptBytes - excerptBytesUsed,
        );
        if (allowance <= 0) {
          refuse("FILE_EXCERPT", "excerpt_budget_exhausted",
            "the excerpt byte budget for this batch was already spent", path);
          return { items: [], excerptBytes: 0 };
        }

        /**
         * The read goes through the inspector, which applies the sensitive-path
         * policy BEFORE opening anything and reads a bounded prefix rather than
         * loading the file. That is Phase 3 code doing Phase 3's job; nothing
         * here re-implements it.
         */
        const excerptFs = this.excerptFs(allowance);
        if (!excerptFs) {
          refuse("FILE_EXCERPT", "inspection_failed",
            "the repository boundary could not be resolved, so no file was read",
            path);
          return { items: [], excerptBytes: 0 };
        }

        let content;
        try {
          content = excerptFs.readTextFile(path);
        } catch {
          refuse("FILE_EXCERPT", "path_escapes_boundary",
            "the path resolves outside the repository boundary", path);
          return { items: [], excerptBytes: 0 };
        }
        if (!content.available) {
          const code: EvidenceRefusalCode =
            content.withheldReason === "sensitive" ? "sensitive_path"
            : content.withheldReason === "binary" ? "binary_content"
            : content.withheldReason === "missing" ? "not_found"
            : content.withheldReason === "not_a_file" ? "not_a_file"
            : "unreadable";
          refuse("FILE_EXCERPT", code,
            `contents withheld (${content.withheldReason ?? "unknown"})`, path);
          return { items: [], excerptBytes: 0 };
        }

        /**
         * BYTE-ACCURATE, not character-accurate.
         *
         * `SafeFs` already bounded the READ to `allowance` BYTES, so nothing
         * larger came off disk. Two things still need doing:
         *
         *   1. A byte-bounded read can cut a multi-byte character in half, and
         *      decoding the remainder yields U+FFFD - which is THREE bytes, so
         *      a naive result can be LARGER than the limit it was enforcing.
         *   2. `String.prototype.slice` and `.length` count UTF-16 units, not
         *      bytes. Slicing to `allowance` characters would let roughly three
         *      times the intended volume through on CJK or emoji text.
         *
         * `truncateToBytes` handles both: it trims to whole characters within
         * the byte ceiling. The trailing replacement character a split sequence
         * may have produced is dropped first, so it cannot be counted as real
         * content or inflate the total.
         */
        const decoded = (content.content ?? "").replace(/\uFFFD+$/, "");
        const text = truncateToBytes(decoded, allowance);
        const textBytes = utf8Bytes(text);

        /**
         * CREDENTIAL-SHAPED CONTENT IS REFUSED, NOT REDACTED.
         *
         * A file may be perfectly readable by the path policy and still have an
         * API key pasted into it. Redacting and forwarding would mean deciding
         * a partially-scrubbed secret is safe to hand onward; refusing does not
         * require that judgement. The value is not echoed into the refusal.
         */
        if (looksLikeSecret(text)) {
          refuse("FILE_EXCERPT", "credential_shaped_content",
            "the excerpt appeared to contain a credential and was refused; its " +
            "value has deliberately not been recorded anywhere", path);
          return { items: [], excerptBytes: 0 };
        }

        return {
          items: [{
            kind: "FILE_EXCERPT",
            path,
            start: 0,
            // UTF-8 BYTES, matching the units every limit is expressed in.
            end: textBytes,
            text,
            // Explicit. A shorter excerpt never silently passes as the whole file.
            truncated: content.truncated || textBytes < utf8Bytes(content.content ?? ""),
            totalBytes: content.bytes,
          }],
          // Charged in BYTES, so the batch budget means what it says.
          excerptBytes: textBytes,
        };
      }
    }
  }
}

/**
 * Lexical path rejection, before the boundary is even consulted.
 *
 * The `FsBoundary` underneath would reject all of these too - this is a second,
 * cheaper gate that also lets the refusal say precisely WHICH rule was broken,
 * which a caller and a human both benefit from. It is not a replacement for the
 * physical check: symlink and junction escapes are still caught by `realpath`
 * inside the boundary, because they cannot be seen lexically at all.
 */
function rejectUnsafePath(
  path: string,
): { code: EvidenceRefusalCode; message: string } | null {
  if (path.length === 0) {
    return { code: "invalid_request", message: "an empty path is not a repository path" };
  }
  if (path.length > EVIDENCE_LIMITS.maxPathLength) {
    return { code: "invalid_request", message: "the path exceeds the maximum length" };
  }
  if (containsTraversal(path)) {
    return { code: "path_traversal", message: "the path contains a traversal segment" };
  }
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    return { code: "path_absolute", message: "only repository-relative paths are served" };
  }
  return null;
}
