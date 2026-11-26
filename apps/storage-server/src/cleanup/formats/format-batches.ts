/**
 * Books without an EPUB: the write batches (stage 12, FORMATS_STAGE). One book per item, each
 * step reported by the sidecar and acknowledged before the next:
 *
 *   convert  pending -> verified (the record as selected: same UUID, its file's format still there,
 *            still no EPUB, last_modified unchanged) -> written (the EPUB the server checked added
 *            with `add_format --dont-replace`). The book is then recorded for the next new-arrivals
 *            run as a book added by hand (calibre_known_books origin 'format'), and the EPUB
 *            Calibre stored is compared with the checked one (verifyStored, byte for byte, else
 *            file for file: DeDRM packs EPUBs again).
 *   fold     pending -> verified -> exported (stage 1's quarantine export; the copy's file must be
 *            the compared one) -> tagged (the file added to the twin when the twin has none of that
 *            format; the user's own tags copied to the twin) -> removed (Calibre's trash).
 *
 * Undo (newest batch first): a converted book's EPUB comes off again (`remove_format`; only when
 * the EPUB in Calibre is still the one stored by the write); a folded copy comes back (Calibre's
 * trash, else its quarantine export) and the format it gave the twin comes off. A book or copy
 * whose write was undone is never proposed again.
 */
import type Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { getLibrary } from '../../calibre/libraries';
import {
  METADATA_DB,
  openSourceDatabase,
  openSourceFile,
  resolveInside,
  statFileSync,
} from '../../calibre/source-fs';
import type {
  BatchDeps,
  BatchRow,
  BatchService,
  ItemReport,
  ItemState,
  SidecarBatch,
  SidecarItem,
} from '../batches';
import { BatchError } from '../batches';
import { FORMATS_STAGE } from '../field-stages';
import { getSettings, isCustomTag } from '../settings';
import { sameEpubContents } from '../move/epub-same';
import { pauseFormats } from './state';
import { EpubStore } from './epub-store';

/** What a stage-12 proposal keeps as its evidence. */
export interface FormatEvidence {
  kind: 'convert' | 'fold';
  title: string;
  authors: string[];
  tags: string[];
  lastModified: string | null;
  formats: string[];
  sourceFormat: string;
  sourceSha256: string;
  sourceSize: number | null;
  /** convert: the checked EPUB. */
  epubSha256?: string | null;
  epubSize?: number | null;
  /** fold: the twin, the format to add to it when it has none, and the measures. */
  twin?: { calibreId: number; uuid: string; title: string; formats: string[]; tags?: string[] };
  addFormat?: string | null;
  how?: 'same' | 'inside' | null;
  reason?: string | null;
  /** The check's and the sidecar's facts, for the card. */
  facts?: Record<string, unknown>;
  /** Set by the user's choice on a near pair ("Fold it" / "Its own book" / "Leave it"). */
  choice?: 'fold' | 'convert' | 'leave';
}

/** A stage-12 item as the sidecar gets it (the sidecar's BatchItem.format). */
export interface SidecarFormatItem extends SidecarItem {
  format: {
    kind: 'convert' | 'fold';
    sourceFormat: string;
    sourceSha256: string;
    epubSha256?: string | null;
    addFormat?: string | null;
    removeFormat?: string | null;
  };
}

const APPLY: Record<'convert' | 'fold', Partial<Record<ItemState, ItemState[]>>> = {
  convert: {
    pending: ['verified', 'skipped', 'failed'],
    verified: ['written', 'skipped', 'failed'],
  },
  fold: {
    pending: ['verified', 'skipped', 'failed'],
    verified: ['exported', 'skipped', 'failed'],
    exported: ['tagged', 'skipped', 'failed'],
    tagged: ['removed', 'skipped', 'failed'],
  },
};

interface ChangeRow {
  id: number;
  library_id: string;
  calibre_id: number;
  calibre_uuid: string;
  evidence_json: string;
  state: string;
}

export class FormatBatches {
  /** The checked EPUBs waiting to be written (the pass's only files). */
  readonly store: EpubStore;

  constructor(
    private readonly batches: BatchService,
    private readonly deps: BatchDeps,
  ) {
    this.store = new EpubStore(deps.cacheDir);
  }

