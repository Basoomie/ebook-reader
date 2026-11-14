/**
 * Stage 2 batches (WP20b): writing the files' metadata and covers into Calibre through the
 * apply sidecar, and Undo.
 *
 * A batch holds up to `batchSize` books (all their auto fields, except paused fields). The
 * sidecar works one book at a time and the server decides everything:
 *
 * - verify: the sidecar sends what Calibre shows now (`calibredb list`); per field the server
 *   answers write (Calibre still has the analysed value), already done (it has the new value),
 *   or skip ("changed in Calibre since the analysis": never overwrite a user's edit). It also
 *   gives the exact `--field` arguments, whether a cover goes with them and whether Calibre's
 *   old cover must be saved in the quarantine first (D1).
 * - written: after the write the sidecar sends what Calibre shows. A field showing the new
 *   value is written (undo record, applied value with its source and last_modified after);
 *   when the write errored or timed out the sidecar keeps asking until Calibre shows it or the
 *   wait is over (`final`), and a write that may have happened is never sent twice.
 * - Undo writes the old values back where Calibre still holds what was written. A cover added
 *   where Calibre had none stays: the content server can't remove a cover (D3).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { parseCalibreDate } from '../calibre/ingest';
import { getLibrary } from '../calibre/libraries';
import { readSourceFile, resolveInside, statFile } from '../calibre/source-fs';
import { BatchError, type BatchRow, type BatchService, type ItemState } from './batches';
import { coverForCalibre, readCoverBytes } from './file-metadata';
import { presentBookCount } from './handoff';
import { getSettings } from './settings';
import { listFieldPauses } from './stage2-gate';
import { titleSort } from './title-rules';
import { readStage2Snapshot, type Stage2Book } from './stage2-snapshot';
import { currentAnalysisId, pauseStage } from './stages';

export const STAGE2_TERMINAL_APPLY: ItemState[] = ['written', 'failed', 'skipped'];

/** What `calibredb list --for-machine` shows for one book (the fields stage 2 reads). */
export interface ListedBook {
  id?: unknown;
  uuid?: unknown;
  title?: unknown;
  authors?: unknown;
  author_sort?: unknown;
  identifiers?: unknown;
  publisher?: unknown;
  languages?: unknown;
  cover?: unknown;
  last_modified?: unknown;
  '*illustrator'?: unknown;
}

export const LIST_FIELDS =
  'uuid,title,authors,author_sort,identifiers,publisher,languages,cover,last_modified,*illustrator';

interface Current {
  uuid: string | null;
  title: string;
  authors: string[];
  identifiers: Record<string, string>;
  publisher: string;
  languages: string[];
  illustrators: string[];
  hasCover: boolean;
  lastModified: string | null;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string' && v !== ''
      ? v.split(',').map((x) => x.trim())
      : [];

export function parseListed(b: ListedBook): Current {
  const ids: Record<string, string> = {};
  if (b.identifiers && typeof b.identifiers === 'object' && !Array.isArray(b.identifiers)) {
    for (const [k, v] of Object.entries(b.identifiers as Record<string, unknown>)) {
      if (typeof v === 'string') ids[k.toLowerCase()] = v;
    }
  }
  return {
    uuid: typeof b.uuid === 'string' ? b.uuid : null,
    title: typeof b.title === 'string' ? b.title : '',
    authors:
      typeof b.authors === 'string'
        ? b.authors
            .split(' & ')
            .map((a) => a.trim())
            .filter((a) => a !== '')
        : strList(b.authors),
    identifiers: ids,
    publisher: typeof b.publisher === 'string' ? b.publisher : '',
    languages: strList(b.languages),
    illustrators: strList(b['*illustrator']),
    hasCover: b.cover === 1 || b.cover === true || b.cover === '1',
    lastModified: typeof b.last_modified === 'string' ? b.last_modified : null,
  };
}

const lowerList = (l: string[]) => l.map((x) => x.toLowerCase());
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const sameDict = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameList(ka, kb) && ka.every((k) => a[k] === b[k]);
};

/**
 * Whether Calibre's current value of a field equals `value`. Shared names (authors,
 * illustrators) compare ignoring case: Calibre may spell a name the way it already knows it.
 */
