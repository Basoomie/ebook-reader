/**
 * Stage 3 (WP20c): the work the reader processes do (book-text-child runs it; tests run the very
 * same functions in-process with the real counter bundle):
 *
 *   text     one book: its length, chapters, ruby, TOC and the sketch (sampled windows)
 *   compare  a few books read once each, then the exact containment of the given pairs both
 *            ways and the extra text of each side
 *   index    the candidate pairs from the stored sketches (the regenerable cache database,
 *            opened read-only): the sort takes seconds and hundreds of MB, kept off the server
 *   libIndex the library's sketches written as one sorted lookup file (new arrivals, WP20g)
 *   textMeasure  one new book read (as text), its library candidates looked up in that file and
 *            measured against it at once (as compare), so the book is not read a second time
 *
 * Calibre files are opened only through calibre/source-fs (read-only).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { openSourceBlob } from '../calibre/source-fs';
import {
  buildLookup,
  candidatePairs,
  lookupCandidates,
  type CandidatePair,
  type IndexStats,
  type LibraryLookup,
} from './stage3-index';
import {
  containment,
  extraText,
  sketchFromBlob,
  sketchOf,
  sortedUnique,
  toCodePoints,
  windowHashes,
  type ExtraText,
} from './stage3-sketch';

/** The counter bundle's entry (vendor/epub-count.cjs). */
export interface BookTextModule {
  bookTextForServer(
    epub: unknown,
    options: unknown,
  ): Promise<{
    text: string;
    characters: number;
    importCharacters: number;
    chapters: { start: number; label: string }[];
    ruby: number;
    tocEntries: number;
  }>;
}

export interface TextRequest {
  id: number;
  type: 'text';
  file: string;
  options: unknown;
}

export interface CompareRequest {
  id: number;
  type: 'compare';
  books: { key: number; file: string }[];
  pairs: [number, number][];
  options: unknown;
  minRun: number;
  minContext: number;
}

export interface IndexRequest {
  id: number;
  type: 'index';
  cacheFile: string;
  libraryId: string;
  ids: number[];
  commonBooks: number;
  minShared: number;
  minEstimate: number;
}

export interface LibIndexRequest {
  id: number;
  type: 'libIndex';
  cacheFile: string;
  libraryId: string;
  /** The library books (stage 3's present ones) and their files, read only. */
  books: { id: number; file: string }[];
  /** Written as <out>.bin (the postings) and <out>.json (ids, sketch lengths, files). */
  out: string;
}

export interface TextMeasureRequest {
  id: number;
  type: 'textMeasure';
  file: string;
  /** The new book's key (a, in every pair measured). */
  key: number;
  options: unknown;
  /** A libIndex output (its <out>). */
  index: string;
  commonBooks: number;
  minShared: number;
  minEstimate: number;
  /** At most this many library books are read and measured (the rest are left to later). */
  maxBooks: number;
  minRun: number;
  minContext: number;
}

export type Stage3Request =
  | TextRequest
  | CompareRequest
  | IndexRequest
  | LibIndexRequest
  | TextMeasureRequest;

export interface TextResult {
  characters: number;
  importCharacters: number;
  sketch: number[];
  chapters: number[];
  ruby: number;
  tocEntries: number;
  bytesRead: number;
  durationMs: number;
}

/** Extra text with its first runs only (for the page), and how many runs there were. */
export type ExtraSummary = ExtraText & { runCount: number };

export interface ComparedPair {
  a: number;
  b: number;
  aInB: number;
  bInA: number;
  extraA: ExtraSummary;
  extraB: ExtraSummary;
}

export interface CompareResult {
  pairs: ComparedPair[];
  /** Books that couldn't be read (their pairs are left out). */
  failed: { key: number; message: string }[];
  characters: Record<number, number>;
  bytesRead: number;
  durationMs: number;
}

export interface IndexResult {
  pairs: CandidatePair[];
  stats: IndexStats;
}

export interface LibIndexResult {
  books: number;
  postings: number;
  durationMs: number;
}

export interface TextMeasureResult {
  text: TextResult;
  /** Every library candidate the lookup found (Calibre ids, most shared samples first). */
  candidates: number[];
  /** The pairs measured (a = the new book), as compare gives them. */
  pairs: ComparedPair[];
  /** Library books that could not be read (their pairs are left out). */
  failed: { key: number; message: string }[];
  /** Bytes read of the library books (text.bytesRead is the new book's). */
  libraryBytesRead: number;
}

