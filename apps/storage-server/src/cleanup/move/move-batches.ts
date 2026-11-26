/**
 * Manga part A: the move's batches (stage 11, MOVE_STAGE). One book per item, each step reported
 * by the sidecar and acknowledged before the next (as stage 1's removals):
 *
 *   pending  -> verified  the book is in the old library as selected (same record, same
 *                          last_modified, EPUB present); the sidecar listed every field
 *   verified -> exported  exported into the quarantine (stage 1's command): the quarantine copy,
 *                          and what is added to the new library
 *   exported -> tagged    added to the new library with every field and checked there: the
 *                          sidecar compared every field it can list; the server compared the
 *                          stored EPUB (byte for byte, else every file inside: Calibre's DeDRM
 *                          packs it again), the cover and the title sort (checkArrived). Reported with
 *                          the new copy's Calibre id and UUID.
 *   tagged   -> removed   removed from the old library the usual way (Calibre's trash); the reader
 *                          keeps the same book (move-handoff.ts) and the cleanup's state follows
 *                          the book (rekey.ts), recorded in calibre_moves.
 *
 * Undo (newest batch first): the old library's copy comes back (Calibre's trash, else the
 * quarantine export), any field changed on the moved copy since the move is written onto it, the
 * moved copy is exported to the quarantine and removed, and the reader and the cleanup's state go
 * back with it. One item step: restored (with the copy now in the old library).
 *
 * The batch holds the index of both libraries while claimed, and the next batch waits until both
 * indexes took the last one in.
 */