  private get db(): Database.Database {
    return this.deps.cleanup;
  }

  private libraryDir(libraryId: string): string | null {
    const lib = getLibrary(this.deps.main, libraryId);
    return lib && this.deps.calibreDir ? path.join(this.deps.calibreDir, lib.folder) : null;
  }

  /** A book as Calibre's live metadata.db holds it now (read only), by UUID. */
  liveBook(
    libraryId: string,
    uuid: string,
  ): { id: number; path: string; formats: Map<string, string> } | null {
    const dir = this.libraryDir(libraryId);
    if (!dir) return null;
    const db = openSourceDatabase(path.join(dir, METADATA_DB));
    try {
      db.pragma('busy_timeout = 3000');
      const b = db.prepare('SELECT id, path FROM books WHERE uuid = ?').get(uuid) as
        | { id: number; path: string }
        | undefined;
      if (!b) return null;
      const formats = new Map<string, string>();
      for (const d of db.prepare('SELECT format, name FROM data WHERE book = ?').all(b.id) as {
        format: string;
        name: string;
      }[])
        formats.set(d.format.toUpperCase(), `${b.path}/${d.name}.${d.format.toLowerCase()}`);
      return { id: b.id, path: b.path, formats };
    } finally {
      db.close();
    }
  }

  // ------------------------------------------------------------------- planning

