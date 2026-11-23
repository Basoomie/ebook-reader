/**
 * Stages 1, 2 and 3 on a new-arrivals run's books (WP20g): the stages' own functions on the run's
 * scope, their proposals under the run's analysis id (`arrivals:<run>`, so the stages' own On
 * never writes them and only the arrivals' On plans them through the stages' own batch planners).
 *
 *   stage 1  the new books' EPUBs stated and hashed into file_facts as stage 1's stat and hash
 *            steps do, with every library file of the same size; each set of identical files that
 *            holds a new book gets stage 1's keep rule (chooseKeeper) and its removals.
 *   stage 2  each new book read (Stage2Analysis.readBook) and proposed with stage 2's rules
 *            (proposalsFor), the library's spelling lookup, its never-again rules.
 *   stage 3  a removal from the content check (compare.ts): the copy stage 3 doesn't keep, with
 *            the evidence the check before a batch reads (both files' SHA-256, size, mtime).
 *
 * The user's rule for the arrivals (2026-11-17): a new copy better than a library book that has
 * reader data is never put in its place automatically: it goes to review instead.
 */
import type Database from 'better-sqlite3';
import { resolveInside, statFile } from '../../calibre/source-fs';
import { booksWithReaderData, findCalibreSource } from '../handoff';
import { getSettings, isCustomTag } from '../settings';
import { chooseKeeper, hashSourceFile, Pacer, type SnapshotBook } from '../stage1';
import type { Stage2Analysis } from '../stage2';
import { spellingLookup } from '../stage2-snapshot';

export interface PassDeps {
  cleanup: Database.Database;
  main: Database.Database;
  libraryId: string;
  libDir: string;
  /** The run's analysis id (arrivals:<run>). */
  analysisId: string;
  /**
   * Copies the fields that are the user's on a copy about to be removed onto the copy that
   * stays (calibre metadata editing); returns the edit's batch, or null when there is none.
   */
  carry?: (fromUuid: string, toUuid: string) => string | null;
}

/** Whether a Calibre book's reader book holds reader data (handoff.ts' test). */
export function hasReaderData(deps: PassDeps, uuid: string): boolean {
  const rb = findCalibreSource(deps.main, deps.libraryId, uuid)?.bookId;
  return rb ? booksWithReaderData(deps.main, [rb]).has(rb) : false;
}

/** stat of books' EPUBs into file_facts (stage 1's statStep): the SHA-256 kept when unchanged. */
export async function statBooks(deps: PassDeps, books: SnapshotBook[]): Promise<void> {
  const get = deps.cleanup.prepare(
    'SELECT file_path, size, mtime_ms, sha256 FROM file_facts WHERE library_id = ? AND calibre_id = ?',
  );
  const put = deps.cleanup.prepare(
    `INSERT INTO file_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms,
       calibre_last_modified, sha256, stat_at, hashed_at, error)
     VALUES (@lib, @id, @uuid, @path, @size, @mtime, @lm, @sha, @now, @hashedAt, @error)
     ON CONFLICT(library_id, calibre_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid,
       file_path = excluded.file_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
       calibre_last_modified = excluded.calibre_last_modified, sha256 = excluded.sha256,
       stat_at = excluded.stat_at, hashed_at = excluded.hashed_at, error = excluded.error`,
  );
  for (const book of books) {
    const now = Date.now();
    let size: number | null = null;
    let mtime: number | null = null;
    let error: string | null = null;
    try {
      const st = await statFile(resolveInside(deps.libDir, book.filePath));
      if (st) {
        size = st.size;
        mtime = st.mtimeMs;
      } else error = 'file_missing';
    } catch (err) {
      error = `stat: ${(err as Error).message}`;
    }
    const old = get.get(deps.libraryId, book.calibreId) as
      | { file_path: string; size: number | null; mtime_ms: number | null; sha256: string | null }
      | undefined;
    const unchanged =
      old && old.file_path === book.filePath && old.size === size && old.mtime_ms === mtime;
    put.run({
      lib: deps.libraryId,
      id: book.calibreId,
      uuid: book.uuid,
      path: book.filePath,
      size,
      mtime,
      lm: book.lastModified,
      sha: unchanged ? old.sha256 : null,
      now,
      hashedAt: unchanged && old.sha256 ? now : null,
      error,
    });
  }
}

/**
 * The SHA-256 of the library's EPUBs of this size (hashed now when unknown, as stage 1's hash
 * step does: stat before and after, a file that changed meanwhile left out). Read only.
 */
