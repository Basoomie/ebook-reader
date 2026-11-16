/**
 * Stage 3 analysis (plan section 5, WP20c): content duplicates, same text in different files.
 *
 *   text        every EPUB's text as the reader counts it (reader processes), its sketch
 *               (cache), length checked against the reader's own count, edition kind,
 *               writing direction, image entries
 *   candidates  pairs from the sketches (index in a reader process), plus the gate's pairs
 *               and image-only books with the same title and author
 *   compare     every candidate measured exactly (both ways) with the extra text of each side,
 *               then classified (stage3-rules); omnibus files found by their text
 *   quality     for books in a duplicate pair: SHA-256, cover, every picture's facts
 *   group       the better copy of each pair, sets, proposals (removals), the gate
 *
 * Runs in small steps (the service calls step() until done), paced by the shared MB/s,
 * resumes after a restart from its saved phase and cursor (saved in the same transaction as
 * the rows). Only cleanup.db and the regenerable cache are written; Calibre is read through
 * source-fs.ts.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { getLibrary } from '../calibre/libraries';
import { resolveInside, statFile } from '../calibre/source-fs';
import { tagsToCopy } from './batches';
import { readFileMetadata } from './file-metadata';
import { booksWithReaderData, findCalibreSource } from './handoff';
import { getSettings, isCustomTag } from './settings';
import { calibreNameBytes, NAME_MAX_BYTES } from './stage2-rules';
import { hashSourceFile, Pacer, readSnapshotBooks, type SnapshotBook } from './stage1';
import type { CompareResult, ComparedPair } from '../counts/book-text-child';
import { loadGatePairs, type GatePairResult, type Stage3Gate } from './stage3-gate';
import { epubImageFacts } from './stage3-images';
import { editionKind, type EditionKind } from './stage3-kinds';
import {
  bestCopy,
  classifyPair,
  decideSets,
  omnibusByText,
  type BestCopy,
  type ImageFact,
  type PairBook,
  type PairClass,
  type QualityFacts,
  type SetEdge,
} from './stage3-rules';
import { sketchToBlob } from './stage3-sketch';
import type { Stage3Reader } from '../counts/book-text-worker';
import { getStage, updateStage } from './stages';

export type Stage3Phase = 'text' | 'candidates' | 'compare' | 'quality' | 'group' | 'done';

export interface PhaseTime {
  /** Wall time spent in the phase (ms) and the items it handled. */
  ms: number;
  items: number;
}

export interface Stage3Progress {
  analysisId: string;
  phase: Stage3Phase;
  libraryId: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  phaseStartedAt: number;
  phaseStartDone: number;
  times: Partial<Record<Exclude<Stage3Phase, 'done'>, PhaseTime>>;
  // text
  textCursor: number;
  textTotal: number;
  textDone: number;
  /** Books actually read (not kept from an earlier analysis) and their summed read time. */
  textRead: number;
  textReadMs: number;
  textErrors: number;
  imageOnly: number;
  /** Books whose file the reader counted too, and how many lengths differ. */
  readerCompared: number;
  readerDiffering: number;
  // candidates
  candidates: number;
  indexStats: Record<string, number> | null;
  // compare
  compareTotal: number;
  compareDone: number;
  compareErrors: number;
  omnibusByText: number;
  // quality
  qualityTotal: number;
  qualityDone: number;
  qualityCursor: number;
  qualityErrors: number;
  // group
  classes: Record<string, number>;
  sets: number;
  setsWithoutKeeper: number;
  toRemove: number;
  review: number;
  removedWithData: number;
  bothWithData: number;
  tagsCopied: number;
  gate: Stage3Gate | null;
}

export interface Stage3Book extends SnapshotBook {
  firstAuthor: string;
}

export interface Stage3Deps {
  cleanup: Database.Database;
  main: Database.Database;
  calibreDir: string;
  cacheDir: string;
  dbDir: string | null;
  /** The reader processes (or a stand-in in tests). */
  reader: () => Stage3Reader;
  /** The counter bundle's build id: a file read with another build is read again. */
  counterBuild: string;
  log?: (m: string) => void;
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
/** Books per compare request (each read once per request). */
const BOOKS_PER_COMPARE = 8;
const COMPARE_CHUNK = 200;
const MIN_RUN = 100;
const MIN_CONTEXT = 500;
const NOT_IN_LIBRARY = 'Not checked: a copy is no longer in the library';

export function stage3CacheFile(cacheDir: string): string {
  return path.join(cacheDir, 'cleanup', 'stage3.db');
}

/** The regenerable sketch store (outside cleanup.db and its nightly snapshots). */
export function openStage3Cache(cacheDir: string): Database.Database {
  const file = stage3CacheFile(cacheDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.prepare(
    `CREATE TABLE IF NOT EXISTS sketches (
    library_id  TEXT NOT NULL,
    calibre_id  INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    build       TEXT NOT NULL,
    samples     BLOB NOT NULL,
    PRIMARY KEY (library_id, calibre_id)
  )`,
  ).run();
  return db;
}

/** Books with an EPUB, with their first author (for image-only grouping and folder names). */
export function readStage3Books(file: string): Map<number, Stage3Book> {
  const books = readSnapshotBooks(file) as Map<number, Stage3Book>;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    for (const b of books.values()) b.firstAuthor = 'Unknown';
    const seen = new Set<number>();
    for (const r of db
      .prepare(
        `SELECT l.book, a.name FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id`,
      )
      .all() as { book: number; name: string }[]) {
      if (seen.has(r.book)) continue;
      seen.add(r.book);
      const b = books.get(r.book);
      if (b) b.firstAuthor = r.name;
    }
  } finally {
    db.close();
  }
  return books;
}

export function emptyStage3Progress(libraryId: string, now = Date.now()): Stage3Progress {
  return {
    analysisId: randomUUID(),
    phase: 'text',
    libraryId,
    startedAt: now,
    finishedAt: null,
    error: null,
    phaseStartedAt: now,
    phaseStartDone: 0,
    times: {},
    textCursor: 0,
    textTotal: 0,
    textDone: 0,
    textRead: 0,
    textReadMs: 0,
    textErrors: 0,
    imageOnly: 0,
    readerCompared: 0,
    readerDiffering: 0,
    candidates: 0,
    indexStats: null,
    compareTotal: 0,
    compareDone: 0,
    compareErrors: 0,
    omnibusByText: 0,
    qualityTotal: 0,
    qualityDone: 0,
    qualityCursor: 0,
    qualityErrors: 0,
    classes: {},
    sets: 0,
    setsWithoutKeeper: 0,
    toRemove: 0,
    review: 0,
    removedWithData: 0,
    bothWithData: 0,
    tagsCopied: 0,
    gate: null,
  };
}

interface FactRow {
  calibre_id: number;
  calibre_uuid: string;
  file_path: string;
  size: number | null;
  mtime_ms: number | null;
  counter_build: string | null;
  chars: number | null;
  reader_chars: number | null;
  samples: number | null;
  chapters_json: string | null;
  ruby: number | null;
  toc_entries: number | null;
  file_title: string | null;
  kind: EditionKind | null;
  kind_marker: string | null;
  kind_by: string | null;
  image_entries: number | null;
  image_only: number;
  error: string | null;
  quality_size: number | null;
  quality_mtime_ms: number | null;
  sha256: string | null;
  vertical: number | null;
  cover_side: number | null;
  images_json: string | null;
  quality_error: string | null;
}

export interface PairRow {
  id: number;
  a_id: number;
  a_uuid: string;
  b_id: number;
  b_uuid: string;
  source: string;
  shared: number | null;
  est_a_in_b: number | null;
  est_b_in_a: number | null;
  a_in_b: number | null;
  b_in_a: number | null;
  class: PairClass | 'image_only' | null;
  rule: string | null;
  reason: string | null;
  container: 'a' | 'b' | null;
  spread_json: string | null;
  best_json: string | null;
  keep_id: number | null;
  error: string | null;
}

/** Titles compared without width, spaces, brackets and their markers (image-only grouping). */
export function looseTitle(t: string): string {
  return t
    .normalize('NFKC')
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, '')
    .replace(/[\s・:：~～\-‐ー]/g, '')
    .toLowerCase();
}