  /**
   * The next write batch of the run's automatic proposals, each checked against Calibre's live
   * metadata.db first (the book as selected, still without an EPUB; a fold's twin still with its
   * EPUB). A proposal that no longer fits is set aside with its reason (never written).
   */
  plan(
    libraryId: string,
    analysisId: string,
    now = Date.now(),
  ): { batch: BatchRow | null; reason: string | null } {
    if (this.batches.open()) return { batch: null, reason: 'A batch is being applied' };
    const size = getSettings(this.db).formats.batchSize;
    const rows = this.db
      .prepare(
        `SELECT id, library_id, calibre_id, calibre_uuid, evidence_json, state FROM proposed_changes
         INDEXED BY proposed_changes_formats
         WHERE stage = ${FORMATS_STAGE} AND library_id = ? AND analysis_id = ? AND state = 'proposed'
           AND class = 'auto' ORDER BY id LIMIT ?`,
      )
      .all(libraryId, analysisId, size * 2) as ChangeRow[];
    if (rows.length === 0) return { batch: null, reason: null };
    const ok: number[] = [];
    const notes = new Map<number, { addFormat: string | null }>();
    const skip = this.db.prepare(
      `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
    );
    for (const r of rows) {
      if (ok.length >= size) break;
      const ev = JSON.parse(r.evidence_json) as FormatEvidence;
      let problem: string | null = null;
      let addFormat: string | null = null;
      try {
        const book = this.liveBook(libraryId, r.calibre_uuid);
        if (!book) problem = 'No longer in Calibre';
        else if (book.formats.has('EPUB')) problem = 'Has an EPUB in Calibre now';
        else if (!book.formats.has(ev.sourceFormat))
          problem = `Has no ${ev.sourceFormat} in Calibre any more`;
        if (!problem && ev.kind === 'fold' && ev.twin) {
          const twin = this.liveBook(libraryId, ev.twin.uuid);
          if (!twin) problem = 'The EPUB book to keep is no longer in Calibre';
          else if (!twin.formats.has('EPUB')) problem = 'The book to keep has no EPUB any more';
          else addFormat = twin.formats.has(ev.sourceFormat) ? null : ev.sourceFormat;
        }
      } catch (err) {
        return {
          batch: null,
          reason: `Calibre's metadata.db can't be read now: ${(err as Error).message}`,
        };
      }
      if (problem) {
        skip.run(problem, now, r.id);
        continue;
      }
      ok.push(r.id);
      notes.set(r.id, { addFormat });
    }
    if (ok.length === 0) return { batch: null, reason: null };
    const batch = this.batches.createBatch(FORMATS_STAGE, libraryId, 'apply', null, ok, now);
    const note = this.db.prepare(
      'UPDATE batch_items SET format_json = ? WHERE batch_id = ? AND change_id = ?',
    );
    this.db.transaction(() => {
      for (const [cid, n] of notes) note.run(JSON.stringify(n), batch.id, cid);
    })();
    return { batch, reason: null };
  }

  // ------------------------------------------------------------------- the sidecar

  sidecarView(batch: BatchRow, base: Omit<SidecarBatch, 'items'>): SidecarBatch {
    const settings = getSettings(this.db);
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, i.change_id, i.state, i.quarantine_dir, i.format_json,
                c.calibre_id, c.calibre_uuid, c.evidence_json,
                w.quarantine_dir AS undo_dir, w.added_format, w.added_tags_json, w.twin_id, w.twin_uuid,
                w.calibre_id AS written_id, w.calibre_uuid AS written_uuid
         FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         LEFT JOIN calibre_format_writes w ON w.change_id = i.change_id
         WHERE i.batch_id = ? ORDER BY i.position`,
      )
      .all(batch.id) as {
      item_id: number;
      change_id: number;
      state: ItemState;
      quarantine_dir: string | null;
      format_json: string | null;
      calibre_id: number;
      calibre_uuid: string;
      evidence_json: string;
      undo_dir: string | null;
      added_format: string | null;
      added_tags_json: string | null;
      twin_id: number | null;
      twin_uuid: string | null;
      written_id: number | null;
      written_uuid: string | null;
    }[];
    const items: SidecarFormatItem[] = rows.map((r) => {
      const ev = JSON.parse(r.evidence_json) as FormatEvidence;
      const note = r.format_json
        ? (JSON.parse(r.format_json) as { addFormat?: string | null })
        : {};
      const fold = ev.kind === 'fold' && ev.twin;
      const kept = fold
        ? { calibreId: ev.twin!.calibreId, uuid: ev.twin!.uuid }
        : { calibreId: r.calibre_id, uuid: r.calibre_uuid };
      const twinTags = new Set((ev.twin?.tags ?? []).map((t) => t.toLowerCase()));
      return {
        itemId: r.item_id,
        changeId: r.change_id,
        state: r.state,
        quarantineDir: batch.kind === 'undo' ? r.undo_dir : r.quarantine_dir,
        calibreId: r.calibre_id,
        uuid: r.calibre_uuid,
        title: ev.title,
        lastModified: ev.lastModified,
        formats: ev.formats,
        sha256: ev.kind === 'convert' ? (ev.epubSha256 ?? '') : ev.sourceSha256,
        kept,
        addTags:
          batch.kind === 'undo'
            ? (JSON.parse(r.added_tags_json ?? '[]') as string[])
            : fold
              ? ev.tags.filter(
                  (t) => isCustomTag(t, settings.customTags) && !twinTags.has(t.toLowerCase()),
                )
              : [],
        format: {
          kind: ev.kind,
          sourceFormat: ev.sourceFormat,
          sourceSha256: ev.sourceSha256,
          epubSha256: ev.epubSha256 ?? null,
          addFormat: batch.kind === 'apply' ? (note.addFormat ?? null) : null,
          removeFormat: batch.kind === 'undo' ? r.added_format : null,
        },
      };
    });
    return { ...base, items };
  }

  /** The checked EPUB of a convert item, for the sidecar to add (read only). */
  epubForItem(itemId: number): { file: string; sha256: string; size: number } {
    const r = this.db
      .prepare(
        `SELECT b.state AS batch_state, b.kind, b.stage, c.library_id, c.calibre_uuid, c.evidence_json
         FROM batch_items i JOIN batches b ON b.id = i.batch_id JOIN proposed_changes c ON c.id = i.change_id
         WHERE i.id = ?`,
      )
      .get(itemId) as
      | {
          batch_state: string;
          kind: string;
          stage: number;
          library_id: string;
          calibre_uuid: string;
          evidence_json: string;
        }
      | undefined;
    if (!r || r.stage !== FORMATS_STAGE || r.kind !== 'apply')
      throw new BatchError(404, 'not_found', 'No such item');
    if (r.batch_state !== 'claimed')
      throw new BatchError(409, 'not_claimed', 'The batch is not claimed');
    const ev = JSON.parse(r.evidence_json) as FormatEvidence;
    if (ev.kind !== 'convert' || !ev.epubSha256)
      throw new BatchError(409, 'not_convert', 'This item adds no EPUB');
    const file = this.store.file(r.library_id, r.calibre_uuid);
    const st = statFileSync(file);
    if (!st) throw new BatchError(410, 'gone', 'The checked EPUB is not on the server any more');
    return { file, sha256: ev.epubSha256, size: st.size };
  }