export function fieldEquals(
  field: string,
  current: Current,
  value: unknown,
  strictCase = true,
): boolean {
  switch (field) {
    case 'title':
      return current.title === value;
    case 'authors': {
      const v = Array.isArray(value) ? (value as string[]) : [];
      return strictCase
        ? sameList(current.authors, v)
        : sameList(lowerList(current.authors), lowerList(v));
    }
    case 'identifiers':
      return sameDict(current.identifiers, (value ?? {}) as Record<string, string>);
    case 'publisher':
      return (current.publisher ?? '') === ((value as string | null) ?? '');
    case 'languages':
      return sameList(current.languages, Array.isArray(value) ? (value as string[]) : []);
    case 'illustrator':
      return sameList(
        lowerList(current.illustrators),
        lowerList(Array.isArray(value) ? (value as string[]) : []),
      );
    default:
      return false;
  }
}

/** The `--field` arguments that set a field to `value` (extra: the sort written alongside). */
export function fieldArgs(
  field: string,
  value: unknown,
  extra: Record<string, unknown> = {},
): string[] {
  switch (field) {
    case 'title':
      return [
        `title:${value as string}`,
        `sort:${typeof extra.sort === 'string' ? extra.sort : titleSort(value as string)}`,
      ];
    case 'authors':
      return [
        `authors:${(value as string[]).join(' & ')}`,
        `author_sort:${typeof extra.author_sort === 'string' ? extra.author_sort : ''}`,
      ];
    case 'identifiers':
      return [
        `identifiers:${Object.entries((value ?? {}) as Record<string, string>)
          .map(([k, v]) => `${k}:${v}`)
          .join(',')}`,
      ];
    case 'publisher':
      return [`publisher:${(value as string | null) ?? ''}`];
    case 'languages':
      return [`languages:${((value as string[] | null) ?? []).join(',')}`];
    case 'illustrator':
      return [`#illustrator:${((value as string[] | null) ?? []).join(',')}`];
    default:
      throw new BatchError(500, 'bad_field', `No such field: ${field}`);
  }
}

interface ItemRow {
  item_id: number;
  change_id: number;
  state: ItemState;
  field: string;
  calibre_id: number;
  calibre_uuid: string;
  old_json: string;
  new_json: string;
  source: string;
  evidence_json: string;
  stage2_json: string | null;
}

interface Evidence2 {
  title?: string;
  lastModified?: string | null;
  extra?: Record<string, { old: unknown; new: unknown }> | null;
  epub?: { path: string; size: number | null; mtimeMs: number | null };
  cover?: { entry: string; sha256: string; hadCover: boolean };
}

export interface Stage2SidecarBook {
  calibreId: number;
  uuid: string;
  title: string;
  state: ItemState;
  fields: { itemId: number; field: string; state: ItemState }[];
  /** undo: Calibre's old cover saved in the quarantine before it was replaced. */
  oldCoverPath: string | null;
}

export interface VerifyAnswer {
  action: 'write' | 'none';
  /** `--field` arguments (cover excluded). */
  fields: string[];
  /** Download the cover (apply) or write the saved one back (undo: oldCoverPath). */
  cover: boolean;
  /** apply: save Calibre's current cover into the quarantine before writing. */
  saveOldCover: boolean;
  oldCoverPath: string | null;
  /** Per field: write / done / skip and why. */
  items: { itemId: number; field: string; state: ItemState; detail: string | null }[];
}

export interface WrittenReport {
  current: ListedBook | null;
  error?: string | null;
  final?: boolean;
  oldCoverPath?: string | null;
  /** The cover was left out of the write (its old cover couldn't be saved, or no download). */
  coverSkipped?: string | null;
}

const EDITED = 'Changed in Calibre since the analysis (left as it is)';
const EDITED_AFTER = 'Changed in Calibre since the cleanup wrote it (left as it is)';

/** Calibre's times: the snapshot says "2026-11-14 13:57:11.479+00:00", `list` says ISO. */
export function sameTime(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = parseCalibreDate(a ?? null);
  const tb = parseCalibreDate(b ?? null);
  return ta !== null && tb !== null ? ta === tb : (a ?? null) === (b ?? null);
}

export class Stage2Batches {
  constructor(
    private readonly batches: BatchService,
    private readonly deps: {
      cleanup: Database.Database;
      main: Database.Database;
      calibreDir: string | null;
      cacheDir: string;
    },
  ) {}

  private get db() {
    return this.deps.cleanup;
  }

