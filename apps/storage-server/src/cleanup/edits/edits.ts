/**
 * Calibre metadata editing from the reader (tier 3 item 2; design calibre-metadata-editing.md).
 *
 * A save is a batch of its own stage (EDIT_STAGE) on the cleanup's field-write path: one row in
 * proposed_changes per changed field (old = the value the form showed, new = the user's), one
 * batch per save (a series save: one batch, one item per book and field). The apply sidecar
 * writes it ahead of every queued cleanup batch and between the chunks of a running one; every
 * write is checked against what Calibre shows afterwards (stage2-batches.ts) and recorded with
 * the value Calibre had (field_undo).
 *
 * Every field the user saves or confirms is theirs from that moment (user_fields): no cleanup
 * pass proposes or writes it again (cleanup.db v29's triggers, the planner and the sidecar's
 * verify). A field that isn't written after all (refused, changed meanwhile) stops being theirs
 * again, unless it was theirs before.
 */
import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { BatchService } from '../batches';
import { EDIT_SIDECAR_VERSION, EDIT_STAGE } from '../field-stages';
import { parseCalibreDate } from '../../calibre/ingest';
import { getIndexState } from '../../calibre/libraries';
import { bookOfUuid, bookRef, catalogValues, seriesBooks, type BookRef } from './catalog';
import { decidePair, librarySeries, notSameAs, seriesPairsOf, type SeriesPair } from './series';
import {
  EDIT_FIELDS,
  EditError,
  type EditField,
  type EditValues,
  normalizeValue,
  refuseLongNames,
  sameValue,
  userKeysOf,
  type UserFieldKey,
} from './fields';
import { markYours, setAiYours, yoursOf } from './yours';
import { bookHistory, editFieldOf, undoTarget, type HistoryEntry } from './history';
import { samePicture, type ArchivedCover, type CoverArchive } from './cover-archive';
import { imageFacts } from '../file-metadata';
import { getSettings } from '../settings';
import { hammingHex } from '../stage2-rules';

export type EditSource = 'edit' | 'undo' | 'carried' | 'confirm';

/** A case-only rename of a name other books share (Calibre renames it for all of them). */
export interface SharedRename {
  field: 'authors' | 'illustrator' | 'publisher' | 'series' | 'tags';
  from: string;
  to: string;
  /** Other present books with that name. */
  books: number;
}

export interface SaveInput {
  /** The values the form showed (what Calibre should still have). */
  base?: Partial<Record<EditField, unknown>>;
  /** The user's values (only the fields they changed need to be sent). */
  values?: Partial<Record<EditField, unknown>>;
  /** A picture saved first with storeCover. */
  coverToken?: string | null;
  /** Fields whose current value the user confirms as right (nothing is written). */
  confirm?: string[];
  /** The user saw the warning about names other books share and saves anyway. */
  acceptRenames?: boolean;
}

export interface SaveResult {
  batchId: string | null;
  changed: string[];
  confirmed: string[];
}

interface EditPlan {
  ref: BookRef;
  current: EditValues;
  rows: { field: EditField; base: unknown; value: unknown }[];
  confirm: UserFieldKey[];
  renames: SharedRename[];
  source: EditSource;
  extra: EditExtra;
}

/** How a save came about beyond the form's values. */
export interface EditExtra {
  undoOf?: string;
  /** Undo of a cover made before the cover archive: the picture in the sidecar's quarantine. */
  coverFrom?: string;
  /** Book covers: a picture from the cover archive (an earlier cover, or Undo) by its SHA-256. */
  coverArchive?: string;
}

export type EditState = 'waiting' | 'writing' | 'written' | 'shown' | 'not_written';

export interface FieldStatus {
  field: string;
  changeId: number;
  state: EditState;
  reason: string | null;
  value: unknown;
  savedAt: number;
}

/** How long a saved edit's state is shown on the book page (the index catches up within ~11 min). */
const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pictures kept for a save (until written; old ones are cleared). */
const COVER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_COVER_BYTES = 32 * 1024 * 1024;

export interface EditDeps {
  cleanup: Database.Database;
  main: Database.Database;
  batches: BatchService;
  cacheDir: string;
  /** Book covers: the pictures a cover had before it was replaced. */
  archive?: CoverArchive | null;
}

