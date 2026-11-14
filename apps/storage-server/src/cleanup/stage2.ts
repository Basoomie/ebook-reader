/**
 * Stage 2 analysis (WP20b, plan section 4): metadata and covers from the files.
 *
 * 1. read: every book with an EPUB in the indexer's metadata.db snapshot; the EPUB's own
 *    metadata and cover facts (file-metadata.ts) and Calibre's cover.jpg facts, read-only
 *    through source-fs, paced (files per second). The labeled books go first, so the gate is
 *    known early. Each book's evidence is kept in cleanup.db (evidence_records, kind 'file')
 *    and read again only when its EPUB or cover.jpg changed.
 * 2. propose: one proposed change per book and field (stage2-rules.ts), class auto or review.
 * 3. the gate on the labeled books (stage2-gate.ts) pauses a field below its bar; the review
 *    alarm pauses a field whose share of review results is far above the labeled books'.
 *
 * Resumable from its saved phase and cursor; writes nothing but cleanup.db.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { snapshotFile } from '../calibre/indexer';
import { getLibrary } from '../calibre/libraries';
import { resolveInside, statFile } from '../calibre/source-fs';
import { calibreCoverFacts, readFileMetadata } from './file-metadata';
import { getSettings, type CleanupSettings } from './settings';
import {
  applyGate,
  defaultReferenceFile,
  evaluateGate,
  listFieldPauses,
  loadGold,
  mapLabeledIds,
  pauseField,
  pauseForMissingLabels,
  resumeField,
  type GateResult,
} from './stage2-gate';
import {
  type CoverFacts,
  type FieldProposal,
  type FileFacts,
  type SpellingLookup,
  authorGroup,
  proposeStage2,
  titleGroup,
} from './stage2-rules';
import type { ScoredBook } from './stage2-score';
import {
  calibreFactsOf,
  readStage2Snapshot,
  spellingLookup,
  type Stage2Book,
  type Stage2Snapshot,
} from './stage2-snapshot';
import { getStage, updateStage } from './stages';

export const EVIDENCE_KIND = 'file';
export const EVIDENCE_VERSION = 1;

export interface FileEvidence {
  v: number;
  /** The EPUB (relative to the library) and its identity when it was read. */
  path: string;
  size: number | null;
  mtimeMs: number | null;
  file: FileFacts | null;
  error: string | null;
  /** Calibre's cover.jpg when it was read (null: the book had no cover). */
  cover: { size: number; mtimeMs: number; facts: CoverFacts | null } | null;
  readAt: number;
}

export function saveEvidence(
  db: Database.Database,
  libraryId: string,
  uuid: string,
  ev: FileEvidence,
): void {
  db.prepare(
    `INSERT INTO evidence_records (library_id, calibre_uuid, kind, version, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, calibre_uuid, kind) DO UPDATE SET version = excluded.version,
       data = excluded.data, created_at = excluded.created_at`,
  ).run(libraryId, uuid, EVIDENCE_KIND, EVIDENCE_VERSION, gzipSync(JSON.stringify(ev)), ev.readAt);
}

export function loadEvidence(
  db: Database.Database,
  libraryId: string,
  uuid: string,
): FileEvidence | null {
  const r = db
    .prepare(
      'SELECT version, data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = ?',
    )
    .get(libraryId, uuid, EVIDENCE_KIND) as { version: number; data: Buffer } | undefined;
  if (!r || r.version !== EVIDENCE_VERSION) return null;
  try {
    return JSON.parse(gunzipSync(r.data).toString('utf8')) as FileEvidence;
  } catch {
    return null;
  }
}

export type Stage2Phase = 'read' | 'propose' | 'done';

export interface Stage2Progress {
  analysisId: string;
  phase: Stage2Phase;
  libraryId: string;
  startedAt: number;
  finishedAt: number | null;
  /** read: the labeled books first, then all books (by Calibre id). */
  pass: 'labeled' | 'all';
  labeledIds: number[];
  cursor: number;
  readTotal: number;
  readDone: number;
  filesRead: number;
  reused: number;
  readErrors: number;
  booksWithoutEpub: number;
  proposeCursor: number;
  proposeDone: number;
  /** For the page's progress bar and time left. */
  phaseStartedAt: number;
  phaseStartDone: number;
  /** Counts after the propose phase. */
  books: number;
  booksWithChanges: number;
  /** Books whose title or first author changes (Calibre moves their folder). */
  folderMoves: number;
  /** Books whose Calibre author is the Japanese "不明" (counted as Unknown). */
  calibreUnknownJa: number;
  fields: Record<string, { auto: number; review: number }>;
  groups: { title: Record<string, number>; authors: Record<string, number> };
  sources: Record<string, number>;
  labelsError: string | null;
  error: string | null;
}

