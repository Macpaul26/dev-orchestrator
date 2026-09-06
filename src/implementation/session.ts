import type { SafeFs } from "../security/safeFs.js";
import type { SafeWriteFs} from "../security/writeBoundary.js";
import { WriteRefused } from "../security/writeBoundary.js";
import type { ActivityJournal } from "../activity/journal.js";
import { newCorrelationId } from "../activity/journal.js";
import {
  type ImplementationGrant, GrantDenied,
  assertGrantUsable, assertCapability, assertInScope,
} from "../domain/grant.js";
import type { Capability } from "../domain/capability.js";
import type { DenialReason } from "../domain/denial.js";
import type { FileContent, DirectoryListing } from "../domain/repository.js";
import { classifySensitivity } from "../security/sensitive.js";

/**
 * THE IMPLEMENTATION SESSION
 *
 * Everything an implementation agent can reach. The security model is that this
 * object IS the agent's entire world:
 *
 *   - no filesystem handle, no path to the project root, no `fs`
 *   - no shell, no `spawn`, no command of any kind
 *   - no git
 *   - no network
 *   - no environment variables
 *   - no access to the grant object it operates under
 *
 * An agent cannot widen its own permissions because there is nothing here to
 * widen. `grantId` is exposed as a string for correlation; the grant itself is
 * private, so an agent cannot read `allowedScope`, let alone assign to it.
 * A `Object.freeze`d capability list is exposed for introspection only.
 *
 * ---------------------------------------------------------------------------
 * EVERY OPERATION FOLLOWS THE SAME ORDER
 * ---------------------------------------------------------------------------
 *   1. is the run cancelled?          -> refuse
 *   2. is the grant still usable?     -> revalidated EVERY time, not once
 *   3. does it carry this capability? -> and is that capability implemented?
 *   4. is the path in the approved scope?
 *   5. is the budget exhausted?
 *   6. record the attempt
 *   7. perform it through the boundary (which re-resolves the path itself)
 *   8. record the outcome
 *
 * Steps 2-5 are the orchestrator's decision and are journalled by the
 * orchestrator. A denial is recorded whether or not the agent ever mentions it.
 */

export interface WriteResult {
  ok: boolean;
  path: string;
  bytes: number;
  created: boolean;
  atomic: boolean;
  /** Set when `ok` is false. Structured, never free-form. */
  denial: string | null;
  detail: string | null;
}

/**
 * Cooperative cancellation, checked before every capability use.
 *
 * Cooperative is enough for an in-process agent: it cannot write without asking,
 * and the flag is checked on every ask. It is NOT enough for a CHILD PROCESS,
 * which keeps running whether or not anyone polls a boolean - so listeners exist
 * for holders that must take real action, like sending a signal.
 *
 * Listeners are best-effort and cannot veto cancellation: a listener that throws
 * is ignored, because a badly-written one must not be able to keep a run alive.
 */
export class CancellationToken {
  private cancelled = false;
  private reason: string | null = null;
  private readonly listeners = new Set<(reason: string) => void>();