  private libDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib || !this.deps.calibreDir)
      throw new BatchError(503, 'no_library', 'The library is not available');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  /** Plans the next stage-2 batch (the caller checked mode, pauses and the safety checks). */
  async plan(libraryId: string): Promise<{ batch: BatchRow | null; reason: string | null }> {
    if (this.batches.open()) return { batch: null, reason: 'A batch is being applied' };
    if (this.batches.awaitingIngest()) {
      return {
        batch: null,
        reason: "Waiting for the reader's library index to take in the last batch",
      };
    }
    const settings = getSettings(this.db);
    const present = presentBookCount(this.deps.main, libraryId);
    const cap = Math.max(
      1,
      Math.min(
        settings.pacing.batchSize,
        Math.floor((present * settings.pacing.maxBatchPercent) / 100),
      ),
    );
    const paused = new Set(listFieldPauses(this.db, 2).map((p) => p.field));
    const rows = this.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, field, old_json, new_json, evidence_json FROM proposed_changes
         WHERE stage = 2 AND library_id = ? AND state = 'proposed' AND class = 'auto'
           AND (analysis_id = ? OR decided_by IS NOT NULL)
         ORDER BY calibre_id, id`,
      )
      .all(libraryId, currentAnalysisId(this.db, 2)) as {
      id: number;
      calibre_id: number;
      calibre_uuid: string;
      field: string;
      old_json: string;
      new_json: string;
      evidence_json: string;
    }[];
    const byBook = new Map<string, typeof rows>();
    for (const r of rows) {
      if (paused.has(r.field)) continue;
      if (!byBook.has(r.calibre_uuid)) {
        if (byBook.size >= cap) break;
        byBook.set(r.calibre_uuid, []);
      }
      byBook.get(r.calibre_uuid)!.push(r);
    }
    if (byBook.size === 0) {
      return {
        batch: null,
        reason: rows.length > 0 ? 'Every field left to apply is paused' : null,
      };
    }
    // Check every book against Calibre now (the indexer's latest snapshot).
    const snap = readStage2Snapshot(snapshotFile(this.deps.cacheDir, libraryId));
    const byUuid = new Map([...snap.books.values()].map((b) => [b.uuid, b]));
    const libDir = this.libDir(libraryId);
    const skip: { id: number; reason: string }[] = [];
    const keep: number[] = [];
    let changedBooks = 0;
    for (const [uuid, items] of byBook) {
      const book = byUuid.get(uuid);
      let changed = false;
      for (const r of items) {
        const ev = JSON.parse(r.evidence_json) as Evidence2;
        const reason = await this.planCheck(book, r, ev, libDir);
        if (reason) {
          skip.push({ id: r.id, reason });
          changed = true;
        } else keep.push(r.id);
      }
      if (changed) changedBooks += 1;
    }
    const share = (100 * changedBooks) / Math.max(cap, byBook.size);
    if (changedBooks > 0 && share > settings.libraryChangedPausePercent) {
      pauseStage(
        this.db,
        2,
        'library_changed',
        `${changedBooks} of the next ${byBook.size} books changed in Calibre since the analysis. Nothing was written or skipped. Run the analysis again: writing goes on by itself after it.`,
      );
      return { batch: null, reason: 'Calibre changed since the analysis' };
    }
    if (skip.length > 0) {
      const mark = this.db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const s of skip) mark.run(s.reason, now, s.id);
      })();
    }
    if (keep.length === 0) return { batch: null, reason: null };
    return { batch: this.batches.createBatch(2, libraryId, 'apply', null, keep), reason: null };
  }

  private async planCheck(
    book: Stage2Book | undefined,
    r: { calibre_id: number; field: string; old_json: string },
    ev: Evidence2,
    libDir: string,
  ): Promise<string | null> {
    if (!book || book.calibreId !== r.calibre_id) return 'The book is no longer in Calibre';
    if (!book.filePath) return 'The book has no EPUB in Calibre any more';
    const old = JSON.parse(r.old_json) as unknown;
    const current: Current = {
      uuid: book.uuid,
      title: book.title,
      authors: book.authors,
      identifiers: book.identifiers,
      publisher: book.publisher ?? '',
      languages: book.languages,
      illustrators: book.illustrators ?? [],
      hasCover: book.hasCover,
      lastModified: book.lastModified,
    };
    if (r.field === 'cover') {
      if (!ev.epub || !ev.cover) return 'No cover facts';
      const st = book.filePath ? await statFile(resolveInside(libDir, book.filePath)) : null;
      if (!st || st.size !== ev.epub.size || st.mtimeMs !== ev.epub.mtimeMs)
        return 'The EPUB changed since the analysis';
      if (book.hasCover !== ev.cover.hadCover) return EDITED;
      if (book.hasCover && !sameTime(book.lastModified, ev.lastModified)) return EDITED;
      return null;
    }
    if (r.field === 'illustrator' && book.illustrators === null)
      return 'The library has no #illustrator column';
    return this.matchingOld(book.uuid, r.field, current, old) ? null : EDITED;
  }

  /**
   * Calibre still has the analysed value, or a value stage 2 itself wrote since (a review
   * decision after the normalization was applied): that is not a user's edit. Returns the
   * value Calibre has (it becomes the undo record's old value), or null.
   */
  private matchingOld(
    uuid: string,
    field: string,
    current: Current,
    old: unknown,
  ): { value: unknown } | null {
    if (fieldEquals(field, current, old)) return { value: old };
    const own = this.db
      .prepare('SELECT value_json FROM applied_values WHERE calibre_uuid = ? AND field = ?')
      .get(uuid, field) as { value_json: string } | undefined;
    if (own) {
      const v = JSON.parse(own.value_json) as unknown;
      if (fieldEquals(field, current, v, false)) return { value: v };
    }
    return null;
  }

  private rows(batchId: string, calibreId?: number): ItemRow[] {
    return this.db
      .prepare(
        `SELECT i.id AS item_id, i.change_id, i.state, i.stage2_json, c.field, c.calibre_id, c.calibre_uuid,
                c.old_json, c.new_json, c.source, c.evidence_json
         FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         WHERE i.batch_id = ? ${calibreId !== undefined ? 'AND c.calibre_id = ?' : ''} ORDER BY i.position`,
      )
      .all(...(calibreId !== undefined ? [batchId, calibreId] : [batchId])) as ItemRow[];
  }

  private undoRecord(batch: BatchRow, changeId: number) {
    return this.db
      .prepare('SELECT * FROM field_undo WHERE batch_id = ? AND change_id = ?')
      .get(batch.undoOf ?? batch.id, changeId) as
      | {
          old_json: string;
          new_json: string;
          extra_json: string;
          last_modified_after: string | null;
          old_cover_path: string | null;
          restored_at: number | null;
        }
      | undefined;
  }

  sidecarBooks(batch: BatchRow): Stage2SidecarBook[] {
    const books = new Map<number, Stage2SidecarBook>();
    for (const r of this.rows(batch.id)) {
      const ev = JSON.parse(r.evidence_json) as Evidence2;
      let b = books.get(r.calibre_id);
      if (!b) {
        b = {
          calibreId: r.calibre_id,
          uuid: r.calibre_uuid,
          title: ev.title ?? '',
          state: 'pending',
          fields: [],
          oldCoverPath: null,
        };
        books.set(r.calibre_id, b);
      }
      b.fields.push({ itemId: r.item_id, field: r.field, state: r.state });
      if (batch.kind === 'undo' && r.field === 'cover')
        b.oldCoverPath = this.undoRecord(batch, r.change_id)?.old_cover_path ?? null;
    }
    const terminal: ItemState[] =
      batch.kind === 'apply' ? STAGE2_TERMINAL_APPLY : ['restored', 'failed', 'skipped'];
    for (const b of books.values()) {
      const states = b.fields.map((f) => f.state);
      if (states.every((s) => terminal.includes(s)))
        b.state = states.some((s) => s === 'failed')
          ? 'failed'
          : states.every((s) => s === 'skipped')
            ? 'skipped'
            : batch.kind === 'apply'
              ? 'written'
              : 'restored';
      else b.state = states.some((s) => s === 'verified') ? 'verified' : 'pending';
    }
    return [...books.values()];
  }

  private setItem(
    itemId: number,
    state: ItemState,
    detail: string | null,
    stage2: Record<string, unknown> | null,
    now: number,
  ) {
    this.db
      .prepare(
        `UPDATE batch_items SET state = ?, detail = ?, stage2_json = COALESCE(?, stage2_json), updated_at = ? WHERE id = ?`,
      )
      .run(
        state,
        detail ? detail.slice(0, 2000) : null,
        stage2 ? JSON.stringify(stage2) : null,
        now,
        itemId,
      );
  }

  private skipChange(changeId: number, reason: string, now: number) {
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason.slice(0, 500), now, changeId);
  }

  private requireBook(batchId: string, calibreId: number): { batch: BatchRow; rows: ItemRow[] } {
    const batch = this.batches.requireClaimed(batchId);
    if (batch.stage !== 2) throw new BatchError(409, 'bad_batch', 'Not a stage 2 batch');
    if (batch.kind === 'apply' && !batch.snapshotSaved) {
      throw new BatchError(
        409,
        'snapshot_first',
        'Save the metadata.db snapshot before the first book',
      );
    }
    const rows = this.rows(batchId, calibreId);
    if (rows.length === 0) throw new BatchError(404, 'not_found', 'No such book in this batch');
    this.batches.progress(batchId);
    return { batch, rows };
  }

  /** The sidecar shows what Calibre has now; the server says what to write. */
  verify(
    batchId: string,
    calibreId: number,
    listed: ListedBook | null,
    oldCoverPath: string | null = null,
    now = Date.now(),
  ): VerifyAnswer {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    const current = listed ? parseListed(listed) : null;
    const answer: VerifyAnswer = {
      action: 'none',
      fields: [],
      cover: false,
      saveOldCover: false,
      oldCoverPath: null,
      items: [],
    };
    const terminal: ItemState[] =
      batch.kind === 'apply' ? STAGE2_TERMINAL_APPLY : ['restored', 'failed', 'skipped'];
    this.db.transaction(() => {
      for (const r of rows) {
        if (terminal.includes(r.state)) {
          answer.items.push({ itemId: r.item_id, field: r.field, state: r.state, detail: null });
          continue;
        }
        const gone = !current || current.uuid !== r.calibre_uuid;
        if (batch.kind === 'apply')
          this.verifyApply(batch, r, current, gone, answer, oldCoverPath, now);
        else this.verifyUndo(batch, r, current, gone, answer, now);
      }
    })();
    answer.action = answer.fields.length > 0 || answer.cover ? 'write' : 'none';
    return answer;
  }

  private verifyApply(
    batch: BatchRow,
    r: ItemRow,
    current: Current | null,
    gone: boolean,
    answer: VerifyAnswer,
    oldCoverPath: string | null,
    now: number,
  ) {
    const push = (state: ItemState, detail: string | null) =>
      answer.items.push({ itemId: r.item_id, field: r.field, state, detail });
    if (gone) {
      this.setItem(r.item_id, 'skipped', 'The book is no longer in Calibre', null, now);
      this.skipChange(r.change_id, 'The book is no longer in Calibre', now);
      return push('skipped', 'The book is no longer in Calibre');
    }
    const cur = current!;
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    const oldV = JSON.parse(r.old_json) as unknown;
    const newV = JSON.parse(r.new_json) as unknown;
    const seen = { lastModified: cur.lastModified, hasCover: cur.hasCover };
    if (r.field === 'cover') {
      const cv = ev.cover;
      // A cover can't be compared through `list`: a book that had one and changed since the
      // analysis is left alone; one that had none must still have none.
      // Verified before (the sidecar restarted): a write since then shows as a new last_modified.
      const before =
        r.state === 'verified'
          ? (JSON.parse(r.stage2_json ?? '{}') as { lastModified?: string | null })
          : null;
      if (before && cur.hasCover && !sameTime(cur.lastModified, before.lastModified)) {
        this.written(batch, r, cur, oldCoverPath, now);
        return push('written', null);
      }
      if (
        !cv ||
        cur.hasCover !== cv.hadCover ||
        (cv.hadCover && !sameTime(cur.lastModified, ev.lastModified))
      ) {
        this.setItem(r.item_id, 'skipped', EDITED, null, now);
        this.skipChange(r.change_id, EDITED, now);
        return push('skipped', EDITED);
      }
      this.setItem(r.item_id, 'verified', null, seen, now);
      answer.cover = true;
      answer.saveOldCover = cv.hadCover;
      return push('verified', null);
    }
    if (fieldEquals(r.field, cur, newV, false)) {
      this.written(batch, r, cur, oldCoverPath, now);
      return push('written', null);
    }
    const matched = this.matchingOld(r.calibre_uuid, r.field, cur, oldV);
    if (!matched) {
      this.setItem(r.item_id, 'skipped', EDITED, null, now);
      this.skipChange(r.change_id, EDITED, now);
      return push('skipped', EDITED);
    }
    const extra = Object.fromEntries(Object.entries(ev.extra ?? {}).map(([k, v]) => [k, v.new]));
    answer.fields.push(...fieldArgs(r.field, newV, extra));
    this.setItem(r.item_id, 'verified', null, { ...seen, oldValue: matched.value }, now);
    push('verified', null);
  }

  private verifyUndo(
    batch: BatchRow,
    r: ItemRow,
    current: Current | null,
    gone: boolean,
    answer: VerifyAnswer,
    now: number,
  ) {
    const push = (state: ItemState, detail: string | null) =>
      answer.items.push({ itemId: r.item_id, field: r.field, state, detail });
    const rec = this.undoRecord(batch, r.change_id);
    if (!rec) throw new BatchError(404, 'not_found', 'No undo record for this item');
    if (gone) {
      this.setItem(r.item_id, 'skipped', 'The book is no longer in Calibre', null, now);
      return push('skipped', 'The book is no longer in Calibre');
    }
    const cur = current!;
    const oldV = JSON.parse(rec.old_json) as unknown;
    const newV = JSON.parse(rec.new_json) as unknown;
    const extraOld = Object.fromEntries(
      Object.entries(JSON.parse(rec.extra_json) as Record<string, { old: unknown }>).map(
        ([k, v]) => [k, v.old],
      ),
    );
    if (r.field === 'cover') {
      if (!rec.old_cover_path) {
        const detail =
          "The cover from the book's own file stays: the content server can't remove a cover";
        this.restored(batch, r, cur, detail, now);
        return push('restored', detail);
      }
      const before =
        r.state === 'verified'
          ? (JSON.parse(r.stage2_json ?? '{}') as { lastModified?: string | null })
          : null;
      if (before && cur.hasCover && !sameTime(cur.lastModified, before.lastModified)) {
        this.restored(batch, r, cur, null, now);
        return push('restored', null);
      }
      if (!cur.hasCover || !sameTime(cur.lastModified, rec.last_modified_after)) {
        this.setItem(r.item_id, 'skipped', EDITED_AFTER, null, now);
        return push('skipped', EDITED_AFTER);
      }
      this.setItem(r.item_id, 'verified', null, { lastModified: cur.lastModified }, now);
      answer.cover = true;
      answer.oldCoverPath = rec.old_cover_path;
      return push('verified', null);
    }
    // Already the old value (an earlier write of this Undo, or put back by hand).
    if (fieldEquals(r.field, cur, oldV ?? (r.field === 'identifiers' ? {} : null), false)) {
      this.restored(batch, r, cur, null, now);
      return push('restored', null);
    }
    if (!fieldEquals(r.field, cur, newV, false)) {
      this.setItem(r.item_id, 'skipped', EDITED_AFTER, null, now);
      return push('skipped', EDITED_AFTER);
    }
    answer.fields.push(
      ...fieldArgs(r.field, oldV ?? (r.field === 'identifiers' ? {} : null), { ...extraOld }),
    );
    this.setItem(r.item_id, 'verified', null, { lastModified: cur.lastModified }, now);
    push('verified', null);
  }

  /** After the write: what Calibre shows decides each field. */
  writtenReport(batchId: string, calibreId: number, report: WrittenReport, now = Date.now()) {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    const current = report.current ? parseListed(report.current) : null;
    const pending: string[] = [];
    const out: { itemId: number; field: string; state: ItemState }[] = [];
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.state !== 'verified') {
          out.push({ itemId: r.item_id, field: r.field, state: r.state });
          continue;
        }
        const before = JSON.parse(r.stage2_json ?? '{}') as { lastModified?: string | null };
        let ok = false;
        if (current && current.uuid === r.calibre_uuid) {
          if (batch.kind === 'apply') {
            ok =
              r.field === 'cover'
                ? !report.coverSkipped &&
                  current.hasCover &&
                  !sameTime(current.lastModified, before.lastModified)
                : fieldEquals(r.field, current, JSON.parse(r.new_json), false);
          } else {
            const rec = this.undoRecord(batch, r.change_id)!;
            ok =
              r.field === 'cover'
                ? current.hasCover && !sameTime(current.lastModified, before.lastModified)
                : fieldEquals(
                    r.field,
                    current,
                    JSON.parse(rec.old_json) ?? (r.field === 'identifiers' ? {} : null),
                    false,
                  );
          }
        }
        if (r.field === 'cover' && report.coverSkipped) {
          // The cover was left out of the write: never counted as written or put back.
          this.setItem(r.item_id, 'skipped', report.coverSkipped, null, now);
          if (batch.kind === 'apply') this.skipChange(r.change_id, report.coverSkipped, now);
          out.push({ itemId: r.item_id, field: r.field, state: 'skipped' });
          continue;
        }
        if (ok) {
          if (batch.kind === 'apply')
            this.written(batch, r, current!, report.oldCoverPath ?? null, now);
          else this.restored(batch, r, current!, null, now);
          out.push({
            itemId: r.item_id,
            field: r.field,
            state: batch.kind === 'apply' ? 'written' : 'restored',
          });
        } else if (report.final) {
          const detail = report.error
            ? `Calibre didn't take the change: ${report.error}`
            : "Calibre doesn't show the new value after the write";
          this.setItem(r.item_id, 'failed', detail, null, now);
          if (batch.kind === 'apply') this.skipChange(r.change_id, detail, now);
          out.push({ itemId: r.item_id, field: r.field, state: 'failed' });
        } else {
          pending.push(r.field);
          out.push({ itemId: r.item_id, field: r.field, state: 'verified' });
        }
      }
    })();
    return { done: pending.length === 0, pending, items: out };
  }

  private written(
    batch: BatchRow,
    r: ItemRow,
    current: Current,
    oldCoverPath: string | null,
    now: number,
  ) {
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    // The value Calibre had when the sidecar verified the book (normally the analysed one).
    const seen = JSON.parse(r.stage2_json ?? '{}') as { oldValue?: unknown };
    const oldJson = 'oldValue' in seen ? JSON.stringify(seen.oldValue ?? null) : r.old_json;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO field_undo (batch_id, change_id, library_id, calibre_id, calibre_uuid, field,
           old_json, new_json, extra_json, last_modified_after, old_cover_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        r.change_id,
        batch.libraryId,
        r.calibre_id,
        r.calibre_uuid,
        r.field,
        oldJson,
        r.new_json,
        JSON.stringify(ev.extra ?? {}),
        current.lastModified,
        r.field === 'cover' ? oldCoverPath : null,
        now,
      );
    this.db
      .prepare(
        `INSERT INTO applied_values (library_id, calibre_uuid, field, value_json, source, batch_id, applied_at,
           change_id, last_modified_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(library_id, calibre_uuid, field) DO UPDATE SET value_json = excluded.value_json,
           source = excluded.source, batch_id = excluded.batch_id, applied_at = excluded.applied_at,
           change_id = excluded.change_id, last_modified_after = excluded.last_modified_after`,
      )
      .run(
        batch.libraryId,
        r.calibre_uuid,
        r.field,
        r.new_json,
        r.source,
        batch.id,
        now,
        r.change_id,
        current.lastModified,
      );
    this.setItem(r.item_id, 'written', null, null, now);
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'applied', decided_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, r.change_id);
  }

  private restored(
    batch: BatchRow,
    r: ItemRow,
    current: Current,
    detail: string | null,
    now: number,
  ) {
    this.db
      .prepare(
        `UPDATE field_undo SET restored_at = ?, restored_last_modified = ?, restore_detail = ?
         WHERE batch_id = ? AND change_id = ?`,
      )
      .run(now, current.lastModified, detail, batch.undoOf, r.change_id);
    this.db
      .prepare(
        'DELETE FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = ? AND change_id = ?',
      )
      .run(batch.libraryId, r.calibre_uuid, r.field, r.change_id);
    this.setItem(r.item_id, 'restored', detail, null, now);
    this.db
      .prepare(`UPDATE proposed_changes SET state = 'undone', updated_at = ? WHERE id = ?`)
      .run(now, r.change_id);
  }

  /** The cover the sidecar hands to calibre (D1), checked against the analysed file. */
  async coverFor(
    batchId: string,
    calibreId: number,
  ): Promise<{ bytes: Buffer; ext: string; sha256: string }> {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    const r = rows.find((x) => x.field === 'cover');
    if (!r || batch.kind !== 'apply')
      throw new BatchError(404, 'not_found', 'No cover for this book in this batch');
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    if (!ev.cover || !ev.epub) throw new BatchError(404, 'not_found', 'No cover facts');
    const libDir = this.libDir(batch.libraryId);
    const bytes = await readCoverBytes(resolveInside(libDir, ev.epub.path), ev.cover.entry).catch(
      () => null,
    );
    if (!bytes) throw new BatchError(409, 'cover_gone', "The EPUB's cover can't be read any more");
    if (createHash('sha256').update(bytes).digest('hex') !== ev.cover.sha256) {
      throw new BatchError(409, 'cover_changed', "The EPUB's cover changed since the analysis");
    }
    const s = getSettings(this.db).stage2;
    const out = await coverForCalibre(bytes, {
      maxBytes: s.coverMaxMb * 1024 * 1024,
      maxSide: s.coverMaxSide,
    });
    return { bytes: out.bytes, ext: out.ext, sha256: out.sha256 };
  }

  /** Calibre's current cover.jpg (read-only), for the quarantine before it is replaced. */
  async oldCover(batchId: string, calibreId: number): Promise<Buffer> {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    if (batch.kind !== 'apply' || !rows.some((x) => x.field === 'cover')) {
      throw new BatchError(404, 'not_found', 'No cover for this book in this batch');
    }
    const snap = readStage2Snapshot(snapshotFile(this.deps.cacheDir, batch.libraryId));
    const book = snap.books.get(calibreId);
    if (!book || !book.hasCover)
      throw new BatchError(404, 'not_found', 'Calibre lists no cover for this book');
    try {
      return await readSourceFile(
        resolveInside(this.libDir(batch.libraryId), `${book.path}/cover.jpg`),
      );
    } catch {
      throw new BatchError(404, 'not_found', "Calibre's cover.jpg can't be read");
    }
  }

  /** Taken in when the reader's index shows each written book's new last_modified. */
  ingested(batch: BatchRow): boolean {
    const rows = this.db
      .prepare(
        `SELECT f.calibre_uuid, f.last_modified_after, f.restored_last_modified, i.state FROM batch_items i
         JOIN field_undo f ON f.change_id = i.change_id AND f.batch_id = ?
         WHERE i.batch_id = ? AND i.state IN ('written', 'restored')`,
      )
      .all(batch.undoOf ?? batch.id, batch.id) as {
      calibre_uuid: string;
      last_modified_after: string | null;
      restored_last_modified: string | null;
      state: ItemState;
    }[];
    for (const r of rows) {
      const want = parseCalibreDate(
        batch.kind === 'apply' ? r.last_modified_after : r.restored_last_modified,
      );
      if (want === null) continue;
      const src = this.deps.main
        .prepare(
          `SELECT calibre_last_modified FROM book_sources WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ?`,
        )
        .get(batch.libraryId, r.calibre_uuid) as
        | { calibre_last_modified: number | string | null }
        | undefined;
      if (!src) continue;
      // The reader stores Calibre's last_modified as milliseconds.
      const have =
        typeof src.calibre_last_modified === 'number'
          ? src.calibre_last_modified
          : parseCalibreDate(src.calibre_last_modified);
      if (have === null || have + 1 < want) return false;
    }
    return true;
  }

  /** Undo of an applied stage-2 batch (the newest batch touching those books first). */
  undo(batch: BatchRow, now = Date.now()): BatchRow {
    const records = this.db
      .prepare(
        `SELECT change_id, calibre_uuid FROM field_undo WHERE batch_id = ? AND restored_at IS NULL`,
      )
      .all(batch.id) as { change_id: number; calibre_uuid: string }[];
    if (records.length === 0)
      throw new BatchError(409, 'nothing_to_undo', 'Nothing in this batch to put back');
    const uuids = new Set(records.map((r) => r.calibre_uuid));
    const later = this.db
      .prepare(
        `SELECT f.calibre_uuid FROM field_undo f JOIN batches b ON b.id = f.batch_id
         WHERE b.created_at > ? AND b.kind = 'apply' AND f.restored_at IS NULL`,
      )
      .all(batch.createdAt) as { calibre_uuid: string }[];
    if (later.some((r) => uuids.has(r.calibre_uuid))) {
      throw new BatchError(
        409,
        'later_batch',
        'A later batch changed some of these books; undo that one first',
      );
    }
    return this.batches.createBatch(
      2,
      batch.libraryId,
      'undo',
      batch.id,
      records.map((r) => r.change_id),
      now,
    );
  }
}
