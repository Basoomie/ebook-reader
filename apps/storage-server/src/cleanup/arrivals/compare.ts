/**
 * The new arrivals' content-duplicate check (WP20g): stage 3's own code on new books. Each new
 * book (a source file of the import, key = -its catalog id; or a book added by hand in Calibre,
 * key = its Calibre id) is read by the reader processes (its text and sketch, as stage 3 reads
 * every book), its sketch put into stage 3's candidate index with the library's, and every pair
 * the index finds with a new book measured exactly (both ways, with the extra text of each side),
 * classified with stage 3's pair rules (classifyPair) and, for a duplicate or superset, the better
 * copy chosen with stage 3's best-copy order (bestCopy: text, pictures, artwork, furigana, table
 * of contents, cover). Nothing here decides what to do with the result: classify.ts does.
 *
 * Library books are read only through source-fs (read-only); source files through the sources
 * mount (read-only). The sketches of source files go into stage 3's regenerable cache under
 * their negative keys (never a Calibre id); their facts stay with the catalog.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { resolveInside, statFile } from '../../calibre/source-fs';
import type { Stage3Reader } from '../../counts/book-text-worker';
import type { ComparedPair } from '../../counts/book-text-child';
import { readFileMetadata } from '../file-metadata';
import { getSettings, isCustomTag } from '../settings';
import { openStage3Cache, stage3CacheFile } from '../stage3';
import { epubImageFacts } from '../stage3-images';
import { editionKind, type EditionKind } from '../stage3-kinds';
import {
  bestCopy,
  classifyPair,
  type BestCopy,
  type ImageFact,
  type PairClass,
  type QualityFacts,
} from '../stage3-rules';
import { sketchToBlob } from '../stage3-sketch';
import { SourcePacer } from './sources-fs';

/** A new book's text facts (as stage 3 keeps them in text_facts). */
export interface NewText {
  key: number;
  file: string;
  chars: number;
  importChars: number;
  kind: EditionKind;
  marker: string | null;
  imageOnly: boolean;
  ruby: number;
  toc: number;
  vertical: boolean | null;
  imageEntries: string[];
  fileTitle: string | null;
  samples: number;
  error: string | null;
}

/** Quality facts of a copy (stage 3's QualityFacts plus its SHA-256). */
export type Quality = QualityFacts & { sha256: string | null };

export interface MeasuredPair {
  /** The new book (a negative key for a source file, else its Calibre id). */
  newKey: number;
  /** The other copy: a library book's Calibre id, or another new book's key. */
  otherKey: number;
  aInB: number;
  bInA: number;
  cls: PairClass;
  rule: string;
  reason: string;
  /** For a duplicate or superset: the copy stage 3 would keep (null: a trade-off, both stay). */
  keep: 'new' | 'other' | null;
  best: BestCopy | null;
}

export interface CompareDeps {
  cleanup: Database.Database;
  cacheDir: string;
  libraryId: string;
  /** The library's folder (Calibre books are read through it, read only). */
  libDir: string;
  reader: Stage3Reader;
  /** Calibre's books with an EPUB (id -> path, title, tags, date added). */
  books: Map<number, { filePath: string; title: string; tags: string[]; timestamp: number | null }>;
  log?: (m: string) => void;
}

export const BOOKS_PER_COMPARE = 8;
const MIN_RUN = 100;
const MIN_CONTEXT = 500;
/** The candidate index's thresholds (the whole index and the per-book lookup use the same). */
const MIN_SHARED = 2;
const MIN_ESTIMATE = 0.05;

/** A book's library pairs measured while its text was read (textMeasure). */
export interface EarlyMeasure {
  /** Every library candidate the lookup found. */
  candidates: number[];
  /** The pairs measured (a = the new book, b = a library book). */
  pairs: ComparedPair[];
}

