import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EpisodicExperience,
  type EpisodicExperience as TEpisodicExperience,
} from "../domain/experience.js";
import {
  StoredExperience, ExperienceListing, ExperienceWriteFailure, ExperienceDefect,
  StorageProjectId, ExperienceId, EXPERIENCE_STORAGE_LIMITS,
  type StoredExperience as TStoredExperience,
  type ExperienceListing as TExperienceListing,
  type ExperienceWriteFailure as TExperienceWriteFailure,
  type ExperienceDefect as TExperienceDefect,
  type ExperienceDefectCode,
  type ExperienceRecordCount as TExperienceRecordCount,
} from "../domain/experienceStorage.js";
import { resolveWithin, orchestratorHome } from "../persistence/paths.js";
import { ProjectQuota, scanDirectoryBounded } from "./projectQuota.js";

/**
 * THE EXPERIENCE STORE
 *
 * Bounded, project-isolated, tamper-evident persistence for episodic
 * experience. Task 009 is THIS AND NOTHING ELSE: a trustworthy place for
 * historical records to survive a restart without becoming authority.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * No retrieval by relevance, no ranking, no embeddings, no cross-project
 * anything, no confidence evaluation, no lesson generation, and no path into a
 * reasoning prompt. Those are Tasks 010 to 014, and each is separately scoped
 * because each can go wrong in a different way.
 *
 * There is no `getAllExperience()` and no `searchAcrossProjects()`. Every
 * operation takes a project id and cannot see past it - a test asserts that
 * no method exists which does not.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS REACHABLE BY A MODEL
 * ---------------------------------------------------------------------------
 * No tool, no capability, no bridge operation, no protocol message. An
 * implementation agent cannot decide what becomes historical memory, because
 * there is nothing for it to call. A test walks `src/models/`,
 * `src/reasoning/` and `src/tools/` and asserts none of them import this file.
 */

/** Storage metadata that must NEVER contribute to a record's identity. */
const IDENTITY_EXCLUDED = ["integrity", "id", "persistedAt"] as const;

/**
 * The stable identity of one experience.
 *
 * A SHA-256 over the record's own fields in a FIXED ORDER - not
 * `JSON.stringify` of the object, whose key order depends on how the object
 * happened to be built. The same logical experience therefore lands on the same
 * id on any machine, and persisting it twice overwrites rather than
 * accumulating a near-duplicate.
 *
 * Storage metadata is excluded on purpose: including `integrity.computedAt`
 * would make identity depend on WHEN it was written, and the same experience
 * saved twice would become two records. See `IDENTITY_EXCLUDED`.
 */