export function emptyStage2Progress(libraryId: string, now = Date.now()): Stage2Progress {
  return {
    analysisId: randomUUID(),
    phase: 'read',
    libraryId,
    startedAt: now,
    finishedAt: null,
    pass: 'labeled',
    labeledIds: [],
    cursor: 0,
    readTotal: 0,
    readDone: 0,
    filesRead: 0,
    reused: 0,
    readErrors: 0,
    booksWithoutEpub: 0,
    proposeCursor: 0,
    proposeDone: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    books: 0,
    booksWithChanges: 0,
    folderMoves: 0,
    calibreUnknownJa: 0,
    fields: {},
    groups: { title: {}, authors: {} },
    sources: {},
    labelsError: null,
    error: null,
  };
}

const READ_CHUNK = 20;
const PROPOSE_CHUNK = 1000;
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export interface Stage2Deps {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string;
  cacheDir: string;
  /** DB_DIR (for the default labels file). */
  dbDir?: string | null;
  log?: (m: string) => void;
}

export function proposalOptions(s: CleanupSettings, spelling?: SpellingLookup) {
  return {
    spelling,
    coverSameDistance: s.stage2.coverSameDistance,
    coverLargerFactor: 1 + s.stage2.coverLargerPercent / 100,
  };
}

export class Stage2Analysis {
  private snapshot: Stage2Snapshot | null = null;
  private snapshotFor: string | null = null;
  private spelling: SpellingLookup | null = null;
  private nextReadAt = 0;

  constructor(private readonly deps: Stage2Deps) {}

