import { z } from "zod";

/**
 * CHANGE ATTRIBUTION
 *
 * The question this module answers:
 *
 *   > Of everything currently different in this repository, which parts did
 *   > THIS RUN actually cause?
 *
 * Real repositories are dirty. A developer has uncommitted work in progress
 * when the orchestrator starts, and refusing to inspect a dirty tree would make
 * the system useless on exactly the repositories it exists to serve. So the
 * answer has to come from better evidence, not from a narrower precondition.
 *
 * ---------------------------------------------------------------------------
 * WHY FILENAMES ARE NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The first implementation compared the SET OF PATHS dirty at baseline against
 * the set dirty afterwards, and treated the difference as the run's work. That
 * is wrong in a way that matters:
 *
 *   baseline:  src/auth.ts is already modified   -> in the baseline set
 *   run:       src/auth.ts is modified FURTHER   -> still in the after set
 *   verdict:   "pre-existing", not attributable  -> THE RUN'S WORK VANISHED
 *
 * A file being dirty before and dirty after says nothing about whether it is
 * dirty in the SAME WAY. Attribution therefore compares STATE, not names:
 * content fingerprints, index/worktree status, existence, and commits.
 *
 * ---------------------------------------------------------------------------
 * THE CLASSES
 * ---------------------------------------------------------------------------
 *   pre_existing         dirty at baseline, and byte-identical since. Not ours.
 *   introduced           did not exist at baseline; exists now.
 *   modified_during_run  content or index state changed between the snapshots,
 *                        INCLUDING a file that was already dirty and changed
 *                        further. This is the class the old model lost.
 *   removed              existed at baseline; gone now.
 *   renamed              same content, different path (or git reported R).
 *   restored             was dirty at baseline, now matches HEAD again - the run
 *                        reverted someone's work, which is very much ours.
 *
 * Everything except `pre_existing` is attributable.
 */

export const AttributionKind = z.enum([
  "pre_existing",
  "introduced",
  "modified_during_run",
  "removed",
  "renamed",
  "restored",
]);
export type AttributionKind = z.infer<typeof AttributionKind>;

/** How confidently a change was detected. Drives the honesty of the report. */
export const FingerprintBasis = z.enum([
  /** SHA-256 of the file's bytes. Exact. */
  "content_hash",
  /**
   * Size + mtime + git status code only.
   *
   * Used for SENSITIVE files, whose bytes are never hashed, and for files above
   * `maxFingerprintBytes`. Can over-report (a `touch` looks like a change) and
   * can under-report (a same-size edit within one mtime tick). Over-reporting is
   * the safer failure and is what this biases toward.
   */
  "metadata_only",
  /**
   * Git's own status code decided it.
   *
   * Used when a path was CLEAN at baseline - identical to HEAD, so it has no
   * baseline fingerprint - and git now reports it as changed. That verdict is
   * exact and content-independent, so it must not be labelled `metadata_only`:
   * nothing was inferred from a size or a timestamp, and the caveats that
   * attach to metadata-only attribution do not apply here.
   */
  "git_status",
  /** No baseline fingerprint existed to compare against. */
  "unavailable",
]);
export type FingerprintBasis = z.infer<typeof FingerprintBasis>;

/**
 * A point-in-time identity for one path.
 *
 * NOTE THE SENSITIVE-FILE RULE: `contentHash` is null for a sensitive file, and
 * the fingerprint falls back to metadata. Attribution is never bought by
 * hashing a credential - a digest of a low-entropy secret stored permanently in
 * an audit log is a real disclosure risk, so we simply do not take one.
 */
