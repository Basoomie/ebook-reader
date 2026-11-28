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
import { gateParts, saveGatePart } from './gate-parts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { snapshotFile } from '../calibre/indexer';
import { getLibrary } from '../calibre/libraries';
import { currentCalibreEpub } from '../calibre/live-lookup';
import { resolveInside, statFile } from '../calibre/source-fs';
import { calibreCoverFacts, readFileMetadata } from './file-metadata';
import { getSettings, type CleanupSettings } from './settings';
import { Pacer } from './stage1';
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
  type Stage2Field,
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
import { attachMarks } from './marks';

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
  /** Manga part B: the reader library this instance works on (one instance per library). */
  libraryId: string;
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
    coverSameDistance: s.covers.sameDistance,
    coverLargerFactor: 1 + s.covers.largerPercent / 100,
  };
}

export class Stage2Analysis {
  private snapshot: Stage2Snapshot | null = null;
  private snapshotFor: string | null = null;
  private current: { file: string; mtime: number; snap: Stage2Snapshot } | null = null;
  private spelling: SpellingLookup | null = null;
  private readPacer: Pacer | null = null;
  /** Fields a later cleanup stage wrote, with the value written (applied_values), per book. */
  private laterValues: Map<string, Map<string, string>> | null = null;
  private readPacerBps = -1;

  constructor(private readonly deps: Stage2Deps) {}