/**
 * The library's lookup file for measuring each new book against its library candidates while
 * its text is read (WP20g: a book is then read once, not again in the measure stage). The same
 * library books the whole index takes (stage 3's, read, not image-only); written by a reader
 * process to `out` (.bin and .json). Null when the reader has no lookup (a stand-in).
 */
export async function buildLibraryLookup(
  deps: CompareDeps,
  out: string,
): Promise<{ books: number } | null> {
  if (!deps.reader.libIndex || !deps.reader.textMeasure) return null;
  const books = presentLibrary(deps).map((id) => ({
    id,
    file: resolveInside(deps.libDir, deps.books.get(id)!.filePath) as string,
  }));
  openCache(deps).pragma('wal_checkpoint(PASSIVE)');
  const r = await deps.reader.libIndex({
    cacheFile: stage3CacheFile(deps.cacheDir),
    libraryId: deps.libraryId,
    books,
    out,
  });
  if (!r.ok) throw new Error(`The library lookup failed: ${r.message}`);
  return { books: r.data.books };
}

/** The library books the candidate index takes: stage 3 read them, not image-only, in Calibre. */
function presentLibrary(deps: CompareDeps): number[] {
  return (
    deps.cleanup
      .prepare(
        `SELECT calibre_id FROM text_facts WHERE library_id = ? AND error IS NULL
           AND image_only = 0 AND samples > 0`,
      )
      .all(deps.libraryId) as { calibre_id: number }[]
  )
    .map((r) => r.calibre_id)
    .filter((id) => deps.books.has(id));
}

/**
 * Reads one new book (text, sketch, edition kind, layout) with the reader processes, as stage 3's
 * text phase does; the sketch goes into stage 3's cache under the book's key.
 */
export async function readNewText(
  deps: CompareDeps,
  key: number,
  file: string,
  titles: (string | null)[],
  pacer: SourcePacer,
  early?: { index: string; maxBooks: number } | null,
): Promise<NewText & { early?: EarlyMeasure }> {
  const s = getSettings(deps.cleanup).duplicates;
  let fileTitle: string | null = null;
  let imageEntries: string[] = [];
  let vertical: boolean | null = null;
  const counted = { bytes: 0 };
  try {
    const meta = await readFileMetadata(file, { text: false, cover: false, layout: true, counted });
    fileTitle = meta.title;
    imageEntries = (meta.layout?.images ?? []).map((i) => i.entry);
    vertical = meta.layout?.vertical ?? null;
  } catch {
    // The reader's import decides whether the file can be read at all.
  }
  const kind = editionKind([fileTitle, ...titles, path.posix.basename(file, '.epub')]);
  const base: NewText = {
    key,
    file,
    chars: 0,
    importChars: 0,
    kind: kind.kind,
    marker: kind.marker,
    imageOnly: false,
    ruby: 0,
    toc: 0,
    vertical,
    imageEntries,
    fileTitle,
    samples: 0,
    error: null,
  };
  // With the library's lookup: the book read and its library candidates measured in one
  // request; any failure there reads the book alone, as without it (the book's own outcome is
  // the text request's).
  let measured: EarlyMeasure | undefined;
  let libBytes = 0;
  let out: Awaited<ReturnType<typeof deps.reader.text>> | null = null;
  if (early && deps.reader.textMeasure) {
    const r = await deps.reader.textMeasure({
      file,
      key,
      index: early.index,
      commonBooks: s.commonWindowBooks,
      minShared: MIN_SHARED,
      minEstimate: MIN_ESTIMATE,
      maxBooks: early.maxBooks,
      minRun: MIN_RUN,
      minContext: MIN_CONTEXT,
    });
    if (r.ok) {
      out = { ok: true, data: r.data.text };
      measured = { candidates: r.data.candidates, pairs: r.data.pairs };
      libBytes = r.data.libraryBytesRead;
    } else if (r.stopped) out = r;
  }
  if (!out) out = await deps.reader.text(file);
  if (!out.ok) return { ...base, error: `${out.code}: ${out.message}`.slice(0, 500) };
  await pacer.take(out.data.bytesRead + libBytes + counted.bytes);
  const sketch = Uint32Array.from(out.data.sketch);
  const cache = openCache(deps);
  cache
    .prepare(
      `INSERT INTO sketches (library_id, calibre_id, size, mtime_ms, build, samples)
       VALUES (?, ?, 0, 0, 'arrivals', ?)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET samples = excluded.samples,
         build = excluded.build`,
    )
    .run(deps.libraryId, key, sketchToBlob(sketch));
  return {
    ...base,
    chars: out.data.characters,
    importChars: out.data.importCharacters,
    imageOnly: out.data.characters < s.imageOnlyMaxChars && imageEntries.length > 0,
    ruby: out.data.ruby,
    toc: out.data.tocEntries,
    samples: sketch.length,
    ...(measured ? { early: measured } : {}),
  };
}