export class EditService {
  constructor(private readonly deps: EditDeps) {}

  private get db() {
    return this.deps.cleanup;
  }

  private ref(bookId: string): BookRef {
    const ref = bookRef(this.deps.main, bookId);
    if (!ref) throw new EditError(404, 'not_calibre', 'Only books from Calibre can be edited here');
    return ref;
  }

  private coverDir(): string {
    return path.join(this.deps.cacheDir, 'cleanup', 'edit-covers');
  }

  /**
   * Keeps an uploaded, dropped or illustration picture for a save; returns its token. Only
   * pictures (JPEG, PNG, WebP, GIF) are taken; the write makes them ready for Calibre.
   */
  storeCover(bytes: Buffer): { token: string; sha256: string } {
    if (bytes.length === 0) throw new EditError(422, 'empty', 'The picture is empty');
    if (bytes.length > MAX_COVER_BYTES)
      throw new EditError(413, 'too_large', 'The picture is larger than 32 MB');
    const ext = pictureType(bytes);
    if (!ext)
      throw new EditError(415, 'not_a_picture', 'Only JPEG, PNG, WebP or GIF pictures can be used');
    const dir = this.coverDir();
    fs.mkdirSync(dir, { recursive: true });
    this.pruneCovers(dir);
    const token = randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(dir, `${token}.${ext}`), bytes, { flag: 'wx' });
    return { token, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  private coverFile(token: string): string | null {
    if (!/^[0-9a-f]{24}$/.test(token)) return null;
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const f = path.join(this.coverDir(), `${token}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  private pruneCovers(dir: string): void {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        if (now - fs.statSync(f).mtimeMs > COVER_KEEP_MS) fs.rmSync(f, { force: true });
      } catch {
        // Another request removed it.
      }
    }
  }

  /** Names in the new values that differ only in case from a name other books share. */
  sharedRenames(ref: BookRef, current: EditValues, values: Partial<EditValues>): SharedRename[] {
    const out: SharedRename[] = [];
    const main = this.deps.main;
    const check = (
      field: SharedRename['field'],
      names: string[],
      own: string[],
      count: (name: string) => { name: string; n: number }[],
    ) => {
      for (const to of names) {
        if (own.includes(to)) continue;
        for (const hit of count(to)) {
          if (hit.name !== to && hit.name.toLowerCase() === to.toLowerCase() && hit.n > 0)
            out.push({ field, from: hit.name, to, books: hit.n });
        }
      }
    };
    const others = (table: string, link: string, col: string) => (name: string) =>
      main
        .prepare(
          `SELECT x.name, COUNT(DISTINCT l.book_id) AS n FROM ${table} x
           JOIN ${link} l ON l.${col} = x.id
           JOIN book_sources s ON s.book_id = l.book_id AND s.missing_at IS NULL
           WHERE lower(x.name) = lower(?) AND l.book_id <> ? GROUP BY x.id`,
        )
        .all(name, ref.bookId) as { name: string; n: number }[];
    if (values.authors)
      check(
        'authors',
        values.authors,
        current.authors,
        others('authors', 'book_authors', 'author_id'),
      );
    if (values.illustrator)
      check(
        'illustrator',
        values.illustrator,
        current.illustrator,
        others('illustrators', 'book_illustrators', 'illustrator_id'),
      );
    if (values.tags)
      check('tags', values.tags, current.tags, others('tags', 'book_tags', 'tag_id'));
    if (values.series?.name)
      check(
        'series',
        [values.series.name],
        current.series.name ? [current.series.name] : [],
        (name) =>
          main
            .prepare(
              `SELECT se.name, COUNT(DISTINCT b.id) AS n FROM series se JOIN books b ON b.series_id = se.id
             JOIN book_sources s ON s.book_id = b.id AND s.missing_at IS NULL
             WHERE lower(se.name) = lower(?) AND b.id <> ? GROUP BY se.id`,
            )
            .all(name, ref.bookId) as { name: string; n: number }[],
      );
    if (values.publisher)
      check(
        'publisher',
        [values.publisher],
        current.publisher ? [current.publisher] : [],
        (name) =>
          main
            .prepare(
              `SELECT b.publisher AS name, COUNT(*) AS n FROM books b
             JOIN book_sources s ON s.book_id = b.id AND s.missing_at IS NULL
             WHERE lower(b.publisher) = lower(?) AND b.id <> ? GROUP BY b.publisher`,
            )
            .all(name, ref.bookId) as { name: string; n: number }[],
      );
    return out;
  }

  /**
   * Saves the user's values of one book: refused at once when a name would be too long for
   * Calibre's folders (never shortened) or a name holds "&"; asks first (409 shared_rename) when
   * a case-only change renames a name other books share. Returns the batch planned.
   */
  save(
    bookId: string,
    input: SaveInput,
    source: EditSource = 'edit',
    now = Date.now(),
    extra: EditExtra = {},
  ): SaveResult {
    const plan = this.plan(bookId, input, source, extra);
    const [result] = this.commit([plan], now);
    return result;
  }

  /** Several books in one batch (a series save): every book is checked before anything is kept. */
  saveMany(
    items: { bookId: string; input: SaveInput }[],
    source: EditSource = 'edit',
    now = Date.now(),
  ): { batchId: string | null; books: SaveResult[] } {
    const plans = items.map((i) => {
      try {
        return this.plan(i.bookId, { ...i.input, acceptRenames: true }, source, {});
      } catch (err) {
        if (err instanceof EditError)
          throw new EditError(err.status, err.code, `${this.titleOf(i.bookId)}: ${err.message}`, {
            ...err.details,
            bookId: i.bookId,
          });
        throw err;
      }
    });
    const renames = plans.flatMap((p) => p.renames);
    if (renames.length > 0 && !items.every((i) => i.input.acceptRenames))
      throw new EditError(
        409,
        'shared_rename',
        'Calibre renames these names for every book that has them',
        { renames },
      );
    const books = this.commit(plans, now);
    return { batchId: books.find((b) => b.batchId)?.batchId ?? null, books };
  }

  private titleOf(bookId: string): string {
    return bookRef(this.deps.main, bookId)?.title ?? 'A book';
  }

  private plan(bookId: string, input: SaveInput, source: EditSource, extra: EditExtra): EditPlan {
    const ref = this.ref(bookId);
    const current = this.currentValues(bookId);
    if (!current) throw new EditError(404, 'not_found', 'No such book');
    const values: Partial<EditValues> = {};
    const rows: EditPlan['rows'] = [];
    for (const [k, raw] of Object.entries(input.values ?? {})) {
      if (!(EDIT_FIELDS as readonly string[]).includes(k) || k === 'cover')
        throw new EditError(422, 'bad_field', `No such field: ${k}`);
      const f = k as Exclude<EditField, 'cover'>;
      const v = normalizeValue(f, raw);
      const base = input.base && f in input.base ? normalizeBase(f, input.base[f]) : current[f];
      if (sameValue(f, v, base)) continue;
      (values as Record<string, unknown>)[f] = v;
      rows.push({ field: f, base, value: v });
    }
    if (input.coverToken) {
      const coverFile = this.coverFile(input.coverToken);
      if (!coverFile)
        throw new EditError(410, 'cover_gone', 'The picture is gone; choose it again');
      rows.push({
        field: 'cover',
        base: ref.hasCover,
        value: {
          file: coverFile,
          sha256: createHash('sha256').update(fs.readFileSync(coverFile)).digest('hex'),
        },
      });
    } else if (extra.coverArchive) {
      // Book covers: an earlier picture from the server's own archive (written like an upload).
      const file = this.deps.archive?.has(ref, extra.coverArchive)
        ? this.deps.archive.file(extra.coverArchive)
        : null;
      if (!file) throw new EditError(410, 'cover_gone', 'That earlier cover is not in the archive');
      rows.push({
        field: 'cover',
        base: ref.hasCover,
        value: { file, sha256: extra.coverArchive, archive: extra.coverArchive },
      });
    } else if (extra.coverFrom) {
      // Undo of a cover: Calibre's earlier picture, kept in the sidecar's quarantine.
      rows.push({ field: 'cover', base: ref.hasCover, value: { quarantine: extra.coverFrom } });
    }
    const confirm = (input.confirm ?? []).filter((f) =>
      (['title', 'authors', 'illustrator', 'series', 'series_index'] as string[]).includes(f),
    ) as UserFieldKey[];
    // Calibre rebuilds the folder and file names on every write (lessons 2), so the check runs
    // for any save, with the title and first author the book will have.
    if (rows.length > 0) {
      refuseLongNames(
        ref.calibreId,
        values.title ?? current.title,
        (values.authors ?? current.authors)[0] ?? 'Unknown',
      );
    }
    const renames = this.sharedRenames(ref, current, values);
    if (renames.length > 0 && !input.acceptRenames)
      throw new EditError(
        409,
        'shared_rename',
        'Calibre renames these names for every book that has them',
        { renames },
      );
    return { ref, current, rows, confirm, renames, source, extra };
  }

  private commit(plans: EditPlan[], now: number): SaveResult[] {
    const results: SaveResult[] = plans.map((p) => ({
      batchId: null,
      changed: p.rows.map((r) => r.field),
      confirmed: p.confirm,
    }));
    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
           new_json, source, evidence_json, class, review_reason, state, decided_by, decided_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', NULL, 'proposed', 'user', ?, ?, ?)`,
      );
      const byLibrary = new Map<string, number[]>();
      for (const p of plans) {
        for (const r of p.rows) {
          const ev: Record<string, unknown> = { title: p.ref.title, edit: p.source };
          if (p.extra.undoOf) ev.undoOf = p.extra.undoOf;
          if (r.field === 'cover') ev.cover = r.value;
          const fieldRenames = p.renames.filter((x) => x.field === r.field);
          if (fieldRenames.length) ev.renames = fieldRenames;
          const id = Number(
            insert.run(
              EDIT_STAGE,
              p.ref.libraryId,
              p.ref.calibreId,
              p.ref.uuid,
              r.field,
              JSON.stringify(r.base ?? null),
              JSON.stringify(r.value ?? null),
              sourceName(p.source),
              JSON.stringify(ev),
              now,
              now,
              now,
            ).lastInsertRowid,
          );
          const ids = byLibrary.get(p.ref.libraryId) ?? [];
          ids.push(id);
          byLibrary.set(p.ref.libraryId, ids);
          for (const key of userKeysOf(r.field, r.base, r.value))
            markYours(this.db, p.ref, key, r.field === 'cover' ? true : r.value, p.source, id, now);
        }
        for (const f of p.confirm) this.confirmField(p.ref, p.current, f, now);
      }
      for (const [libraryId, ids] of byLibrary) {
        const id = this.deps.batches.createBatch(EDIT_STAGE, libraryId, 'apply', null, ids, now).id;
        plans.forEach((p, i) => {
          if (p.ref.libraryId === libraryId && p.rows.length > 0) results[i].batchId = id;
        });
      }
    })();
    return results;
  }

  /** "Confirm as right": the value stays as it is and becomes the user's (nothing is written). */
  private confirmField(ref: BookRef, current: EditValues, key: UserFieldKey, now: number): void {
    const value =
      key === 'series' || key === 'series_index'
        ? current.series
        : (current as unknown as Record<string, unknown>)[key];
    markYours(this.db, ref, key, value, 'confirm', null, now);
    setAiYours(this.db, ref, key, value, now);
    this.db
      .prepare(
        `INSERT INTO calibre_seen_changes (library_id, calibre_uuid, calibre_id, field, old_json,
           new_json, kind, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 'confirm', ?)`,
      )
      .run(
        ref.libraryId,
        ref.uuid,
        ref.calibreId,
        key,
        JSON.stringify(value ?? null),
        JSON.stringify(value ?? null),
        now,
      );
  }

  /** The fields whose value is the cleanup's best guess (shown "Unconfirmed" on the form). */
  unconfirmed(bookId: string): { field: string; reason: string | null }[] {
    const ref = this.ref(bookId);
    const yours = new Set(this.yours(ref).map((y) => y.field));
    const out = new Map<string, string | null>();
    const ai = this.db
      .prepare(
        `SELECT field, reason FROM ai_values WHERE stage = 'calibre4' AND item_key = ? AND flagged = 1`,
      )
      .all(`${ref.libraryId}:${ref.uuid}`) as { field: string; reason: string | null }[];
    const byAi: Record<string, string> = {
      t: 'title',
      au: 'authors',
      il: 'illustrator',
      se: 'series',
      ix: 'series_index',
    };
    for (const r of ai) if (byAi[r.field]) out.set(byAi[r.field], r.reason);
    const guess = this.db
      .prepare(
        `SELECT reason FROM stage4_series_order WHERE library_id = ? AND calibre_uuid = ? AND guess = 1`,
      )
      .get(ref.libraryId, ref.uuid) as { reason: string | null } | undefined;
    if (guess) out.set('series_index', guess.reason);
    const written = this.db
      .prepare(
        `SELECT field, review_reason FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND stage <> ${EDIT_STAGE} AND state = 'applied'
           AND COALESCE(json_extract(evidence_json, '$.unconfirmed'), 0) = 1`,
      )
      .all(ref.libraryId, ref.uuid) as { field: string; review_reason: string | null }[];
    for (const r of written) if (!out.has(r.field)) out.set(r.field, r.review_reason);
    return [...out.entries()]
      .filter(([f]) => !yours.has(f))
      .map(([field, reason]) => ({ field, reason }));
  }

  yours(ref: { libraryId: string; uuid: string }) {
    return yoursOf(this.db, ref.libraryId, ref.uuid);
  }

  /**
   * Each field's latest saved edit and where it stands: waiting to be written, being written,
   * written (the library's index hasn't read it yet), shown, or not written (and why).
   */
  status(bookId: string, now = Date.now()): FieldStatus[] {
    const ref = this.ref(bookId);
    const rows = this.db
      .prepare(
        `SELECT p.id, p.field, p.new_json, p.state, p.review_reason, p.created_at,
                b.state AS batch_state, f.last_modified_after, f.created_at AS written_at
         FROM proposed_changes p INDEXED BY proposed_changes_book
         LEFT JOIN batches b ON b.id = p.batch_id
         LEFT JOIN field_undo f ON f.change_id = p.id
         WHERE p.library_id = ? AND p.calibre_uuid = ? AND p.stage = ${EDIT_STAGE}
           AND p.created_at > ?
         ORDER BY p.id DESC`,
      )
      .all(ref.libraryId, ref.uuid, now - STATUS_WINDOW_MS) as {
      id: number;
      field: string;
      new_json: string;
      state: string;
      review_reason: string | null;
      created_at: number;
      batch_state: string | null;
      last_modified_after: string | null;
      written_at: number | null;
    }[];
    // Shown: the index copied metadata.db after the write was recorded, and its record of the
    // book is at least as new as Calibre's after the write (to the second).
    const indexedAt = getIndexState(this.deps.main, ref.libraryId).snapshotAt ?? 0;
    const seen = new Set<string>();
    const out: FieldStatus[] = [];
    for (const r of rows) {
      if (seen.has(r.field)) continue;
      seen.add(r.field);
      let state: EditState;
      if (r.state === 'applied') {
        const after = parseCalibreDate(r.last_modified_after);
        state =
          after !== null &&
          ref.lastModified !== null &&
          ref.lastModified + 1000 >= after &&
          r.written_at !== null &&
          indexedAt > r.written_at
            ? 'shown'
            : 'written';
      } else if (r.state === 'skipped' || r.state === 'undone') state = 'not_written';
      else state = r.batch_state === 'claimed' ? 'writing' : 'waiting';
      const value = JSON.parse(r.new_json) as unknown;
      out.push({
        field: r.field,
        changeId: r.id,
        state,
        reason: state === 'not_written' ? r.review_reason : null,
        value: r.field === 'cover' ? true : value,
        savedAt: r.created_at,
      });
    }
    return out;
  }

  /**
   * The book's values as the user last saved them: the library's index, with each field's edit
   * that is saved but not shown there yet (written, or still to be written) laid over it. The
   * index catches up within about 1-11 minutes; until then a form opened again starts from what
   * the user saved (and a save compares with that), not from the older index.
   */
  currentValues(bookId: string): EditValues | null {
    const values = catalogValues(this.deps.main, bookId);
    if (!values) return null;
    for (const s of this.status(bookId)) {
      if (s.field === 'cover' || !['waiting', 'writing', 'written'].includes(s.state)) continue;
      (values as unknown as Record<string, unknown>)[s.field] = s.value;
    }
    return values;
  }

  /** What the edit form needs beyond the book's values. */
  form(bookId: string): {
    calibreId: number;
    hasCover: boolean;
    values: EditValues;
    unconfirmed: { field: string; reason: string | null }[];
    yours: { field: string; source: string; since: number; changeId: number | null }[];
    status: FieldStatus[];
    writer: { ready: boolean; wait: string | null };
  } {
    const ref = this.ref(bookId);
    const values = this.currentValues(bookId)!;
    return {
      calibreId: ref.calibreId,
      hasCover: ref.hasCover,
      values,
      unconfirmed: this.unconfirmed(bookId),
      yours: this.yours(ref),
      status: this.status(bookId),
      writer: this.writer(),
    };
  }

  /**
   * A new copy replaces a book (stage 3's removal of the old copy, new arrivals included): the
   * fields that are the user's on the old copy are copied onto the new one, as the user's
   * ("carried"), with their values as Calibre holds them on the old copy now (its cover from
   * the library, read only). Returns the edit's batch (the removal waits for it), or null when
   * the old copy has no field of the user's.
   */
  carry(libraryId: string, fromUuid: string, toUuid: string, now = Date.now()): string | null {
    const keys = yoursOf(this.db, libraryId, fromUuid).map((y) => y.field);
    if (keys.length === 0) return null;
    const from = bookOfUuid(this.deps.main, libraryId, fromUuid);
    const to = bookOfUuid(this.deps.main, libraryId, toUuid);
    if (!from || !to) return null;
    const values = catalogValues(this.deps.main, from);
    if (!values) return null;
    const out: Partial<Record<EditField, unknown>> = {};
    for (const k of keys) {
      const f = editFieldOf(k);
      if (!f || f === 'cover') continue;
      out[f] = values[f as keyof EditValues];
    }
    let coverToken: string | null = null;
    if (keys.includes('cover') && this.readCover) {
      const fromRef = bookRef(this.deps.main, from);
      const bytes = fromRef ? this.readCover(libraryId, fromRef.path) : null;
      if (bytes) coverToken = this.storeCover(bytes).token;
    }
    const plan = this.plan(to, { values: out, coverToken, acceptRenames: true }, 'carried', {});
    // Every carried field is the user's on the new copy even when Calibre already has its value.
    const toRef = plan.ref;
    for (const k of keys) {
      if (k === 'cover' && !coverToken) continue;
      const f = editFieldOf(k);
      markYours(
        this.db,
        toRef,
        k as UserFieldKey,
        f && f !== 'cover' ? out[f] : true,
        'carried',
        null,
        now,
      );
    }
    const [r] = this.commit([plan], now);
    return r.batchId;
  }

  /**
   * Book covers: every picture the book's cover has had that the archive keeps, oldest first
   * (the first is the original), each marked when it looks like the cover Calibre has now.
   */
  async earlierCovers(bookId: string): Promise<{
    current: { width: number; height: number } | null;
    covers: (ArchivedCover & { current: boolean })[];
  }> {
    const ref = this.ref(bookId);
    const list = this.deps.archive?.list(ref) ?? [];
    const bytes = ref.hasCover && this.readCover ? this.readCover(ref.libraryId, ref.path) : null;
    const facts = bytes ? await imageFacts(bytes) : null;
    const sha = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
    const max = getSettings(this.db).covers.sameDistance;
    // The cover now is the picture with Calibre's exact bytes. Only when none has them (a picture
    // Calibre wrote differently) the closest one by its difference hash, within stage 4's
    // setting: a near look-alike must never hide a picture the user can pick (found in the e2e).
    let currentSha = list.some((c) => c.sha256 === sha) ? sha : null;
    if (!currentSha && facts?.dhash) {
      let best: { sha: string; d: number } | null = null;
      for (const c of list) {
        if (!samePicture(c.dhash, facts.dhash, max)) continue;
        const d = hammingHex(c.dhash, facts.dhash) ?? Infinity;
        if (!best || d < best.d) best = { sha: c.sha256, d };
      }
      currentSha = best?.sha ?? null;
    }
    return {
      current: facts ? { width: facts.width, height: facts.height } : null,
      covers: list.map((c) => ({ ...c, current: c.sha256 === currentSha })),
    };
  }

  /** Book covers: a picture of the book's archive (the form's thumbnails), or null. */
  archivedPicture(bookId: string, sha256: string): string | null {
    const ref = this.ref(bookId);
    return this.deps.archive?.has(ref, sha256) ? this.deps.archive.file(sha256) : null;
  }

  /** Reads a book's cover.jpg from the Calibre library (read only); set by the service. */
  readCover: ((libraryId: string, bookPath: string | null) => Buffer | null) | null = null;

  /** What the series editor shows: the series' books in order, and its suggested pair. */
  seriesView(
    libraryId: string,
    name: string,
  ): {
    libraryId: string;
    name: string;
    books: {
      bookId: string;
      calibreId: number;
      title: string;
      index: number | null;
      firstAuthor: string;
      unconfirmed: string | null;
      yours: string[];
    }[];
    pairs: SeriesPair[];
  } {
    const books = seriesBooks(this.deps.main, libraryId, name);
    const guess = this.db.prepare(
      `SELECT reason FROM stage4_series_order WHERE library_id = ? AND calibre_uuid = ? AND guess = 1`,
    );
    const flagged = this.db.prepare(
      `SELECT reason FROM ai_values WHERE stage = 'calibre4' AND item_key = ? AND field = 'ix' AND flagged = 1`,
    );
    const pairs = seriesPairsOf(
      name,
      librarySeries(this.deps.main, libraryId),
      notSameAs(this.db, libraryId, name),
    );
    return {
      libraryId,
      name,
      books: books.map((b) => {
        const yours = yoursOf(this.db, libraryId, b.uuid).map((y) => y.field);
        const g =
          (guess.get(libraryId, b.uuid) as { reason: string | null } | undefined) ??
          (flagged.get(`${libraryId}:${b.uuid}`) as { reason: string | null } | undefined);
        return {
          bookId: b.bookId,
          calibreId: b.calibreId,
          title: b.title,
          index: b.index,
          firstAuthor: b.firstAuthor,
          unconfirmed: g && !yours.includes('series_index') ? (g.reason ?? 'A best guess') : null,
          yours,
        };
      }),
      pairs,
    };
  }

  /**
   * The series editor's save, one batch for every book it changes: the series renamed for all
   * its books, each volume's title and number, numbers confirmed as right, and the books of a
   * suggested pair moved into this series ("Move them into this series", their numbers kept).
   */
  saveSeries(
    input: {
      libraryId: string;
      name: string;
      rename?: string | null;
      books?: {
        bookId: string;
        base?: { title?: string; index?: number | null };
        title?: string;
        index?: number | null;
      }[];
      confirm?: string[];
      merge?: string | null;
      acceptRenames?: boolean;
    },
    now = Date.now(),
  ): { batchId: string | null; books: number } {
    const members = seriesBooks(this.deps.main, input.libraryId, input.name);
    if (members.length === 0) throw new EditError(404, 'not_found', 'No such series');
    const target =
      input.rename !== undefined && input.rename !== null && input.rename.trim() !== ''
        ? (normalizeValue('series', { name: input.rename, index: 1 }) as { name: string }).name
        : input.name;
    const edits = new Map((input.books ?? []).map((b) => [b.bookId, b]));
    const confirm = new Set(input.confirm ?? []);
    const items: { bookId: string; input: SaveInput }[] = [];
    for (const m of members) {
      const e = edits.get(m.bookId);
      const values: Partial<Record<EditField, unknown>> = {};
      const base: Partial<Record<EditField, unknown>> = {
        series: { name: input.name, index: e?.base?.index ?? m.index },
      };
      if (e?.title !== undefined && e.title !== (e.base?.title ?? m.title)) {
        values.title = e.title;
        base.title = e.base?.title ?? m.title;
      }
      const index = e?.index !== undefined ? e.index : m.index;
      if (target !== input.name || index !== (e?.base?.index ?? m.index))
        values.series = { name: target, index };
      const c = confirm.has(m.bookId) ? ['series_index'] : [];
      if (Object.keys(values).length || c.length)
        items.push({
          bookId: m.bookId,
          input: { base, values, confirm: c, acceptRenames: input.acceptRenames },
        });
    }
    if (input.merge) {
      const others = seriesBooks(this.deps.main, input.libraryId, input.merge);
      for (const o of others)
        items.push({
          bookId: o.bookId,
          input: {
            base: { series: { name: input.merge, index: o.index } },
            values: { series: { name: target, index: o.index } },
            acceptRenames: input.acceptRenames,
          },
        });
    }
    if (items.length === 0) return { batchId: null, books: 0 };
    const r = this.saveMany(items, 'edit', now);
    if (input.merge) decidePair(this.db, input.libraryId, input.name, input.merge, 'merged', now);
    return { batchId: r.batchId, books: items.length };
  }

  /** "Not the same series": the pair is not suggested again. */
  notSameSeries(libraryId: string, name: string, other: string, now = Date.now()): void {
    decidePair(this.db, libraryId, name, other, 'different', now);
  }

  /** The book's history of changes, newest first. */
  history(bookId: string): HistoryEntry[] {
    const ref = this.ref(bookId);
    return bookHistory(
      this.db,
      ref,
      catalogValues(this.deps.main, bookId)!,
      this.deps.archive ?? null,
    );
  }

  /**
   * Undo of one history entry (the page asked first): a new edit of the user's back to the
   * entry's old value, which becomes theirs. Refused unless the entry is still undoable.
   */
  undo(bookId: string, entryId: string, now = Date.now()): SaveResult {
    const ref = this.ref(bookId);
    const current = catalogValues(this.deps.main, bookId)!;
    const entry = undoTarget(
      bookHistory(this.db, ref, current, this.deps.archive ?? null),
      entryId,
    );
    const field = editFieldOf(entry.field)!;
    if (field === 'cover') {
      const to = entry.undo.to as { archive?: string; quarantine?: string } | null;
      if (to?.archive)
        return this.save(bookId, {}, 'undo', now, { undoOf: entryId, coverArchive: to.archive });
      if (!to?.quarantine)
        throw new EditError(409, 'not_undoable', 'The earlier picture was not kept');
      return this.save(bookId, {}, 'undo', now, { undoOf: entryId, coverFrom: to.quarantine });
    }
    return this.save(
      bookId,
      {
        base: { [field]: current[field as keyof EditValues] },
        values: { [field]: entry.undo.to },
        // Putting a name's case back renames it for the books that share it, as the edit did.
        acceptRenames: true,
      },
      'undo',
      now,
      { undoOf: entryId },
    );
  }

  /** Whether the apply sidecar can write edits now (its version and last heartbeat). */
  writer(now = Date.now()): { ready: boolean; wait: string | null } {
    const sc = this.db.prepare('SELECT last_seen_at FROM sidecar_status WHERE id = 1').get() as
      | { last_seen_at: number | null }
      | undefined;
    if (!sc?.last_seen_at || now - sc.last_seen_at > 5 * 60_000)
      return {
        ready: false,
        wait: "The library's writer (ttsu-cleanup-apply) isn't running: your changes wait until it is",
      };
    if (!this.deps.batches.sidecarAtLeast(EDIT_SIDECAR_VERSION))
      return {
        ready: false,
        wait: `The library's writer is older than ${EDIT_SIDECAR_VERSION}: your changes wait until it is rebuilt`,
      };
    return { ready: true, wait: null };
  }
}

function sourceName(s: EditSource): string {
  return s === 'edit' ? 'user' : s;
}

/** A base value the form sent, in the server's form (an unparsable one counts as given). */
function normalizeBase(f: Exclude<EditField, 'cover'>, v: unknown): unknown {
  try {
    if (f === 'pubdate' && typeof v === 'number') return v;
    if (f === 'title' && typeof v === 'string') return v;
    if (f === 'authors' && Array.isArray(v)) return v;
    return normalizeValue(f, v);
  } catch {
    return v;
  }
}

/** The picture's file type by its first bytes; null when it is none of the four. */
export function pictureType(b: Buffer): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'gif';
  return null;
}
