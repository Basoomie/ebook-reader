/**
 * Stage 3 (WP20c): the work the reader processes do (book-text-child runs it; tests run the very
 * same functions in-process with the real counter bundle):
 *
 *   text     one book: its length, chapters, ruby, TOC and the sketch (sampled windows)
 *   compare  a few books read once each, then the exact containment of the given pairs both
 *            ways and the extra text of each side
 *   index    the candidate pairs from the stored sketches (the regenerable cache database,
 *            opened read-only): the sort takes seconds and hundreds of MB, kept off the server
 *
 * Calibre files are opened only through calibre/source-fs (read-only).
 */
import Database from 'better-sqlite3';
import { openSourceBlob } from '../calibre/source-fs';
import { candidatePairs, type CandidatePair, type IndexStats } from './stage3-index';
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

export type Stage3Request = TextRequest | CompareRequest | IndexRequest;

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

export type WorkResult =
  | { ok: true; data: TextResult | CompareResult | IndexResult }
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
    const books = new Map<
      number,
      { hashes: Uint32Array; set: Uint32Array; length: number; chapters: number[] }
    >();
    const failed: { key: number; message: string }[] = [];
    const characters: Record<number, number> = {};
    let bytesRead = 0;
    for (const b of req.books) {
      try {
        const t = await readText(b.file, req.options);
        bytesRead += t.bytesRead;
        const cps = toCodePoints(t.text);
        const hashes = windowHashes(cps);
        books.set(b.key, {
          hashes,
          set: sortedUnique(hashes),
          length: cps.length,
          chapters: t.chapters.map((c) => c.start),
        });
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
      const c = containment(a.set, b.set);
      pairs.push({
        a: ka,
        b: kb,
        aInB: c.aInB,
        bInA: c.bInA,
        extraA: summary(extraText(a.hashes, a.length, b.set, a.chapters, opts)),
        extraB: summary(extraText(b.hashes, b.length, a.set, b.chapters, opts)),
      });
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