  cancel(reason = "cancelled"): void {
    if (this.cancelled) return; // idempotent; listeners fire exactly once
    this.cancelled = true;
    this.reason = reason;
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        // A listener cannot prevent cancellation.
      }
    }
  }

  /**
   * Run `listener` when cancellation happens - or immediately, if it already
   * has. The immediate call closes the race where a holder subscribes just
   * after cancellation and would otherwise never hear about it.
   *
   * @returns an unsubscribe function.
   */
  onCancel(listener: (reason: string) => void): () => void {
    if (this.cancelled) {
      try {
        listener(this.reason ?? "cancelled");
      } catch {
        // As above.
      }
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
  get cancellationReason(): string | null {
    return this.reason;
  }
}

export class ImplementationCancelled extends Error {
  constructor(reason: string) {
    super(`Implementation cancelled: ${reason}`);
    this.name = "ImplementationCancelled";
  }
}

/** Counters the ORCHESTRATOR maintains. The agent cannot touch them. */
export interface SessionCounters {
  writes: number;
  deletes: number;
  denials: number;
}

export class ImplementationSession {
  /**
   * NATIVE PRIVATE FIELDS - `#`, not TypeScript's `private`.
   *
   * This distinction is the difference between a compile-time convention and an
   * actual boundary. TypeScript's `private` vanishes at runtime: the property is
   * an ordinary own property, and untrusted code reaches it with
   * `(session as any).writer`. That is not a hypothetical - it was true of the
   * first version of this class, and the escalation test caught it.
   *
   * What was reachable mattered:
   *
   *   #writer   SafeWriteFs performs writes WITHOUT any grant, capability or
   *             scope check. Reaching it is a complete scope bypass - the
   *             project boundary would still hold, and nothing else would.
   *   #grant    a mutable object; pushing to `allowedScope` or `capabilities`
   *             would widen the very thing being enforced.
   *   #journal  the audit trail, which the audited party could then append to.
   *
   * `#` fields are enforced by the language itself. There is no cast, no
   * `Object.keys`, no `JSON.stringify` and no property access that reveals them.
   */
  readonly #grant: ImplementationGrant;
  readonly #reader: SafeFs;
  readonly #writer: SafeWriteFs;
  readonly #journal: ActivityJournal;
  readonly #cancellation: CancellationToken;
  readonly #clock: () => Date;
  readonly #counters: SessionCounters = { writes: 0, deletes: 0, denials: 0 };

  constructor(
    grant: ImplementationGrant,
    reader: SafeFs,
    writer: SafeWriteFs,
    journal: ActivityJournal,
    cancellation: CancellationToken,
    clock: () => Date = () => new Date(),
  ) {
    // Frozen as well as private: a caller that already holds a reference to the
    // same grant object cannot widen it underneath us either.
    this.#grant = deepFreezeGrant(grant);
    this.#reader = reader;
    this.#writer = writer;
    this.#journal = journal;
    this.#cancellation = cancellation;
    this.#clock = clock;
  }

  /** For correlation only. The grant object itself is never exposed. */
  get grantId(): string {
    return this.#grant.grantId;
  }
  get runId(): string {
    return this.#grant.runId;
  }
  get projectId(): string {
    return this.#grant.projectId;
  }
  /** Introspection only - a frozen copy, assigning to it changes nothing. */
  get capabilities(): readonly Capability[] {
    return Object.freeze([...this.#grant.capabilities]);
  }
  /** A frozen copy, for an agent that wants to know where it may work. */
  get allowedScope(): readonly string[] {
    return Object.freeze([...this.#grant.allowedScope]);
  }
  /** Orchestrator-maintained totals. A copy, so the agent cannot rewrite them. */
  get stats(): SessionCounters {
    return { ...this.#counters };
  }

  // ---- read -------------------------------------------------------------

  async readFile(relativePath: string): Promise<FileContent> {
    this.authorise("repo.read", relativePath, "session.readFile");
    return this.#reader.readTextFile(relativePath);
  }

  async listDirectory(relativePath = "."): Promise<DirectoryListing> {
    // Listing is metadata, so it is not scope-restricted: an agent may look
    // around the project it was pointed at. Contents still require repo.read,
    // and the sensitive-file policy still withholds what it covers.
    this.requireLive();
    this.requireCapability("repo.metadata.read", relativePath, "session.listDirectory");
    return this.#reader.listDirectory(relativePath);
  }

  // ---- write ------------------------------------------------------------

  async writeFile(relativePath: string, contents: string): Promise<WriteResult> {
    const correlationId = newCorrelationId();
    const bytes = Buffer.byteLength(contents, "utf8");

    try {
      this.authorise("repo.file.write", relativePath, "session.writeFile", correlationId);

      if (this.#counters.writes + this.#counters.deletes >= this.#grant.maxWrites) {
        throw new GrantDenied(
          "write_budget_exhausted",
          `Grant ${this.#grant.grantId} permits at most ${this.#grant.maxWrites} mutations.`,
        );
      }
      if (bytes > this.#grant.maxWriteBytes) {
        throw new GrantDenied(
          "file_too_large",
          `Grant ${this.#grant.grantId} permits at most ${this.#grant.maxWriteBytes} bytes per file.`,
        );
      }

      // Metadata only: the byte count, never the bytes.
      const sensitive = classifySensitivity(relativePath).sensitive;
      this.record({
        type: "write_attempted", correlationId, path: relativePath,
        byteCount: bytes, contentHash: null, sensitive,
      });

      const outcome = this.#writer.writeFile(relativePath, contents);
      this.#counters.writes += 1;

      this.record({
        type: "write_completed", correlationId, path: outcome.path,
        byteCount: outcome.bytes,
        // A hash identifies the payload without disclosing it - and is omitted
        // entirely for a sensitive path, where even a digest is a risk.
        contentHash: sensitive ? null : outcome.contentHash,
        sensitive,
        created: outcome.created, atomic: outcome.atomic,
      });

      return {
        ok: true, path: outcome.path, bytes: outcome.bytes,
        created: outcome.created, atomic: outcome.atomic, denial: null, detail: null,
      };
    } catch (error) {
      return this.denyWrite(relativePath, bytes, correlationId, error);
    }
  }

  async deleteFile(relativePath: string): Promise<WriteResult> {
    const correlationId = newCorrelationId();
    try {
      this.authorise("repo.file.delete", relativePath, "session.deleteFile", correlationId);

      if (this.#counters.writes + this.#counters.deletes >= this.#grant.maxWrites) {
        throw new GrantDenied(
          "write_budget_exhausted",
          `Grant ${this.#grant.grantId} permits at most ${this.#grant.maxWrites} mutations.`,
        );
      }

      this.record({ type: "delete_attempted", correlationId, path: relativePath });
      const outcome = this.#writer.deleteFile(relativePath);
      this.#counters.deletes += 1;
      this.record({ type: "delete_completed", correlationId, path: outcome.path });

      return {
        ok: true, path: outcome.path, bytes: 0, created: false, atomic: true,
        denial: null, detail: null,
      };
    } catch (error) {
      const { reason, detail } = describe(error);
      this.#counters.denials += 1;
      this.record({
        type: "delete_denied", correlationId, path: relativePath, reason, detail,
      });
      if (error instanceof ImplementationCancelled) throw error;
      return { ok: false, path: relativePath, bytes: 0, created: false, atomic: false, denial: reason, detail };
    }
  }

  // ---- internals ---------------------------------------------------------

  private denyWrite(
    relativePath: string, bytes: number, correlationId: string, error: unknown,
  ): WriteResult {
    const { reason, detail } = describe(error);
    this.#counters.denials += 1;
    this.record({ type: "write_denied", correlationId, path: relativePath, reason, detail });
    if (error instanceof ImplementationCancelled) throw error;
    return { ok: false, path: relativePath, bytes, created: false, atomic: false, denial: reason, detail };
  }

  private requireLive(): void {
    if (this.#cancellation.isCancelled) {
      throw new ImplementationCancelled(this.#cancellation.cancellationReason ?? "cancelled");
    }
  }

  /** The full check. Revalidates the grant EVERY time it is called. */
  private authorise(
    capability: Capability,
    relativePath: string,
    tool: string,
    correlationId = newCorrelationId(),
  ): void {
    this.requireLive();
    this.requireCapability(capability, relativePath, tool, correlationId);
    try {
      assertInScope(this.#grant, relativePath);
    } catch (error) {
      this.recordDenial(capability, relativePath, correlationId, error);
      throw error;
    }
    this.record({ type: "capability_granted", correlationId, capability, path: relativePath });
  }

  private requireCapability(
    capability: Capability,
    relativePath: string | null,
    tool: string,
    correlationId = newCorrelationId(),
  ): void {
    this.record({ type: "tool_invoked", correlationId, tool, capability, path: relativePath });
    try {
      // Expiry is re-checked here, so a long run cannot outlive its grant.
      assertGrantUsable(this.#grant, {
        projectId: this.#grant.projectId,
        runId: this.#grant.runId,
        now: this.#clock(),
      });
      assertCapability(this.#grant, capability);
    } catch (error) {
      this.recordDenial(capability, relativePath, correlationId, error);
      throw error;
    }
  }

  private recordDenial(
    capability: Capability, relativePath: string | null, correlationId: string, error: unknown,
  ): void {
    const { reason, detail } = describe(error);
    this.record({
      type: "capability_denied", correlationId, capability, path: relativePath, reason, detail,
    });
  }

  /** Fills in the fields every record shares. */
  private record(partial: Record<string, unknown>): void {
    this.#journal.append({
      runId: this.#grant.runId,
      projectId: this.#grant.projectId,
      grantId: this.#grant.grantId,
      at: this.#clock().toISOString(),
      ...partial,
    } as never);
  }
}

/**
 * Freeze a grant and the arrays inside it.
 *
 * `Object.freeze` is shallow, and the two fields worth attacking - `allowedScope`
 * and `capabilities` - are arrays, so freezing only the top level would leave
 * `grant.allowedScope.push("/")` working.
 */
function deepFreezeGrant(grant: ImplementationGrant): ImplementationGrant {
  Object.freeze(grant.allowedScope);
  Object.freeze(grant.capabilities);
  return Object.freeze(grant);
}

/**
 * Turn an error into a structured reason plus a SHORT detail.
 *
 * Deliberately narrow: only messages this codebase produced are passed through.
 * An unexpected error contributes its NAME and nothing else, so a stack trace,
 * a file buffer, or an environment dump can never reach the journal.
 */
function describe(error: unknown): { reason: DenialReason; detail: string } {
  if (error instanceof GrantDenied) return { reason: error.reason, detail: error.message };
  if (error instanceof WriteRefused) return { reason: error.code, detail: error.message };
  if (error instanceof ImplementationCancelled) {
    return { reason: "cancelled", detail: "the run was cancelled" };
  }
  // Anything unexpected contributes its NAME and nothing else. A message could
  // carry a path, a buffer or an environment value; a name cannot.
  return {
    reason: "internal_error",
    detail: `refused (${error instanceof Error ? error.name : "unknown error"})`,
  };
}