let cacheDb: { file: string; db: Database.Database } | null = null;
function openCache(deps: CompareDeps): Database.Database {
  const file = stage3CacheFile(deps.cacheDir);
  if (cacheDb?.file === file) return cacheDb.db;
  cacheDb = { file, db: openStage3Cache(deps.cacheDir) };
  return cacheDb.db;
}

/** Removes the sketches of source files (negative keys) once a run is through with them. */
export function dropNewSketches(deps: CompareDeps, keys: number[]): void {
  const cache = openCache(deps);
  const del = cache.prepare('DELETE FROM sketches WHERE library_id = ? AND calibre_id = ?');
  cache.transaction(() => {
    for (const k of keys) if (k < 0) del.run(deps.libraryId, k);
  })();
}

interface LibraryFacts {
  calibre_id: number;
  chars: number | null;
  kind: EditionKind | null;
  image_only: number;
  samples: number | null;
  error: string | null;
  ruby: number | null;
  toc_entries: number | null;
  vertical: number | null;
  cover_side: number | null;
  images_json: string | null;
  sha256: string | null;
  quality_size: number | null;
  quality_mtime_ms: number | null;
  quality_error: string | null;
  size: number | null;
  mtime_ms: number | null;
}

/**
 * The candidate pairs of the new books: stage 3's index over every sketch of the library (books
 * stage 3 read, not image-only) and the new books, keeping only pairs with a new book.
 */
export async function candidatePairsOf(
  deps: CompareDeps,
  news: NewText[],
): Promise<{ a: number; b: number }[]> {
  const s = getSettings(deps.cleanup).duplicates;
  const present = presentLibrary(deps);
  const newKeys = new Set(
    news.filter((n) => !n.error && !n.imageOnly && n.samples > 0).map((n) => n.key),
  );
  if (newKeys.size === 0) return [];
  openCache(deps).pragma('wal_checkpoint(PASSIVE)');
  const ids = [...new Set([...present.filter((id) => !newKeys.has(id)), ...newKeys])];
  const out = await deps.reader.index({
    cacheFile: stage3CacheFile(deps.cacheDir),
    libraryId: deps.libraryId,
    ids,
    commonBooks: s.commonWindowBooks,
    minShared: MIN_SHARED,
    minEstimate: MIN_ESTIMATE,
  });
  if (!out.ok) throw new Error(`The candidate index failed: ${out.message}`);
  return out.data.pairs
    .filter((c) => newKeys.has(c.a) || newKeys.has(c.b))
    .map((c) => ({ a: c.a, b: c.b }));
}

function libraryFacts(deps: CompareDeps, id: number): LibraryFacts | null {
  return (
    (deps.cleanup
      .prepare('SELECT * FROM text_facts WHERE library_id = ? AND calibre_id = ?')
      .get(deps.libraryId, id) as LibraryFacts | undefined) ?? null
  );
}

/**
 * Measures the pairs exactly (the reader processes, both ways) and classifies them with stage 3's
 * rules. Library books are read from their files (read only); new books from theirs.
 */