export async function libraryHashesOfSize(
  deps: PassDeps,
  books: Map<number, SnapshotBook>,
  size: number,
  pacer: Pacer,
  shouldStop: () => boolean,
): Promise<{ calibreId: number; sha256: string }[]> {
  const rows = deps.cleanup
    .prepare(
      `SELECT calibre_id, file_path, size, mtime_ms, sha256 FROM file_facts
       WHERE library_id = ? AND size = ? AND error IS NULL`,
    )
    .all(deps.libraryId, size) as {
    calibre_id: number;
    file_path: string;
    size: number;
    mtime_ms: number;
    sha256: string | null;
  }[];
  const setHash = deps.cleanup.prepare(
    'UPDATE file_facts SET sha256 = ?, hashed_at = ?, error = ? WHERE library_id = ? AND calibre_id = ?',
  );
  const out: { calibreId: number; sha256: string }[] = [];
  for (const r of rows) {
    if (!books.has(r.calibre_id)) continue;
    if (r.sha256) {
      out.push({ calibreId: r.calibre_id, sha256: r.sha256 });
      continue;
    }
    if (shouldStop()) break;
    const file = resolveInside(deps.libDir, r.file_path);
    const before = await statFile(file);
    if (!before || before.size !== r.size || before.mtimeMs !== r.mtime_ms) {
      setHash.run(null, null, 'changed', deps.libraryId, r.calibre_id);
      continue;
    }
    const h = await hashSourceFile(file, pacer, shouldStop);
    if (!h) break;
    const after = await statFile(file);
    if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      setHash.run(null, null, 'changed', deps.libraryId, r.calibre_id);
      continue;
    }
    setHash.run(h.sha256, Date.now(), null, deps.libraryId, r.calibre_id);
    out.push({ calibreId: r.calibre_id, sha256: h.sha256 });
  }
  return out;
}

export interface PassReview {
  kind: 'better_copy';
  /** The new book (Calibre id) and the library book it would replace. */
  newId: number;
  newUuid: string;
  libraryId: number;
  libraryUuid: string;
  stage: 1 | 3;
  detail: Record<string, unknown>;
}

/**
 * Stage 1 on the run's books: their files and the library's of the same sizes hashed, and each
 * set of identical files holding a new book given stage 1's keep rule. Returns the proposals made
 * and the review items (a new copy kept over a library book that has reader data).
 */