export type WorkResult =
  | {
      ok: true;
      data: TextResult | CompareResult | IndexResult | LibIndexResult | TextMeasureResult;
    }
  | { ok: false; code: string; message: string };

const MAX_MESSAGE = 500;
const MAX_RUNS_KEPT = 40;

export function describe(err: unknown): string {
  const text = err instanceof Error ? err.message || String(err) : String(err);
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'file_missing' : 'bad_epub';
}

function summary(e: ExtraText): ExtraSummary {
  return { ...e, runs: e.runs.slice(0, MAX_RUNS_KEPT), runCount: e.runs.length };
}

interface LoadedBook {
  hashes: Uint32Array;
  set: Uint32Array;
  length: number;
  chapters: number[];
}

function loaded(text: string, chapters: { start: number }[]): LoadedBook {
  const cps = toCodePoints(text);
  const hashes = windowHashes(cps);
  return {
    hashes,
    set: sortedUnique(hashes),
    length: cps.length,
    chapters: chapters.map((c) => c.start),
  };
}

function measured(
  ka: number,
  a: LoadedBook,
  kb: number,
  b: LoadedBook,
  opts: { minRun: number; minContext: number },
): ComparedPair {
  const c = containment(a.set, b.set);
  return {
    a: ka,
    b: kb,
    aInB: c.aInB,
    bInA: c.bInA,
    extraA: summary(extraText(a.hashes, a.length, b.set, a.chapters, opts)),
    extraB: summary(extraText(b.hashes, b.length, a.set, b.chapters, opts)),
  };
}

/** The lookup file this process loaded last (a process serves many books with one file). */
let lookupLoaded: {
  file: string;
  mtimeMs: number;
  lookup: LibraryLookup;
  files: string[];
} | null = null;

function loadLookup(out: string): { lookup: LibraryLookup; files: string[] } {
  const mtimeMs = fs.statSync(`${out}.bin`).mtimeMs;
  if (lookupLoaded?.file === out && lookupLoaded.mtimeMs === mtimeMs) return lookupLoaded;
  lookupLoaded = null;
  const meta = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')) as {
    ids: number[];
    lens: number[];
    files: string[];
  };
  const buf = fs.readFileSync(`${out}.bin`);
  // A copy aligned for Float64Array (a Buffer from the pool may start anywhere).
  const postings = new Float64Array(buf.byteLength / 8);
  new Uint8Array(postings.buffer).set(buf);
  lookupLoaded = {
    file: out,
    mtimeMs,
    lookup: { postings, ids: Int32Array.from(meta.ids), lens: Int32Array.from(meta.lens) },
    files: meta.files,
  };
  return lookupLoaded;
}