export const FileFingerprint = z.object({
  path: z.string(),
  present: z.boolean(),
  kind: z.enum(["file", "directory", "symlink", "other", "absent"]),
  size: z.number().int().nonnegative().default(0),
  /** Milliseconds. Used only when a content hash is unavailable. */
  mtimeMs: z.number().nonnegative().default(0),
  /** SHA-256 hex, or null when withheld. */
  contentHash: z.string().nullable().default(null),
  /**
   * Git blob SHA-1 of the CURRENT on-disk content.
   *
   * Kept alongside the SHA-256 for one reason: it is directly comparable with
   * what git itself stores, so a file that vanished can be matched against a
   * file that appeared WITHOUT reading either one's contents out of git. See
   * `headBlobSha`.
   */
  blobSha: z.string().nullable().default(null),
  /**
   * Git blob SHA-1 of this path's content AT HEAD, when it exists there.
   *
   * This is how a rename is recognised after the fact. When a file is deleted,
   * its bytes are gone from disk - but `git rev-parse HEAD:<path>` still yields
   * the blob id, which is an identifier, not content. Matching it against a
   * newly-appeared file's blob id identifies the rename with no content leaving
   * the repository at all.
   */
  headBlobSha: z.string().nullable().default(null),
  basis: FingerprintBasis.default("content_hash"),
  /** Why no hash was taken, when none was. */
  withheldReason: z.string().nullable().default(null),
  /** Two-character git porcelain code at the time of the snapshot, if dirty. */
  statusCode: z.string().nullable().default(null),
  staged: z.boolean().default(false),
  unstaged: z.boolean().default(false),
  untracked: z.boolean().default(false),
  /** Original path when git itself reported a rename (a staged `git mv`). */
  renamedFrom: z.string().nullable().default(null),
});
export type FileFingerprint = z.infer<typeof FileFingerprint>;

export const FileAttribution = z.object({
  path: z.string(),
  kind: AttributionKind,
  /** Set for `renamed`. */
  renamedFrom: z.string().nullable().default(null),
  /** Whether this run is answerable for it. False only for `pre_existing`. */
  attributable: z.boolean(),
  /** How the verdict was reached, in one human-readable clause. */
  evidence: z.string(),
  basis: FingerprintBasis.default("content_hash"),
  /** True when the change is only that the file moved between index and tree. */
  indexStateOnly: z.boolean().default(false),
});
export type FileAttribution = z.infer<typeof FileAttribution>;