  // ------------------------------------------------------------------- reports

  report(batch: BatchRow, itemId: number, report: ItemReport, now: number): { state: ItemState } {
    if (batch.kind === 'apply' && !batch.snapshotSaved && report.step !== 'skipped')
      throw new BatchError(
        409,
        'snapshot_first',
        'Save the metadata.db snapshot before the first item',
      );
    const item = this.db
      .prepare('SELECT * FROM batch_items WHERE id = ? AND batch_id = ?')
      .get(itemId, batch.id) as
      | {
          id: number;
          change_id: number;
          state: ItemState;
          quarantine_dir: string | null;
          format_json: string | null;
        }
      | undefined;
    if (!item) throw new BatchError(404, 'not_found', 'No such item in this batch');
    this.batches.progress(batch.id, now);
    if (item.state === report.step) return { state: item.state };
    const change = this.db
      .prepare('SELECT * FROM proposed_changes WHERE id = ?')
      .get(item.change_id) as ChangeRow;
    const ev = JSON.parse(change.evidence_json) as FormatEvidence;
    const detail = report.detail ? String(report.detail).slice(0, 2000) : null;
    if (batch.kind === 'apply') {
      if (!(APPLY[ev.kind][item.state] ?? []).includes(report.step))
        throw new BatchError(409, 'bad_step', `Can't go from ${item.state} to ${report.step}`);
      if (report.step === 'exported') {
        if (!report.quarantineDir || !report.exportSha256)
          throw new BatchError(400, 'bad_report', 'exported needs quarantineDir and exportSha256');
        if (report.exportSha256 !== ev.sourceSha256)
          throw new BatchError(
            409,
            'export_mismatch',
            'The exported file differs from the compared one',
          );
      }
      this.db.transaction(() => {
        const note =
          report.step === 'tagged'
            ? JSON.stringify({
                ...(item.format_json ? JSON.parse(item.format_json) : {}),
                added: (report.fixed ?? [])[0] ?? null,
              })
            : item.format_json;
        this.db
          .prepare(
            `UPDATE batch_items SET state = ?, quarantine_dir = COALESCE(?, quarantine_dir),
               export_sha256 = COALESCE(?, export_sha256), detail = ?, format_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            report.step,
            report.quarantineDir ?? null,
            report.exportSha256 ?? null,
            detail,
            note,
            now,
            itemId,
          );
        if (report.step === 'written' || report.step === 'removed') {
          const added =
            ev.kind === 'fold'
              ? ((JSON.parse(note ?? '{}') as { added?: string | null }).added ?? null)
              : 'EPUB';
          const settings = getSettings(this.db);
          const twinTags = new Set((ev.twin?.tags ?? []).map((t) => t.toLowerCase()));
          const tags =
            ev.kind === 'fold'
              ? ev.tags.filter(
                  (t) => isCustomTag(t, settings.customTags) && !twinTags.has(t.toLowerCase()),
                )
              : [];
          this.db
            .prepare(
              `INSERT OR REPLACE INTO calibre_format_writes (change_id, batch_id, library_id, kind,
                 calibre_id, calibre_uuid, twin_id, twin_uuid, added_format, epub_sha256, quarantine_dir,
                 added_tags_json, state, written_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'written', ?)`,
            )
            .run(
              change.id,
              batch.id,
              change.library_id,
              ev.kind,
              change.calibre_id,
              change.calibre_uuid,
              ev.twin?.calibreId ?? null,
              ev.twin?.uuid ?? null,
              added,
              ev.epubSha256 ?? null,
              item.quarantine_dir ?? report.quarantineDir ?? null,
              JSON.stringify(tags),
              now,
            );
          this.db
            .prepare(`UPDATE proposed_changes SET state = 'applied', updated_at = ? WHERE id = ?`)
            .run(now, change.id);
          if (ev.kind === 'convert')
            this.knownAsNew(change.library_id, change.calibre_id, change.calibre_uuid, now);
        }
        if (report.step === 'skipped' || report.step === 'failed')
          this.db
            .prepare(
              `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
            )
            .run(detail ?? report.step, now, change.id);
      })();
      return { state: report.step };
    }
    if (item.state !== 'pending' || !['restored', 'failed', 'skipped'].includes(report.step))
      throw new BatchError(409, 'bad_step', `Can't go from ${item.state} to ${report.step}`);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE batch_items SET state = ?, method = ?, detail = ?, updated_at = ? WHERE id = ?`,
        )
        .run(report.step, report.method ?? null, detail, now, itemId);
      if (report.step === 'restored') {
        this.db
          .prepare(
            `UPDATE calibre_format_writes SET state = 'undone', undone_at = ?, undo_batch_id = ?,
               back_uuid = CASE WHEN ? IS NOT NULL AND ? <> calibre_uuid THEN ? ELSE back_uuid END
             WHERE change_id = ?`,
          )
          .run(
            now,
            batch.id,
            report.uuid ?? null,
            report.uuid ?? null,
            report.uuid ?? null,
            change.id,
          );
        this.db
          .prepare(`UPDATE proposed_changes SET state = 'undone', updated_at = ? WHERE id = ?`)
          .run(now, change.id);
        if (ev.kind === 'convert') {
          // Not taken in by the new arrivals yet: it is a baseline book again (it has no EPUB).
          this.db
            .prepare(
              `UPDATE calibre_known_books SET origin = 'baseline', settled_at = NULL
               WHERE library_id = ? AND calibre_id = ? AND origin = 'format' AND run_id IS NULL`,
            )
            .run(change.library_id, change.calibre_id);
        }
      }
    })();
    return { state: report.step };
  }

  /**
   * A book that got its EPUB from this pass: the next new-arrivals run takes it in as a book
   * added by hand (stages 1-5, and the manga move for a picture book). Every book is in the
   * arrivals' baseline today, so the row is turned into one of this pass's own.
   */
  private knownAsNew(libraryId: string, calibreId: number, uuid: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at)
         VALUES (?, ?, ?, 'format', ?)
         ON CONFLICT(library_id, calibre_id) DO UPDATE SET origin = 'format', calibre_uuid = excluded.calibre_uuid,
           added_at = excluded.added_at, settled_at = NULL, run_id = NULL, gone_at = NULL`,
      )
      .run(libraryId, calibreId, uuid, now);
  }

  // ------------------------------------------------------------------- undo

  /** Undo of an applied batch: the writes not undone yet whose books are still as written. */
  undo(batch: BatchRow, now: number): BatchRow {
    const writes = this.db
      .prepare(
        `SELECT change_id, kind, calibre_uuid, twin_uuid FROM calibre_format_writes
         WHERE batch_id = ? AND state = 'written'`,
      )
      .all(batch.id) as {
      change_id: number;
      kind: 'convert' | 'fold';
      calibre_uuid: string;
      twin_uuid: string | null;
    }[];
    if (writes.length === 0)
      throw new BatchError(409, 'nothing_to_undo', 'Nothing in this batch to take back');
    const uuids = new Set(
      writes.flatMap((w) => [w.calibre_uuid, w.twin_uuid].filter(Boolean) as string[]),
    );
    const later = this.db
      .prepare(
        `SELECT w.calibre_uuid, w.twin_uuid FROM calibre_format_writes w JOIN batches b ON b.id = w.batch_id
         WHERE b.created_at > ? AND w.state = 'written'`,
      )
      .all(batch.createdAt) as { calibre_uuid: string; twin_uuid: string | null }[];
    if (later.some((r) => uuids.has(r.calibre_uuid) || (r.twin_uuid && uuids.has(r.twin_uuid))))
      throw new BatchError(
        409,
        'later_batch',
        'A later batch changed some of these books; undo that one first',
      );
    // A converted book's EPUB comes off only while it is the one the write stored (never an EPUB
    // put in its place since). A book the new arrivals moved to another library isn't here.
    const ids: number[] = [];
    for (const w of writes) {
      if (w.kind === 'convert') {
        const live = this.liveBook(batch.libraryId, w.calibre_uuid);
        const epub = live?.formats.get('EPUB');
        if (!live || !epub) continue;
        const stored = this.db
          .prepare(
            `SELECT stored_size, stored_mtime FROM calibre_format_store WHERE change_id = ? AND state <> 'missing'`,
          )
          .get(w.change_id) as { stored_size: number; stored_mtime: number } | undefined;
        if (stored) {
          const dir = this.libraryDir(batch.libraryId);
          const st = dir ? statFileSync(resolveInside(dir, epub)) : null;
          if (!st || st.size !== stored.stored_size || st.mtimeMs !== stored.stored_mtime) continue;
        }
      }
      ids.push(w.change_id);
    }
    if (ids.length === 0)
      throw new BatchError(
        409,
        'nothing_to_undo',
        'Every EPUB of this batch was changed or moved in Calibre since: nothing is taken back',
      );
    return this.batches.createBatch(FORMATS_STAGE, batch.libraryId, 'undo', batch.id, ids, now);
  }

  /** Writes of this batch not undone yet (the batch counts as undone at 0). */
  leftToUndo(batchId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_format_writes WHERE batch_id = ? AND state = 'written'`,
        )
        .get(batchId) as { n: number }
    ).n;
  }

  // ------------------------------------------------------------------- the stored EPUB

  /**
   * The next written EPUB not looked at yet, compared with the checked one (byte for byte, else
   * file for file); its size and mtime kept for Undo. A different EPUB pauses the pass. The
   * checked copy on the server is deleted once the stored one matches. Returns false when there
   * is nothing to look at.
   */
  async verifyStored(now = Date.now()): Promise<boolean> {
    const w = this.db
      .prepare(
        `SELECT w.change_id, w.library_id, w.calibre_uuid, w.calibre_id, w.epub_sha256
         FROM calibre_format_writes w LEFT JOIN calibre_format_store s ON s.change_id = w.change_id
         WHERE w.kind = 'convert' AND w.state = 'written' AND s.change_id IS NULL
         ORDER BY w.written_at LIMIT 1`,
      )
      .get() as
      | {
          change_id: number;
          library_id: string;
          calibre_uuid: string;
          calibre_id: number;
          epub_sha256: string;
        }
      | undefined;
    if (!w) return false;
    const dir = this.libraryDir(w.library_id);
    const live = this.liveBook(w.library_id, w.calibre_uuid);
    const epub = live?.formats.get('EPUB');
    const record = (
      state: 'same' | 'repacked' | 'different' | 'missing',
      size: number,
      mtime: number,
      detail: string | null,
    ) =>
      this.db
        .prepare(
          `INSERT OR REPLACE INTO calibre_format_store (change_id, state, stored_size, stored_mtime, detail, checked_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(w.change_id, state, size, mtime, detail, now);
    if (!dir || !live || !epub) {
      record('missing', 0, 0, 'Calibre lists no EPUB for the book');
      return true;
    }
    const file = resolveInside(dir, epub);
    const st = statFileSync(file);
    if (!st) {
      // Calibre may still be writing it: looked at again later (not recorded).
      return false;
    }
    const checked = this.store.file(w.library_id, w.calibre_uuid);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256');
    const h = await openSourceFile(file);
    try {
      for await (const chunk of h.createReadStream()) hash.update(chunk as Buffer);
    } finally {
      await h.close().catch(() => {});
    }
    const sha = hash.digest('hex');
    if (sha === w.epub_sha256) {
      record('same', st.size, st.mtimeMs, null);
    } else {
      let same = false;
      let problem: string | null = 'the checked copy is gone';
      if (statFileSync(checked)) {
        const c = await sameEpubContents(checked, file, (f) =>
          f === file ? openSourceFile(f) : fs.open(f, 'r'),
        );
        same = c.same;
        problem = c.problem;
      }
      if (same) record('repacked', st.size, st.mtimeMs, null);
      else {
        record('different', st.size, st.mtimeMs, problem);
        pauseFormats(
          this.db,
          w.library_id,
          'stored_differs',
          `The EPUB Calibre stored for book ${w.calibre_id} is not the checked one (${problem}). Check the book in Calibre, then resume.`,
        );
        return true;
      }
    }
    await this.store.remove(w.library_id, w.calibre_uuid);
    return true;
  }
}
