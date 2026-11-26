/**
 * Books without an EPUB (docs/design/non-epub-books.md, stop 1 `non-epub-stop1.md`): the pass,
 * with its own Off / Preview / On on /cleanup. The phases are in state.ts; this file runs them:
 *
 *   select   reads the reader's snapshot of the cleanup's library (select.ts): a row per book with
 *            no EPUB, listed and left with its reason, or waiting with the file to convert and its
 *            EPUB twins (same title);
 *   convert  the sidecar claims one book at a time (claimJob), converts it in its own folder and
 *            uploads the EPUB; each EPUB is checked here as it comes (check.ts); the job's own
 *            findings (DRM, a series in one archive, not a book…) list the book;
 *   compare  each checked book with twins is measured against them by stage 3's reader processes
 *            and decided (copies.ts): folded, near (review), or a book of its own;
 *   propose  stage-12 proposals under `formats:<run>` (field 'epub': the EPUB for the book's own
 *            record; field 'fold': the copy into its twin); never again for a book whose write was
 *            undone;
 *   spot     30 converted books drawn by kind (text, picture, extracted, rebuilt) for the user to
 *            mark; Preview stops here, On only with all marked and none wrong (the user);
 *   write    (On) one batch at a time (format-batches.ts); each stored EPUB is checked after;
 *   done     a newer snapshot selects again (books added since without an EPUB).
 *
 * Nothing in Preview writes to Calibre: the sidecar's conversion only reads (calibredb export).
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { snapshotFile } from '../../calibre/indexer';
import { getLibrary } from '../../calibre/libraries';
import { resolveInside } from '../../calibre/source-fs';
import type { Stage3Reader } from '../../counts/book-text-worker';
import type { BatchRow, BatchService } from '../batches';
import { FORMATS_STAGE } from '../field-stages';
import { DISK_OWNERS } from '../disk-lock';
import { getSettings } from '../settings';
import { checkEpub, type CheckResult, type JobFacts } from './check';
import { decideCopy, type TwinMeasure } from './copies';
import type { FormatBatches, FormatEvidence } from './format-batches';
import { EpubStoreError, type EpubStore } from './epub-store';
import {
  chooseFile,
  LISTED_TEXT,
  nonEpubUuids,
  readFormatCandidates,
  twinsOf,
  type FormatFile,
  type ListedReason,
  type Twin,
} from './select';
import {
  emptyFormatsProgress,
  formatsAnalysisId,
  getFormatsState,
  resumeFormats,
  saveFormatsProgress,
  setFormatsMode,
  type FormatsMode,
  type FormatsPhase,
  type FormatsProgress,
  type FormatsState,
} from './state';

export const FORMATS_SPOT_SIZE = 30;
export const FORMATS_SPOT_MAX_WRONG = 0;
/** Proposals inserted per step (the server answers between steps). */
const PROPOSE_CHUNK = 200;

export type FormatsStep = 'more' | 'wait' | 'idle';

/** The sidecar's kinds that list a book (its outcome 'listed'), as the card's reasons. */
const KIND_REASON: Record<string, ListedReason> = {
  series: 'series',
  'pdf-inside': 'pdf_inside',
  'kfx-inside': 'kfx_inside',
  'archive-inside': 'archive_inside',
  'text-archive': 'text_archive',
  'not-book': 'not_book',
  unknown: 'unknown',
};

export interface FormatJobView {
  id: number;
  calibreId: number;
  uuid: string;
  title: string;
  format: string;
  timeoutSeconds: number;
  calibreLibrary: string | null;
}

export interface FormatsPassDeps {
  db: Database.Database;
  main: Database.Database;
  cacheDir: string;
  calibreDir: string | null;
  batches: BatchService;
  writes: FormatBatches;
  /** The checked EPUBs waiting to be written (CACHE_DIR/cleanup/formats). */
  store: EpubStore;
  reader: () => Stage3Reader;
  /** The cleanup's library. */
  library: () => string | null;
  /** Why a write must wait now (a batch open, earlier stages writing, the checks, the sidecar). */
  writeWait: (lib: string) => string | null;
  /** The content server's id of a reader library. */
  calibreLibraryOf: (lib: string) => string | null;
  /** The shared disk lock (a conversion reads the library: Calibre's side). */
  disk?: { tryAcquire(owner: string, side: 'calibre'): boolean; release(owner: string): void };
  log?: (m: string) => void;
}

interface BookRow {
  id: number;
  library_id: string;
  calibre_uuid: string;
  calibre_id: number;
  run: number;
  title: string;
  authors_json: string;
  tags_json: string;
  formats_json: string;
  last_modified: string | null;
  source_format: string | null;
  state: string;
  listed_reason: string | null;
  detail: string | null;
  lease_until: number | null;
  attempts: number;
  result_json: string | null;
  epub_sha256: string | null;
  epub_size: number | null;
  check_json: string | null;
  twins_json: string;
  compare_json: string | null;
  verdict: string | null;
  change_id: number | null;
  converted_at: number | null;
  updated_at: number;
}

const DISK_OWNER = DISK_OWNERS.calibreFormats;

const orderKey = (run: number, uuid: string) =>
  createHash('sha256').update(`formats:${run}:${uuid}`).digest('hex');

export class FormatsPass {
  private readonly db: Database.Database;
  /** One check or comparison at a time (they run the reader processes). */
  private busy = false;
  /** The book whose conversion holds the disk lock. */
  private diskJob: number | null = null;

  constructor(private readonly deps: FormatsPassDeps) {
    this.db = deps.db;
  }

  state(): FormatsState {
    return getFormatsState(this.db);
  }