export async function measurePairs(
  deps: CompareDeps,
  news: Map<number, NewText>,
  pairs: { a: number; b: number }[],
): Promise<{ pair: { a: number; b: number }; m: ComparedPair | null; error: string | null }[]> {
  const fileOf = (k: number): string | null => {
    const n = news.get(k);
    if (n) return n.file;
    const b = deps.books.get(k);
    return b ? (resolveInside(deps.libDir, b.filePath) as string) : null;
  };
  const results: {
    pair: { a: number; b: number };
    m: ComparedPair | null;
    error: string | null;
  }[] = [];
  // Requests of at most BOOKS_PER_COMPARE books, each pair into the first request with room.
  const requests: { keys: Set<number>; pairs: { a: number; b: number }[] }[] = [];
  for (const pr of pairs) {
    let r = requests.find((x) => new Set([...x.keys, pr.a, pr.b]).size <= BOOKS_PER_COMPARE);
    if (!r) requests.push((r = { keys: new Set(), pairs: [] }));
    r.keys.add(pr.a);
    r.keys.add(pr.b);
    r.pairs.push(pr);
  }
  for (const r of requests) {
    const books: { key: number; file: string }[] = [];
    for (const k of r.keys) {
      const f = fileOf(k);
      if (f) books.push({ key: k, file: f });
    }
    const out = await deps.reader.compare(
      books,
      r.pairs.map((p) => [p.a, p.b] as [number, number]),
      { minRun: MIN_RUN, minContext: MIN_CONTEXT },
    );
    if (!out.ok) {
      for (const pr of r.pairs)
        results.push({ pair: pr, m: null, error: out.message.slice(0, 300) });
      continue;
    }
    const failed = new Set(out.data.failed.map((f) => f.key));
    for (const pr of r.pairs) {
      const m = out.data.pairs.find((x) => x.a === pr.a && x.b === pr.b) ?? null;
      results.push({
        pair: pr,
        m,
        error: m
          ? null
          : failed.has(pr.a) || failed.has(pr.b)
            ? 'A copy could not be read'
            : 'Not measured',
      });
    }
  }
  return results;
}

/** A library book's quality facts: stage 3's when they are for its file now, else read (read only). */
export async function libraryQuality(
  deps: CompareDeps,
  id: number,
  pacer: SourcePacer,
): Promise<Quality | null> {
  const b = deps.books.get(id);
  const f = libraryFacts(deps, id);
  if (!b || !f) return null;
  const s = getSettings(deps.cleanup);
  const file = resolveInside(deps.libDir, b.filePath) as string;
  const st = await statFile(file).catch(() => null);
  if (!st) return null;
  const customTags = b.tags.filter((t) => isCustomTag(t, s.customTags)).length;
  if (
    f.quality_size === st.size &&
    f.quality_mtime_ms === Math.round(st.mtimeMs) &&
    f.sha256 &&
    !f.quality_error
  ) {
    return {
      calibreId: id,
      chars: f.chars ?? 0,
      images: f.images_json ? (JSON.parse(f.images_json) as ImageFact[]) : [],
      ruby: f.ruby ?? 0,
      tocEntries: f.toc_entries ?? 0,
      vertical: f.vertical === null ? null : f.vertical === 1,
      coverSide: f.cover_side,
      customTags,
      addedAt: b.timestamp,
      sha256: f.sha256,
    };
  }
  return qualityOfFile(file, {
    calibreId: id,
    chars: f.chars ?? 0,
    ruby: f.ruby ?? 0,
    tocEntries: f.toc_entries ?? 0,
    customTags,
    addedAt: b.timestamp,
    pacer,
    cache: deps.cleanup,
  });
}

/**
 * A file's quality facts read now (cover, layout, pictures), read only. No SHA-256: no rule reads
 * it, and hashing read every file a second time through the read pace (WP20g, 2026-11-24: about
 * half of the measuring's paced bytes, which held it to ~44 books a minute).
 */