export class Stage3Analysis {
  private books: Map<number, Stage3Book> | null = null;
  private booksFor: string | null = null;
  private cacheDb: Database.Database | null = null;

  constructor(private readonly deps: Stage3Deps) {}

  progress(): Stage3Progress | null {
    const p = getStage(this.deps.cleanup, 3).progress as unknown as Stage3Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: Stage3Progress, state?: string): void {
    updateStage(this.deps.cleanup, 3, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  private cache(): Database.Database {
    if (!this.cacheDb) this.cacheDb = openStage3Cache(this.deps.cacheDir);
    return this.cacheDb;
  }

  close(): void {
    this.cacheDb?.close();
    this.cacheDb = null;
  }

  /** Starts a fresh analysis (keeps the text facts and sketches of unchanged files). */
  restart(libraryId: string): Stage3Progress {
    const p = emptyStage3Progress(libraryId);
    this.books = null;
    // Pairs of earlier analyses are replaced (the proposals keep what a batch needs).
    this.deps.cleanup
      .prepare('DELETE FROM content_pairs WHERE library_id = ? AND analysis_id <> ?')
      .run(libraryId, p.analysisId);
    this.save(p, 'analysing');
    return p;
  }

  invalidate(): void {
    this.books = null;
  }

  private libraryDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib) throw new Error('The chosen library is not in the reader any more');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  loadBooks(libraryId: string): Map<number, Stage3Book> {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    if (this.books && this.booksFor === file) return this.books;
    this.books = readStage3Books(file);
    this.booksFor = file;
    return this.books;
  }

  /** One unit of work. Returns true when finished (or failed). Never throws. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    try {
      const before = p.phase;
      const started = Date.now();
      if (p.phase === 'text') p = await this.textStep(p, shouldStop);
      else if (p.phase === 'candidates') p = await this.candidatesStep(p);
      else if (p.phase === 'compare') p = await this.compareStep(p, shouldStop);
      else if (p.phase === 'quality') p = await this.qualityStep(p, shouldStop);
      else if (p.phase === 'group') p = this.groupStep(p);
      const t = p.times[before as Exclude<Stage3Phase, 'done'>] ?? { ms: 0, items: 0 };
      t.ms += Date.now() - started;
      p.times[before as Exclude<Stage3Phase, 'done'>] = t;
      if (p.phase !== before) {
        p.phaseStartedAt = Date.now();
        p.phaseStartDone = 0;
      }
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

  // ---- text ----

  private readerChars(libraryId: string, uuid: string, size: number): number | null {
    try {
      const r = this.deps.main
        .prepare(
          `SELECT cc.characters, cc.file_bytes FROM book_sources bs
           JOIN char_counts cc ON cc.book_id = bs.book_id
           WHERE bs.kind = 'calibre' AND bs.library_id = ? AND bs.calibre_uuid = ?
             AND cc.status = 'ok' LIMIT 1`,
        )
        .get(libraryId, uuid) as
        | { characters: number | null; file_bytes: number | null }
        | undefined;
      if (!r || r.characters === null || r.file_bytes !== size) return null;
      return r.characters;
    } catch {
      return null;
    }
  }

  private async textStep(p: Stage3Progress, shouldStop: () => boolean): Promise<Stage3Progress> {
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const settings = getSettings(this.deps.cleanup);
    const dup = settings.duplicates;
    const pacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    p.textTotal = books.size;
    const chunk = Math.max(8, dup.textWorkers * 4);
    const ids = [...books.keys()]
      .filter((id) => id > p.textCursor)
      .sort((a, b) => a - b)
      .slice(0, chunk);
    if (ids.length === 0) {
      p.phase = 'candidates';
      return p;
    }
    const facts = this.deps.cleanup.prepare(
      'SELECT * FROM text_facts WHERE library_id = ? AND calibre_id = ?',
    );
    const sketchRow = this.cache().prepare(
      'SELECT size, mtime_ms, build FROM sketches WHERE library_id = ? AND calibre_id = ?',
    );
    type Out = { row: Record<string, unknown>; sketch?: Buffer; readMs?: number; reused: boolean };
    const readOne = async (book: Stage3Book): Promise<Out | null> => {
      if (shouldStop()) return null;
      const file = resolveInside(libDir, book.filePath);
      const now = Date.now();
      const base = {
        lib: p.libraryId,
        id: book.calibreId,
        uuid: book.uuid,
        path: book.filePath,
        lm: book.lastModified,
        build: this.deps.counterBuild,
        now,
      };
      const st = await statFile(file).catch(() => null);
      if (!st) {
        return { reused: false, row: { ...base, size: null, mtime: null, error: 'file_missing' } };
      }
      const old = facts.get(p.libraryId, book.calibreId) as FactRow | undefined;
      const cached = sketchRow.get(p.libraryId, book.calibreId) as
        | { size: number; mtime_ms: number; build: string }
        | undefined;
      const kindOf = (fileTitle: string | null) =>
        editionKind([fileTitle, book.title, path.posix.basename(book.filePath, '.epub')]);
      if (
        old &&
        old.error === null &&
        old.size === st.size &&
        old.mtime_ms === Math.round(st.mtimeMs) &&
        old.counter_build === this.deps.counterBuild &&
        cached &&
        cached.size === st.size &&
        cached.mtime_ms === Math.round(st.mtimeMs) &&
        cached.build === this.deps.counterBuild
      ) {
        const kind =
          old.kind_by === 'text'
            ? { kind: old.kind!, marker: old.kind_marker }
            : kindOf(old.file_title);
        return {
          reused: true,
          row: {
            ...base,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            reuse: 1,
            kind: kind.kind,
            marker: kind.marker,
            kindBy: old.kind_by === 'text' ? 'text' : 'title',
            readerChars: this.readerChars(p.libraryId, book.uuid, st.size),
          },
        };
      }
      const counted = { bytes: 0 };
      let fileTitle: string | null = null;
      let imageEntries: number | null = null;
      let vertical: boolean | null = null;
      try {
        const meta = await readFileMetadata(file, {
          text: false,
          cover: false,
          layout: true,
          counted,
        });
        fileTitle = meta.title;
        imageEntries = meta.layout?.images.length ?? null;
        vertical = meta.layout?.vertical ?? null;
      } catch {
        // The reader's import decides whether the file can be read at all.
      }
      const started = Date.now();
      const out = await this.deps.reader().text(file);
      const readMs = Date.now() - started;
      if (!out.ok) {
        if (out.stopped) return null;
        return {
          reused: false,
          readMs,
          row: {
            ...base,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            error: `${out.code}: ${out.message}`.slice(0, 500),
            fileTitle,
            imageEntries,
          },
        };
      }
      await pacer.take(out.data.bytesRead + counted.bytes);
      const kind = kindOf(fileTitle);
      const imageOnly =
        out.data.characters < dup.imageOnlyMaxChars && (imageEntries ?? 0) > 0 ? 1 : 0;
      const sketch = Uint32Array.from(out.data.sketch);
      return {
        reused: false,
        readMs,
        sketch: sketchToBlob(sketch),
        row: {
          ...base,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          error: null,
          chars: out.data.characters,
          importChars: out.data.importCharacters,
          readerChars: this.readerChars(p.libraryId, book.uuid, st.size),
          samples: sketch.length,
          chapters: JSON.stringify(out.data.chapters),
          ruby: out.data.ruby,
          toc: out.data.tocEntries,
          fileTitle,
          kind: kind.kind,
          marker: kind.marker,
          kindBy: 'title',
          imageEntries,
          imageOnly,
          vertical: vertical === null ? null : vertical ? 1 : 0,
          readMs,
        },
      };
    };

    const results = await Promise.all(ids.map((id) => readOne(books.get(id)!)));
    // Stopped part-way: keep only the books before the first one not done (cursor order).
    const done: Out[] = [];
    for (const r of results) {
      if (!r) break;
      done.push(r);
    }
    if (done.length === 0) return p;

    const cache = this.cache();
    const putSketch = cache.prepare(
      `INSERT INTO sketches (library_id, calibre_id, size, mtime_ms, build, samples)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET size = excluded.size,
         mtime_ms = excluded.mtime_ms, build = excluded.build, samples = excluded.samples`,
    );
    const dropSketch = cache.prepare(
      'DELETE FROM sketches WHERE library_id = ? AND calibre_id = ?',
    );
    cache.transaction(() => {
      for (const d of done) {
        if (d.reused) continue;
        const r = d.row;
        if (d.sketch) putSketch.run(r.lib, r.id, r.size, r.mtime, r.build, d.sketch);
        else dropSketch.run(r.lib, r.id);
      }
    })();

    const upsert = this.deps.cleanup.prepare(
      `INSERT INTO text_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms,
         calibre_last_modified, counter_build, chars, import_chars, reader_chars, samples,
         chapters_json, ruby, toc_entries, file_title, kind, kind_marker, kind_by, image_entries,
         image_only, vertical, read_ms, read_at, error)
       VALUES (@lib, @id, @uuid, @path, @size, @mtime, @lm, @build, @chars, @importChars,
         @readerChars, @samples, @chapters, @ruby, @toc, @fileTitle, @kind, @marker, @kindBy,
         @imageEntries, @imageOnly, @vertical, @readMs, @now, @error)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid,
         file_path = excluded.file_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
         calibre_last_modified = excluded.calibre_last_modified, counter_build = excluded.counter_build,
         chars = excluded.chars, import_chars = excluded.import_chars,
         reader_chars = excluded.reader_chars, samples = excluded.samples,
         chapters_json = excluded.chapters_json, ruby = excluded.ruby,
         toc_entries = excluded.toc_entries, file_title = excluded.file_title, kind = excluded.kind,
         kind_marker = excluded.kind_marker, kind_by = excluded.kind_by,
         image_entries = excluded.image_entries, image_only = excluded.image_only,
         vertical = excluded.vertical, read_ms = excluded.read_ms, read_at = excluded.read_at,
         error = excluded.error,
         -- A different file loses its best-copy facts (they are read again when needed).
         quality_size = CASE WHEN excluded.size IS text_facts.quality_size
           AND excluded.mtime_ms IS text_facts.quality_mtime_ms THEN text_facts.quality_size END`,
    );
    const reuse = this.deps.cleanup.prepare(
      `UPDATE text_facts SET calibre_uuid = @uuid, file_path = @path, calibre_last_modified = @lm,
         kind = @kind, kind_marker = @marker, kind_by = @kindBy, reader_chars = @readerChars
       WHERE library_id = @lib AND calibre_id = @id`,
    );
    const nullRow = {
      chars: null,
      importChars: null,
      readerChars: null,
      samples: null,
      chapters: null,
      ruby: null,
      toc: null,
      fileTitle: null,
      kind: null,
      marker: null,
      kindBy: null,
      imageEntries: null,
      imageOnly: 0,
      vertical: null,
      readMs: null,
      error: null,
    };
    this.deps.cleanup.transaction(() => {
      for (const d of done) {
        if (d.reused) reuse.run(d.row);
        else upsert.run({ ...nullRow, ...d.row });
        const r = d.row as Record<string, unknown>;
        p.textDone++;
        if (!d.reused) {
          p.textRead++;
          p.textReadMs += d.readMs ?? 0;
        }
        if (r.error) p.textErrors++;
        p.textCursor = r.id as number;
      }
      this.save(p, 'analysing');
    })();
    await yieldNow();
    return p;
  }

  // ---- candidates ----

  private gateFile(): string | null {
    const s = getSettings(this.deps.cleanup);
    if (s.gate.duplicatePairsFile) return s.gate.duplicatePairsFile;
    return this.deps.dbDir
      ? path.join(this.deps.dbDir, 'cleanup', 'reference-sample', 'stage3-pairs.json')
      : null;
  }

  /**
   * A copy stage 1 (identical files) or stage 3 (same text) removed: its Calibre id → the copy
   * that stayed (the gate's pairs and labeled books were measured before those removals).
   */
  private removalMap(libraryId: string): Map<number, number> {
    const rows = this.deps.cleanup
      .prepare(
        `SELECT u.removed_calibre_id, u.kept_calibre_id FROM undo_records u
         JOIN batches b ON b.id = u.batch_id
         WHERE u.library_id = ? AND b.stage IN (1, 3) AND u.restored_at IS NULL`,
      )
      .all(libraryId) as { removed_calibre_id: number; kept_calibre_id: number }[];
    const map = new Map(rows.map((r) => [r.removed_calibre_id, r.kept_calibre_id]));
    const resolve = (id: number) => {
      let x = id;
      for (let i = 0; i < 10 && map.has(x); i++) x = map.get(x)!;
      return x;
    };
    return new Map([...map.keys()].map((k) => [k, resolve(k)]));
  }

  private facts(libraryId: string): Map<number, FactRow> {
    const rows = this.deps.cleanup
      .prepare('SELECT * FROM text_facts WHERE library_id = ?')
      .all(libraryId) as FactRow[];
    return new Map(rows.map((r) => [r.calibre_id, r]));
  }

  private async candidatesStep(p: Stage3Progress): Promise<Stage3Progress> {
    const books = this.loadBooks(p.libraryId);
    const facts = this.facts(p.libraryId);
    const s = getSettings(this.deps.cleanup);
    const present = [...books.keys()].filter((id) => {
      const f = facts.get(id);
      return f && f.error === null && f.image_only === 0 && (f.samples ?? 0) > 0;
    });
    // Make sure the sketches are on disk before the reader process opens the cache.
    this.cache().pragma('wal_checkpoint(PASSIVE)');
    const out = await this.deps.reader().index({
      cacheFile: stage3CacheFile(this.deps.cacheDir),
      libraryId: p.libraryId,
      ids: present,
      commonBooks: s.duplicates.commonWindowBooks,
      minShared: 2,
      minEstimate: 0.05,
    });
    if (!out.ok) {
      if (out.stopped) return p;
      throw new Error(`The candidate index failed: ${out.message}`);
    }
    p.indexStats = out.data.stats as unknown as Record<string, number>;

    const insert = this.deps.cleanup.prepare(
      `INSERT OR IGNORE INTO content_pairs (analysis_id, library_id, a_id, a_uuid, b_id, b_uuid,
         source, shared, est_a_in_b, est_b_in_a)
       VALUES (@analysis, @lib, @a, @aUuid, @b, @bUuid, @source, @shared, @estA, @estB)`,
    );
    const pairs: Record<string, unknown>[] = [];
    for (const c of out.data.pairs) {
      const a = books.get(c.a);
      const b = books.get(c.b);
      if (!a || !b) continue;
      pairs.push({
        analysis: p.analysisId,
        lib: p.libraryId,
        a: c.a,
        aUuid: a.uuid,
        b: c.b,
        bUuid: b.uuid,
        source: 'index',
        shared: c.shared,
        estA: c.estAInB,
        estB: c.estBInA,
      });
    }

    // The gate's pairs are measured even if the index didn't find them.
    const gateFile = this.gateFile();
    const gate = gateFile ? loadGatePairs(gateFile) : { pairs: null, error: null };
    if (gate.pairs) {
      const map = this.removalMap(p.libraryId);
      const have = new Set(pairs.map((x) => `${x.a}:${x.b}`));
      for (const g of gate.pairs) {
        const ga = map.get(g.a) ?? g.a;
        const gb = map.get(g.b) ?? g.b;
        if (ga === gb) continue;
        const [x, y] = ga < gb ? [ga, gb] : [gb, ga];
        if (have.has(`${x}:${y}`)) continue;
        const a = books.get(x);
        const b = books.get(y);
        if (!a || !b) continue;
        have.add(`${x}:${y}`);
        pairs.push({
          analysis: p.analysisId,
          lib: p.libraryId,
          a: x,
          aUuid: a.uuid,
          b: y,
          bUuid: b.uuid,
          source: 'gate',
          shared: null,
          estA: null,
          estB: null,
        });
      }
    }

    // Image-only books with the same title and first author: the review list (never auto).
    const groups = new Map<string, number[]>();
    for (const [id, f] of facts) {
      if (f.image_only !== 1 || !books.has(id)) continue;
      const b = books.get(id)!;
      const key = `${looseTitle(b.title)}|${b.firstAuthor.normalize('NFKC').replace(/\s/g, '')}`;
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    p.imageOnly = [...facts.values()].filter(
      (f) => f.image_only === 1 && books.has(f.calibre_id),
    ).length;
    for (const ids of groups.values()) {
      ids.sort((x, y) => x - y);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          pairs.push({
            analysis: p.analysisId,
            lib: p.libraryId,
            a: ids[i],
            aUuid: books.get(ids[i])!.uuid,
            b: ids[j],
            bUuid: books.get(ids[j])!.uuid,
            source: 'image_only',
            shared: null,
            estA: null,
            estB: null,
          });
        }
      }
    }

    const settings = s.duplicates;
    const decideByKind = this.deps.cleanup.prepare(
      `UPDATE content_pairs SET class = ?, rule = ?, reason = ?, measured_at = ?
       WHERE analysis_id = ? AND a_id = ? AND b_id = ?`,
    );
    this.deps.cleanup.transaction(() => {
      for (const x of pairs) insert.run(x);
      // Decided without reading the text: image-only pairs and a preview or store-bonus
      // story against another kind (never a duplicate whatever the overlap).
      const now = Date.now();
      for (const x of pairs) {
        if (x.source === 'image_only') {
          decideByKind.run(
            'review',
            'image_only',
            'Picture books with the same title and author (compared by their pictures)',
            now,
            p.analysisId,
            x.a,
            x.b,
          );
          continue;
        }
        const fa = facts.get(x.a as number);
        const fb = facts.get(x.b as number);
        if (!fa || !fb || fa.error || fb.error) continue;
        const v = classifyPair(
          { calibreId: fa.calibre_id, kind: fa.kind ?? 'full', chars: fa.chars ?? 0 },
          { calibreId: fb.calibre_id, kind: fb.kind ?? 'full', chars: fb.chars ?? 0 },
          { aInB: 0, bInA: 0, extraA: null, extraB: null },
          settings,
        );
        if (v.cls === 'never' && (v.rule === 'sample' || v.rule === 'bonus')) {
          decideByKind.run(v.cls, v.rule, v.reason, now, p.analysisId, x.a, x.b);
        }
      }
      p.candidates = pairs.length;
      p.compareTotal = (
        this.deps.cleanup
          .prepare(
            'SELECT COUNT(*) AS n FROM content_pairs WHERE analysis_id = ? AND class IS NULL',
          )
          .get(p.analysisId) as { n: number }
      ).n;
      p.phase = 'compare';
      this.save(p, 'analysing');
    })();
    this.deps.log?.(
      `Cleanup stage 3: ${pairs.length} candidate pairs (${out.data.stats.postings} samples of ${out.data.stats.books} books, index ${out.data.stats.ms} ms)`,
    );
    return p;
  }