export async function stage1Pass(
  deps: PassDeps,
  scope: SnapshotBook[],
  books: Map<number, SnapshotBook>,
  shouldStop: () => boolean,
): Promise<{ proposals: number; reviews: PassReview[] }> {
  const settings = getSettings(deps.cleanup);
  const pacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
  await statBooks(deps, scope);
  const facts = deps.cleanup.prepare(
    'SELECT size, sha256, error FROM file_facts WHERE library_id = ? AND calibre_id = ?',
  );
  const sets = new Map<string, { size: number; copies: SnapshotBook[] }>();
  for (const b of scope) {
    const f = facts.get(deps.libraryId, b.calibreId) as
      | { size: number | null; sha256: string | null; error: string | null }
      | undefined;
    if (!f || f.error || f.size === null) continue;
    const same = await libraryHashesOfSize(deps, books, f.size, pacer, shouldStop);
    const mine = same.find((x) => x.calibreId === b.calibreId);
    if (!mine) continue;
    const copies = same
      .filter((x) => x.sha256 === mine.sha256)
      .map((x) => books.get(x.calibreId)!)
      .filter(Boolean);
    if (copies.length > 1) sets.set(mine.sha256, { size: f.size, copies });
  }
  const active = new Set(
    (
      deps.cleanup
        .prepare(
          `SELECT calibre_uuid AS uuid FROM proposed_changes
           WHERE stage = 1 AND library_id = ? AND state IN ('queued', 'applied', 'undone', 'kept')
           UNION SELECT restored_uuid AS uuid FROM undo_records
           WHERE library_id = ? AND restored_uuid IS NOT NULL`,
        )
        .all(deps.libraryId, deps.libraryId) as { uuid: string }[]
    ).map((r) => r.uuid),
  );
  const scopeIds = new Set(scope.map((b) => b.calibreId));
  const insert = deps.cleanup.prepare(
    `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
       new_json, source, evidence_json, class, state, analysis_id, created_at, updated_at)
     VALUES (1, @lib, @id, @uuid, 'book', '"present"', '"removed"', 'stage1:sha256', @evidence,
       'auto', 'proposed', @analysis, @now, @now)`,
  );
  const reviews: PassReview[] = [];
  let proposals = 0;
  const now = Date.now();
  deps.cleanup.transaction(() => {
    deps.cleanup
      .prepare(
        `DELETE FROM proposed_changes WHERE stage = 1 AND library_id = ? AND analysis_id = ?
           AND state = 'proposed' AND id NOT IN (SELECT change_id FROM batch_items)`,
      )
      .run(deps.libraryId, deps.analysisId);
    for (const [sha256, { size, copies }] of sets) {
      const { keep, rule } = chooseKeeper(copies, settings.customTags);
      const keptHasData = hasReaderData(deps, keep.uuid);
      for (const copy of copies) {
        if (copy === keep || active.has(copy.uuid)) continue;
        const removedHasData = hasReaderData(deps, copy.uuid);
        // The arrivals' rule: a new copy never takes the place of a library book with reader data.
        if (!scopeIds.has(copy.calibreId) && scopeIds.has(keep.calibreId) && removedHasData) {
          reviews.push({
            kind: 'better_copy',
            newId: keep.calibreId,
            newUuid: keep.uuid,
            libraryId: copy.calibreId,
            libraryUuid: copy.uuid,
            stage: 1,
            detail: { sha256, rule, reason: 'Identical files; the new copy has more of your tags' },
          });
          continue;
        }
        const extra = copy.formats.filter((f) => !keep.formats.includes(f));
        insert.run({
          lib: deps.libraryId,
          id: copy.calibreId,
          uuid: copy.uuid,
          analysis: deps.analysisId,
          now,
          evidence: JSON.stringify({
            sha256,
            size,
            setSize: copies.length,
            rule,
            title: copy.title,
            arrival: true,
            kept: {
              calibreId: keep.calibreId,
              uuid: keep.uuid,
              title: keep.title,
              tags: keep.tags,
              formats: keep.formats,
              addedAt: keep.timestamp,
              lastModified: keep.lastModified,
              readerData: keptHasData,
            },
            removed: {
              calibreId: copy.calibreId,
              uuid: copy.uuid,
              title: copy.title,
              tags: copy.tags,
              customTags: copy.tags.filter((t) => isCustomTag(t, settings.customTags)),
              formats: copy.formats,
              extraFormats: extra,
              addedAt: copy.timestamp,
              lastModified: copy.lastModified,
              filePath: copy.filePath,
              readerData: removedHasData,
            },
          }),
        });
        proposals++;
      }
    }
  })();
  return { proposals, reviews };
}