  progress(): Stage2Progress | null {
    const p = getStage(this.deps.cleanup, this.deps.libraryId, 2)
      .progress as unknown as Stage2Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: Stage2Progress, state?: string): void {
    updateStage(this.deps.cleanup, this.deps.libraryId, 2, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(libraryId: string): Stage2Progress {
    const p = emptyStage2Progress(libraryId);
    this.snapshot = null;
    this.spelling = null;
    this.laterValues = null;
    this.save(p, 'analysing');
    return p;
  }

  invalidate(): void {
    this.snapshot = null;
    this.laterValues = null;
  }

  /**
   * The fields of this book whose value Calibre holds now was written by a later cleanup stage
   * (any stage but stage 2: the online sources, the user's edits; Undo removes the record), so
   * it is Calibre's own (stage2-rules.ts `owned`). Read once per analysis.
   */
  private ownedFields(libraryId: string, book: Stage2Book): Stage2Field[] {
    if (!this.laterValues) {
      const m = new Map<string, Map<string, string>>();
      for (const r of this.deps.cleanup
        .prepare(
          `SELECT a.calibre_uuid, a.field, a.value_json FROM applied_values a
           JOIN batches b ON b.id = a.batch_id
           WHERE a.library_id = ? AND a.field IN ('title', 'authors', 'cover') AND b.stage <> 2`,
        )
        .iterate(libraryId) as Iterable<{
        calibre_uuid: string;
        field: string;
        value_json: string;
      }>) {
        let f = m.get(r.calibre_uuid);
        if (!f) m.set(r.calibre_uuid, (f = new Map()));
        f.set(r.field, r.value_json);
      }
      this.laterValues = m;
    }
    const later = this.laterValues.get(book.uuid);
    if (!later) return [];
    const out: Stage2Field[] = [];
    const title = later.get('title');
    if (title !== undefined && JSON.parse(title) === book.title) out.push('title');
    const authors = later.get('authors');
    if (
      authors !== undefined &&
      JSON.stringify(JSON.parse(authors)) === JSON.stringify(book.authors)
    )
      out.push('authors');
    // A cover a later stage wrote and Calibre still lists one (a cover you changed since is
    // yours: user_fields keeps stage 2 off it).
    if (later.has('cover') && book.hasCover) out.push('cover');
    return out;
  }

  /**
   * Calibre's title and authors before stage 2 first changed them (its earliest applied change's
   * old value), for the gate; not for a field a later stage owns (that book is scored as
   * Calibre's own value).
   */
  private beforeStage2(
    libraryId: string,
    uuid: string,
    owned: readonly Stage2Field[] | undefined,
  ): { title?: string; authors?: string[] } | undefined {
    const first = this.deps.cleanup.prepare(
      `SELECT old_json FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND stage = 2 AND field = ? AND state = 'applied'
       ORDER BY id LIMIT 1`,
    );
    const out: { title?: string; authors?: string[] } = {};
    for (const field of ['title', 'authors'] as const) {
      if (owned?.includes(field)) continue;
      const r = first.get(libraryId, uuid, field) as { old_json: string | null } | undefined;
      if (!r?.old_json) continue;
      const v = JSON.parse(r.old_json) as unknown;
      if (field === 'title' && typeof v === 'string') out.title = v;
      if (field === 'authors' && Array.isArray(v))
        out.authors = v.filter((x) => typeof x === 'string');
    }
    return out.title !== undefined || out.authors !== undefined ? out : undefined;
  }

  /** Calibre's facts of a book for the rules, with the fields later stages own. */
  private calFacts(libraryId: string, book: Stage2Book, ev: FileEvidence) {
    return {
      ...calibreFactsOf(book, ev.cover?.facts ?? null),
      owned: this.ownedFields(libraryId, book),
    };
  }

  referenceFile(): string | null {
    const s = getSettings(this.deps.cleanup).gate.labeledBooksFile;
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
    // The Google run's marks stage 5 removed from Calibre still count for the rules (WP20f).
    attachMarks(this.deps.cleanup, libraryId, this.snapshot.books.values());
    this.snapshotFor = file;
    return this.snapshot;
  }

  /**
   * The library as the reader's index has it now, read again whenever its snapshot file changes
   * (the new arrivals' pass: books added since the analysis). The analysis' own snapshot stays
   * as it was for the rest of its run.
   */
  currentSnapshot(libraryId: string): Stage2Snapshot {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (this.current && this.current.file === file && this.current.mtime === mtime)
      return this.current.snap;
    const snap = readStage2Snapshot(file);
    attachMarks(this.deps.cleanup, libraryId, snap.books.values());
    this.current = { file, mtime, snap };
    return snap;
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

  /** Paces reading by the bytes actually read (the shared reading speed, like stage 1's hashing). */
  private pacer(): Pacer {
    const bps = getSettings(this.deps.cleanup).pacing.readMbPerSecond * 1024 * 1024;
    if (!this.readPacer || this.readPacerBps !== bps) {
      this.readPacer = new Pacer(bps);
      this.readPacerBps = bps;
    }
    return this.readPacer;
  }

  /** Reads (or reuses) one book's evidence. */
  async readBook(
    libDir: string,
    libraryId: string,
    book: Stage2Book,
  ): Promise<{ ev: FileEvidence | null; read: boolean }> {
    if (!book.filePath) return { ev: null, read: false };
    // The analysis keeps one snapshot for its whole run, and any Calibre write moves a book's
    // folder: a book not at the snapshot's path is looked for where it is now (by UUID, in the
    // live metadata.db), never recorded as missing (seen 2026-11-15: 4,277 books were never
    // analysed because stage-2 batches moved their folders during the analysis).
    let filePath = book.filePath;
    let epub = resolveInside(libDir, filePath);
    let st = await statFile(epub);
    if (!st) {
      const now = await currentCalibreEpub(libDir, book.uuid, book.calibreId);
      if (now && now !== filePath) {
        filePath = now;
        epub = resolveInside(libDir, filePath);
        st = await statFile(epub);
      }
    }
    const folder = filePath === book.filePath ? book.path : path.posix.dirname(filePath);
    const coverFile = resolveInside(libDir, `${folder}/cover.jpg`);
    const coverSt = book.hasCover ? await statFile(coverFile) : null;
    const old = loadEvidence(this.deps.cleanup, libraryId, book.uuid);
    const sameFile =
      old !== null &&
      st !== null &&
      old.path === filePath &&
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
        read = true;
        const counted = { bytes: 0 };
        try {
          file = await readFileMetadata(epub, { counted });
        } catch (err) {
          error = `read: ${String((err as Error).message ?? err).slice(0, 300)}`;
        }
        await this.pacer().take(counted.bytes);
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
      path: filePath,
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
    const lib = this.progress()?.libraryId ?? null;
    const cal = lib ? this.calFacts(lib, book, ev) : calibreFactsOf(book, ev.cover?.facts ?? null);
    return proposeStage2(cal, ev.file, {
      ...proposalOptions(settings, spelling),
      calibreId: book.calibreId,
    });
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
        // items the user already decided stay as they are. A new-arrivals run's own proposals
        // (arrivals:<run>, e.g. a field its gate held) are that run's, never the library's.
        db.prepare(
          `DELETE FROM proposed_changes WHERE stage = 2 AND library_id = ? AND decided_by IS NULL
             AND state IN ('proposed', 'skipped') AND id NOT IN (SELECT change_id FROM batch_items)
             AND analysis_id NOT LIKE 'arrivals:%'`,
        ).run(p.libraryId);
        db.prepare(
          `UPDATE proposed_changes SET state = 'skipped', review_reason = 'Replaced by a new analysis',
             updated_at = ? WHERE stage = 2 AND library_id = ? AND state = 'proposed' AND decided_by IS NULL
             AND analysis_id NOT LIKE 'arrivals:%'`,
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
    // What this analysis already proposed for these books: a chunk run again (seen on the NAS
    // 2026-11-15: one chunk of 1,000 books proposed twice, 4.6 s apart) adds nothing.
    const already = new Set(
      (
        db
          .prepare(
            `SELECT calibre_uuid || '|' || field || '|' || class || '|' || COALESCE(new_json, '') AS k
             FROM proposed_changes WHERE stage = 2 AND analysis_id = ? AND calibre_id BETWEEN ? AND ?`,
          )
          .all(p.analysisId, books[0].calibreId, books[books.length - 1].calibreId) as {
          k: string;
        }[]
      ).map((r) => r.k),
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
          const key = `${book.uuid}|${prop.field}|${prop.class}|${JSON.stringify(prop.new ?? null)}`;
          if (already.has(key)) continue;
          already.add(key);
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
              ...(prop.fit ? { fit: prop.fit } : {}),
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
      // The cursor is saved with the proposals, never after a yield.
      this.save(p, 'analysing');
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
      const cal = this.calFacts(p.libraryId, book, ev);
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
      const cal = this.calFacts(p.libraryId, book, ev);
      out.push({
        id: goldId,
        gold: gold[goldId],
        cal,
        file: ev.file,
        proposals: this.proposalsFor(book, ev, settings, spelling),
        before: this.beforeStage2(p.libraryId, book.uuid, cal.owned),
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
      pauseForMissingLabels(db, this.deps.libraryId, error);
      updateStage(db, this.deps.libraryId, 2, { precision: { gate: null, labelsError: error } });
      return null;
    }
    // One gate across the libraries: this library's labeled books with the others' (saved by
    // their own analyses); with one library it is the gate as before.
    saveGatePart(db, 2, 'books', this.deps.libraryId, { books, missing });
    const parts = gateParts<{ books: ScoredBook[]; missing: number }>(
      db,
      2,
      'books',
      this.deps.libraryId,
    );
    const gate = evaluateGate(
      parts.flatMap((x) => x.data.books),
      parts.reduce((a, x) => a + x.data.missing, 0),
      getSettings(db),
    );
    updateStage(db, this.deps.libraryId, 2, { precision: { gate, final, labelsError: null } });
    if (final) applyGate(db, this.deps.libraryId, gate);
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
      const current = listFieldPauses(db, this.deps.libraryId, 2).find((x) => x.field === field);
      if (library - sample > settings.reviewAlarmPercent) {
        pauseField(
          db,
          this.deps.libraryId,
          2,
          field,
          'review_alarm',
          `${library.toFixed(1)} % of the library's books have this field in review, against ${sample.toFixed(1)} % of the labeled books (alarm above ${settings.reviewAlarmPercent} points). Look at the review list, then resume.`,
        );
      } else if (current?.reason === 'review_alarm') {
        resumeField(db, this.deps.libraryId, 2, field);
      }
    }
  }
}
