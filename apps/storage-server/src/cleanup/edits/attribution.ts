/**
 * What the reader's index saw change in Calibre (ttsu.db calibre_field_changes, queued by the
 * ingest per book and field), sorted out after each index (design: "Edits made in Calibre's own
 * program are protected too").
 *
 * A change is a write's (the cleanup's batches, the user's edits, their Undos) when a write of
 * that field — or one that changes it with it: a title write the title sort, an author write
 * the author sort, a series write the number — happened between the book's record the index had
 * and the one it read now (Calibre's last_modified after the write, to the second). Tags copied
 * onto a kept copy by stage 1/3 count for its tags. A case-only change of a name other books
 * share is the edit's that renamed it (Calibre renames a shared name for every book): the field
 * is the user's on those books too, with its own history entry. Anything else was changed in
 * Calibre's own program: a "Changed in Calibre" entry, and the field is the user's.
 *
 * A change of a book in a batch that isn't finished waits for it (the index may have copied
 * metadata.db between Calibre's write and the sidecar's report).
 */
import type Database from 'better-sqlite3';
import { parseCalibreDate } from '../../calibre/ingest';
import { markYours } from './yours';
import type { UserFieldKey } from './fields';

/** The proposal fields whose write also changes an index field. */
const WRITTEN_BY: Record<string, string[]> = {
  title: ['title'],
  sort: ['title', 'sort'],
  authors: ['authors'],
  author_sort: ['authors', 'author_sort'],
  illustrator: ['illustrator'],
  series: ['series'],
  series_index: ['series'],
  publisher: ['publisher'],
  pubdate: ['pubdate'],
  description: ['description'],
  tags: ['tags'],
  identifiers: ['identifiers'],
  rating: ['rating'],
  languages: ['languages'],
  cover: ['cover'],
};

const SHARED_NAMES = new Set(['authors', 'illustrator', 'tags', 'series', 'publisher']);
/** How far back a rename by an edit or a cleanup write is looked for. */
const RECENT_MS = 2 * 24 * 60 * 60 * 1000;

interface QueuedChange {
  id: number;
  library_id: string;
  calibre_uuid: string;
  calibre_id: number;
  book_id: string;
  field: string;
  old_json: string;
  new_json: string;
  last_modified: number | null;
  before_modified: number | null;
  seen_at: number;
}

export interface DrainResult {
  processed: number;
  waiting: number;
  calibre: number;
  renames: number;
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? (v as string[]) : typeof v === 'string' && v !== '' ? [v] : [];

/**
 * The renames from `old` to `now` when every difference is one of case only (as Calibre renames
 * a shared name); null otherwise.
 */
export function caseOnlyRenames(
  oldV: unknown,
  newV: unknown,
): { from: string; to: string }[] | null {
  const a = asList(oldV);
  const b = asList(newV);
  if (a.length !== b.length || a.length === 0) return null;
  const out: { from: string; to: string }[] = [];
  const pool = [...a];
  for (const to of b) {
    const exact = pool.indexOf(to);
    if (exact >= 0) {
      pool.splice(exact, 1);
      continue;
    }
    const i = pool.findIndex((x) => x.toLowerCase() === to.toLowerCase());
    if (i < 0) return null;
    out.push({ from: pool[i], to });
    pool.splice(i, 1);
  }
  return out.length ? out : null;
}

export class ChangeAttribution {
  constructor(private readonly deps: { cleanup: Database.Database; main: Database.Database }) {}

  private get db() {
    return this.deps.cleanup;
  }

  /** Whether any queued change waits. */
  pending(): boolean {
    return (
      this.deps.main.prepare('SELECT 1 FROM calibre_field_changes LIMIT 1').get() !== undefined
    );
  }