  setMode(mode: FormatsMode): void {
    if (mode === 'on' && !this.spotPassed())
      throw new Error('Switch On only after the spot check: every book marked, none wrong');
    setFormatsMode(this.db, mode);
    if (mode === 'off') this.releaseDisk();
    this.deps.log?.(`Books without an EPUB: ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  resume(): void {
    resumeFormats(this.db);
  }

  private releaseDisk(): void {
    if (this.diskJob !== null) this.deps.disk?.release(DISK_OWNER);
    this.diskJob = null;
  }

  /**
   * Looks again from the start (a new run): every book not written, queued or undone is selected
   * and converted again; written books have their EPUB and are no longer selected.
   */
  again(): void {
    const p = this.state().progress;
    const lib = p.libraryId;
    if (lib) {
      const rows = this.db
        .prepare(
          `SELECT b.id, b.calibre_uuid FROM calibre_format_books b
           LEFT JOIN proposed_changes c ON c.id = b.change_id
           WHERE b.library_id = ? AND (c.id IS NULL OR c.state IN ('proposed', 'skipped', 'kept'))`,
        )
        .all(lib) as { id: number; calibre_uuid: string }[];
      this.db.transaction(() => {
        this.db
          .prepare(
            `DELETE FROM proposed_changes WHERE stage = ${FORMATS_STAGE} AND library_id = ?
               AND state IN ('proposed', 'skipped', 'kept') AND batch_id IS NULL`,
          )
          .run(lib);
        const del = this.db.prepare('DELETE FROM calibre_format_books WHERE id = ?');
        for (const r of rows) del.run(r.id);
        this.db.prepare('DELETE FROM calibre_formats_spot').run();
      })();
      for (const r of rows)
        void this.deps.store.remove(lib, r.calibre_uuid).catch(() => {
          // Gone already.
        });
    }
    this.releaseDisk();
    resumeFormats(this.db);
    saveFormatsProgress(this.db, emptyFormatsProgress(p.run + 1, lib));
  }

  private next(p: FormatsProgress, phase: FormatsPhase): void {
    p.phase = phase;
    p.phaseStartedAt = Date.now();
    p.error = null;
    if (phase === 'done') p.finishedAt = Date.now();
  }

  private snapshotMtime(lib: string): number | null {
    try {
      return Math.round(fs.statSync(snapshotFile(this.deps.cacheDir, lib)).mtimeMs);
    } catch {
      return null;
    }
  }

  /** One step; 'idle' when there is nothing to do now. */
  async step(shouldStop: () => boolean = () => false): Promise<FormatsStep> {
    const st = this.state();
    if (st.mode === 'off') return 'idle';
    const lib = this.deps.library();
    let p = st.progress;
    if (!lib) {
      p.write.waiting = 'Choose the library to clean';
      saveFormatsProgress(this.db, p);
      return 'idle';
    }
    if (p.libraryId !== lib) {
      p = emptyFormatsProgress(p.run + (p.libraryId ? 1 : 0), lib);
      saveFormatsProgress(this.db, p);
    }
    if (st.pausedReason) return 'idle';
    if (p.phase === 'done') {
      const mtime = this.snapshotMtime(lib);
      if (mtime === null || mtime === p.snapshotMtimeMs) {
        if (await this.deps.writes.verifyStored()) return 'more';
        return 'idle';
      }
      // A newer snapshot: one indexed query for books without an EPUB the pass doesn't know
      // (books added by hand since); the full select only when there are some.
      if (!this.hasNewBooks(lib)) {
        p.snapshotMtimeMs = mtime;
        saveFormatsProgress(this.db, p);
        return 'idle';
      }
      this.next(p, 'select');
    }
    p.startedAt ??= Date.now();
    p.phaseStartedAt ??= Date.now();
    const phase = p.phase;
    const t0 = performance.now();
    let r: FormatsStep = 'idle';
    try {
      if (p.phase === 'select') r = this.selectStep(p, lib);
      else if (p.phase === 'convert') r = await this.convertStep(p, lib);
      else if (p.phase === 'compare') r = await this.compareStep(p, lib);
      else if (p.phase === 'propose') r = this.proposeStep(p, lib);
      else if (p.phase === 'spot') r = this.spotStep(p, lib, st.mode);
      else if (p.phase === 'write')
        r = st.mode === 'on' ? await this.writeStep(p, lib, shouldStop) : 'idle';
    } catch (err) {
      p.error = String((err as Error).message ?? err).slice(0, 500);
      this.deps.log?.(`Books without an EPUB failed: ${p.error}`);
      r = 'idle';
    } finally {
      const ms = performance.now() - t0;
      const t = ((p.times ??= {})[phase] ??= { n: 0, maxMs: 0, totalMs: 0 });
      t.n++;
      t.maxMs = Math.max(t.maxMs, Math.round(ms));
      t.totalMs += Math.round(ms);
      // A step may have changed the mode or the pause: only the progress is saved.
      saveFormatsProgress(this.db, p);
    }
    return r;
  }

  // ------------------------------------------------------------------- select

  /** Selects the library's books without an EPUB not selected before (one read of the snapshot). */
  private selectStep(p: FormatsProgress, lib: string): FormatsStep {
    const file = snapshotFile(this.deps.cacheDir, lib);
    const mtime = this.snapshotMtime(lib);
    if (mtime === null) {
      p.write.waiting = "The reader's copy of the library isn't there yet";
      return 'idle';
    }
    const added = this.select(lib, p.run, file);
    p.snapshotMtimeMs = mtime;
    p.write.waiting = null;
    if (added === 0 && this.openRows(lib) === 0 && p.finishedAt !== null) {
      // Looked again after the run finished: nothing new.
      this.next(p, 'done');
      return 'idle';
    }
    this.next(p, 'convert');
    return 'more';
  }

  /** The UUIDs the pass knows (selected, or a write undone: never selected again). */
  private knownUuids(lib: string): Set<string> {
    const known = new Set(
      (
        this.db
          .prepare('SELECT calibre_uuid FROM calibre_format_books WHERE library_id = ?')
          .all(lib) as { calibre_uuid: string }[]
      ).map((r) => r.calibre_uuid),
    );
    for (const r of this.db
      .prepare(
        `SELECT calibre_uuid, back_uuid FROM calibre_format_writes WHERE library_id = ? AND state = 'undone'`,
      )
      .all(lib) as { calibre_uuid: string; back_uuid: string | null }[]) {
      known.add(r.calibre_uuid);
      if (r.back_uuid) known.add(r.back_uuid);
    }
    return known;
  }

  /** Whether the library's snapshot has a book without an EPUB the pass doesn't know. */
  hasNewBooks(lib: string): boolean {
    const known = this.knownUuids(lib);
    try {
      return nonEpubUuids(snapshotFile(this.deps.cacheDir, lib)).some((u) => !known.has(u));
    } catch {
      return false;
    }
  }

  /** Rows of books new to the pass; returns how many. Pure on the snapshot and the database. */
  select(lib: string, run: number, snapshot: string, now = Date.now()): number {
    const settings = getSettings(this.db).formats;
    const { books, byTitle } = readFormatCandidates(snapshot);
    // Never again: a book (or a copy brought back under a new UUID) whose write was undone.
    const known = this.knownUuids(lib);
    const insert = this.db.prepare(
      `INSERT INTO calibre_format_books (library_id, calibre_uuid, calibre_id, run, title, authors_json,
         tags_json, formats_json, last_modified, source_format, state, listed_reason, detail, twins_json,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const b of books) {
        if (known.has(b.uuid)) continue;
        const choice = chooseFile(b);
        const listed = 'listed' in choice ? choice.listed : null;
        const file: FormatFile | null = 'file' in choice ? choice.file : null;
        const twins = listed ? [] : twinsOf(b, byTitle, settings.maxTwins);
        insert.run(
          lib,
          b.uuid,
          b.calibreId,
          run,
          b.title,
          JSON.stringify(b.authors),
          JSON.stringify(b.tags),
          JSON.stringify(b.formats),
          b.lastModified,
          file?.format ?? null,
          listed ? 'listed' : 'waiting',
          listed,
          listed ? LISTED_TEXT[listed] : null,
          JSON.stringify(twins),
          now,
        );
        n++;
      }
    })();
    return n;
  }

  private openRows(lib: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_format_books INDEXED BY calibre_format_books_state
           WHERE library_id = ? AND state IN ('waiting', 'converting', 'converted', 'checked', 'compared')`,
        )
        .get(lib) as { n: number }
    ).n;
  }

  // ------------------------------------------------------------------- the conversion jobs

  /** Leases that ran out: the book is handed out again, or listed as failed after the last try. */
  private expireJobs(now = Date.now()): void {
    const max = getSettings(this.db).formats.maxAttempts;
    const expired = this.db
      .prepare(
        `SELECT id, attempts FROM calibre_format_books INDEXED BY calibre_format_books_state
         WHERE state = 'converting' AND lease_until <= ?`,
      )
      .all(now) as { id: number; attempts: number }[];
    for (const r of expired) {
      if (this.diskJob === r.id) this.releaseDisk();
      if (r.attempts >= max)
        this.db
          .prepare(
            `UPDATE calibre_format_books SET state = 'listed', listed_reason = 'failed', lease_until = NULL,
               detail = 'The sidecar stopped answering about it (tried ' || attempts || ' times)', updated_at = ?
             WHERE id = ?`,
          )
          .run(now, r.id);
      else
        this.db
          .prepare(
            `UPDATE calibre_format_books SET state = 'waiting', lease_until = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, r.id);
    }
  }

  /** The next book for the sidecar to convert, or null (Off, paused, not converting, disk busy). */
  claimJob(now = Date.now()): FormatJobView | null {
    const st = this.state();
    const lib = st.progress.libraryId;
    if (st.mode === 'off' || st.pausedReason || st.progress.phase !== 'convert' || !lib)
      return null;
    this.expireJobs(now);
    const settings = getSettings(this.db).formats;
    // One conversion at a time.
    const running = this.db
      .prepare(
        `SELECT 1 FROM calibre_format_books INDEXED BY calibre_format_books_state
         WHERE library_id = ? AND state = 'converting' LIMIT 1`,
      )
      .get(lib);
    if (running) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM calibre_format_books INDEXED BY calibre_format_books_state
         WHERE library_id = ? AND state = 'waiting' ORDER BY id LIMIT 1`,
      )
      .get(lib) as BookRow | undefined;
    if (!row) return null;
    if (this.deps.disk) {
      if (!this.deps.disk.tryAcquire(DISK_OWNER, 'calibre')) return null;
      this.diskJob = row.id;
    }
    this.db
      .prepare(
        `UPDATE calibre_format_books SET state = 'converting', lease_until = ?, attempts = attempts + 1,
           updated_at = ? WHERE id = ?`,
      )
      .run(now + settings.jobLeaseMinutes * 60_000, now, row.id);
    return {
      id: row.id,
      calibreId: row.calibre_id,
      uuid: row.calibre_uuid,
      title: row.title,
      format: row.source_format!,
      timeoutSeconds: settings.convertTimeoutSeconds,
      calibreLibrary: this.deps.calibreLibraryOf(lib),
    };
  }

  private jobRow(jobId: number): BookRow {
    const row = this.db.prepare('SELECT * FROM calibre_format_books WHERE id = ?').get(jobId) as
      | BookRow
      | undefined;
    if (!row) throw new FormatsError(404, 'not_found', 'No such job');
    if (row.state !== 'converting')
      throw new FormatsError(
        409,
        'not_claimed',
        'The job is not being converted (its lease may have run out)',
      );
    return row;
  }

  jobAlive(jobId: number, now = Date.now()): void {
    this.jobRow(jobId);
    const minutes = getSettings(this.db).formats.jobLeaseMinutes;
    this.db
      .prepare('UPDATE calibre_format_books SET lease_until = ?, updated_at = ? WHERE id = ?')
      .run(now + minutes * 60_000, now, jobId);
  }

  /** The job's EPUB, streamed in and checked against the SHA-256 the sidecar sent. */
  async receiveEpub(jobId: number, body: Readable, sha256: string, size: number): Promise<void> {
    const row = this.jobRow(jobId);
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new FormatsError(400, 'bad_sha', 'A SHA-256 is needed');
    try {
      await this.deps.store.receive(row.library_id, row.calibre_uuid, body, sha256, size);
    } catch (err) {
      if (err instanceof EpubStoreError) throw new FormatsError(400, 'bad_upload', err.message);
      throw err;
    }
  }

  /** The sidecar's answer for a job. */
  finishJob(jobId: number, facts: JobFacts, now = Date.now()): void {
    const row = this.jobRow(jobId);
    const settings = getSettings(this.db).formats;
    if (this.diskJob === jobId) this.releaseDisk();
    const set = (state: string, reason: string | null, detail: string | null) =>
      this.db
        .prepare(
          `UPDATE calibre_format_books SET state = ?, listed_reason = ?, detail = ?, lease_until = NULL,
             result_json = ?, epub_sha256 = ?, epub_size = ?, converted_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          state,
          reason,
          detail,
          JSON.stringify(facts),
          state === 'converted' ? facts.epubSha256 : null,
          state === 'converted' ? facts.epubSize : null,
          now,
          now,
          jobId,
        );
    switch (facts.outcome) {
      case 'converted': {
        if (!facts.epubSha256 || !this.deps.store.has(row.library_id, row.calibre_uuid))
          throw new FormatsError(409, 'no_epub', 'Upload the EPUB before the answer');
        set('converted', null, facts.detail);
        return;
      }
      case 'drm':
        set('listed', 'drm', facts.detail ?? LISTED_TEXT.drm);
        return;
      case 'gone':
        set('listed', 'gone', facts.detail ?? LISTED_TEXT.gone);
        return;
      case 'listed': {
        const reason = KIND_REASON[facts.kind ?? ''] ?? 'unknown';
        set(
          'listed',
          reason,
          facts.detail ? `${LISTED_TEXT[reason]}: ${facts.detail}` : LISTED_TEXT[reason],
        );
        return;
      }
      default: {
        if (row.attempts < settings.maxAttempts) {
          this.db
            .prepare(
              `UPDATE calibre_format_books SET state = 'waiting', lease_until = NULL, detail = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(facts.detail, now, jobId);
          return;
        }
        set('listed', 'failed', facts.detail ?? LISTED_TEXT.failed);
      }
    }
  }

  /** Checks the next converted book (the reader's own import); then, all done, compare. */
  private async convertStep(p: FormatsProgress, lib: string): Promise<FormatsStep> {
    this.expireJobs();
    const row = this.db
      .prepare(
        `SELECT * FROM calibre_format_books INDEXED BY calibre_format_books_state
         WHERE library_id = ? AND state = 'converted' ORDER BY converted_at LIMIT 1`,
      )
      .get(lib) as BookRow | undefined;
    if (row) {
      if (this.busy) return 'wait';
      this.busy = true;
      try {
        await this.checkRow(row);
      } finally {
        this.busy = false;
      }
      return 'more';
    }
    const open = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_format_books INDEXED BY calibre_format_books_state
           WHERE library_id = ? AND state IN ('waiting', 'converting')`,
        )
        .get(lib) as { n: number }
    ).n;
    if (open > 0) return 'wait';
    this.next(p, 'compare');
    return 'more';
  }

  private async checkRow(row: BookRow, now = Date.now()): Promise<void> {
    const facts = JSON.parse(row.result_json!) as JobFacts;
    const file = this.deps.store.file(row.library_id, row.calibre_uuid);
    const result = await checkEpub(file, facts, this.deps.reader(), getSettings(this.db).formats);
    if (result.ok) {
      this.db
        .prepare(
          `UPDATE calibre_format_books SET state = 'checked', check_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(result), now, row.id);
      return;
    }
    this.db
      .prepare(
        `UPDATE calibre_format_books SET state = 'listed', listed_reason = 'check_failed', detail = ?,
           check_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(`${LISTED_TEXT.check_failed}: ${result.reason}`, JSON.stringify(result), now, row.id);
    await this.deps.store.remove(row.library_id, row.calibre_uuid);
  }

  // ------------------------------------------------------------------- compare

  private async compareStep(p: FormatsProgress, lib: string): Promise<FormatsStep> {
    const row = this.db
      .prepare(
        `SELECT * FROM calibre_format_books INDEXED BY calibre_format_books_state
         WHERE library_id = ? AND state = 'checked' ORDER BY id LIMIT 1`,
      )
      .get(lib) as BookRow | undefined;
    if (!row) {
      this.next(p, 'propose');
      return 'more';
    }
    if (this.busy) return 'wait';
    this.busy = true;
    try {
      await this.compareRow(row, lib);
    } finally {
      this.busy = false;
    }
    return 'more';
  }

  private async compareRow(row: BookRow, lib: string, now = Date.now()): Promise<void> {
    const t0 = Date.now();
    const twins = JSON.parse(row.twins_json) as Twin[];
    const check = JSON.parse(row.check_json!) as CheckResult;
    const settings = getSettings(this.db);
    const measures: TwinMeasure[] = [];
    if (twins.length > 0 && (check.readerChars ?? 0) >= settings.duplicates.imageOnlyMaxChars) {
      const file = this.deps.store.file(lib, row.calibre_uuid);
      const libDir = this.libraryDir(lib);
      const books: { key: number; file: string }[] = [{ key: -1, file }];
      for (const t of twins) {
        // Calibre renames folders on every write: the twin's EPUB is looked up by UUID now.
        let rel: string | null = null;
        try {
          rel = this.deps.writes.liveBook(lib, t.uuid)?.formats.get('EPUB') ?? null;
        } catch {
          rel = t.epubPath;
        }
        if (!rel || !libDir) {
          measures.push(twinError(t, 'No longer in Calibre with an EPUB'));
          continue;
        }
        books.push({ key: t.calibreId, file: resolveInside(libDir, rel) });
      }
      const pairs = books.slice(1).map((b) => [-1, b.key] as [number, number]);
      const out = pairs.length
        ? await this.deps.reader().compare(books, pairs, { minRun: 100, minContext: 500 })
        : null;
      for (const t of twins) {
        if (measures.some((m) => m.twinId === t.calibreId)) continue;
        if (!out || !out.ok) {
          measures.push(twinError(t, out && !out.ok ? out.message : 'Not measured'));
          continue;
        }
        const m = out.data.pairs.find((x) => x.a === -1 && x.b === t.calibreId);
        if (!m) {
          measures.push(twinError(t, 'A copy could not be read'));
          continue;
        }
        measures.push({
          twinId: t.calibreId,
          twinUuid: t.uuid,
          twinTitle: t.title,
          copyInTwin: m.aInB,
          twinInCopy: m.bInA,
          extraCopy: m.extraA,
          extraTwin: m.extraB,
          error: null,
        });
      }
    }
    const decision = decideCopy(
      row.title,
      check.readerChars ?? 0,
      twins.length > 0 && measures.length === 0
        ? twins.map((t) => twinError(t, 'Not compared'))
        : measures,
      settings.duplicates,
      settings.formats.sameMin,
      settings.formats.copyExtraMax,
    );
    this.db
      .prepare(
        `UPDATE calibre_format_books SET state = 'compared', verdict = ?, compare_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        decision.verdict,
        JSON.stringify({
          decision,
          measures: measures.map((m) => ({ ...m, extraCopy: undefined, extraTwin: undefined })),
          ms: Date.now() - t0,
        }),
        now,
        row.id,
      );
  }

  private libraryDir(lib: string): string | null {
    const l = getLibrary(this.deps.main, lib);
    return l && this.deps.calibreDir ? path.join(this.deps.calibreDir, l.folder) : null;
  }

  // ------------------------------------------------------------------- propose

  private proposeStep(p: FormatsProgress, lib: string, now = Date.now()): FormatsStep {
    const rows = this.db
      .prepare(
        `SELECT * FROM calibre_format_books INDEXED BY calibre_format_books_state
         WHERE library_id = ? AND state = 'compared' ORDER BY id LIMIT ${PROPOSE_CHUNK}`,
      )
      .all(lib) as BookRow[];
    if (rows.length === 0) {
      this.next(p, 'spot');
      return 'more';
    }
    const insert = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (${FORMATS_STAGE}, ?, ?, ?, ?, ?, ?, 'formats', ?, ?, ?, 'proposed', ?, ?, ?)`,
    );
    const done = this.db.prepare(
      `UPDATE calibre_format_books SET state = 'proposed', change_id = ?, updated_at = ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        const ev = this.evidenceOf(r);
        const cmp = r.compare_json
          ? (JSON.parse(r.compare_json) as { decision: ReturnType<typeof decideCopy> })
          : null;
        const near = r.verdict === 'near';
        const fold = r.verdict === 'fold' || near;
        const formats = (JSON.parse(r.formats_json) as FormatFile[]).map((f) => f.format);
        const id = insert.run(
          lib,
          r.calibre_id,
          r.calibre_uuid,
          fold ? 'fold' : 'epub',
          JSON.stringify(formats),
          JSON.stringify(
            fold
              ? { twin: ev.twin?.calibreId ?? null, addFormat: ev.addFormat ?? null }
              : { format: 'EPUB', sha256: r.epub_sha256, size: r.epub_size },
          ),
          JSON.stringify(ev),
          near ? 'review' : 'auto',
          near ? (cmp?.decision.reason ?? 'Part of the text in common') : null,
          formatsAnalysisId(r.run),
          now,
          now,
        ).lastInsertRowid as number;
        done.run(id, now, r.id);
      }
    })();
    return 'more';
  }

  private evidenceOf(r: BookRow): FormatEvidence {
    const facts = r.result_json ? (JSON.parse(r.result_json) as JobFacts) : null;
    const check = r.check_json ? (JSON.parse(r.check_json) as CheckResult) : null;
    const cmp = r.compare_json
      ? (JSON.parse(r.compare_json) as { decision: ReturnType<typeof decideCopy> })
      : null;
    const fold = r.verdict === 'fold' || r.verdict === 'near';
    const decision = cmp?.decision;
    const twins = JSON.parse(r.twins_json) as Twin[];
    const twinId = decision && 'twin' in decision ? decision.twin.twinId : null;
    const twin = twins.find((t) => t.calibreId === twinId) ?? null;
    return {
      kind: fold ? 'fold' : 'convert',
      title: r.title,
      authors: JSON.parse(r.authors_json) as string[],
      tags: JSON.parse(r.tags_json) as string[],
      lastModified: r.last_modified,
      formats: (JSON.parse(r.formats_json) as FormatFile[]).map((f) => f.format),
      sourceFormat: r.source_format!,
      sourceSha256: facts?.sourceSha256 ?? '',
      sourceSize: facts?.sourceSize ?? null,
      epubSha256: r.epub_sha256,
      epubSize: r.epub_size,
      twin:
        fold && twin
          ? {
              calibreId: twin.calibreId,
              uuid: twin.uuid,
              title: twin.title,
              formats: twin.formats,
              tags: this.tagsOf(r.library_id, twin.uuid),
            }
          : undefined,
      addFormat:
        fold && twin ? (twin.formats.includes(r.source_format!) ? null : r.source_format) : null,
      how: decision?.verdict === 'fold' ? decision.how : null,
      reason: decision?.reason ?? null,
      facts: {
        kind: facts?.kind ?? null,
        method: facts?.method ?? null,
        group: check?.group ?? null,
        sourceChars: facts?.sourceChars ?? null,
        epubChars: facts?.epubChars ?? null,
        readerChars: check?.readerChars ?? null,
        chapters: check?.chapters ?? null,
        sourceImages: facts?.sourceImages ?? null,
        epubImages: check?.epubImages ?? null,
        textShare: check?.textShare ?? null,
        convertMs: facts?.ms ?? null,
      },
    };
  }

  /** A twin's tags from the reader's snapshot (the user's own are copied to it on a fold). */
  private tagsOf(lib: string, uuid: string): string[] {
    try {
      const db = new Database(snapshotFile(this.deps.cacheDir, lib), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        return (
          db
            .prepare(
              `SELECT t.name FROM books b JOIN books_tags_link l ON l.book = b.id JOIN tags t ON t.id = l.tag
               WHERE b.uuid = ?`,
            )
            .all(uuid) as { name: string }[]
        ).map((x) => x.name);
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------- spot check

  private spotStep(p: FormatsProgress, lib: string, mode: FormatsMode): FormatsStep {
    const drawn = (
      this.db.prepare('SELECT COUNT(*) AS n FROM calibre_formats_spot').get() as { n: number }
    ).n;
    if (drawn === 0) {
      const rows = this.db
        .prepare(
          `SELECT id, calibre_uuid, evidence_json FROM proposed_changes INDEXED BY proposed_changes_formats
           WHERE stage = ${FORMATS_STAGE} AND library_id = ? AND analysis_id = ? AND state = 'proposed'
             AND class = 'auto' AND field = 'epub'`,
        )
        .all(lib, formatsAnalysisId(p.run)) as {
        id: number;
        calibre_uuid: string;
        evidence_json: string;
      }[];
      const books = rows.map((r) => ({
        changeId: r.id,
        uuid: r.calibre_uuid,
        group: String((JSON.parse(r.evidence_json) as FormatEvidence).facts?.group ?? 'text'),
      }));
      const pick = drawSpot(books, FORMATS_SPOT_SIZE, (u) => orderKey(p.run, u));
      const put = this.db.prepare(
        `INSERT OR IGNORE INTO calibre_formats_spot (library_id, calibre_uuid, change_id, position, kind)
         VALUES (?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() =>
        pick.forEach((b, i) => put.run(lib, b.uuid, b.changeId, i, b.group)),
      )();
    }
    if (mode !== 'on' || !this.spotPassed()) return 'idle';
    this.next(p, 'write');
    return 'more';
  }

  spotCounts(): { total: number; right: number; wrong: number; open: number } {
    const rows = this.db
      .prepare('SELECT verdict, COUNT(*) AS n FROM calibre_formats_spot GROUP BY verdict')
      .all() as { verdict: string | null; n: number }[];
    const by = (v: string | null) => rows.find((r) => r.verdict === v)?.n ?? 0;
    return {
      total: rows.reduce((a, r) => a + r.n, 0),
      right: by('right'),
      wrong: by('wrong'),
      open: by(null),
    };
  }

  spotPassed(): boolean {
    const c = this.spotCounts();
    return c.total > 0 && c.open === 0 && c.wrong <= FORMATS_SPOT_MAX_WRONG;
  }

  setVerdict(uuid: string, verdict: 'right' | 'wrong' | null, now = Date.now()): void {
    const p = this.state().progress;
    if (p.phase === 'write' || p.phase === 'done')
      throw new Error('The spot check is closed: the pass is writing or done');
    const changed = this.db
      .prepare('UPDATE calibre_formats_spot SET verdict = ?, decided_at = ? WHERE calibre_uuid = ?')
      .run(verdict, verdict ? now : null, uuid).changes;
    if (changed === 0) throw new Error('No such book in the spot check');
  }

  spotList(): FormatBookView[] {
    const rows = this.db
      .prepare(
        `SELECT s.verdict, s.kind AS spot_kind, b.* FROM calibre_formats_spot s
         JOIN calibre_format_books b ON b.library_id = s.library_id AND b.calibre_uuid = s.calibre_uuid
         ORDER BY s.position`,
      )
      .all() as (BookRow & { verdict: 'right' | 'wrong' | null })[];
    return rows.map((r) => ({ ...this.view(r), mark: r.verdict }));
  }

  /** The checked EPUB of a book on the card (spot check and review), for the user to open. */
  epubFileOf(uuid: string): { file: string; title: string } {
    const lib = this.state().progress.libraryId;
    const r = this.db
      .prepare('SELECT * FROM calibre_format_books WHERE library_id = ? AND calibre_uuid = ?')
      .get(lib, uuid) as BookRow | undefined;
    if (!r || !lib) throw new FormatsError(404, 'not_found', 'No such book');
    const file = this.deps.store.file(lib, uuid);
    if (!fs.existsSync(file))
      throw new FormatsError(410, 'gone', 'The EPUB is not kept any more (written, or not made)');
    return { file, title: r.title };
  }

  // ------------------------------------------------------------------- write

  private async writeStep(
    p: FormatsProgress,
    lib: string,
    shouldStop: () => boolean,
  ): Promise<FormatsStep> {
    if (!shouldStop() && (await this.deps.writes.verifyStored())) return 'more';
    if (this.state().pausedReason) return 'idle';
    const wait = this.deps.writeWait(lib);
    if (wait) {
      p.write.waiting = wait;
      return 'wait';
    }
    const left = this.leftToWrite(lib, p.run);
    if (left === 0) {
      p.write.waiting = null;
      this.next(p, 'done');
      return 'idle';
    }
    const { batch, reason } = this.deps.writes.plan(lib, formatsAnalysisId(p.run));
    p.write.waiting = reason;
    if (batch) {
      p.write.startedAt ??= Date.now();
      p.write.doneAtStart ??= this.writtenCount(lib);
      p.write.batches.push(batch.id);
      this.deps.log?.(`Books without an EPUB: batch ${batch.id} (${batch.itemCount} books)`);
    }
    return 'wait';
  }

  leftToWrite(lib: string, run: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_formats
           WHERE stage = ${FORMATS_STAGE} AND library_id = ? AND analysis_id = ? AND state IN ('proposed', 'queued')
             AND class = 'auto'`,
        )
        .get(lib, formatsAnalysisId(run)) as { n: number }
    ).n;
  }

  writtenCount(lib: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_format_writes WHERE library_id = ? AND state = 'written'`,
        )
        .get(lib) as { n: number }
    ).n;
  }

  // ------------------------------------------------------------------- the review (near pairs)

  /** "Fold it", "Its own book" (the checked EPUB to its own record) or "Leave it" for a near pair. */
  choose(changeId: number, choice: 'fold' | 'convert' | 'leave', now = Date.now()): void {
    const r = this.db
      .prepare(
        `SELECT state, class, field, evidence_json FROM proposed_changes WHERE id = ? AND stage = ${FORMATS_STAGE}`,
      )
      .get(changeId) as
      | { state: string; class: string; field: string; evidence_json: string }
      | undefined;
    if (!r) throw new Error('No such book');
    if (!['proposed', 'kept'].includes(r.state) || (r.class === 'auto' && r.state !== 'kept'))
      throw new Error('This book is being written or was written');
    const ev = { ...(JSON.parse(r.evidence_json) as FormatEvidence), choice };
    if (choice === 'convert') {
      ev.kind = 'convert';
      if (!ev.epubSha256) throw new Error('This book has no checked EPUB');
    } else if (choice === 'fold') ev.kind = 'fold';
    this.db
      .prepare(
        `UPDATE proposed_changes SET class = ?, state = ?, field = ?, decided_by = 'you', decided_at = ?,
           evidence_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        choice === 'leave' ? 'review' : 'auto',
        choice === 'leave' ? 'kept' : 'proposed',
        choice === 'convert' ? 'epub' : 'fold',
        now,
        JSON.stringify(ev),
        now,
        changeId,
      );
    const p = this.state().progress;
    if (choice !== 'leave' && p.phase === 'done') {
      this.next(p, 'write');
      saveFormatsProgress(this.db, p);
    }
  }

  // ------------------------------------------------------------------- views

  private view(r: BookRow): FormatBookView {
    const facts = r.result_json ? (JSON.parse(r.result_json) as JobFacts) : null;
    const check = r.check_json ? (JSON.parse(r.check_json) as CheckResult) : null;
    const cmp = r.compare_json
      ? (JSON.parse(r.compare_json) as { decision: ReturnType<typeof decideCopy> })
      : null;
    const change = r.change_id
      ? (this.db
          .prepare(
            'SELECT id, state, class, field, review_reason, decided_by FROM proposed_changes WHERE id = ?',
          )
          .get(r.change_id) as
          | {
              id: number;
              state: string;
              class: string;
              field: string;
              review_reason: string | null;
              decided_by: string | null;
            }
          | undefined)
      : undefined;
    const decision = cmp?.decision;
    return {
      uuid: r.calibre_uuid,
      calibreId: r.calibre_id,
      title: r.title,
      authors: JSON.parse(r.authors_json) as string[],
      formats: (JSON.parse(r.formats_json) as FormatFile[]).map((f) => f.format),
      sourceFormat: r.source_format,
      state: r.state,
      listedReason: r.listed_reason,
      detail: r.detail,
      kind: facts?.kind ?? null,
      method: facts?.method ?? null,
      group: check?.group ?? null,
      sourceChars: facts?.sourceChars ?? null,
      epubChars: facts?.epubChars ?? null,
      readerChars: check?.readerChars ?? null,
      sourceImages: facts?.sourceImages ?? null,
      epubImages: check?.epubImages ?? null,
      epubSize: r.epub_size,
      checkReason: check?.reason ?? null,
      verdict: r.verdict,
      reason: decision?.reason ?? null,
      twin:
        decision && 'twin' in decision
          ? { calibreId: decision.twin.twinId, title: decision.twin.twinTitle }
          : null,
      change: change
        ? {
            id: change.id,
            state: change.state,
            klass: change.class,
            field: change.field,
            reason: change.review_reason,
            decidedBy: change.decided_by,
          }
        : null,
      hasEpub: this.deps.store.has(r.library_id, r.calibre_uuid),
    };
  }

  /** Books of the pass by what happened to them, paged. */
  list(
    lib: string,
    which: 'listed' | 'review' | 'fold' | 'convert' | 'all',
    offset = 0,
    limit = 50,
    reason?: string,
  ): { total: number; books: FormatBookView[] } {
    let where = 'b.library_id = ?';
    const params: unknown[] = [lib];
    if (which === 'listed') {
      where += ` AND b.state = 'listed'`;
      if (reason) {
        where += ' AND b.listed_reason = ?';
        params.push(reason);
      }
    } else if (which === 'review') where += ` AND c.class = 'review'`;
    else if (which === 'fold') where += ` AND c.class = 'auto' AND c.field = 'fold'`;
    else if (which === 'convert') where += ` AND c.class = 'auto' AND c.field = 'epub'`;
    const from = `FROM calibre_format_books b LEFT JOIN proposed_changes c ON c.id = b.change_id WHERE ${where}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number })
      .n;
    const rows = this.db
      .prepare(`SELECT b.* ${from} ORDER BY b.calibre_id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as BookRow[];
    return { total, books: rows.map((r) => this.view(r)) };
  }

  /** Counts for the card: books by state, listed by reason, proposals, spot, writes. */
  counts(lib: string): {
    byState: Record<string, number>;
    listed: Record<string, number>;
    proposals: Record<string, number>;
    written: { convert: number; fold: number; undone: number };
    stored: Record<string, number>;
  } {
    const byState: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        'SELECT state, COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? GROUP BY state',
      )
      .all(lib) as { state: string; n: number }[])
      byState[r.state] = r.n;
    const listed: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT listed_reason AS k, COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND state = 'listed'
         GROUP BY listed_reason`,
      )
      .all(lib) as { k: string; n: number }[])
      listed[r.k] = r.n;
    const proposals: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT field, class, state, COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_formats
         WHERE stage = ${FORMATS_STAGE} AND library_id = ? GROUP BY field, class, state`,
      )
      .all(lib) as { field: string; class: string; state: string; n: number }[])
      proposals[`${r.field}:${r.class}:${r.state}`] = r.n;
    const w = this.db
      .prepare(
        `SELECT SUM(kind = 'convert' AND state = 'written') AS c, SUM(kind = 'fold' AND state = 'written') AS f,
                SUM(state = 'undone') AS u FROM calibre_format_writes WHERE library_id = ?`,
      )
      .get(lib) as { c: number | null; f: number | null; u: number | null };
    const stored: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT state, COUNT(*) AS n FROM calibre_format_store GROUP BY state')
      .all() as { state: string; n: number }[])
      stored[r.state] = r.n;
    return {
      byState,
      listed,
      proposals,
      written: { convert: w.c ?? 0, fold: w.f ?? 0, undone: w.u ?? 0 },
      stored,
    };
  }

  /**
   * The bars with the time left, from what is still open and the measured times of the books
   * done in this run (lessons 4: never from an average over a stretch unlike what is left).
   */
  bars(lib: string, now = Date.now()): FormatsBar[] {
    const p = this.state().progress;
    const out: FormatsBar[] = [];
    const run = p.run;
    const n = (sql: string, ...params: unknown[]) =>
      (this.db.prepare(sql).get(...params) as { n: number | null }).n ?? 0;
    const selected = n(
      `SELECT COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND run = ? AND (state <> 'listed' OR result_json IS NOT NULL)`,
      lib,
      run,
    );
    if (selected > 0) {
      const open = n(
        `SELECT COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND run = ? AND state IN ('waiting', 'converting')`,
        lib,
        run,
      );
      // Time left: each open book by the mean time of the books of its format done so far.
      const means = new Map<string, number>();
      let all = 0;
      let allN = 0;
      for (const r of this.db
        .prepare(
          `SELECT source_format AS f, AVG(json_extract(result_json, '$.ms')) AS ms, COUNT(*) AS c
           FROM calibre_format_books WHERE library_id = ? AND result_json IS NOT NULL GROUP BY source_format`,
        )
        .all(lib) as { f: string; ms: number; c: number }[]) {
        means.set(r.f, r.ms);
        all += r.ms * r.c;
        allN += r.c;
      }
      let left: number | null = 0;
      for (const r of this.db
        .prepare(
          `SELECT source_format AS f, COUNT(*) AS c FROM calibre_format_books
           WHERE library_id = ? AND state IN ('waiting', 'converting') GROUP BY source_format`,
        )
        .all(lib) as { f: string; c: number }[]) {
        const m = means.get(r.f) ?? (allN ? all / allN : null);
        if (m === null || left === null) left = null;
        else left += m * r.c;
      }
      out.push({
        phase: 'convert',
        label: 'Converted',
        done: selected - open,
        total: selected,
        leftMs: open === 0 ? 0 : left,
        note: this.state().mode === 'off' ? 'Off: nothing is converted' : null,
      });
      const toCheck = n(
        `SELECT COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND run = ? AND state = 'converted'`,
        lib,
        run,
      );
      const checked = n(
        `SELECT COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND run = ? AND check_json IS NOT NULL`,
        lib,
        run,
      );
      const checkMs = n(
        `SELECT AVG(json_extract(check_json, '$.ms')) AS n FROM calibre_format_books WHERE library_id = ? AND check_json IS NOT NULL`,
        lib,
      );
      out.push({
        phase: 'check',
        label: 'Checked',
        done: checked,
        total: checked + toCheck + open,
        leftMs: checkMs ? checkMs * (toCheck + open) : null,
        note: null,
      });
      const toCompare = n(
        `SELECT COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND run = ? AND state = 'checked'`,
        lib,
        run,
      );
      const compared = n(
        `SELECT COUNT(*) AS n FROM calibre_format_books WHERE library_id = ? AND run = ? AND compare_json IS NOT NULL`,
        lib,
        run,
      );
      const cmpMs = n(
        `SELECT AVG(json_extract(compare_json, '$.ms')) AS n FROM calibre_format_books WHERE library_id = ? AND compare_json IS NOT NULL`,
        lib,
      );
      out.push({
        phase: 'compare',
        label: 'Compared with EPUB books of the same title',
        done: compared,
        total: compared + toCompare + toCheck + open,
        leftMs: cmpMs ? cmpMs * (toCompare + toCheck + open) : null,
        note: null,
      });
    }
    if (p.phase === 'write' || p.phase === 'done') {
      const left = this.leftToWrite(lib, run);
      const done = this.writtenCount(lib) - (p.write.doneAtStart ?? this.writtenCount(lib));
      const recent = (
        this.db
          .prepare(
            `SELECT written_at FROM calibre_format_writes WHERE library_id = ? ORDER BY written_at DESC LIMIT 50`,
          )
          .all(lib) as { written_at: number }[]
      ).map((r) => r.written_at);
      const pace =
        recent.length >= 2 ? (recent[0] - recent[recent.length - 1]) / (recent.length - 1) : null;
      out.push({
        phase: 'write',
        label: 'Written to Calibre',
        done: Math.max(0, done),
        total: Math.max(0, done) + left,
        leftMs:
          left === 0 ? 0 : pace !== null && now - recent[0] < 30 * 60_000 ? pace * left : null,
        note: p.write.waiting,
      });
    }
    return out;
  }

  /** Batches of the pass, newest first (Undo is the shared batches route). */
  batchesOf(limit = 50): BatchRow[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM batches WHERE stage = ${FORMATS_STAGE} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => this.deps.batches.get(r.id)!);
  }
}

export interface FormatsBar {
  phase: string;
  label: string;
  done: number;
  total: number;
  leftMs: number | null;
  note: string | null;
}

export interface FormatBookView {
  uuid: string;
  calibreId: number;
  title: string;
  authors: string[];
  formats: string[];
  sourceFormat: string | null;
  state: string;
  listedReason: string | null;
  detail: string | null;
  kind: string | null;
  method: string | null;
  group: string | null;
  sourceChars: number | null;
  epubChars: number | null;
  readerChars: number | null;
  sourceImages: number | null;
  epubImages: number | null;
  epubSize: number | null;
  checkReason: string | null;
  verdict: string | null;
  reason: string | null;
  twin: { calibreId: number; title: string } | null;
  change: {
    id: number;
    state: string;
    klass: string;
    field: string;
    reason: string | null;
    decidedBy: string | null;
  } | null;
  hasEpub: boolean;
  /** The spot check's mark (spot list only). */
  mark?: 'right' | 'wrong' | null;
}

export class FormatsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function twinError(t: Twin, error: string): TwinMeasure {
  return {
    twinId: t.calibreId,
    twinUuid: t.uuid,
    twinTitle: t.title,
    copyInTwin: null,
    twinInCopy: null,
    error,
  };
}

/** The spot check's books: in proportion to the groups, at least one of each, in a fixed order. */
export function drawSpot<T extends { uuid: string; group: string }>(
  books: T[],
  size: number,
  key: (uuid: string) => string,
): T[] {
  if (books.length <= size)
    return [...books].sort((a, b) => key(a.uuid).localeCompare(key(b.uuid)));
  const groups = new Map<string, T[]>();
  for (const b of books) {
    const g = groups.get(b.group);
    if (g) g.push(b);
    else groups.set(b.group, [b]);
  }
  for (const g of groups.values()) g.sort((a, b) => key(a.uuid).localeCompare(key(b.uuid)));
  const share = new Map<string, number>();
  for (const [name, g] of groups)
    share.set(name, Math.max(1, Math.floor((g.length / books.length) * size)));
  let total = [...share.values()].reduce((a, x) => a + x, 0);
  // Round to exactly `size`: the biggest groups give or take one.
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([n]) => n);
  for (let i = 0; total !== size && i < 1000; i++) {
    const name = order[i % order.length];
    const g = groups.get(name)!;
    const now = share.get(name)!;
    if (total < size && now < g.length) {
      share.set(name, now + 1);
      total++;
    } else if (total > size && now > 1) {
      share.set(name, now - 1);
      total--;
    }
  }
  const out: T[] = [];
  for (const [name, g] of groups) out.push(...g.slice(0, share.get(name)));
  return out.sort((a, b) => key(a.uuid).localeCompare(key(b.uuid)));
}