export async function qualityOfFile(
  file: string,
  base: {
    calibreId: number;
    chars: number;
    ruby: number;
    tocEntries: number;
    customTags: number;
    addedAt: number | null;
    pacer: SourcePacer;
    /**
     * cleanup.db: the file's picture facts are kept once read (calibre_arrival_quality, by path,
     * size and mtime) and read from there while the file is unchanged. Only what comes from the
     * file is kept; the rest (characters, tags, the date added) is the caller's, as without it.
     */
    cache?: Database.Database;
  },
): Promise<Quality | null> {
  const fromFile = (f: {
    images: ImageFact[];
    vertical: boolean | null;
    coverSide: number | null;
  }): Quality => ({
    calibreId: base.calibreId,
    chars: base.chars,
    images: f.images,
    ruby: base.ruby,
    tocEntries: base.tocEntries,
    vertical: f.vertical,
    coverSide: f.coverSide,
    customTags: base.customTags,
    addedAt: base.addedAt,
    sha256: null,
  });
  try {
    const before = base.cache ? await statFile(file) : null;
    if (before && base.cache) {
      const kept = base.cache
        .prepare('SELECT size, mtime_ms, facts_json FROM calibre_arrival_quality WHERE file = ?')
        .get(file) as { size: number; mtime_ms: number; facts_json: string } | undefined;
      if (kept && kept.size === before.size && kept.mtime_ms === before.mtimeMs)
        return fromFile(JSON.parse(kept.facts_json));
    }
    const counted = { bytes: 0 };
    const meta = await readFileMetadata(file, { text: false, cover: true, layout: true, counted });
    const images = await epubImageFacts(
      file,
      (meta.layout?.images ?? []).map((i) => i.entry),
      counted,
    );
    await base.pacer.take(counted.bytes);
    const read = {
      images,
      vertical: meta.layout?.vertical ?? null,
      coverSide: meta.cover ? Math.max(meta.cover.width, meta.cover.height) : null,
    };
    if (before && base.cache) {
      // Kept only when the file did not change while it was read.
      const after = await statFile(file);
      if (after && after.size === before.size && after.mtimeMs === before.mtimeMs)
        base.cache
          .prepare(
            `INSERT OR REPLACE INTO calibre_arrival_quality (file, size, mtime_ms, facts_json, made_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(file, before.size, before.mtimeMs, JSON.stringify(read), Date.now());
    }
    return fromFile(read);
  } catch {
    return null;
  }
}

/**
 * Classifies a measured pair with stage 3's rules and, for a duplicate or a superset, chooses the
 * better copy. `quality` gives each side's quality facts (read when needed).
 */
export async function judgePair(
  deps: CompareDeps,
  newKey: number,
  otherKey: number,
  m: ComparedPair,
  news: Map<number, NewText>,
  quality: (key: number) => Promise<Quality | null>,
): Promise<MeasuredPair> {
  const s = getSettings(deps.cleanup);
  const side = (k: number) => {
    const n = news.get(k);
    if (n) return { calibreId: k, kind: n.kind, chars: n.chars };
    const f = libraryFacts(deps, k);
    return { calibreId: k, kind: (f?.kind ?? 'full') as EditionKind, chars: f?.chars ?? 0 };
  };
  const a = side(m.a);
  const b = side(m.b);
  const v = classifyPair(
    a,
    b,
    { aInB: m.aInB, bInA: m.bInA, extraA: m.extraA, extraB: m.extraB },
    s.duplicates,
  );
  const base = {
    newKey,
    otherKey,
    aInB: m.aInB,
    bInA: m.bInA,
    cls: v.cls,
    rule: v.rule,
    reason: v.reason,
    keep: null as MeasuredPair['keep'],
    best: null as BestCopy | null,
  };
  if (v.cls !== 'duplicate' && v.cls !== 'superset') return base;
  const qa = await quality(m.a);
  const qb = await quality(m.b);
  if (!qa || !qb) {
    return {
      ...base,
      best: {
        keep: null,
        by: 'tradeoff',
        measures: [],
        reason: "A copy's pictures couldn't be read",
      },
    };
  }
  const best = bestCopy(qa, qb, {
    superset: v.cls === 'superset' ? v.container : undefined,
    imageMatchDistance: s.duplicates.imageMatchDistance,
    coverLargerPercent: s.covers.largerPercent,
  });
  const keepKey = best.keep === 'a' ? m.a : best.keep === 'b' ? m.b : null;
  return {
    ...base,
    best,
    keep: keepKey === null ? null : keepKey === newKey ? 'new' : 'other',
  };
}

/**
 * A book that joined the library (added by the import, or by hand) gets stage 3's text facts and
 * its sketch under its Calibre id, as stage 3's text phase would store them for its file: later
 * arrivals are compared with it, and stage 3's own next analysis reuses them.
 */
export function saveLibraryText(
  deps: CompareDeps,
  book: { calibreId: number; uuid: string; filePath: string; lastModified: string | null },
  file: { size: number; mtimeMs: number },
  counterBuild: string,
  t: NewText,
  sketchFromKey: number = t.key,
): void {
  const cache = openCache(deps);
  const row = cache
    .prepare('SELECT samples FROM sketches WHERE library_id = ? AND calibre_id = ?')
    .get(deps.libraryId, sketchFromKey) as { samples: Buffer } | undefined;
  const mtime = Math.round(file.mtimeMs);
  if (row) {
    cache
      .prepare(
        `INSERT INTO sketches (library_id, calibre_id, size, mtime_ms, build, samples)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(library_id, calibre_id) DO UPDATE SET size = excluded.size,
           mtime_ms = excluded.mtime_ms, build = excluded.build, samples = excluded.samples`,
      )
      .run(deps.libraryId, book.calibreId, file.size, mtime, counterBuild, row.samples);
  }
  deps.cleanup
    .prepare(
      `INSERT INTO text_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms,
         calibre_last_modified, counter_build, chars, import_chars, reader_chars, samples,
         chapters_json, ruby, toc_entries, file_title, kind, kind_marker, kind_by, image_entries,
         image_only, vertical, read_ms, read_at, error)
       VALUES (@lib, @id, @uuid, @path, @size, @mtime, @lm, @build, @chars, @importChars, NULL,
         @samples, NULL, @ruby, @toc, @fileTitle, @kind, @marker, 'title', @imageEntries,
         @imageOnly, @vertical, NULL, @now, @error)
       ON CONFLICT(library_id, calibre_id) DO UPDATE SET calibre_uuid = excluded.calibre_uuid,
         file_path = excluded.file_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
         calibre_last_modified = excluded.calibre_last_modified,
         counter_build = excluded.counter_build, chars = excluded.chars,
         import_chars = excluded.import_chars, samples = excluded.samples, ruby = excluded.ruby,
         toc_entries = excluded.toc_entries, file_title = excluded.file_title, kind = excluded.kind,
         kind_marker = excluded.kind_marker, kind_by = excluded.kind_by,
         image_entries = excluded.image_entries, image_only = excluded.image_only,
         vertical = excluded.vertical, read_at = excluded.read_at, error = excluded.error`,
    )
    .run({
      lib: deps.libraryId,
      id: book.calibreId,
      uuid: book.uuid,
      path: book.filePath,
      size: file.size,
      mtime,
      lm: book.lastModified,
      build: counterBuild,
      chars: t.error ? null : t.chars,
      importChars: t.error ? null : t.importChars,
      samples: t.error ? null : t.samples,
      ruby: t.error ? null : t.ruby,
      toc: t.error ? null : t.toc,
      fileTitle: t.fileTitle,
      kind: t.error ? null : t.kind,
      marker: t.error ? null : t.marker,
      imageEntries: t.imageEntries.length,
      imageOnly: t.imageOnly ? 1 : 0,
      vertical: t.vertical === null ? null : t.vertical ? 1 : 0,
      now: Date.now(),
      error: t.error,
    });
}