  private openBatchFor(libraryId: string, uuid: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM proposed_changes p INDEXED BY proposed_changes_book
           JOIN batches b ON b.id = p.batch_id
           WHERE p.library_id = ? AND p.calibre_uuid = ? AND b.state IN ('planned', 'claimed')
           LIMIT 1`,
        )
        .get(libraryId, uuid) !== undefined ||
      this.db
        .prepare(
          `SELECT 1 FROM undo_records u JOIN batches b ON b.id = u.batch_id
           WHERE u.library_id = ? AND u.kept_uuid = ? AND b.state IN ('planned', 'claimed') LIMIT 1`,
        )
        .get(libraryId, uuid) !== undefined
    );
  }

  /** A write of the field (or one that changes it with it) in the index's window. */
  private byWrite(c: QueuedChange): boolean {
    const fields = WRITTEN_BY[c.field] ?? [c.field];
    const lo = c.before_modified === null ? Number.NEGATIVE_INFINITY : c.before_modified - 1000;
    const hi = (c.last_modified ?? Number.POSITIVE_INFINITY) + 1000;
    const rows = this.db
      .prepare(
        `SELECT last_modified_after, restored_last_modified FROM field_undo
         WHERE library_id = ? AND calibre_uuid = ? AND field IN (${fields.map(() => '?').join(', ')})`,
      )
      .all(c.library_id, c.calibre_uuid, ...fields) as {
      last_modified_after: string | null;
      restored_last_modified: string | null;
    }[];
    const inWindow = (t: number | null) => t !== null && t > lo && t <= hi;
    for (const r of rows) {
      if (inWindow(parseCalibreDate(r.last_modified_after))) return true;
      if (inWindow(parseCalibreDate(r.restored_last_modified))) return true;
    }
    if (c.field === 'tags') {
      // Stage 1/3 copy the user's own tags of a removed copy onto the kept one (and Undo takes
      // them off again): no Calibre time is kept for those, so the server's time is used.
      const copied = this.db
        .prepare(
          `SELECT 1 FROM undo_records WHERE library_id = ? AND kept_uuid = ?
             AND (created_at > ? OR restored_at > ?) LIMIT 1`,
        )
        .get(c.library_id, c.calibre_uuid, c.seen_at - RECENT_MS, c.seen_at - RECENT_MS);
      if (copied) return true;
    }
    return false;
  }

  /**
   * A case-only rename of a shared name: the edit that renamed it (or a cleanup write that did),
   * looked for among the recent writes.
   */
  private byRename(
    c: QueuedChange,
  ): { kind: 'edit'; changeId: number; title: string } | { kind: 'cleanup' } | null {
    if (!SHARED_NAMES.has(c.field)) return null;
    const renames = caseOnlyRenames(JSON.parse(c.old_json), JSON.parse(c.new_json));
    if (!renames) return null;
    const since = c.seen_at - RECENT_MS;
    const edits = this.db
      .prepare(
        `SELECT id, json_extract(evidence_json, '$.renames') AS renames,
                json_extract(evidence_json, '$.title') AS title
         FROM proposed_changes INDEXED BY proposed_changes_stage
         WHERE stage = 10 AND state = 'applied' AND updated_at > ?
           AND json_extract(evidence_json, '$.renames') IS NOT NULL`,
      )
      .all(since) as { id: number; renames: string; title: string | null }[];
    for (const e of edits) {
      const list = JSON.parse(e.renames) as { field: string; from: string; to: string }[];
      if (
        renames.every((r) =>
          list.some(
            (x) =>
              x.field === c.field && x.to === r.to && x.from.toLowerCase() === r.from.toLowerCase(),
          ),
        )
      )
        return { kind: 'edit', changeId: e.id, title: e.title ?? '' };
    }
    const batches = this.db
      .prepare(
        `SELECT id FROM batches WHERE finished_at > ? AND kind = 'apply' AND stage IN (2, 4, 5)`,
      )
      .all(since) as { id: string }[];
    const field = c.field === 'series' ? 'series' : c.field;
    for (const b of batches) {
      for (const r of renames) {
        const hit = this.db
          .prepare(
            `SELECT 1 FROM field_undo WHERE batch_id = ? AND field = ? AND instr(new_json, ?) > 0 LIMIT 1`,
          )
          .get(b.id, field, JSON.stringify(r.to).slice(1, -1));
        if (hit) return { kind: 'cleanup' };
      }
    }
    return null;
  }

  /**
   * Sorts out up to `limit` queued changes (one cleanup.db transaction per call; the caller
   * yields between calls). Waiting rows stay queued.
   */
  drain(limit = 500, now = Date.now()): DrainResult {
    const result: DrainResult = { processed: 0, waiting: 0, calibre: 0, renames: 0 };
    const rows = this.deps.main
      .prepare('SELECT * FROM calibre_field_changes ORDER BY id LIMIT ?')
      .all(limit * 4) as QueuedChange[];
    const done: number[] = [];
    const insert = this.db.prepare(
      `INSERT INTO calibre_seen_changes (library_id, calibre_uuid, calibre_id, field, old_json,
         new_json, kind, cause_change_id, cause_title, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const waits = new Map<string, boolean>();
    this.db.transaction(() => {
      for (const c of rows) {
        if (done.length >= limit) break;
        const key = `${c.library_id}|${c.calibre_uuid}`;
        let wait = waits.get(key);
        if (wait === undefined) {
          wait = this.openBatchFor(c.library_id, c.calibre_uuid);
          waits.set(key, wait);
        }
        if (wait) {
          result.waiting++;
          continue;
        }
        done.push(c.id);
        result.processed++;
        if (this.byWrite(c)) continue;
        const rename = this.byRename(c);
        if (rename?.kind === 'cleanup') continue;
        const ref = { libraryId: c.library_id, uuid: c.calibre_uuid };
        const value = c.field === 'cover' ? true : (JSON.parse(c.new_json) as unknown);
        if (rename?.kind === 'edit') {
          insert.run(
            c.library_id,
            c.calibre_uuid,
            c.calibre_id,
            c.field,
            c.old_json,
            c.new_json,
            'shared_rename',
            rename.changeId,
            rename.title,
            now,
          );
          markYours(this.db, ref, c.field as UserFieldKey, value, 'shared_rename', null, now);
          result.renames++;
          continue;
        }
        insert.run(
          c.library_id,
          c.calibre_uuid,
          c.calibre_id,
          c.field,
          c.old_json,
          c.new_json,
          'calibre',
          null,
          null,
          now,
        );
        markYours(this.db, ref, c.field as UserFieldKey, value, 'calibre', null, now);
        result.calibre++;
      }
    })();
    if (done.length > 0) {
      const del = this.deps.main.prepare('DELETE FROM calibre_field_changes WHERE id = ?');
      this.deps.main.transaction(() => {
        for (const id of done) del.run(id);
      })();
    }
    return result;
  }
}