  // ---- compare ----

  private async compareStep(p: Stage3Progress, shouldStop: () => boolean): Promise<Stage3Progress> {
    const pending = this.deps.cleanup
      .prepare(
        `SELECT * FROM content_pairs WHERE analysis_id = ? AND class IS NULL AND error IS NULL
         ORDER BY a_id, b_id LIMIT ?`,
      )
      .all(p.analysisId, COMPARE_CHUNK) as PairRow[];
    if (pending.length === 0) {
      this.findOmnibusByText(p);
      p.phase = 'quality';
      p.qualityTotal = this.qualityBooks(p).length;
      return p;
    }
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const settings = getSettings(this.deps.cleanup);
    const pacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const facts = this.facts(p.libraryId);

    // Requests of at most BOOKS_PER_COMPARE books each.
    const requests: { books: Set<number>; pairs: PairRow[] }[] = [];
    for (const pair of pending) {
      let req = requests.find(
        (r) =>
          r.books.size + (r.books.has(pair.a_id) ? 0 : 1) + (r.books.has(pair.b_id) ? 0 : 1) <=
          BOOKS_PER_COMPARE,
      );
      if (!req) {
        req = { books: new Set(), pairs: [] };
        requests.push(req);
      }
      req.books.add(pair.a_id);
      req.books.add(pair.b_id);
      req.pairs.push(pair);
    }
    const results = await Promise.all(
      requests.map(async (r) => {
        if (shouldStop()) return null;
        const list = [...r.books]
          .filter((id) => books.has(id))
          .map((id) => ({ key: id, file: resolveInside(libDir, books.get(id)!.filePath) }));
        const out = await this.deps.reader().compare(
          list,
          r.pairs.map((x) => [x.a_id, x.b_id] as [number, number]),
          { minRun: MIN_RUN, minContext: MIN_CONTEXT },
        );
        if (out.ok) await pacer.take(out.data.bytesRead);
        return { r, out };
      }),
    );
    const update = this.deps.cleanup.prepare(
      `UPDATE content_pairs SET a_in_b = @aInB, b_in_a = @bInA, class = @cls, rule = @rule,
         reason = @reason, container = @container, spread_json = @spread, measured_at = @now,
         error = @error WHERE id = @id`,
    );
    const now = Date.now();
    this.deps.cleanup.transaction(() => {
      for (const res of results) {
        if (!res) continue;
        const { r, out } = res;
        if (!out.ok) {
          if (out.stopped) continue;
          for (const pair of r.pairs) {
            update.run({
              id: pair.id,
              aInB: null,
              bInA: null,
              cls: null,
              rule: null,
              reason: null,
              container: null,
              spread: null,
              now,
              error: `${out.code}: ${out.message}`.slice(0, 500),
            });
            p.compareErrors++;
          }
          continue;
        }
        const data: CompareResult = out.data;
        const byKey = new Map<string, ComparedPair>(data.pairs.map((x) => [`${x.a}:${x.b}`, x]));
        const failed = new Map(data.failed.map((f) => [f.key, f.message]));
        for (const pair of r.pairs) {
          const m = byKey.get(`${pair.a_id}:${pair.b_id}`);
          if (!m) {
            const why = failed.get(pair.a_id) ?? failed.get(pair.b_id) ?? 'not compared';
            update.run({
              id: pair.id,
              aInB: null,
              bInA: null,
              cls: null,
              rule: null,
              reason: null,
              container: null,
              spread: null,
              now,
              error: `Couldn't read a copy: ${why}`.slice(0, 500),
            });
            p.compareErrors++;
            continue;
          }
          const v = this.classify(pair, m, facts, settings.duplicates);
          update.run({
            id: pair.id,
            aInB: m.aInB,
            bInA: m.bInA,
            cls: v.cls,
            rule: v.rule,
            reason: v.reason,
            container: v.container ?? null,
            spread: JSON.stringify({ a: m.extraA, b: m.extraB }),
            now,
            error: null,
          });
          p.compareDone++;
        }
      }
      this.save(p, 'analysing');
    })();
    await yieldNow();
    return p;
  }