/** A stage-3 removal (content duplicate) of one copy in favour of another, under the run's id. */
export function proposeStage3Removal(
  deps: PassDeps,
  removed: SnapshotBook & { sha256: string; size: number; mtimeMs: number },
  kept: SnapshotBook & { sha256: string; size: number; mtimeMs: number },
  pair: Record<string, unknown>,
): void {
  const settings = getSettings(deps.cleanup);
  const now = Date.now();
  // The user's fields of the copy that goes are written onto the copy that stays first (the
  // removal waits for that write: planRemovals).
  let carriedBatch: string | null = null;
  let carryError: string | null = null;
  try {
    carriedBatch = deps.carry?.(removed.uuid, kept.uuid) ?? null;
  } catch (err) {
    carryError = `Your edited fields couldn't be copied onto the new copy: ${(err as Error).message}`;
  }
  deps.cleanup
    .prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (3, ?, ?, ?, 'book', '"present"', '"removed"', 'stage3:text', ?, ?, ?, 'proposed', ?, ?, ?)`,
    )
    .run(
      deps.libraryId,
      removed.calibreId,
      removed.uuid,
      JSON.stringify({
        sha256: removed.sha256,
        title: removed.title,
        arrival: true,
        pair,
        ...(carriedBatch ? { carriedBatch } : {}),
        kept: {
          calibreId: kept.calibreId,
          uuid: kept.uuid,
          title: kept.title,
          tags: kept.tags,
          formats: kept.formats,
          addedAt: kept.timestamp,
          lastModified: kept.lastModified,
          sha256: kept.sha256,
          size: kept.size,
          mtimeMs: kept.mtimeMs,
          readerData: hasReaderData(deps, kept.uuid),
        },
        removed: {
          calibreId: removed.calibreId,
          uuid: removed.uuid,
          title: removed.title,
          tags: removed.tags,
          customTags: removed.tags.filter((t) => isCustomTag(t, settings.customTags)),
          formats: removed.formats,
          extraFormats: removed.formats.filter((f) => !kept.formats.includes(f)),
          addedAt: removed.timestamp,
          lastModified: removed.lastModified,
          filePath: removed.filePath,
          size: removed.size,
          mtimeMs: removed.mtimeMs,
          readerData: hasReaderData(deps, removed.uuid),
        },
      }),
      carryError ? 'review' : 'auto',
      carryError,
      deps.analysisId,
      now,
      now,
    );
}

/**
 * Stage 2 on the run's books: each read (or its evidence reused) and proposed with stage 2's own
 * rules and never-again rules. Returns how many fields were proposed.
 */
export async function stage2Pass(
  deps: PassDeps,
  analysis: Stage2Analysis,
  uuids: string[],
  shouldStop: () => boolean,
): Promise<number> {
  const db = deps.cleanup;
  // The library now (books added in this run), not the analysis' snapshot from before them.
  const snap = analysis.currentSnapshot(deps.libraryId);
  const settings = getSettings(db);
  const spelling = spellingLookup(snap.names);
  const byUuid = new Map([...snap.books.values()].map((b) => [b.uuid, b]));
  const done = new Set(
    (
      db
        .prepare(
          `SELECT calibre_uuid || '|' || field AS k FROM proposed_changes WHERE stage = 2 AND library_id = ?
           AND (state IN ('queued', 'applied', 'undone', 'kept')
                OR (state = 'proposed' AND decided_by IS NOT NULL))`,
        )
        .all(deps.libraryId) as { k: string }[]
    ).map((r) => r.k),
  );
  const leaving = new Set(
    (
      db
        .prepare(
          `SELECT calibre_uuid FROM proposed_changes WHERE stage IN (1, 3) AND library_id = ?
           AND state IN ('proposed', 'queued') AND class = 'auto'
           AND (analysis_id = ? OR state = 'queued')`,
        )
        .all(deps.libraryId, deps.analysisId) as { calibre_uuid: string }[]
    ).map((r) => r.calibre_uuid),
  );
  const insert = db.prepare(
    `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
       source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
     VALUES (2, @lib, @id, @uuid, @field, @old, @new, @source, @evidence, @class, @reason, 'proposed',
       @analysis, @now, @now)`,
  );
  const del = db.prepare(
    `DELETE FROM proposed_changes INDEXED BY proposed_changes_book
     WHERE library_id = ? AND calibre_uuid = ? AND stage = 2 AND analysis_id = ? AND state = 'proposed'
       AND decided_by IS NULL AND id NOT IN (SELECT change_id FROM batch_items)`,
  );
  let n = 0;
  for (const uuid of uuids) {
    if (shouldStop()) break;
    const book = byUuid.get(uuid);
    if (!book?.filePath || leaving.has(uuid)) continue;
    const { ev } = await analysis.readBook(deps.libDir, deps.libraryId, book);
    if (!ev?.file) continue;
    const now = Date.now();
    db.transaction(() => {
      del.run(deps.libraryId, uuid, deps.analysisId);
      for (const prop of analysis.proposalsFor(book, ev, settings, spelling)) {
        if (done.has(`${uuid}|${prop.field}`)) continue;
        insert.run({
          lib: deps.libraryId,
          id: book.calibreId,
          uuid,
          field: prop.field,
          old: JSON.stringify(prop.old ?? null),
          new: JSON.stringify(prop.new ?? null),
          source: prop.source,
          evidence: JSON.stringify({
            title: book.title,
            authors: book.authors,
            group: prop.group,
            reason: prop.reason,
            extra: prop.extra ?? null,
            ...(prop.fit ? { fit: prop.fit } : {}),
            lastModified: book.lastModified,
            arrival: true,
            epub: { path: ev.path, size: ev.size, mtimeMs: ev.mtimeMs },
            cover:
              prop.field === 'cover' && ev.file?.cover
                ? {
                    entry: ev.file.cover.entry,
                    sha256: ev.file.cover.sha256,
                    hadCover: book.hasCover,
                  }
                : undefined,
          }),
          class: prop.class,
          reason: prop.reason,
          analysis: deps.analysisId,
          now,
        });
        n++;
      }
    })();
  }
  return n;
}