export const AttributionSummary = z.object({
  /** Dirty before this run, and untouched by it. */
  preExisting: z.array(z.string()).default([]),
  /** Created by this run. */
  introduced: z.array(z.string()).default([]),
  /** Changed by this run - including files that were ALREADY dirty. */
  modifiedDuringRun: z.array(z.string()).default([]),
  /** Deleted by this run. */
  removed: z.array(z.string()).default([]),
  renamed: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  /** Reverted to HEAD by this run - someone's work was undone. */
  restored: z.array(z.string()).default([]),

  /** Everything this run is answerable for. The input to scope drift. */
  attributable: z.array(z.string()).default([]),
  entries: z.array(FileAttribution).default([]),

  /** False when no baseline existed, so nothing could be attributed precisely. */
  baselineAvailable: z.boolean().default(false),
  /** Paths whose verdict rests on metadata rather than a content hash. */
  metadataOnlyPaths: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type AttributionSummary = z.infer<typeof AttributionSummary>;

const norm = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/^\.\//, "");

/** Did the file's identity change between the two snapshots? */
function changed(
  before: FileFingerprint,
  after: FileFingerprint,
): { changed: boolean; basis: FingerprintBasis; reason: string } {
  // An exact comparison whenever both sides hashed their contents.
  if (before.contentHash !== null && after.contentHash !== null) {
    return before.contentHash === after.contentHash
      ? { changed: false, basis: "content_hash", reason: "content hash unchanged" }
      : { changed: true, basis: "content_hash", reason: "content hash differs" };
  }

  // Sensitive or oversized: metadata only, and say so.
  if (before.size !== after.size) {
    return { changed: true, basis: "metadata_only", reason: "size differs" };
  }
  if (before.mtimeMs !== after.mtimeMs) {
    return { changed: true, basis: "metadata_only", reason: "modification time differs" };
  }
  return { changed: false, basis: "metadata_only", reason: "size and modification time unchanged" };
}

/**
 * Classify every path either snapshot knows about.
 *
 * Pure and deterministic: two fingerprint maps and a list of paths touched by
 * commits go in, a verdict comes out. No filesystem, no git, no model - which
 * is what lets the result be treated as evidence.
 *
 * @param baseline   fingerprints taken BEFORE the implementation phase
 * @param after      fingerprints taken AFTER it, over the union of both sides
 * @param committedPaths paths changed by commits created during the run
 */
export function attributeChanges(
  baseline: readonly FileFingerprint[] | null,
  after: readonly FileFingerprint[],
  committedPaths: readonly string[] = [],
): AttributionSummary {
  const notes: string[] = [];
  const afterMap = new Map(after.map((f) => [norm(f.path), f]));
  const committed = new Set(committedPaths.map(norm));

  // ---- no baseline: we cannot attribute, and must not pretend otherwise ----
  if (!baseline) {
    const entries = [...afterMap.values()]
      .filter((f) => f.present || f.statusCode !== null)
      .map((f) =>
        FileAttribution.parse({
          path: norm(f.path),
          kind: "modified_during_run",
          attributable: true,
          basis: "unavailable",
          evidence: "no baseline snapshot exists; cannot distinguish this run's work",
        }),
      );
    notes.push(
      "no baseline snapshot was captured, so every current change is reported as " +
        "attributable. This OVERSTATES what the run did on a dirty repository.",
    );
    return AttributionSummary.parse({
      modifiedDuringRun: entries.map((e) => e.path).sort(),
      attributable: entries.map((e) => e.path).sort(),
      entries,
      baselineAvailable: false,
      notes,
    });
  }

  const baselineMap = new Map(baseline.map((f) => [norm(f.path), f]));
  const paths = [...new Set([...baselineMap.keys(), ...afterMap.keys(), ...committed])].sort();

  const entries: FileAttribution[] = [];
  const metadataOnly: string[] = [];

  for (const path of paths) {
    const before = baselineMap.get(path);
    const now = afterMap.get(path);

    /**
     * NO BASELINE FINGERPRINT.
     *
     * Only DIRTY paths are fingerprinted at baseline, so an absent entry means
     * the file was CLEAN then - identical to HEAD. That makes the reasoning
     * simple rather than impossible: anything dirty about it now, or any
     * commit touching it, happened during the run.
     */
    if (!before) {
      if (!now) continue;

      // Every verdict below is decided by git itself - existence, or the
      // porcelain status code - never by inferring from size or timestamp. So
      // the basis is `git_status`, and these carry no metadata-only caveat even
      // for a sensitive file whose bytes were never hashed.
      if (!now.present) {
        entries.push(FileAttribution.parse({
          path, kind: "removed", attributable: true, basis: "git_status",
          evidence: "clean at baseline, absent now",
        }));
        continue;
      }
      if (now.untracked) {
        entries.push(FileAttribution.parse({
          path, kind: "introduced", attributable: true, basis: "git_status",
          evidence: "did not exist at baseline",
        }));
        continue;
      }
      if (now.statusCode !== null || committed.has(path)) {
        const added = now.statusCode?.startsWith("A") ?? false;
        entries.push(FileAttribution.parse({
          path, kind: added ? "introduced" : "modified_during_run",
          attributable: true, basis: "git_status",
          evidence: committed.has(path)
            ? "clean at baseline; changed by a commit created during this run"
            : `clean at baseline, git reports ${now.statusCode}`,
        }));
      }
      continue;
    }

    // ---- known at baseline, gone now ---------------------------------------
    if (!now || (before.present && !now.present)) {
      entries.push(FileAttribution.parse({
        path, kind: "removed", attributable: true, basis: "git_status",
        evidence: "present at baseline, absent now",
      }));
      continue;
    }

    // ---- known at baseline as absent, present now --------------------------
    if (!before.present && now.present) {
      entries.push(FileAttribution.parse({
        path, kind: "introduced", attributable: true, basis: "git_status",
        evidence: "absent at baseline, present now",
      }));
      continue;
    }

    const verdict = changed(before, now);
    if (verdict.basis === "metadata_only") metadataOnly.push(path);

    // ---- committed during the run -----------------------------------------
    // Checked BEFORE the clean/dirty comparison: a file the run edited and then
    // committed is clean again, and would otherwise read as "restored".
    if (committed.has(path)) {
      entries.push(FileAttribution.parse({
        path, kind: "modified_during_run", attributable: true, basis: verdict.basis,
        evidence: "changed by a commit created during this run",
      }));
      continue;
    }

    // ---- dirty at baseline, clean now: the run undid someone's work --------
    if (before.statusCode !== null && now.statusCode === null) {
      entries.push(FileAttribution.parse({
        path, kind: "restored", attributable: true, basis: verdict.basis,
        evidence: "modified at baseline, no longer differs from HEAD",
      }));
      continue;
    }

    // ---- content changed ---------------------------------------------------
    if (verdict.changed) {
      // THE CASE THE OLD MODEL LOST: already dirty, and changed again.
      const alreadyDirty = before.statusCode !== null;
      entries.push(FileAttribution.parse({
        path, kind: "modified_during_run", attributable: true,
        basis: verdict.basis,
        evidence: alreadyDirty
          ? `already modified at baseline and changed further (${verdict.reason})`
          : verdict.reason,
      }));
      continue;
    }

    // ---- content identical; did it move between index and worktree? -------
    if (before.statusCode !== now.statusCode) {
      entries.push(FileAttribution.parse({
        path, kind: "modified_during_run", attributable: true,
        basis: verdict.basis, indexStateOnly: true,
        evidence:
          `index/worktree state changed (${before.statusCode ?? "clean"} -> ` +
          `${now.statusCode ?? "clean"}) with identical content`,
      }));
      continue;
    }

    // ---- genuinely untouched by this run ----------------------------------
    if (before.statusCode !== null) {
      entries.push(FileAttribution.parse({
        path, kind: "pre_existing", attributable: false,
        basis: verdict.basis,
        evidence: `dirty before this run and unchanged since (${verdict.reason})`,
      }));
    }
  }

  // ---- rename detection -------------------------------------------------
  // A manual rename shows up as a delete plus an untracked add. Matching
  // content hashes make that recoverable without guessing.
  const removed = entries.filter((e) => e.kind === "removed");
  const introduced = entries.filter((e) => e.kind === "introduced");
  const renamed: { from: string; to: string }[] = [];

  for (const gone of removed) {
    // What the vanished file contained, by identity rather than by content:
    // its SHA-256 if we fingerprinted it at baseline, otherwise the git blob id
    // recorded for its HEAD version. Neither requires reading it back.
    const goneAfter = afterMap.get(gone.path);
    const beforeHash = baselineMap.get(gone.path)?.contentHash ?? null;
    const beforeBlob = goneAfter?.headBlobSha ?? baselineMap.get(gone.path)?.blobSha ?? null;
    if (!beforeHash && !beforeBlob) continue;

    const match = introduced.find((candidate) => {
      if (renamed.some((r) => r.to === candidate.path)) return false;
      const fingerprint = afterMap.get(candidate.path);
      if (!fingerprint) return false;
      if (beforeHash && fingerprint.contentHash === beforeHash) return true;
      return Boolean(beforeBlob) && fingerprint.blobSha === beforeBlob;
    });
    if (!match) continue;
    renamed.push({ from: gone.path, to: match.path });
    gone.kind = "renamed";
    gone.renamedFrom = null;
    match.kind = "renamed";
    match.renamedFrom = gone.path;
    match.evidence = `content identical to "${gone.path}", which no longer exists`;
    gone.evidence = `renamed to "${match.path}"`;
  }

  // Renames git itself reported (a staged `git mv`).
  for (const fingerprint of after) {
    const from = fingerprint.renamedFrom;
    if (!from) continue;
    const to = norm(fingerprint.path);
    if (renamed.some((r) => r.to === to)) continue;
    renamed.push({ from: norm(from), to });
    const entry = entries.find((e) => e.path === to);
    if (entry) {
      entry.kind = "renamed";
      entry.renamedFrom = norm(from);
      entry.evidence = `git reports a rename from "${norm(from)}"`;
    }
  }

  if (metadataOnly.length > 0) {
    notes.push(
      `${metadataOnly.length} path(s) were attributed from metadata rather than a ` +
        "content hash (sensitive or oversized). This can over-report a change.",
    );
  }

  const of = (kind: AttributionKind): string[] =>
    entries.filter((e) => e.kind === kind).map((e) => e.path).sort();

  return AttributionSummary.parse({
    preExisting: of("pre_existing"),
    introduced: of("introduced"),
    modifiedDuringRun: of("modified_during_run"),
    removed: of("removed"),
    restored: of("restored"),
    renamed: renamed.sort((a, b) => a.to.localeCompare(b.to)),
    attributable: entries.filter((e) => e.attributable).map((e) => e.path).sort(),
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    baselineAvailable: true,
    metadataOnlyPaths: metadataOnly.sort(),
    notes,
  });
}