  private pairBook(f: FactRow | undefined, id: number): PairBook {
    return { calibreId: id, kind: f?.kind ?? 'full', chars: f?.chars ?? 0 };
  }

  private classify(
    pair: { a_id: number; b_id: number },
    m: { aInB: number; bInA: number; extraA: unknown; extraB: unknown },
    facts: Map<number, FactRow>,
    s: ReturnType<typeof getSettings>['duplicates'],
  ) {
    return classifyPair(
      this.pairBook(facts.get(pair.a_id), pair.a_id),
      this.pairBook(facts.get(pair.b_id), pair.b_id),
      m as Parameters<typeof classifyPair>[2],
      s,
    );
  }

  /** P2: a book that holds two or more books that share nothing is an omnibus. */
  private findOmnibusByText(p: Stage3Progress): void {
    const s = getSettings(this.deps.cleanup).duplicates;
    const facts = this.facts(p.libraryId);
    const pairs = this.deps.cleanup
      .prepare(`SELECT * FROM content_pairs WHERE analysis_id = ? AND source <> 'image_only'`)
      .all(p.analysisId) as PairRow[];
    const overlapping = new Set<string>();
    const holds = new Map<number, number[]>();
    for (const x of pairs) {
      const most = Math.max(x.a_in_b ?? x.est_a_in_b ?? 0, x.b_in_a ?? x.est_b_in_a ?? 0);
      if (most >= s.reviewFloor) overlapping.add(`${x.a_id}:${x.b_id}`);
      if (x.a_in_b === null || x.b_in_a === null) continue;
      // A held by B: A's text is (almost) all in B, but B's not all in A.
      if (x.a_in_b >= s.superset && x.b_in_a < s.bothWays)
        holds.set(x.b_id, [...(holds.get(x.b_id) ?? []), x.a_id]);
      if (x.b_in_a >= s.superset && x.a_in_b < s.bothWays)
        holds.set(x.a_id, [...(holds.get(x.a_id) ?? []), x.b_id]);
    }
    const overlap = (x: number, y: number) =>
      overlapping.has(`${Math.min(x, y)}:${Math.max(x, y)}`);
    const changed: number[] = [];
    for (const [container, held] of holds) {
      const f = facts.get(container);
      if (!f || f.kind === 'omnibus' || f.kind === 'sample' || f.kind === 'bonus') continue;
      const heldBooks = held.map((id) => this.pairBook(facts.get(id), id));
      if (omnibusByText(heldBooks, overlap)) changed.push(container);
    }
    if (changed.length === 0) return;
    const setKind = this.deps.cleanup.prepare(
      `UPDATE text_facts SET kind = 'omnibus', kind_by = 'text',
         kind_marker = 'holds several books' WHERE library_id = ? AND calibre_id = ?`,
    );
    const update = this.deps.cleanup.prepare(
      `UPDATE content_pairs SET class = ?, rule = ?, reason = ?, container = ? WHERE id = ?`,
    );
    this.deps.cleanup.transaction(() => {
      for (const id of changed) setKind.run(p.libraryId, id);
      const now = this.facts(p.libraryId);
      const ids = new Set(changed);
      for (const x of pairs) {
        if (!ids.has(x.a_id) && !ids.has(x.b_id)) continue;
        if (x.a_in_b === null || x.b_in_a === null) continue;
        const spread = x.spread_json
          ? (JSON.parse(x.spread_json) as { a: unknown; b: unknown })
          : null;
        const v = this.classify(
          x,
          { aInB: x.a_in_b, bInA: x.b_in_a, extraA: spread?.a ?? null, extraB: spread?.b ?? null },
          now,
          s,
        );
        update.run(v.cls, v.rule, v.reason, v.container ?? null, x.id);
      }
    })();
    p.omnibusByText = changed.length;
    this.deps.log?.(`Cleanup stage 3: ${changed.length} omnibus files found by their text`);
  }