import path from 'path';
import { sha256File } from '../file-hash';
import { snapshotFile } from '../../calibre/indexer';
import { getIndexState, getLibrary } from '../../calibre/libraries';
import {
  METADATA_DB,
  openSourceDatabase,
  openSourceFile,
  resolveInside,
  statFile,
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
import { BatchError, summarizeReasons } from '../batches';
import { MOVE_STAGE } from '../field-stages';
import { findCalibreSource, presentBookCount } from '../handoff';
import { getSettings } from '../settings';
import { moveReaderSource, moveReaderSourceBack, type MoveHandoff } from './move-handoff';
import { memoryOpener, readWhole, sameEpubContents, sha256Of } from './epub-same';
import { rekeyCleanupState, type BookIdentity } from './rekey';
import { pauseMove } from './state';

/** What a move proposal (stage 11, field 'book') keeps as its evidence. */
export interface MoveEvidence {
  title: string;
  authors: string[];
  series: string | null;
  formats: string[];
  tags: string[];
  matched: string[];
  lastModified: string | null;
  epubPath: string | null;
  epubSize: number | null;
  chars: number | null;
  hold: string | null;
  holdDetail: string | null;
  readerBookId: string | null;
  readerHasData: boolean;
  targetLibraryId: string;
  /** Set by "Move it anyway" / "Keep it here" on the card. */
  choice?: 'move' | 'keep';
}

/** What the sidecar keeps on an item (batch_items.move_json). */
export interface MoveItemNote {
  added?: { calibreId: number; uuid: string };
  /** The fields the sidecar listed on the old copy (written back on Undo when changed). */
  fields?: Record<string, unknown>;
  fixed?: string[];
}

/** A move item as the sidecar gets it. */
export interface SidecarMoveItem extends SidecarItem {
  move: {
    added: { calibreId: number; uuid: string } | null;
    /** undo: the moved copy in the new library, and the fields it had when it arrived. */
    movedCopy?: { calibreId: number; uuid: string } | null;
    fieldsAtMove?: Record<string, unknown> | null;
  };
}

const APPLY_STEPS: Record<string, ItemState[]> = {
  pending: ['verified', 'skipped', 'failed'],
  verified: ['exported', 'skipped', 'failed'],
  exported: ['tagged', 'skipped', 'failed'],
  tagged: ['removed', 'skipped', 'failed'],
};

/** A book as Calibre's live metadata.db holds it now (read-only, one query by UUID). */
function liveBook(
  libraryDir: string,
  uuid: string,
): { id: number; path: string; epub: string | null; hasCover: boolean; sort: string } | null {
  try {
    const db = openSourceDatabase(path.join(libraryDir, METADATA_DB));
    try {
      db.pragma('busy_timeout = 3000');
      const b = db
        .prepare('SELECT id, path, has_cover, sort FROM books WHERE uuid = ?')
        .get(uuid) as
        | { id: number; path: string; has_cover: number; sort: string | null }
        | undefined;
      if (!b) return null;
      const d = db
        .prepare(`SELECT name FROM data WHERE book = ? AND format = 'EPUB' LIMIT 1`)
        .get(b.id) as { name: string } | undefined;
      return {
        id: b.id,
        path: b.path,
        epub: d ? `${b.path}/${d.name}.epub` : null,
        hasCover: b.has_cover === 1,
        sort: b.sort ?? '',
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export class MoveBatches {
  constructor(
    private readonly batches: BatchService,
    private readonly deps: BatchDeps,
  ) {}

  private get db() {
    return this.deps.cleanup;
  }

  private libraryDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib || !this.deps.calibreDir) throw new Error('The library is not available');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  /** The move batch the index hasn't taken in yet (the next one waits for it). */
  awaitingIngest(): BatchRow | null {
    return this.batches.awaitingIngest(MOVE_STAGE);
  }

  /**
   * The next move batch: the run's automatic moves (at most the batch size and the % cap of the
   * old library), each checked first against the reader's snapshot: the same record, unchanged
   * since the selection, its EPUB still there. A large share changed pauses the move (lessons 1).
   */
  async plan(
    libraryId: string,
    targetId: string,
    analysisId: string,
    shouldStop: () => boolean = () => false,
  ): Promise<{ batch: BatchRow | null; reason: string | null }> {
    if (this.batches.open()) return { batch: null, reason: 'A batch is being applied' };
    if (this.awaitingIngest())
      return { batch: null, reason: "Waiting for the reader's index to take in the last move" };
    const settings = getSettings(this.db);
    const present = presentBookCount(this.deps.main, libraryId);
    // The move's own batch size: between batches it waits for the reader to index both
    // libraries again (several minutes each time); a run of failures stops a batch early
    // (move.stopAfterFailures), so a bigger batch risks no more books than a small one.
    const cap = Math.max(
      1,
      Math.min(
        settings.move.batchSize,
        Math.floor((present * settings.pacing.maxBatchPercent) / 100),
      ),
    );
    const candidates = this.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, evidence_json FROM proposed_changes INDEXED BY proposed_changes_move
         WHERE stage = ${MOVE_STAGE} AND library_id = ? AND analysis_id = ? AND state = 'proposed'
           AND class = 'auto'
         ORDER BY id LIMIT ?`,
      )
      .all(libraryId, analysisId, cap) as {
      id: number;
      calibre_id: number;
      calibre_uuid: string;
      evidence_json: string;
    }[];
    if (candidates.length === 0) return { batch: null, reason: null };
    const snapshot = snapshotFile(this.deps.cacheDir, libraryId);
    const live = new Map<
      string,
      { id: number; lastModified: string | null; path: string; epub: string | null }
    >();
    {
      const sdb = openSourceDatabase(snapshot);
      try {
        const q = sdb.prepare(
          `SELECT b.id, b.last_modified, b.path, d.name FROM books b
           LEFT JOIN data d ON d.book = b.id AND d.format = 'EPUB' WHERE b.uuid = ?`,
        );
        for (const c of candidates) {
          const r = q.get(c.calibre_uuid) as
            | { id: number; last_modified: string | null; path: string; name: string | null }
            | undefined;
          if (r)
            live.set(c.calibre_uuid, {
              id: r.id,
              lastModified: r.last_modified,
              path: r.path,
              epub: r.name ? `${r.path}/${r.name}.epub` : null,
            });
        }
      } finally {
        sdb.close();
      }
    }
    const libDir = this.libraryDir(libraryId);
    const skipped: { id: number; reason: string }[] = [];
    const ok: number[] = [];
    for (const c of candidates) {
      if (shouldStop()) return { batch: null, reason: null };
      const ev = JSON.parse(c.evidence_json) as MoveEvidence;
      const b = live.get(c.calibre_uuid);
      if (!b || b.id !== c.calibre_id) {
        skipped.push({ id: c.id, reason: 'The book is no longer in Calibre' });
        continue;
      }
      if (!b.epub) {
        skipped.push({ id: c.id, reason: 'The book has no EPUB in Calibre any more' });
        continue;
      }
      if (b.lastModified !== ev.lastModified) {
        skipped.push({ id: c.id, reason: 'The book was changed in Calibre since the selection' });
        continue;
      }
      const st = await statFile(resolveInside(libDir, b.epub));
      if (!st) {
        skipped.push({ id: c.id, reason: "The book's EPUB file can't be read" });
        continue;
      }
      ok.push(c.id);
    }
    const share = (100 * skipped.length) / Math.max(cap, candidates.length);
    if (skipped.length > 0 && share > settings.libraryChangedPausePercent) {
      pauseMove(
        this.db,
        'library_changed',
        `${skipped.length} of the next ${candidates.length} books to move changed in Calibre since the selection (${summarizeReasons(skipped)}). ` +
          'Nothing was moved or skipped. Select again: the books are read again and a new spot check is drawn.',
      );
      return { batch: null, reason: 'Calibre changed since the selection' };
    }
    if (skipped.length > 0) {
      const mark = this.db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const s of skipped) mark.run(s.reason, now, s.id);
      })();
    }
    if (ok.length === 0) return { batch: null, reason: null };
    const batch = this.batches.createBatch(MOVE_STAGE, libraryId, 'apply', null, ok);
    this.db
      .prepare('UPDATE batches SET target_library_id = ? WHERE id = ?')
      .run(targetId, batch.id);
    return { batch: this.batches.get(batch.id), reason: null };
  }

  /** The batch as the sidecar gets it (its two libraries are added by BatchService). */
  sidecarView(batch: BatchRow, base: Omit<SidecarBatch, 'items'>): SidecarBatch {
    if (batch.kind === 'apply') {
      const rows = this.db
        .prepare(
          `SELECT i.id AS item_id, i.change_id, i.state, i.quarantine_dir, i.export_sha256, i.move_json,
                  c.calibre_id, c.calibre_uuid, c.evidence_json
           FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
           WHERE i.batch_id = ? ORDER BY i.position`,
        )
        .all(batch.id) as {
        item_id: number;
        change_id: number;
        state: ItemState;
        quarantine_dir: string | null;
        export_sha256: string | null;
        move_json: string | null;
        calibre_id: number;
        calibre_uuid: string;
        evidence_json: string;
      }[];
      const items: SidecarMoveItem[] = rows.map((r) => {
        const ev = JSON.parse(r.evidence_json) as MoveEvidence;
        const note = r.move_json ? (JSON.parse(r.move_json) as MoveItemNote) : {};
        return {
          itemId: r.item_id,
          changeId: r.change_id,
          state: r.state,
          quarantineDir: r.quarantine_dir,
          calibreId: r.calibre_id,
          uuid: r.calibre_uuid,
          title: ev.title,
          lastModified: ev.lastModified,
          formats: ev.formats,
          sha256: r.export_sha256 ?? '',
          kept: { calibreId: 0, uuid: '' },
          addTags: [],
          move: { added: note.added ?? null },
        };
      });
      return { ...base, items, stopAfterFailures: getSettings(this.db).move.stopAfterFailures };
    }
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, i.change_id, i.state, m.from_calibre_id, m.from_uuid, m.to_calibre_id,
                m.to_uuid, m.fields_json, c.evidence_json, a.quarantine_dir
         FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         JOIN calibre_moves m ON m.change_id = i.change_id AND m.batch_id = ?
         LEFT JOIN batch_items a ON a.batch_id = ? AND a.change_id = i.change_id
         WHERE i.batch_id = ? ORDER BY i.position`,
      )
      .all(batch.undoOf, batch.undoOf, batch.id) as {
      item_id: number;
      change_id: number;
      state: ItemState;
      from_calibre_id: number;
      from_uuid: string;
      to_calibre_id: number;
      to_uuid: string;
      fields_json: string | null;
      evidence_json: string;
      quarantine_dir: string | null;
    }[];
    const items: SidecarMoveItem[] = rows.map((r) => {
      const ev = JSON.parse(r.evidence_json) as MoveEvidence;
      return {
        itemId: r.item_id,
        changeId: r.change_id,
        state: r.state,
        quarantineDir: r.quarantine_dir,
        calibreId: r.from_calibre_id,
        uuid: r.from_uuid,
        title: ev.title,
        lastModified: ev.lastModified,
        formats: ev.formats,
        sha256: '',
        kept: { calibreId: 0, uuid: '' },
        addTags: [],
        move: {
          added: null,
          movedCopy: { calibreId: r.to_calibre_id, uuid: r.to_uuid },
          fieldsAtMove: r.fields_json
            ? (JSON.parse(r.fields_json) as Record<string, unknown>)
            : null,
        },
      };
    });
    return { ...base, items };
  }

  /**
   * The server's half of the check after the add: the copy in the new library holds the same
   * EPUB (byte for byte), the same cover (byte for byte, or none on both) and the same title
   * sort (calibredb can't list the sort through the content server). Read-only.
   */
  async checkArrived(
    batchId: string,
    itemId: number,
    copy: { calibreId: number; uuid: string },
  ): Promise<{ ok: boolean; problems: string[] }> {
    const batch = this.batches.requireClaimed(batchId);
    if (batch.stage !== MOVE_STAGE || batch.kind !== 'apply' || !batch.targetLibraryId)
      throw new BatchError(409, 'bad_batch', 'Not a move batch');
    const item = this.db
      .prepare(
        `SELECT i.export_sha256, c.calibre_uuid FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         WHERE i.id = ? AND i.batch_id = ?`,
      )
      .get(itemId, batchId) as { export_sha256: string | null; calibre_uuid: string } | undefined;
    if (!item) throw new BatchError(404, 'not_found', 'No such item in this batch');
    const problems: string[] = [];
    const fromDir = this.libraryDir(batch.libraryId);
    const toDir = this.libraryDir(batch.targetLibraryId);
    const from = liveBook(fromDir, item.calibre_uuid);
    const to = liveBook(toDir, copy.uuid);
    if (!to || to.id !== copy.calibreId) {
      problems.push('The new library does not show the added copy yet');
      return { ok: false, problems };
    }
    if (!to.epub) problems.push('The added copy has no EPUB');
    else if (item.export_sha256) {
      try {
        const stored = resolveInside(toDir, to.epub);
        // Each copy is read once: its SHA-256 and, when needed, its files from the same read.
        const storedBuf = await readWhole(stored);
        const sha = storedBuf ? await sha256Of(storedBuf) : await sha256File(stored);
        if (sha !== item.export_sha256) {
          // Calibre's file-type plugins (DeDRM) pack the EPUB again as it is added: the copy is
          // the same EPUB when every file inside is (epub-same.ts; decided 2026-11-25). Compared
          // with the book's own EPUB in the old library, whose bytes the export step matched.
          if (!from?.epub)
            problems.push(
              'The EPUB stored in the new library differs from the exported one, and the book’s own EPUB is gone',
            );
          else {
            const own = resolveInside(fromDir, from.epub);
            const ownBuf = storedBuf ? await readWhole(own) : null;
            const ownSha = ownBuf ? await sha256Of(ownBuf) : await sha256File(own);
            if (ownSha !== item.export_sha256)
              problems.push('The book’s EPUB changed in the old library since it was exported');
            else {
              const c = await sameEpubContents(
                own,
                stored,
                storedBuf && ownBuf
                  ? memoryOpener(
                      new Map([
                        [own, ownBuf],
                        [stored, storedBuf],
                      ]),
                    )
                  : openSourceFile,
              );
              if (!c.same)
                problems.push(
                  `The EPUB stored in the new library differs from the book’s: ${c.problem}`,
                );
            }
          }
        }
      } catch (err) {
        problems.push(`The added copy's EPUB can't be read: ${(err as Error).message}`);
      }
    }
    if (from) {
      if (from.hasCover !== to.hasCover)
        problems.push(
          from.hasCover ? 'The cover did not arrive' : 'The copy got a cover the book did not have',
        );
      else if (from.hasCover) {
        try {
          const [a, b] = await Promise.all([
            sha256File(resolveInside(fromDir, `${from.path}/cover.jpg`)),
            sha256File(resolveInside(toDir, `${to.path}/cover.jpg`)),
          ]);
          if (a !== b) problems.push('The cover in the new library differs from the book’s');
        } catch (err) {
          problems.push(`The covers can't be compared: ${(err as Error).message}`);
        }
      }
      if (from.sort !== to.sort)
        problems.push(`The title sort differs ("${to.sort}" for "${from.sort}")`);
    } else problems.push('The book is no longer in the old library');
    return { ok: problems.length === 0, problems };
  }

  /** One step of one item (BatchService.report hands move batches here). */
  report(
    batch: BatchRow,
    itemId: number,
    report: ItemReport & { fields?: Record<string, unknown>; fixed?: string[] },
    now: number,
  ): { state: ItemState } {
    if (batch.kind === 'apply' && !batch.snapshotSaved && report.step !== 'skipped') {
      throw new BatchError(
        409,
        'snapshot_first',
        'Save the metadata.db snapshot before the first item',
      );
    }
    const item = this.db
      .prepare('SELECT * FROM batch_items WHERE id = ? AND batch_id = ?')
      .get(itemId, batch.id) as
      | { id: number; change_id: number; state: ItemState; move_json: string | null }
      | undefined;
    if (!item) throw new BatchError(404, 'not_found', 'No such item in this batch');
    this.batches.progress(batch.id, now);
    if (item.state === report.step) return { state: item.state };
    const detail = report.detail ? String(report.detail).slice(0, 2000) : null;
    if (batch.kind === 'undo') {
      if (item.state !== 'pending' || !['restored', 'failed', 'skipped'].includes(report.step))
        throw new BatchError(409, 'bad_step', `Can't go from ${item.state} to ${report.step}`);
      this.db.transaction(() => {
        if (report.step === 'restored') this.recordMoveBack(batch, item.change_id, report, now);
        this.db
          .prepare(
            `UPDATE batch_items SET state = ?, method = ?, detail = ?, updated_at = ? WHERE id = ?`,
          )
          .run(report.step, report.method ?? null, detail, now, itemId);
      })();
      return { state: report.step };
    }
    if (!(APPLY_STEPS[item.state] ?? []).includes(report.step))
      throw new BatchError(409, 'bad_step', `Can't go from ${item.state} to ${report.step}`);
    const note: MoveItemNote = item.move_json ? (JSON.parse(item.move_json) as MoveItemNote) : {};
    if (report.step === 'exported' && (!report.quarantineDir || !report.exportSha256))
      throw new BatchError(400, 'bad_report', 'exported needs quarantineDir and exportSha256');
    if (report.step === 'tagged') {
      if (typeof report.calibreId !== 'number' || !report.uuid)
        throw new BatchError(400, 'bad_report', 'The added copy needs its calibreId and uuid');
      note.added = { calibreId: report.calibreId, uuid: report.uuid };
      if (report.fields) note.fields = report.fields;
      if (report.fixed) note.fixed = report.fixed;
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE batch_items SET state = ?, quarantine_dir = COALESCE(?, quarantine_dir),
             export_sha256 = COALESCE(?, export_sha256), detail = ?, move_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          report.step,
          report.quarantineDir ?? null,
          report.exportSha256 ?? null,
          detail,
          Object.keys(note).length ? JSON.stringify(note) : null,
          now,
          itemId,
        );
      if (report.step === 'removed') this.recordMove(batch, item.change_id, note, now);
      if (report.step === 'skipped' || report.step === 'failed')
        this.db
          .prepare(
            `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
          )
          .run(detail ?? report.step, now, item.change_id);
    })();
    return { state: report.step };
  }

  private change(changeId: number): {
    libraryId: string;
    calibreId: number;
    uuid: string;
    evidence: MoveEvidence;
  } {
    const r = this.db
      .prepare(
        'SELECT library_id, calibre_id, calibre_uuid, evidence_json FROM proposed_changes WHERE id = ?',
      )
      .get(changeId) as
      | { library_id: string; calibre_id: number; calibre_uuid: string; evidence_json: string }
      | undefined;
    if (!r) throw new BatchError(404, 'not_found', 'No such change');
    return {
      libraryId: r.library_id,
      calibreId: r.calibre_id,
      uuid: r.calibre_uuid,
      evidence: JSON.parse(r.evidence_json) as MoveEvidence,
    };
  }

  /** The book is in the new library and gone from the old one: the reader and the cleanup follow. */
  private recordMove(batch: BatchRow, changeId: number, note: MoveItemNote, now: number): void {
    if (!note.added || !batch.targetLibraryId)
      throw new BatchError(409, 'bad_step', 'The added copy is not known');
    const c = this.change(changeId);
    const from: BookIdentity = { libraryId: c.libraryId, calibreId: c.calibreId, uuid: c.uuid };
    const to: BookIdentity = {
      libraryId: batch.targetLibraryId,
      calibreId: note.added.calibreId,
      uuid: note.added.uuid,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO calibre_moves (change_id, batch_id, from_library_id, from_calibre_id,
           from_uuid, to_library_id, to_calibre_id, to_uuid, fields_json, state, moved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'moved', ?)`,
      )
      .run(
        changeId,
        batch.id,
        from.libraryId,
        from.calibreId,
        from.uuid,
        to.libraryId,
        to.calibreId,
        to.uuid,
        note.fields ? JSON.stringify(note.fields) : null,
        now,
      );
    // Manga part B: the moved copy is known to the new arrivals of the library it moved to (its
    // own baseline may come later): never taken for a book added there by hand.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at, settled_at)
         VALUES (?, ?, ?, 'move', ?, ?)`,
      )
      .run(to.libraryId, to.calibreId, to.uuid, now, now);
    const rec = this.db
      .prepare('SELECT handoff_json FROM calibre_moves WHERE batch_id = ? AND change_id = ?')
      .get(batch.id, changeId) as { handoff_json: string };
    const previous = JSON.parse(rec.handoff_json) as MoveHandoff | Record<string, never>;
    const handoff = moveReaderSource(
      this.deps.main,
      from,
      to,
      'kind' in previous ? (previous as MoveHandoff) : null,
      now,
    );
    const series = [c.evidence.series].filter((s): s is string => !!s);
    const order = this.db
      .prepare('SELECT series FROM stage4_series_order WHERE library_id = ? AND calibre_uuid = ?')
      .get(from.libraryId, from.uuid) as { series: string } | undefined;
    if (order) series.push(order.series);
    const counts = rekeyCleanupState(this.db, from, to, series);
    this.db
      .prepare(
        `UPDATE calibre_moves SET handoff_json = ?, rekey_json = ?, source_row_id = ?
         WHERE batch_id = ? AND change_id = ?`,
      )
      .run(
        JSON.stringify(handoff),
        JSON.stringify(counts),
        handoff.sourceId ?? null,
        batch.id,
        changeId,
      );
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'applied', decided_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, changeId);
  }

  /** Undo: the book is back in the old library: the reader and the cleanup go back with it. */
  private recordMoveBack(batch: BatchRow, changeId: number, report: ItemReport, now: number): void {
    if (!batch.undoOf) throw new BatchError(409, 'bad_batch', 'Undo batch without its batch');
    if (!report.method || !report.uuid || typeof report.calibreId !== 'number')
      throw new BatchError(400, 'bad_report', 'restored needs method, calibreId and uuid');
    const m = this.db
      .prepare('SELECT * FROM calibre_moves WHERE batch_id = ? AND change_id = ?')
      .get(batch.undoOf, changeId) as
      | {
          from_library_id: string;
          to_library_id: string;
          to_calibre_id: number;
          to_uuid: string;
          handoff_json: string;
          state: string;
        }
      | undefined;
    if (!m) throw new BatchError(404, 'not_found', 'No move record for this item');
    if (m.state === 'undone') return;
    const movedTo: BookIdentity = {
      libraryId: m.to_library_id,
      calibreId: m.to_calibre_id,
      uuid: m.to_uuid,
    };
    const back: BookIdentity = {
      libraryId: m.from_library_id,
      calibreId: report.calibreId,
      uuid: report.uuid,
    };
    const handoff = moveReaderSourceBack(
      this.deps.main,
      JSON.parse(m.handoff_json) as MoveHandoff,
      movedTo,
      back,
      now,
    );
    const c = this.change(changeId);
    const order = this.db
      .prepare('SELECT series FROM stage4_series_order WHERE library_id = ? AND calibre_uuid = ?')
      .get(movedTo.libraryId, movedTo.uuid) as { series: string } | undefined;
    const series = [c.evidence.series, order?.series].filter((s): s is string => !!s);
    rekeyCleanupState(this.db, movedTo, back, series);
    this.db
      .prepare(
        `UPDATE calibre_moves SET state = 'undone', undo_batch_id = ?, undone_at = ?, back_calibre_id = ?,
           back_uuid = ?, handoff_json = json_set(handoff_json, '$.back', json(?))
         WHERE batch_id = ? AND change_id = ?`,
      )
      .run(
        batch.id,
        now,
        back.calibreId,
        back.uuid,
        JSON.stringify(handoff),
        batch.undoOf,
        changeId,
      );
    this.db
      .prepare(`UPDATE proposed_changes SET state = 'undone', updated_at = ? WHERE id = ?`)
      .run(now, changeId);
    // A copy re-added from the quarantine is a new record of the old library: the new arrivals
    // must not count it as added by hand (as stage 1's Undo re-adds).
    if (report.method === 'readd' || back.calibreId !== c.calibreId)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO calibre_known_books (library_id, calibre_id, calibre_uuid, origin, added_at, settled_at)
           VALUES (?, ?, ?, 'undo', ?, ?)`,
        )
        .run(back.libraryId, back.calibreId, back.uuid, now, now);
  }

  /** Undo of a move batch: every book it moved that hasn't come back yet. */
  undo(batch: BatchRow, now: number): BatchRow {
    const rows = this.db
      .prepare(`SELECT change_id FROM calibre_moves WHERE batch_id = ? AND state = 'moved'`)
      .all(batch.id) as { change_id: number }[];
    if (rows.length === 0)
      throw new BatchError(409, 'nothing_to_undo', 'Nothing in this batch to move back');
    const undo = this.batches.createBatch(
      MOVE_STAGE,
      batch.libraryId,
      'undo',
      batch.id,
      rows.map((r) => r.change_id),
      now,
    );
    this.db
      .prepare('UPDATE batches SET target_library_id = ? WHERE id = ?')
      .run(batch.targetLibraryId, undo.id);
    return this.batches.get(undo.id)!;
  }

  /** Moves left to bring back from an apply batch (finish() marks it undone at 0). */
  leftToUndo(batchId: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM calibre_moves WHERE batch_id = ? AND state = 'moved'`)
        .get(batchId) as { n: number }
    ).n;
  }

  /**
   * A finished move batch is taken in once both libraries' indexes ran after it: the moved books
   * present in the new library on their reader book (undo: back in the old library). An index
   * that ran and still doesn't show it pauses the move.
   */
  checkIngested(now = Date.now()): void {
    for (;;) {
      const batch = this.awaitingIngest();
      if (!batch) return;
      const finishedAt = batch.finishedAt ?? now;
      const rows = this.db
        .prepare(
          batch.kind === 'apply'
            ? `SELECT to_library_id AS lib, to_uuid AS uuid FROM calibre_moves WHERE batch_id = ? AND state = 'moved'`
            : `SELECT from_library_id AS lib, back_uuid AS uuid FROM calibre_moves WHERE undo_batch_id = ? AND state = 'undone'`,
        )
        .all(batch.id) as { lib: string; uuid: string }[];
      // A batch that moved nothing (every book failed or skipped) changed neither library, so no
      // index runs after it: waiting for one held the move for good (2026-11-25, a one-book batch
      // skipped because the book changed in Calibre since the selection).
      if (rows.length === 0) {
        this.db
          .prepare('UPDATE batches SET ingested_at = ?, updated_at = ? WHERE id = ?')
          .run(now, now, batch.id);
        continue;
      }
      const libs = [batch.libraryId, batch.targetLibraryId].filter((l): l is string => !!l);
      let ran = true;
      for (const lib of libs) {
        try {
          const st = getIndexState(this.deps.main, lib);
          if (st.indexedAt === null || st.indexedAt <= finishedAt || st.status !== 'idle')
            ran = false;
        } catch {
          ran = false;
        }
      }
      if (!ran) return;
      const missing = rows.filter((r) => {
        const src = findCalibreSource(this.deps.main, r.lib, r.uuid);
        return !src || src.missingAt !== null;
      });
      if (missing.length > 0)
        pauseMove(
          this.db,
          'ingest_mismatch',
          `The reader's index doesn't show ${missing.length} of the last batch's ${batch.kind === 'apply' ? 'moved books in the new library' : 'books moved back'}. Check the batch, then resume.`,
        );
      this.db
        .prepare('UPDATE batches SET ingested_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, batch.id);
    }
  }
}