/** Does one request with the given counter bundle. Never throws. */
export async function doWork(reader: BookTextModule, req: Stage3Request): Promise<WorkResult> {
  const readText = async (file: string, options: unknown) => {
    const source = await openSourceBlob(file);
    try {
      const t = await reader.bookTextForServer(source.blob, options);
      return { ...t, bytesRead: source.bytesRead() };
    } finally {
      await source.close().catch(() => {});
    }
  };
  const started = Date.now();

  if (req.type === 'text') {
    try {
      const t = await readText(req.file, req.options);
      const hashes = windowHashes(toCodePoints(t.text));
      const data: TextResult = {
        characters: t.characters,
        importCharacters: t.importCharacters,
        sketch: Array.from(sketchOf(hashes)),
        chapters: t.chapters.map((c) => c.start),
        ruby: t.ruby,
        tocEntries: t.tocEntries,
        bytesRead: t.bytesRead,
        durationMs: Date.now() - started,
      };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: errorCode(err), message: describe(err) };
    }
  }

  if (req.type === 'compare') {
    const books = new Map<number, LoadedBook>();
    const failed: { key: number; message: string }[] = [];
    const characters: Record<number, number> = {};
    let bytesRead = 0;
    for (const b of req.books) {
      try {
        const t = await readText(b.file, req.options);
        bytesRead += t.bytesRead;
        books.set(b.key, loaded(t.text, t.chapters));
        characters[b.key] = t.characters;
      } catch (err) {
        failed.push({ key: b.key, message: describe(err) });
      }
    }
    const pairs: ComparedPair[] = [];
    const opts = { minRun: req.minRun, minContext: req.minContext };
    for (const [ka, kb] of req.pairs) {
      const a = books.get(ka);
      const b = books.get(kb);
      if (!a || !b) continue;
      pairs.push(measured(ka, a, kb, b, opts));
    }
    const data: CompareResult = {
      pairs,
      failed,
      characters,
      bytesRead,
      durationMs: Date.now() - started,
    };
    return { ok: true, data };
  }

  if (req.type === 'textMeasure') {
    let t: Awaited<ReturnType<typeof readText>>;
    try {
      t = await readText(req.file, req.options);
    } catch (err) {
      return { ok: false, code: errorCode(err), message: describe(err) };
    }
    try {
      const own = loaded(t.text, t.chapters);
      // As the text request makes it (window hashes of the same text).
      const sketch = sketchOf(own.hashes);
      const text: TextResult = {
        characters: t.characters,
        importCharacters: t.importCharacters,
        sketch: Array.from(sketch),
        chapters: own.chapters,
        ruby: t.ruby,
        tocEntries: t.tocEntries,
        bytesRead: t.bytesRead,
        durationMs: Date.now() - started,
      };
      const { lookup, files } = loadLookup(req.index);
      const cands = lookupCandidates(lookup, sketch, {
        commonBooks: req.commonBooks,
        minShared: req.minShared,
        minEstimate: req.minEstimate,
      });
      const fileOf = new Map<number, string>();
      lookup.ids.forEach((id, i) => fileOf.set(id, files[i]));
      const pairs: ComparedPair[] = [];
      const failed: { key: number; message: string }[] = [];
      let libraryBytesRead = 0;
      const opts = { minRun: req.minRun, minContext: req.minContext };
      for (const c of cands.slice(0, req.maxBooks)) {
        try {
          const lt = await readText(fileOf.get(c.b)!, req.options);
          libraryBytesRead += lt.bytesRead;
          pairs.push(measured(req.key, own, c.b, loaded(lt.text, lt.chapters), opts));
        } catch (err) {
          failed.push({ key: c.b, message: describe(err) });
        }
      }
      const data: TextMeasureResult = {
        text,
        candidates: cands.map((c) => c.b),
        pairs,
        failed,
        libraryBytesRead,
      };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: 'measure_failed', message: describe(err) };
    }
  }

  if (req.type === 'libIndex') {
    try {
      const fileOf = new Map(req.books.map((b) => [b.id, b.file]));
      const db = new Database(req.cacheFile, { readonly: true, fileMustExist: true });
      const books: { calibreId: number; sketch: Uint32Array }[] = [];
      try {
        const rows = db
          .prepare(
            'SELECT calibre_id, samples FROM sketches WHERE library_id = ? ORDER BY calibre_id',
          )
          .iterate(req.libraryId) as Iterable<{ calibre_id: number; samples: Buffer }>;
        for (const r of rows) {
          if (!fileOf.has(r.calibre_id)) continue;
          books.push({ calibreId: r.calibre_id, sketch: sketchFromBlob(r.samples) });
        }
      } finally {
        db.close();
      }
      const lookup = buildLookup(books);
      // Written aside and renamed: a process never loads a half-written file.
      const tmp = `${req.out}.${process.pid}.tmp`;
      fs.writeFileSync(
        `${tmp}.json`,
        JSON.stringify({
          ids: Array.from(lookup.ids),
          lens: Array.from(lookup.lens),
          files: books.map((b) => fileOf.get(b.calibreId)!),
        }),
      );
      fs.writeFileSync(
        `${tmp}.bin`,
        Buffer.from(lookup.postings.buffer, lookup.postings.byteOffset, lookup.postings.byteLength),
      );
      fs.renameSync(`${tmp}.json`, `${req.out}.json`);
      fs.renameSync(`${tmp}.bin`, `${req.out}.bin`);
      const data: LibIndexResult = {
        books: books.length,
        postings: lookup.postings.length,
        durationMs: Date.now() - started,
      };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: 'index_failed', message: describe(err) };
    }
  }

  try {
    const db = new Database(req.cacheFile, { readonly: true, fileMustExist: true });
    const wanted = new Set(req.ids);
    const books: { calibreId: number; sketch: Uint32Array }[] = [];
    try {
      const rows = db
        .prepare(
          'SELECT calibre_id, samples FROM sketches WHERE library_id = ? ORDER BY calibre_id',
        )
        .iterate(req.libraryId) as Iterable<{ calibre_id: number; samples: Buffer }>;
      for (const r of rows) {
        if (!wanted.has(r.calibre_id)) continue;
        books.push({ calibreId: r.calibre_id, sketch: sketchFromBlob(r.samples) });
      }
    } finally {
      db.close();
    }
    const data = candidatePairs(books, {
      commonBooks: req.commonBooks,
      minShared: req.minShared,
      minEstimate: req.minEstimate,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, code: 'index_failed', message: describe(err) };
  }
}