export function experienceId(record: TEpisodicExperience): string {
  const canonical = JSON.stringify([
    record.scope,
    record.layer,
    record.projectId,
    record.runId,
    record.taskType,
    record.planSummary,
    record.implementationOutcome,
    record.verificationOutcome,
    record.reviewOutcome,
    record.failures,
    record.corrections,
    record.successfulPatterns,
    record.failedPatterns,
    record.evidence.map((e) => [e.source, e.ref]),
    record.sources,
    record.status,
    record.createdAt,
  ]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

/**
 * The canonical serialization the integrity digest covers.
 *
 * Same fixed-order rule, for the same reason: a digest computed over
 * `JSON.stringify(record)` would change when nothing about the record did.
 */
function canonicalRecord(record: TEpisodicExperience): string {
  return JSON.stringify([
    experienceId(record),
    record.scope, record.layer, record.projectId, record.runId, record.taskType,
    record.planSummary, record.implementationOutcome,
    record.verificationOutcome, record.reviewOutcome,
    record.failures, record.corrections,
    record.successfulPatterns, record.failedPatterns,
    record.evidence.map((e) => [e.source, e.ref]),
    record.sources, record.status, record.createdAt,
  ]);
}

function digestOf(record: TEpisodicExperience): string {
  return crypto.createHash("sha256").update(canonicalRecord(record), "utf8").digest("hex");
}

/**
 * Filenames carry the timestamp AND the id.
 *
 * The reason is bounded listing. Ordering by `createdAt` would otherwise mean
 * opening and parsing every record in the project just to sort them, and then
 * discarding all but the first page - exactly the read-everything-then-slice
 * pattern the storage budget exists to prevent. With the timestamp in the name,
 * a directory read is enough to order and page, and only the records on the
 * chosen page are ever opened.
 *
 * `:` and `.` are stripped because they are not portable in filenames.
 */
function fileNameFor(record: TEpisodicExperience, id: string): string {
  const stamp = record.createdAt.replace(/[:.]/g, "").replace(/-/g, "");
  return `${stamp}-${id}.json`;
}

/**
 * Split a filename back into its ordering key and id. Null if malformed.
 *
 * `String.match` rather than the RegExp method deliberately. The spawn-site
 * inventory in tests/gitHardening.test.ts scans for process-execution tokens to
 * keep spawning confined to three enumerated files, and the RegExp method
 * shares its name with one of them - a false positive. Narrowing that guard to
 * admit this would blunt a real security check for a cosmetic reason, so the
 * code moves instead.
 *
 * The first version of this comment NAMED the token and tripped the same guard,
 * which is a fair demonstration that the scan is blunt but awake.
 */
function parseFileName(name: string): { stamp: string; id: string } | null {
  const match = name.match(/^(\d{8}T\d{9}Z)-([0-9a-f]{32})\.json$/);
  if (!match) return null;
  return { stamp: match[1]!, id: match[2]! };
}

/** Suffix every in-flight write uses. Never matches the record name shape. */
const TEMPORARY_SUFFIX = ".tmp";

const isRecordName = (name: string): boolean => parseFileName(name) !== null;
const isTemporaryName = (name: string): boolean => name.endsWith(TEMPORARY_SUFFIX);

export type ExperienceWriteResult =
  | { ok: true; stored: TStoredExperience; id: string }
  | { ok: false; failure: TExperienceWriteFailure };

/**
 * `missing` and `indeterminate` are different answers and never share a shape.
 *
 * `missing` asserts absence: the whole project directory was examined and the
 * record is not in it. `indeterminate` asserts nothing: the directory is larger
 * than `maxDirectoryEntries`, the scan stopped, and the record may well exist
 * past the cutoff. Collapsing the second into the first would be the store
 * claiming to have looked everywhere when it had not.
 */
export type ExperienceReadResult =
  | { ok: true; stored: TStoredExperience }
  | { ok: false; defect: TExperienceDefect }
  | { ok: false; missing: true }
  | { ok: false; indeterminate: true };

export class ExperienceStore {
  /**
   * Root of the experience store, separate from the project store and from the
   * LangGraph checkpoint database.
   *
   * Deliberately its own tree: workflow checkpoint state and learning memory
   * have different lifetimes, different contents and different rules, and
   * putting them together is how a checkpoint dump ends up being read back as
   * experience.
   */
  constructor(readonly root: string = path.join(orchestratorHome(), "experience")) {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * PRIVATE AT RUNTIME, not merely to the compiler.
   *
   * TypeScript's `private` is erased at build time - the method stays on the
   * prototype and any caller can reach it. Phase 4A found that the hard way
   * when an unchecked writer turned out to be reachable through a `private`
   * field. `#` members do not exist outside the class at all, so the store's
   * runtime surface really is write/read/list, and a test asserts exactly that.
   *
   * The directory for one project.
   *
   * TWO independent gates: the id must match the kebab-case shape, which makes
   * traversal, absolute paths, drive letters, UNC prefixes and separators
   * unrepresentable rather than filtered; and the result must still resolve
   * inside the root. Neither is redundant - the first rejects the input, the
   * second rejects the outcome.
   */
  #projectDir(projectId: string): string | null {
    if (!StorageProjectId.safeParse(projectId).success) return null;
    try {
      return resolveWithin(this.root, projectId);
    } catch {
      return null;
    }
  }

  /**
   * Persist one episodic experience.
   *
   * Fails closed on every problem: an invalid project id, a record that does
   * not validate, one over the size ceiling, or a project that has reached its
   * quota. A failed write NEVER becomes a successful piece of learning.
   */
  write(projectId: string, candidate: unknown): ExperienceWriteResult {
    const fail = (
      code: TExperienceWriteFailure["code"], message: string,
    ): ExperienceWriteResult => ({
      ok: false, failure: ExperienceWriteFailure.parse({ code, message }),
    });

    const dir = this.#projectDir(projectId);
    if (!dir) {
      return fail("invalid_project_id",
        "the project id is not a valid kebab-case identifier");
    }

    /**
     * Validated at runtime, not trusted because TypeScript said so.
     *
     * `EpisodicExperience` is `.strict()`, so a record carrying an authority
     * field, a raw payload field, or a caller-asserted confidence is rejected
     * here - the store does not get to be the place those slip through.
     */
    const parsed = EpisodicExperience.safeParse(candidate);
    if (!parsed.success) {
      return fail("invalid_record",
        "the record did not validate against the episodic experience schema");
    }
    const record = parsed.data;

    // The record must belong to the project it is being filed under. A
    // mismatch is a caller bug or an isolation attack; either way, refuse.
    if (record.projectId !== projectId) {
      return fail("invalid_record",
        "the record's projectId does not match the project it is being stored in");
    }

    const id = experienceId(record);
    const stored = StoredExperience.parse({
      id,
      record,
      integrity: {
        algorithm: "sha256",
        digest: digestOf(record),
        computedAt: new Date().toISOString(),
      },
    });

    const serialized = `${JSON.stringify(stored, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > EXPERIENCE_STORAGE_LIMITS.maxRecordBytes) {
      return fail("oversized",
        `the serialized record is ${String(bytes)} bytes, over the ` +
        `${String(EXPERIENCE_STORAGE_LIMITS.maxRecordBytes)}-byte ceiling`);
    }

    const fileName = fileNameFor(record, id);
    const file = path.join(dir, fileName);

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // The message names no path: a storage error should not leak the layout.
      return fail("storage_failure", "the record could not be written to storage");
    }

    /**
     * THE QUOTA IS A HARD BOUND, AND THIS IS WHERE THAT IS MADE TRUE.
     *
     * The count, the "is this record new?" decision and the publish all happen
     * inside one cross-process lock, so two writers cannot both see the last
     * free slot. The store hands the gate a filename and two predicates and
     * nothing else - it never sees the record - which is why the accounting
     * cannot leak anything even in an error path.
     *
     * See ProjectQuota for why the count is derived from the records on every
     * write rather than cached in a counter file.
     */
    const decision = new ProjectQuota(dir).reserveAndPublish({
      fileName,
      isRecordName,
      isTemporaryName,
      publish: () => { this.#writeAtomic(file, serialized); },
      unpublish: () => { fs.rmSync(file, { force: true }); },
    });

    if (!decision.ok) {
      switch (decision.reason) {
        case "quota_exceeded":
          return fail("project_quota_exceeded",
            `the project holds ${String(decision.records)} records, at the ceiling of ` +
            `${String(EXPERIENCE_STORAGE_LIMITS.maxRecordsPerProject)}`);
        case "indeterminate":
          return fail("quota_indeterminate",
            "the project's record count could not be established within the " +
            "directory scan bound, so the write cannot be proved to stay under " +
            "the ceiling");
        case "busy":
          return fail("storage_busy",
            "another writer holds this project's write lock; nothing was written");
        default:
          return fail("storage_failure", "the record could not be written to storage");
      }
    }

    return { ok: true, stored, id };
  }

  /**
   * Write to a temporary file, flush it, then rename into place.
   *
   * ---------------------------------------------------------------------------
   * WHAT THIS ACTUALLY GUARANTEES
   * ---------------------------------------------------------------------------
   * ATOMIC VISIBILITY, on both POSIX and Windows: `rename` within a directory
   * replaces the entry in one step, so a concurrent reader sees either the
   * previous complete record or the new complete one - never a half-serialized
   * object that happens to parse. This is the property the store relies on and
   * the one it is entitled to claim.
   *
   * DURABILITY OF THE FILE'S CONTENTS, via `fsync` on the data before the
   * rename. Without it the rename could be durable while the bytes it points at
   * were not.
   *
   * ---------------------------------------------------------------------------
   * WHAT IT DOES NOT GUARANTEE - CORRECTED AFTER REVIEW
   * ---------------------------------------------------------------------------
   * The first version of this comment said the `fsync` made the write survive
   * "a power loss rather than only a crash". That was more than the code did.
   * Flushing the file does not flush the DIRECTORY ENTRY that makes the new name
   * visible, so on a POSIX filesystem a power cut just after the rename could
   * leave the data on disk under no name at all.
   *
   * The directory flush below closes that on POSIX. On Windows it cannot: a
   * directory cannot be opened for `fsync` this way, the call fails, and the
   * failure is swallowed deliberately. So on Windows the durability of the
   * rename itself is whatever the filesystem provides, and this code does not
   * improve it and does not claim to.
   *
   * There is no claim here of guaranteed durability across all power-loss
   * scenarios on every OS. Network filesystems, virtualised disks and drives
   * that lie about their write caches all defeat it, and none of them is
   * detectable from here.
   *
   * On failure the temporary file is removed and the previous record is left
   * untouched: a botched write must not destroy the valid record it was
   * replacing.
   */
  #writeAtomic(file: string, contents: string): void {
    const temporary =
      `${file}.${String(process.pid)}.${crypto.randomUUID()}${TEMPORARY_SUFFIX}`;
    let handle: number | null = null;
    try {
      handle = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(handle, contents, "utf8");
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(temporary, file);
    } catch (error) {
      if (handle !== null) { try { fs.closeSync(handle); } catch { /* closing */ } }
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }

    // Best effort, and only meaningful where the platform supports it. A
    // failure here means the rename is no less durable than the filesystem
    // makes it - not that the record was lost, which is why it does not fail
    // the write.
    let directory: number | null = null;
    try {
      directory = fs.openSync(path.dirname(file), "r");
      fs.fsyncSync(directory);
    } catch { /* Windows, and some filesystems, cannot flush a directory */ } finally {
      if (directory !== null) { try { fs.closeSync(directory); } catch { /* closing */ } }
    }
  }

  /**
   * Read one record by id, within one project.
   *
   * Returns a defect rather than a record when the file is unparseable, fails
   * the schema, fails its digest, or disagrees with its own filename. Corrupt
   * history must never be handed back as though it were experience.
   *
   * The filename carries the record's timestamp as well as its id, so finding a
   * record by id alone means scanning. The scan is bounded, which means absence
   * cannot always be established: when the bound stops the scan before the
   * record is found, the answer is `indeterminate`, not `missing`. Reporting
   * "not there" after looking at part of a directory would be a claim the store
   * has not earned. No lock is taken - `rename` gives readers a consistent view
   * without one, and serialising reads behind writes would buy nothing.
   */
  read(projectId: string, id: string): ExperienceReadResult {
    const dir = this.#projectDir(projectId);
    if (!dir || !ExperienceId.safeParse(id).success) {
      return { ok: false, defect: defect(id, "identity_mismatch",
        "the project id or experience id is not a valid identifier") };
    }

    let scan;
    try {
      scan = scanDirectoryBounded(dir);
    } catch {
      return { ok: false, defect: defect(id, "unreadable",
        "the project's history could not be read") };
    }

    const match = scan.names.find((name) => parseFileName(name)?.id === id);
    if (!match) {
      return scan.complete
        ? { ok: false, missing: true }
        : { ok: false, indeterminate: true };
    }

    const loaded = this.#load(dir, match, projectId);
    if ("defect" in loaded) return { ok: false, defect: loaded.defect };
    return { ok: true, stored: loaded.stored };
  }

  /**
   * List one project's experience, newest first.
   *
   * ---------------------------------------------------------------------------
   * ORDERING
   * ---------------------------------------------------------------------------
   *   createdAt DESC, then experienceId ASC
   *
   * Both parts come from the FILENAME, so the order is decided before any file
   * is opened and does not depend on `readdir` order, which is a property of
   * the filesystem rather than of the data. The id tiebreak matters: records
   * written inside the same millisecond would otherwise have no defined order,
   * and two runs of the same query could disagree.
   *
   * ---------------------------------------------------------------------------
   * BOUNDED
   * ---------------------------------------------------------------------------
   * Only the records on the returned page are opened. A project with a hundred
   * thousand records costs one directory read and at most `maxListResults`
   * file reads - never a parse of the whole corpus followed by a slice.
   *
   * ---------------------------------------------------------------------------
   * THE COUNT SAYS WHAT IT KNOWS
   * ---------------------------------------------------------------------------
   * The directory scan stops at `maxDirectoryEntries`. When it does, the page
   * holds the newest of what was SCANNED rather than the newest in the project,
   * and `count` comes back as `bounded` with a lower bound instead of an exact
   * total. See `ExperienceRecordCount` for why that is a different shape rather
   * than a smaller number.
   */
  list(
    projectId: string,
    options: { limit?: number; after?: string } = {},
  ): TExperienceListing {
    const empty = ExperienceListing.parse({
      records: [], defects: [], count: { kind: "exact", records: 0 },
    });
    const dir = this.#projectDir(projectId);
    if (!dir) return empty;

    let scan;
    try {
      scan = scanDirectoryBounded(dir);
    } catch {
      return empty;
    }

    const entries = scan.names
      .map((name) => ({ name, parsed: parseFileName(name) }))
      .filter((e): e is { name: string; parsed: { stamp: string; id: string } } =>
        e.parsed !== null);

    /**
     * PLAIN OPERATORS, NOT LOCALE-SENSITIVE COLLATION - CORRECTED WITH TASK 010.
     *
     * This sort used the locale-aware collation method, whose answer depends on
     * the host locale and the runtime's ICU data. Two machines could therefore
     * page the same project in different orders.
     *
     * It also disagreed with the cursor filter just below, which compares with
     * `<` and `>`. A sort and a cursor that order the same strings by different
     * rules is how paging silently skips or repeats records - a defect
     * introduced by Task 010's cursor, and so corrected by Task 010.
     *
     * The stamp is a fixed-width ASCII timestamp and the id is lower-case hex,
     * so code-unit order IS the intended order and nothing is lost.
     */
    entries.sort((a, b) => {
      if (a.parsed.stamp !== b.parsed.stamp) {
        return a.parsed.stamp < b.parsed.stamp ? 1 : -1;  // newest first
      }
      if (a.parsed.id !== b.parsed.id) {
        return a.parsed.id < b.parsed.id ? -1 : 1;        // stable tiebreak
      }
      return 0;
    });

    /**
     * ADDED FOR TASK 010, AND THE ONLY TASK 009 BEHAVIOUR IT TOUCHES.
     *
     * A cursor into the SAME total order the page already used. Without it, the
     * retrieval layer could only ever see the newest `maxListResults` records of
     * a project that may hold five thousand - so retrieval would be one page of
     * storage under another name, which is exactly what it must not be. The
     * alternatives were worse: a new unbounded store method, or a retrieval
     * layer reading the filesystem itself.
     *
     * Purely additive. `list(projectId)` with no cursor behaves exactly as
     * before, the ordering is unchanged, and nothing here relaxes a bound.
     *
     * The cursor is a FILENAME from this same directory, so it is opaque to
     * callers and meaningful only against this ordering. A malformed one returns
     * an empty listing rather than silently starting from the beginning: paging
     * from the wrong place would quietly re-examine or skip records.
     */
    let ordered = entries;
    if (options.after !== undefined) {
      const cursor = parseFileName(options.after);
      if (cursor === null) return empty;
      ordered = entries.filter((entry) =>
        entry.parsed.stamp < cursor.stamp
        || (entry.parsed.stamp === cursor.stamp && entry.parsed.id > cursor.id));
    }

    const limit = Math.min(
      options.limit ?? EXPERIENCE_STORAGE_LIMITS.maxListResults,
      EXPERIENCE_STORAGE_LIMITS.maxListResults,
    );

    const records: TStoredExperience[] = [];
    const defects: TExperienceDefect[] = [];
    let bytesReturned = 0;
    // An incomplete scan is itself a bound that stopped this listing returning
    // more, so it counts as truncation even when the page is not full.
    let truncated = ordered.length > limit || !scan.complete;

    /**
     * The last entry this page CONSUMED, defect or record alike.
     *
     * Deliberately not "the last record returned": a page made entirely of
     * corrupt files would then hand back a cursor that had not moved, and a
     * caller paging on it would read the same entries forever. Advancing past
     * everything examined is what makes paging terminate.
     */
    let consumed: string | null = null;

    for (const entry of ordered) {
      if (records.length >= limit) break;
      const loaded = this.#load(dir, entry.name, projectId);
      if ("defect" in loaded) {
        // Reported, never returned, and never allowed to abort the page: one
        // bad file must not hide the good records around it.
        if (defects.length < EXPERIENCE_STORAGE_LIMITS.maxListResults) {
          defects.push(loaded.defect);
        }
        consumed = entry.name;
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(loaded.stored), "utf8");
      if (bytesReturned + size > EXPERIENCE_STORAGE_LIMITS.maxListBytes) {
        truncated = true;
        break;
      }
      records.push(loaded.stored);
      bytesReturned += size;
      consumed = entry.name;
    }

    const count: TExperienceRecordCount = scan.complete
      ? { kind: "exact", records: ordered.length }
      : { kind: "bounded", atLeast: ordered.length };

    /**
     * Null means "this page reached the end of the order", which is the only
     * thing that lets a caller claim it saw everything. A page stopped by a
     * bound returns where to resume, never null.
     */
    const exhausted = consumed !== null
      && ordered.length > 0
      && ordered[ordered.length - 1]!.name === consumed;

    return ExperienceListing.parse({
      records, defects, truncated, count, bytesReturned,
      nextCursor: exhausted || consumed === null ? null : consumed,
    });
  }

  /**
   * Load and validate one file. The single place a defect is decided.
   *
   * The order of checks is deliberate: size before parse, parse before schema,
   * schema before digest, digest before identity. Each step is cheaper than the
   * next and each rules out a class of problem the next would misdiagnose.
   */
  #load(
    dir: string, fileName: string, projectId: string,
  ): { stored: TStoredExperience } | { defect: TExperienceDefect } {
    const named = parseFileName(fileName);
    const id = named?.id ?? fileName;
    const file = path.join(dir, fileName);

    let raw: string;
    try {
      const size = fs.statSync(file).size;
      if (size > EXPERIENCE_STORAGE_LIMITS.maxRecordBytes) {
        return { defect: defect(id, "oversized",
          "the stored record is larger than the per-record ceiling") };
      }
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { defect: defect(id, "unreadable", "the record could not be read") };
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { defect: defect(id, "unreadable",
        "the record is not parseable JSON - it may be truncated or corrupt") };
    }

    if (value === null || typeof value !== "object" || !("integrity" in value)) {
      return { defect: defect(id, "integrity_missing",
        "the record carries no integrity metadata") };
    }

    const parsed = StoredExperience.safeParse(value);
    if (!parsed.success) {
      return { defect: defect(id, "schema_invalid",
        "the record did not validate against the stored experience schema") };
    }
    const stored = parsed.data;

    // Recomputed, never trusted from the file. See IntegrityMetadata for what
    // this does and does not establish.
    if (digestOf(stored.record) !== stored.integrity.digest) {
      return { defect: defect(id, "integrity_mismatch",
        "the record does not match the digest stored beside it") };
    }

    // Filename, stored id and recomputed id must all agree. A renamed or
    // relocated file is a tampering signal, not a record that moved.
    if (named === null || stored.id !== named.id || experienceId(stored.record) !== stored.id) {
      return { defect: defect(id, "identity_mismatch",
        "the filename, the stored id and the record's derived id disagree") };
    }

    /**
     * PROJECT ISOLATION, ENFORCED ON READ AS WELL AS WRITE.
     *
     * A record whose own `projectId` disagrees with the directory it sits in is
     * refused, so a file copied or linked into the wrong project cannot be read
     * back as that project's history.
     */
    if (stored.record.projectId !== projectId) {
      return { defect: defect(id, "project_mismatch",
        "the record belongs to a different project than the one it is filed under") };
    }

    return { stored };
  }
}

function defect(
  id: string, code: ExperienceDefectCode, detail: string,
): TExperienceDefect {
  return ExperienceDefect.parse({ id: id.slice(0, 200), code, detail });
}

export { IDENTITY_EXCLUDED };