  progress(): Stage2Progress | null {
    const p = getStage(this.deps.cleanup, 2).progress as unknown as Stage2Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: Stage2Progress, state?: string): void {
    updateStage(this.deps.cleanup, 2, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(libraryId: string): Stage2Progress {
    const p = emptyStage2Progress(libraryId);
    this.snapshot = null;
    this.spelling = null;
    this.save(p, 'analysing');
    return p;
  }

  invalidate(): void {
    this.snapshot = null;
  }

  referenceFile(): string | null {
    const s = getSettings(this.deps.cleanup).stage2.referenceFile;
    if (s) return s;
    return this.deps.dbDir ? defaultReferenceFile(this.deps.dbDir) : null;
  }

  private libraryDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib) throw new Error('The chosen library is not in the reader any more');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  loadSnapshot(libraryId: string): Stage2Snapshot {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (this.snapshot && this.snapshotFor === file) return this.snapshot;
    this.snapshot = readStage2Snapshot(file);
    this.snapshotFor = file;
    return this.snapshot;
  }

  /** One unit of work; true when finished (or failed). Never throws. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    try {
      if (p.phase === 'read') p = await this.readStep(p, shouldStop);
      else if (p.phase === 'propose') p = await this.proposeStep(p);
      this.save(p, p.phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
      return p.phase === 'done';
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      return true;
    }
  }

  private gold() {
    const file = this.referenceFile();
    if (!file) return { gold: null, error: 'No labeled-books file is set' };
    return loadGold(file);
  }

  private async pace(): Promise<void> {
    const fps = getSettings(this.deps.cleanup).stage2.filesPerSecond;
    if (fps <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextReadAt);
    this.nextReadAt = at + 1000 / fps;
    if (at > now) await new Promise((r) => setTimeout(r, Math.min(at - now, 5000)));
  }

  /** Reads (or reuses) one book's evidence. */
  async readBook(
    libDir: string,
    libraryId: string,
    book: Stage2Book,
  ): Promise<{ ev: FileEvidence | null; read: boolean }> {
    if (!book.filePath) return { ev: null, read: false };
    const epub = resolveInside(libDir, book.filePath);
    const st = await statFile(epub);
    const coverFile = resolveInside(libDir, `${book.path}/cover.jpg`);
    const coverSt = book.hasCover ? await statFile(coverFile) : null;
    const old = loadEvidence(this.deps.cleanup, libraryId, book.uuid);
    const sameFile =
      old !== null &&
      st !== null &&
      old.path === book.filePath &&
      old.size === st.size &&
      old.mtimeMs === st.mtimeMs;
    const sameCover =
      old !== null &&
      (coverSt === null
        ? old.cover === null
        : old.cover !== null &&
          old.cover.size === coverSt.size &&
          old.cover.mtimeMs === coverSt.mtimeMs);
    if (sameFile && sameCover) return { ev: old, read: false };
    let file: FileFacts | null = sameFile ? old!.file : null;
    let error: string | null = sameFile ? old!.error : null;
    let read = false;
    if (!sameFile) {
      if (!st) {
        error = 'file_missing';
      } else {
        await this.pace();
        read = true;
        try {
          file = await readFileMetadata(epub);
        } catch (err) {
          error = `read: ${String((err as Error).message ?? err).slice(0, 300)}`;
        }
      }
    }
    let cover: FileEvidence['cover'] = null;
    if (coverSt) {
      cover =
        sameCover && old?.cover
          ? old.cover
          : {
              size: coverSt.size,
              mtimeMs: coverSt.mtimeMs,
              facts: await calibreCoverFacts(coverFile),
            };
    }
    const ev: FileEvidence = {
      v: EVIDENCE_VERSION,
      path: book.filePath,
      size: st?.size ?? null,
      mtimeMs: st?.mtimeMs ?? null,
      file,
      error,
      cover,
      readAt: Date.now(),
    };
    saveEvidence(this.deps.cleanup, libraryId, book.uuid, ev);
    return { ev, read };
  }

  private async readStep(p: Stage2Progress, shouldStop: () => boolean): Promise<Stage2Progress> {
    const snap = this.loadSnapshot(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const withEpub = [...snap.books.values()].filter((b) => b.filePath !== null);
    p.readTotal = withEpub.length;
    p.booksWithoutEpub = snap.books.size - withEpub.length;
    if (p.pass === 'labeled' && p.labeledIds.length === 0 && p.cursor === 0) {
      const { gold, error } = this.gold();
      p.labelsError = error;
      if (gold) {
        const mapped = mapLabeledIds(this.deps.cleanup, p.libraryId, Object.keys(gold));
        p.labeledIds = [...new Set([...mapped.values()])]
          .filter((id) => snap.books.get(id)?.filePath)
          .sort((a, b) => a - b);
      }
    }
    const ids =
      p.pass === 'labeled'
        ? p.labeledIds.filter((id) => id > p.cursor).slice(0, READ_CHUNK)
        : withEpub
            .map((b) => b.calibreId)
            .filter((id) => id > p.cursor)
            .slice(0, READ_CHUNK);
    if (ids.length === 0) {
      if (p.pass === 'labeled') {
        // The labeled books are read: show the gate early.
        this.gateNow(p, false);
        p.pass = 'all';
        p.cursor = 0;
        return p;
      }
      p.phase = 'propose';
      p.phaseStartedAt = Date.now();
      p.phaseStartDone = 0;
      return p;
    }
    const labeled = new Set(p.labeledIds);
    for (const id of ids) {
      if (shouldStop()) break;
      const book = snap.books.get(id)!;
      const { ev, read } = await this.readBook(libDir, p.libraryId, book);
      p.cursor = id;
      // The labeled books are counted once, in the "all" pass.
      if (p.pass === 'all') {
        p.readDone += 1;
        if (read) p.filesRead += 1;
        else if (!labeled.has(id)) p.reused += 1;
        if (ev?.error) p.readErrors += 1;
      }
    }
    await yieldNow();
    return p;
  }

  /** The proposals of one book from its evidence (also used by the gate and the batches). */
  proposalsFor(
    book: Stage2Book,
    ev: FileEvidence,
    settings: CleanupSettings,
    spelling?: SpellingLookup,
  ): FieldProposal[] {
    if (!ev.file) return [];
    return proposeStage2(
      calibreFactsOf(book, ev.cover?.facts ?? null),
      ev.file,
      proposalOptions(settings, spelling),
    );
  }

  private rebuildSpelling(p: Stage2Progress, snap: Stage2Snapshot): SpellingLookup {
    const spelling = spellingLookup(snap.names);
    // Names proposed earlier in this analysis (before a restart) keep their spelling.
    for (const r of this.deps.cleanup
      .prepare(
        `SELECT field, new_json FROM proposed_changes WHERE stage = 2 AND analysis_id = ?
         AND field IN ('authors', 'publisher', 'illustrator')`,
      )
      .all(p.analysisId) as { field: string; new_json: string }[]) {
      const v = JSON.parse(r.new_json) as unknown;
      const kind =
        r.field === 'authors' ? 'author' : r.field === 'publisher' ? 'publisher' : 'illustrator';
      for (const n of Array.isArray(v) ? v : [v]) if (typeof n === 'string') spelling(kind, n);
    }
    return spelling;
  }

  private async proposeStep(p: Stage2Progress): Promise<Stage2Progress> {
    const db = this.deps.cleanup;
    const snap = this.loadSnapshot(p.libraryId);
    const settings = getSettings(db);
    const now = Date.now();
    if (p.proposeCursor === 0) {
      db.transaction(() => {
        // Proposals never queued (or skipped without reaching a batch) are replaced; review
        // items the user already decided stay as they are.
        db.prepare(
          `DELETE FROM proposed_changes WHERE stage = 2 AND library_id = ? AND decided_by IS NULL
             AND state IN ('proposed', 'skipped') AND id NOT IN (SELECT change_id FROM batch_items)`,
        ).run(p.libraryId);
        db.prepare(
          `UPDATE proposed_changes SET state = 'skipped', review_reason = 'Replaced by a new analysis',
             updated_at = ? WHERE stage = 2 AND library_id = ? AND state = 'proposed' AND decided_by IS NULL`,
        ).run(now, p.libraryId);
      })();
      this.spelling = spellingLookup(snap.names);
    }
    if (!this.spelling) this.spelling = this.rebuildSpelling(p, snap);
    // A field stage 2 already queued, applied, undid, or the user kept is never proposed again
    // for that book: a later change by the user is theirs.
    const done = new Set(
      (
        db
          .prepare(
            `SELECT calibre_uuid || '|' || field AS k FROM proposed_changes WHERE stage = 2 AND library_id = ?
             AND (state IN ('queued', 'applied', 'undone', 'kept')
                  OR (state = 'proposed' AND decided_by IS NOT NULL))`,
          )
          .all(p.libraryId) as { k: string }[]
      ).map((r) => r.k),
    );
    // Copies stage 1 still has to remove are left alone.
    const leaving = new Set(
      (
        db
          .prepare(
            `SELECT calibre_uuid FROM proposed_changes WHERE stage = 1 AND library_id = ?
             AND state IN ('proposed', 'queued') AND class = 'auto'`,
          )
          .all(p.libraryId) as { calibre_uuid: string }[]
      ).map((r) => r.calibre_uuid),
    );
    const books = [...snap.books.values()]
      .filter((b) => b.filePath !== null && b.calibreId > p.proposeCursor)
      .slice(0, PROPOSE_CHUNK);
    if (books.length === 0) return this.finishPropose(p);
    const insert = db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (2, @lib, @id, @uuid, @field, @old, @new, @source, @evidence, @class, @reason, 'proposed',
         @analysis, @now, @now)`,
    );
    db.transaction(() => {
      for (const book of books) {
        p.proposeCursor = book.calibreId;
        p.proposeDone += 1;
        if (leaving.has(book.uuid)) continue;
        const ev = loadEvidence(db, p.libraryId, book.uuid);
        if (!ev?.file) continue;
        for (const prop of this.proposalsFor(book, ev, settings, this.spelling!)) {
          if (done.has(`${book.uuid}|${prop.field}`)) continue;
          insert.run({
            lib: p.libraryId,
            id: book.calibreId,
            uuid: book.uuid,
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
              lastModified: book.lastModified,
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
            analysis: p.analysisId,
            now,
          });
        }
      }
    })();
    await yieldNow();
    return p;
  }

  private finishPropose(p: Stage2Progress): Stage2Progress {
    const db = this.deps.cleanup;
    const snap = this.loadSnapshot(p.libraryId);
    const settings = getSettings(db);
    const fields: Stage2Progress['fields'] = {};
    for (const r of db
      .prepare(
        `SELECT field, class, COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND analysis_id = ?
         GROUP BY field, class`,
      )
      .all(p.analysisId) as { field: string; class: 'auto' | 'review'; n: number }[]) {
      (fields[r.field] ??= { auto: 0, review: 0 })[r.class] = r.n;
    }
    p.fields = fields;
    p.sources = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT source || ':' || class AS k, COUNT(*) AS n FROM proposed_changes WHERE stage = 2
             AND analysis_id = ? GROUP BY source, class`,
          )
          .all(p.analysisId) as { k: string; n: number }[]
      ).map((r) => [r.k, r.n]),
    );
    p.booksWithChanges = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT calibre_id) AS n FROM proposed_changes WHERE stage = 2 AND analysis_id = ?
           AND class = 'auto'`,
        )
        .get(p.analysisId) as { n: number }
    ).n;
    p.folderMoves = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT calibre_id) AS n FROM proposed_changes WHERE stage = 2 AND analysis_id = ?
           AND class = 'auto' AND (field = 'title'
             OR (field = 'authors' AND json_extract(new_json, '$[0]') IS NOT json_extract(old_json, '$[0]')))`,
        )
        .get(p.analysisId) as { n: number }
    ).n;
    // Apply groups over the whole library (for the page and the dry-run report).
    const groups: Stage2Progress['groups'] = { title: {}, authors: {} };
    let books = 0;
    let unknownJa = 0;
    for (const book of snap.books.values()) {
      if (!book.filePath) continue;
      const ev = loadEvidence(db, p.libraryId, book.uuid);
      if (!ev?.file) continue;
      books += 1;
      const cal = calibreFactsOf(book, ev.cover?.facts ?? null);
      const tg = titleGroup(cal, ev.file);
      const ag = authorGroup(cal, ev.file);
      groups.title[tg] = (groups.title[tg] ?? 0) + 1;
      groups.authors[ag] = (groups.authors[ag] ?? 0) + 1;
      if (book.authors.some((a) => a.trim() === '不明')) unknownJa += 1;
    }
    p.books = books;
    p.groups = groups;
    p.calibreUnknownJa = unknownJa;
    const gate = this.gateNow(p, true);
    if (gate) this.reviewAlarm(p, gate, settings);
    p.phase = 'done';
    p.finishedAt = Date.now();
    this.deps.log?.(
      `Cleanup stage 2: analysis done: ${p.books} books, ${p.booksWithChanges} with changes, ${p.folderMoves} folder moves`,
    );
    return p;
  }

  /** The labeled books as scored books (their current Calibre record and file evidence). */
  labeledBooks(p: Stage2Progress): { books: ScoredBook[]; missing: number; error: string | null } {
    const { gold, error } = this.gold();
    if (!gold) return { books: [], missing: 0, error };
    const snap = this.loadSnapshot(p.libraryId);
    const settings = getSettings(this.deps.cleanup);
    const spelling = spellingLookup(snap.names);
    const mapped = mapLabeledIds(this.deps.cleanup, p.libraryId, Object.keys(gold));
    const out: ScoredBook[] = [];
    let missing = 0;
    for (const [goldId, calibreId] of mapped) {
      const book = snap.books.get(calibreId);
      const ev = book ? loadEvidence(this.deps.cleanup, p.libraryId, book.uuid) : null;
      if (!book || !ev?.file) {
        missing += 1;
        continue;
      }
      out.push({
        id: goldId,
        gold: gold[goldId],
        cal: calibreFactsOf(book, ev.cover?.facts ?? null),
        file: ev.file,
        proposals: this.proposalsFor(book, ev, settings, spelling),
      });
    }
    return { books: out, missing, error: null };
  }

  /** Evaluates the gate, stores it as the stage's precision and (when final) applies its pauses. */
  gateNow(p: Stage2Progress, final: boolean): GateResult | null {
    const db = this.deps.cleanup;
    const { books, missing, error } = this.labeledBooks(p);
    if (error) {
      p.labelsError = error;
      pauseForMissingLabels(db, error);
      updateStage(db, 2, { precision: { gate: null, labelsError: error } });
      return null;
    }
    const gate = evaluateGate(books, missing, getSettings(db).stage2);
    updateStage(db, 2, { precision: { gate, final, labelsError: null } });
    if (final) applyGate(db, gate);
    return gate;
  }

  /** A field whose share of review results is far above the labeled books' pauses (plan section 1). */
  private reviewAlarm(p: Stage2Progress, gate: GateResult, settings: CleanupSettings): void {
    const db = this.deps.cleanup;
    const books = Math.max(1, p.books);
    for (const field of Object.keys(p.fields)) {
      const review = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT calibre_id) AS n FROM proposed_changes WHERE stage = 2 AND analysis_id = ?
             AND field = ? AND class = 'review'`,
          )
          .get(p.analysisId, field) as { n: number }
      ).n;
      const library = (100 * review) / books;
      const sample = gate.reviewShare[field] ?? 0;
      const current = listFieldPauses(db, 2).find((x) => x.field === field);
      if (library - sample > settings.reviewAlarmPercent) {
        pauseField(
          db,
          2,
          field,
          'review_alarm',
          `${library.toFixed(1)} % of the library's books have this field in review, against ${sample.toFixed(1)} % of the labeled books (alarm above ${settings.reviewAlarmPercent} points). Look at the review list, then resume.`,
        );
      } else if (current?.reason === 'review_alarm') {
        resumeField(db, 2, field);
      }
    }
  }
}