  // ---- quality ----

  /** Books whose best-copy facts are needed: both sides of duplicate pairs, image-only pairs. */
  private qualityBooks(p: Stage3Progress): number[] {
    const rows = this.deps.cleanup
      .prepare(
        `SELECT a_id AS id FROM content_pairs WHERE analysis_id = ?
           AND (class IN ('duplicate', 'superset') OR source = 'image_only')
         UNION SELECT b_id FROM content_pairs WHERE analysis_id = ?
           AND (class IN ('duplicate', 'superset') OR source = 'image_only')
         ORDER BY id`,
      )
      .all(p.analysisId, p.analysisId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  private async qualityStep(p: Stage3Progress, shouldStop: () => boolean): Promise<Stage3Progress> {
    const books = this.loadBooks(p.libraryId);
    const libDir = this.libraryDir(p.libraryId);
    const settings = getSettings(this.deps.cleanup);
    const pacer = new Pacer(settings.pacing.readMbPerSecond * 1024 * 1024);
    const all = this.qualityBooks(p);
    p.qualityTotal = all.length;
    const ids = all
      .filter((id) => id > p.qualityCursor)
      .slice(0, Math.max(4, settings.duplicates.textWorkers * 2));
    if (ids.length === 0) {
      p.phase = 'group';
      return p;
    }
    const facts = this.facts(p.libraryId);
    type Q = { id: number; row: Record<string, unknown> | null };
    const one = async (id: number): Promise<Q | null> => {
      if (shouldStop()) return null;
      const book = books.get(id);
      const f = facts.get(id);
      if (!book || !f) return { id, row: null };
      const file = resolveInside(libDir, book.filePath);
      const st = await statFile(file).catch(() => null);
      if (!st) return { id, row: { id, error: 'The file is gone' } };
      const mtime = Math.round(st.mtimeMs);
      if (f.quality_size === st.size && f.quality_mtime_ms === mtime && f.sha256) {
        return { id, row: null };
      }
      const started = Date.now();
      try {
        const counted = { bytes: 0 };
        const meta = await readFileMetadata(file, {
          text: false,
          cover: true,
          layout: true,
          counted,
        });
        const hashed = await hashSourceFile(file, pacer, shouldStop);
        if (!hashed) return null;
        const images = await epubImageFacts(
          file,
          (meta.layout?.images ?? []).map((i) => i.entry),
          counted,
        );
        await pacer.take(counted.bytes);
        return {
          id,
          row: {
            id,
            size: st.size,
            mtime,
            sha: hashed.sha256,
            vertical:
              meta.layout?.vertical === null || meta.layout?.vertical === undefined
                ? null
                : meta.layout.vertical
                  ? 1
                  : 0,
            cover: meta.cover ? Math.max(meta.cover.width, meta.cover.height) : null,
            images: JSON.stringify(images),
            ms: Date.now() - started,
            error: null,
          },
        };
      } catch (err) {
        return { id, row: { id, error: (err as Error).message.slice(0, 500) } };
      }
    };
    const results = await Promise.all(ids.map(one));
    const done: Q[] = [];
    for (const r of results) {
      if (!r) break;
      done.push(r);
    }
    const put = this.deps.cleanup.prepare(
      `UPDATE text_facts SET quality_size = @size, quality_mtime_ms = @mtime, sha256 = @sha,
         vertical = @vertical, cover_side = @cover, images_json = @images, quality_ms = @ms,
         quality_at = @now, quality_error = NULL WHERE library_id = @lib AND calibre_id = @id`,
    );
    const fail = this.deps.cleanup.prepare(
      `UPDATE text_facts SET quality_error = ?, quality_at = ? WHERE library_id = ? AND calibre_id = ?`,
    );
    const now = Date.now();
    this.deps.cleanup.transaction(() => {
      for (const d of done) {
        if (d.row && d.row.error) {
          fail.run(d.row.error, now, p.libraryId, d.id);
          p.qualityErrors++;
        } else if (d.row) {
          put.run({ ...d.row, now, lib: p.libraryId });
        }
        p.qualityDone++;
        p.qualityCursor = d.id;
      }
      this.save(p, 'analysing');
    })();
    await yieldNow();
    return p;
  }

  // ---- group ----

  private qualityOf(f: FactRow, book: Stage3Book, customTags: string[]): QualityFacts {
    return {
      calibreId: f.calibre_id,
      chars: f.chars ?? 0,
      images: f.images_json ? (JSON.parse(f.images_json) as ImageFact[]) : [],
      ruby: f.ruby ?? 0,
      tocEntries: f.toc_entries ?? 0,
      vertical: f.vertical === null ? null : f.vertical === 1,
      coverSide: f.cover_side,
      customTags: book.tags.filter((t) => isCustomTag(t, customTags)).length,
      addedAt: book.timestamp,
    };
  }

  private groupStep(p: Stage3Progress): Stage3Progress {
    const db = this.deps.cleanup;
    const settings = getSettings(db);
    const books = this.loadBooks(p.libraryId);
    const facts = this.facts(p.libraryId);
    const pairs = db
      .prepare('SELECT * FROM content_pairs WHERE analysis_id = ?')
      .all(p.analysisId) as PairRow[];
    const decisions = new Map(
      (
        db
          .prepare('SELECT a_uuid, b_uuid, decision FROM pair_decisions WHERE library_id = ?')
          .all(p.libraryId) as { a_uuid: string; b_uuid: string; decision: string }[]
      ).map((d) => [`${d.a_uuid}|${d.b_uuid}`, d.decision]),
    );
    const decisionOf = (x: PairRow): string | null => {
      const direct = decisions.get(`${x.a_uuid}|${x.b_uuid}`);
      if (direct) return direct;
      const flipped = decisions.get(`${x.b_uuid}|${x.a_uuid}`);
      if (flipped === 'remove_a') return 'remove_b';
      if (flipped === 'remove_b') return 'remove_a';
      return flipped ?? null;
    };

    const updateBest = db.prepare(
      `UPDATE content_pairs SET best_json = ?, keep_id = ?, class = ?, rule = ?, reason = ? WHERE id = ?`,
    );
    const edges: SetEdge[] = [];
    const pairOf = new Map<string, PairRow>();
    const userDecided = new Set<string>();
    const opts = {
      imageMatchDistance: settings.duplicates.imageMatchDistance,
      coverLargerPercent: settings.covers.largerPercent,
    };
    db.transaction(() => {
      for (const x of pairs) {
        const decision = decisionOf(x);
        const key = `${x.a_id}:${x.b_id}`;
        pairOf.set(key, x);
        if (decision === 'keep_both') {
          updateBest.run(
            x.best_json,
            null,
            'keep_both',
            'user',
            'You chose to keep both copies',
            x.id,
          );
          x.class = 'keep_both';
          continue;
        }
        if (decision === 'remove_a' || decision === 'remove_b') {
          const keep = decision === 'remove_a' ? x.b_id : x.a_id;
          updateBest.run(x.best_json, keep, x.class ?? 'review', x.rule, x.reason, x.id);
          edges.push({ a: x.a_id, b: x.b_id, keep });
          userDecided.add(key);
          continue;
        }
        if (x.class !== 'duplicate' && x.class !== 'superset') continue;
        const fa = facts.get(x.a_id);
        const fb = facts.get(x.b_id);
        const ba = books.get(x.a_id);
        const bb = books.get(x.b_id);
        if (
          !fa ||
          !fb ||
          !ba ||
          !bb ||
          fa.quality_error ||
          fb.quality_error ||
          !fa.sha256 ||
          !fb.sha256
        ) {
          const best = {
            keep: null,
            by: 'tradeoff',
            measures: [],
            reason: "A copy's pictures couldn't be read",
          };
          updateBest.run(JSON.stringify(best), null, x.class, x.rule, x.reason, x.id);
          edges.push({ a: x.a_id, b: x.b_id, keep: null });
          continue;
        }
        const best: BestCopy = bestCopy(
          this.qualityOf(fa, ba, settings.customTags),
          this.qualityOf(fb, bb, settings.customTags),
          { ...opts, superset: x.class === 'superset' ? (x.container ?? undefined) : undefined },
        );
        const keep = best.keep === 'a' ? x.a_id : best.keep === 'b' ? x.b_id : null;
        updateBest.run(JSON.stringify(best), keep, x.class, x.rule, x.reason, x.id);
        x.keep_id = keep;
        edges.push({ a: x.a_id, b: x.b_id, keep });
      }
    })();

    const sets = decideSets(edges);
    const readerBook = (uuid: string) =>
      findCalibreSource(this.deps.main, p.libraryId, uuid)?.bookId;
    const allReader: string[] = [];
    for (const set of sets) {
      for (const id of set.members) {
        const b = books.get(id);
        const rb = b ? readerBook(b.uuid) : undefined;
        if (rb) allReader.push(rb);
      }
    }
    const withData = booksWithReaderData(this.deps.main, allReader);
    const active = new Set(
      (
        db
          .prepare(
            `SELECT calibre_uuid AS uuid FROM proposed_changes
             WHERE stage IN (1, 3) AND library_id = ? AND state IN ('queued', 'applied', 'undone', 'kept')
             UNION SELECT restored_uuid AS uuid FROM undo_records
             WHERE library_id = ? AND restored_uuid IS NOT NULL`,
          )
          .all(p.libraryId, p.libraryId) as { uuid: string }[]
      ).map((r) => r.uuid),
    );
    const insert = db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, state, decided_by, decided_at, analysis_id,
         created_at, updated_at)
       VALUES (3, @lib, @id, @uuid, 'book', '"present"', '"removed"', 'stage3:text', @evidence,
         'auto', 'proposed', @by, @decidedAt, @analysis, @now, @now)`,
    );
    const markPair = db.prepare(
      `UPDATE content_pairs SET class = 'review', rule = ?, reason = ? WHERE id = ?`,
    );
    let toRemove = 0;
    let setsWithoutKeeper = 0;
    let removedWithData = 0;
    let bothWithData = 0;
    let tagsCopied = 0;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        `DELETE FROM proposed_changes WHERE stage = 3 AND library_id = ?
           AND state IN ('proposed', 'skipped') AND id NOT IN (SELECT change_id FROM batch_items)`,
      ).run(p.libraryId);
      db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = 'Replaced by a new analysis',
           updated_at = ? WHERE stage = 3 AND library_id = ? AND state = 'proposed'`,
      ).run(now, p.libraryId);
      for (const set of sets) {
        if (set.keeper === null) {
          setsWithoutKeeper++;
          continue;
        }
        const keep = books.get(set.keeper)!;
        const keepFacts = facts.get(set.keeper)!;
        const keptReader = readerBook(keep.uuid);
        const keptHasData = keptReader ? withData.has(keptReader) : false;
        for (const id of set.removed) {
          const copy = books.get(id);
          const copyFacts = facts.get(id);
          if (!copy || !copyFacts || active.has(copy.uuid)) continue;
          const key = `${Math.min(id, set.keeper)}:${Math.max(id, set.keeper)}`;
          const pair = pairOf.get(key)!;
          const removedReader = readerBook(copy.uuid);
          const removedHasData = removedReader ? withData.has(removedReader) : false;
          const evidence = {
            sha256: copyFacts.sha256,
            size: copyFacts.quality_size ?? copyFacts.size,
            setSize: set.members.length,
            rule: 'stage3',
            title: copy.title,
            kept: {
              calibreId: keep.calibreId,
              uuid: keep.uuid,
              title: keep.title,
              firstAuthor: keep.firstAuthor,
              tags: keep.tags,
              formats: keep.formats,
              addedAt: keep.timestamp,
              lastModified: keep.lastModified,
              readerData: keptHasData,
              sha256: keepFacts.sha256,
              filePath: keep.filePath,
              size: keepFacts.quality_size ?? keepFacts.size,
              mtimeMs: keepFacts.quality_mtime_ms ?? keepFacts.mtime_ms,
              chars: keepFacts.chars,
              kind: keepFacts.kind,
            },
            removed: {
              calibreId: copy.calibreId,
              uuid: copy.uuid,
              title: copy.title,
              tags: copy.tags,
              customTags: copy.tags.filter((t) => isCustomTag(t, settings.customTags)),
              formats: copy.formats,
              extraFormats: copy.formats.filter((f) => !keep.formats.includes(f)),
              addedAt: copy.timestamp,
              lastModified: copy.lastModified,
              filePath: copy.filePath,
              readerData: removedHasData,
              size: copyFacts.quality_size ?? copyFacts.size,
              mtimeMs: copyFacts.quality_mtime_ms ?? copyFacts.mtime_ms,
              chars: copyFacts.chars,
              kind: copyFacts.kind,
            },
            stage3: {
              pairId: pair.id,
              class: pair.class,
              rule: pair.rule,
              reason: pair.reason,
              /** Share of the removed copy's text found in the kept one, and the other way. */
              removedInKept: pair.a_id === id ? pair.a_in_b : pair.b_in_a,
              keptInRemoved: pair.a_id === id ? pair.b_in_a : pair.a_in_b,
              best: pair.best_json ? (JSON.parse(pair.best_json) as BestCopy) : null,
              byUser: userDecided.has(key),
            },
          };
          // P7: copying tags writes the kept copy, which renames its folder (every write
          // renames): a name the disk would refuse goes to review instead.
          const copied = tagsToCopy(
            evidence as unknown as Parameters<typeof tagsToCopy>[0],
            settings.customTags,
          );
          if (copied.length > 0) {
            const bytes = calibreNameBytes(keep.calibreId, keep.title, keep.firstAuthor);
            if (bytes > NAME_MAX_BYTES) {
              markPair.run(
                'name_too_long',
                `Your tags would go to the copy that stays, but its folder name would be too long for Calibre's library (${bytes} bytes; the disk takes ${NAME_MAX_BYTES})`,
                pair.id,
              );
              continue;
            }
            tagsCopied++;
          }
          if (removedHasData && keptHasData) bothWithData++;
          else if (removedHasData) removedWithData++;
          toRemove++;
          insert.run({
            lib: p.libraryId,
            id: copy.calibreId,
            uuid: copy.uuid,
            evidence: JSON.stringify(evidence),
            by: userDecided.has(key) ? 'user' : null,
            decidedAt: userDecided.has(key) ? now : null,
            analysis: p.analysisId,
            now,
          });
        }
      }
    })();

    const classes: Record<string, number> = {};
    for (const r of db
      .prepare(
        `SELECT COALESCE(class, CASE WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END) AS c,
                COUNT(*) AS n FROM content_pairs WHERE analysis_id = ? GROUP BY c`,
      )
      .all(p.analysisId) as { c: string; n: number }[]) {
      classes[r.c] = r.n;
    }
    p.classes = classes;
    p.sets = sets.length;
    p.setsWithoutKeeper = setsWithoutKeeper;
    p.toRemove = toRemove;
    p.review = this.reviewCount(p.analysisId);
    p.removedWithData = removedWithData;
    p.bothWithData = bothWithData;
    p.tagsCopied = tagsCopied;
    p.gate = this.evaluateGate(p);
    p.phase = 'done';
    p.finishedAt = Date.now();
    this.deps.log?.(
      `Cleanup stage 3: analysis done: ${toRemove} copies to remove, ${p.review} pairs to review, gate ${p.gate.passed ? 'passed' : 'not passed'}`,
    );
    return p;
  }

  /** Pairs waiting for a decision: review, image-only, and duplicates without a clear better copy. */
  reviewCount(analysisId: string): number {
    return (
      this.deps.cleanup
        .prepare(
          `SELECT COUNT(*) AS n FROM content_pairs WHERE analysis_id = ?
             AND (class = 'review' OR (class IN ('duplicate', 'superset') AND keep_id IS NULL))`,
        )
        .get(analysisId) as { n: number }
    ).n;
  }

  // ---- gate ----

  labeledFile(): string | null {
    const s = getSettings(this.deps.cleanup);
    if (s.gate.labeledBooksFile) return s.gate.labeledBooksFile;
    return this.deps.dbDir
      ? path.join(this.deps.dbDir, 'cleanup', 'reference-sample', 'gold800.json')
      : null;
  }

  evaluateGate(p: Stage3Progress): Stage3Gate {
    const problems: string[] = [];
    const facts = this.facts(p.libraryId);
    const map = this.removalMap(p.libraryId);
    const s = getSettings(this.deps.cleanup).duplicates;
    const gate: Stage3Gate = {
      checkedAt: Date.now(),
      passed: false,
      problems,
      pairs: null,
      spread: null,
      kinds: null,
      textLength: null,
    };

    // 1. The measured pairs.
    const file = this.gateFile();
    const loaded = file
      ? loadGatePairs(file)
      : { pairs: null, error: 'No file for the measured pairs is set' };
    if (!loaded.pairs) {
      problems.push(`The measured duplicate pairs: ${loaded.error}`);
    } else {
      const rows = this.deps.cleanup.prepare(
        'SELECT * FROM content_pairs WHERE analysis_id = ? AND a_id = ? AND b_id = ?',
      );
      const results: GatePairResult[] = [];
      let same = 0;
      for (const g of loaded.pairs) {
        const ga = map.get(g.a) ?? g.a;
        const gb = map.get(g.b) ?? g.b;
        if (ga === gb) {
          same++;
          continue;
        }
        const swap = ga > gb;
        const [x, y] = swap ? [gb, ga] : [ga, gb];
        const row = rows.get(p.analysisId, x, y) as PairRow | undefined;
        let got: string | null = null;
        let ours: { aInB: number; bInA: number } | null = null;
        let note: string | null = null;
        if (!row) note = NOT_IN_LIBRARY;
        else if (row.error) note = row.error;
        else if (row.class === 'never' && row.a_in_b === null) got = 'never';
        else if (row.a_in_b !== null && row.b_in_a !== null) {
          // The class before the spread check, from our numbers and our kinds.
          const base = this.classify(
            row,
            { aInB: row.a_in_b, bInA: row.b_in_a, extraA: null, extraB: null },
            facts,
            s,
          );
          got = base.cls;
          ours = swap
            ? { aInB: row.b_in_a, bInA: row.a_in_b }
            : { aInB: row.a_in_b, bInA: row.b_in_a };
        } else note = 'Not measured';
        results.push({
          key: g.key,
          group: g.group,
          a: g.a,
          b: g.b,
          expected: g.expected,
          got,
          measured: g.measured,
          ours,
          foundByIndex: row?.source === 'index',
          note,
        });
      }
      // A pair with a copy no longer in the library can't be measured: listed, not failed.
      const gone = results.filter((r) => r.note === NOT_IN_LIBRARY).length;
      const checked = results.length - gone;
      const asMeasured = results.filter((r) => r.got === r.expected).length;
      gate.pairs = {
        file: file!,
        total: loaded.pairs.length,
        sameAfterStage1: same,
        notInLibrary: gone,
        checked,
        asMeasured,
        results,
      };
      if (asMeasured < checked) {
        problems.push(`${checked - asMeasured} of ${checked} measured pairs come out differently`);
      }
      const missed = results.filter(
        (r) =>
          (r.expected === 'duplicate' || r.expected === 'superset') &&
          r.got === r.expected &&
          !r.foundByIndex,
      );
      if (missed.length > 0)
        problems.push(`${missed.length} expected duplicates were not found by the index`);

      // 2. The spread anchors.
      const shareOf = (g: (typeof loaded.pairs)[number]): number | null => {
        const ga = map.get(g.a) ?? g.a;
        const gb = map.get(g.b) ?? g.b;
        const [x, y] = ga < gb ? [ga, gb] : [gb, ga];
        const row = rows.get(p.analysisId, x, y) as PairRow | undefined;
        if (!row?.spread_json) return null;
        const sp = JSON.parse(row.spread_json) as {
          a?: { interleavedShare: number };
          b?: { interleavedShare: number };
        };
        return Math.max(sp.a?.interleavedShare ?? 0, sp.b?.interleavedShare ?? 0);
      };
      const spread = loaded.pairs.filter((g) => g.anchor === 'spread').map(shareOf);
      const flat = loaded.pairs.filter((g) => g.anchor === 'not_spread').map(shareOf);
      if (
        spread.length &&
        flat.length &&
        spread.every((x) => x !== null) &&
        flat.every((x) => x !== null)
      ) {
        const lo = Math.min(...(spread as number[]));
        const hi = Math.max(...(flat as number[]));
        gate.spread = {
          ok: lo > hi,
          detail: `Commentary edition ${(100 * lo).toFixed(1)} % extra inside the chapters; editions without: at most ${(100 * hi).toFixed(1)} %`,
        };
        if (!gate.spread.ok)
          problems.push('The spread measure does not separate the inspected editions');
      } else {
        gate.spread = { ok: null, detail: 'The inspected editions were not all measured' };
      }
    }

    // 3 and 4. The labeled books.
    const labeled = this.labeledFile();
    type Label = { kind?: string; fmt?: string };
    let gold: Record<string, Label> | null = null;
    try {
      gold = labeled
        ? (JSON.parse(fs.readFileSync(labeled, 'utf8')) as Record<string, Label>)
        : null;
    } catch {
      gold = null;
    }
    if (!gold) {
      problems.push(`The labeled books: can't read ${labeled ?? '(no file set)'}`);
    } else {
      const missed: { id: number; label: string; got: string }[] = [];
      let guards = 0;
      let imageOnly = 0;
      const imageOnlyMissed: number[] = [];
      let compared = 0;
      let equal = 0;
      const differing: { id: number; ours: number; reader: number }[] = [];
      for (const [key, label] of Object.entries(gold)) {
        const id = map.get(Number(key)) ?? Number(key);
        const f = facts.get(id);
        if (!f || f.error) continue;
        const want = label.kind === 'special edition' ? 'special' : label.kind;
        if (want === 'sample' || want === 'bonus' || want === 'omnibus') {
          guards++;
          if (f.kind !== want) missed.push({ id, label: want, got: f.kind ?? 'none' });
        }
        if (label.fmt === 'image-only') {
          imageOnly++;
          if (f.image_only !== 1) imageOnlyMissed.push(id);
        }
        if (f.reader_chars !== null && f.chars !== null) {
          compared++;
          if (f.reader_chars === f.chars) equal++;
          else differing.push({ id, ours: f.chars, reader: f.reader_chars });
        }
      }
      gate.kinds = {
        guards,
        recognized: guards - missed.length,
        missed,
        imageOnly,
        imageOnlyRecognized: imageOnly - imageOnlyMissed.length,
        imageOnlyMissed,
      };
      gate.textLength = { compared, equal, differing };
      if (missed.length)
        problems.push(
          `${missed.length} labeled previews, bonus stories or omnibus files not recognized`,
        );
      if (imageOnlyMissed.length)
        problems.push(`${imageOnlyMissed.length} labeled image-only books not recognized`);
      if (differing.length)
        problems.push(
          `${differing.length} labeled books' text length differs from the reader's count`,
        );
    }
    // Library-wide: stage 3's text length against the reader's own count of the same file.
    const books = this.loadBooks(p.libraryId);
    let compared = 0;
    let differing = 0;
    for (const f of facts.values()) {
      if (!books.has(f.calibre_id) || f.error || f.reader_chars === null || f.chars === null)
        continue;
      compared++;
      if (f.reader_chars !== f.chars) differing++;
    }
    p.readerCompared = compared;
    p.readerDiffering = differing;
    const alarm = getSettings(this.deps.cleanup).reviewAlarmPercent;
    if (compared > 0 && (100 * differing) / compared > alarm) {
      problems.push(
        `${differing} of ${compared} books' text length differs from the reader's own count (more than ${alarm} %)`,
      );
    }
    gate.passed = problems.length === 0;
    return gate;
  }
}
