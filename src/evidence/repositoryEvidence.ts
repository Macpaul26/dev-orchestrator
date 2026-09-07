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

export class RepositoryEvidenceService {
  constructor(
    private readonly inspector: RepositoryInspector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A SafeFs whose read limit IS the excerpt limit.
   *
   * The shared inspector reads a bounded prefix too, but its bound is the much
   * larger inspection limit - so going through it would pull up to 256 KB into
   * memory and then slice 8 KB out of it. That is the read-then-slice pattern
   * this task is explicitly told to avoid. Setting `maxFileBytes` to the
   * excerpt cap bounds the READ ITSELF at 8 KB through exactly the same Phase 3
   * code path: same containment, same symlink resolution, same sensitive-path
   * check before a single byte is opened.
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
  private excerptFs(): SafeFs | null {
    try {
      return new SafeFs(
        FsBoundary.create(this.inspector.boundaryRoot),
        resolveLimits({ maxFileBytes: EVIDENCE_LIMITS.maxExcerptBytes }),
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
    let excerptBytesUsed = 0;

    const refuse = (
      operation: EvidenceOperation,
      code: EvidenceRefusalCode,
      message: string,
      path: string | null = null,
    ): void => {
      if (refusals.length >= EVIDENCE_LIMITS.maxItems) return;
      refusals.push(EvidenceRefusal.parse({ operation, code, message, path }));
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

      const served = await this.serve(parsed.data, excerptBytesUsed, refuse);
      for (const item of served.items) {
        if (items.length >= EVIDENCE_LIMITS.maxItems) {
          // Reported, never silently dropped.
          refuse(parsed.data.operation, "item_limit_exceeded",
            "the evidence item limit for this batch was reached");
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
      collectedAt: this.now().toISOString(),
    });
  }

  private async serve(
    request: TEvidenceRequest,
    excerptBytesUsed: number,
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
        const kept = all.slice(0, EVIDENCE_LIMITS.maxChangedFiles);
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
          results.push({
            kind: "FILE_METADATA",
            path,
            exists: metadata !== null,
            fileKind: metadata?.kind ?? null,
            sizeBytes: metadata?.size ?? 0,
            // Reported, never resolved by opening the file.
            sensitive: metadata?.sensitive ?? false,
          });
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
        const excerptFs = this.excerptFs();
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

        // Already bounded at the READ by the tight SafeFs limit; this only
        // applies a smaller caller-requested allowance on top.
        const text = (content.content ?? "").slice(0, allowance);

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
            end: text.length,
            text,
            // Explicit. A shorter excerpt never silently passes as the whole file.
            truncated: content.truncated || text.length < (content.content ?? "").length,
            totalBytes: content.bytes,
          }],
          excerptBytes: text.length,
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
