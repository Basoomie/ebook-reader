/**
 * Series and author figures on the server (docs/design/series-figures.md): what the Series and
 * Authors tabs sort and search by, and the `kept:` search everywhere. The rules are the web
 * app's own (`apps/web/src/lib/library/series-figures.ts`), run from the query bundle, so the
 * offline Library works out the same figures.
 *
 * Worked out live, never stored, and never on the main thread when it can be helped: working
 * them out reads the library (on the NAS about 1 s for the series, 2 s for the authors), so the
 * routes call `prepareFigures` first, which has the search worker (search-runner.ts) do it on its
 * own connection and keeps the answer; planning then only reads the cache. The cache holds until
 * the book list (bookListVersion), the store ratings (at most once per 10 minutes), the score's
 * pull, your thresholds or the day change. Only a figure sort or a figure search needs them,
 * never a plain page of the tabs. A search term on a figure becomes the list of series that
 * match, bound as one JSON value, so it runs the same in the search worker.
 */
import type Database from 'better-sqlite3';
import { bookListVersion } from './catalog-version';
import { parseQuery, QUERY_BUNDLE, type ParsedQuery, type QueryTerm } from './query-parser';
import type { FigureTermSql, SqlCondition } from './search-sql';
import { globalSetting } from '../sync/global-setting';

export interface FigureRating {
  avg: number;
  count: number;
  score: number;
}

export interface SeriesFigure {
  rating: FigureRating | null;
  readers: number | null;
  kept: number | null;
}

export type FigureKey = 'rating' | 'ratings' | 'readers' | 'kept';

export interface KeptRules {
  minReaders: number;
  neighbourPercent: number;
  maxPercent: number;
  minMonths: number;
}

interface FigureVolume {
  id: string;
  library: string;
  series: string;
  index: number;
  ratingX10: number | null;
  ratingCount: number | null;
  ratingScore: number | null;
  readers: number | null;
  publishedAt: number | null;
}

interface FiguresBundle {
  seriesFigures(
    volumes: Iterable<FigureVolume>,
    rules: KeptRules,
    now: number,
  ): Map<string, SeriesFigure>;
  pickFigure(figures: readonly (SeriesFigure | undefined)[]): SeriesFigure | null;
  worksFigure(
    works: Iterable<{ rating: FigureRating | null; readers: number | null }>,
    params: { m: number; c: number },
  ): SeriesFigure;
  figureKey(library: string, series: string | number): string;
  figureSortValue(f: SeriesFigure | null | undefined, key: FigureKey): number | null;
  figureTermValue(f: SeriesFigure | null | undefined, key: FigureKey): number | null;
  figureMatches(
    value: number | null,
    min: number | null,
    max: number | null,
    negated: boolean,
  ): boolean;
  DEFAULT_KEPT_RULES: KeptRules;
  DEFAULT_SCORE_PARAMS: { m: number; c: number };
}

/**
 * queries.ts SQL_BOOK_FROM, copied: the search worker loads this module, and importing queries.ts
 * would load most of the catalog into it (a slower worker start). A test keeps the two equal.
 */
export const FIGURES_BOOK_FROM = `
  FROM books b
  CROSS JOIN book_sources s ON s.book_id = b.id AND s.kind IN ('calibre', 'upload')
  JOIN libraries l ON l.id = b.library_id AND l.enabled = 1`;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(QUERY_BUNDLE) as FiguresBundle;

export const pickFigure = bundle.pickFigure;
export const figureSortValue = bundle.figureSortValue;
export const DEFAULT_KEPT_RULES = bundle.DEFAULT_KEPT_RULES;

/** The synced settings of "Went on to vol 2" (web: lib/library/series-figures-settings.ts). */
export const KEPT_SETTING_KEYS: Record<keyof KeptRules, string> = {
  minReaders: 'seriesKeptMinReaders',
  neighbourPercent: 'seriesKeptNeighbourPercent',
  maxPercent: 'seriesKeptMaxPercent',
  minMonths: 'seriesKeptMinMonths',
};

/** Your thresholds (synced global settings; the defaults when unset or not a number). */
export function keptRules(db: Database.Database, userId: string): KeptRules {
  const out = { ...DEFAULT_KEPT_RULES };
  for (const key of Object.keys(KEPT_SETTING_KEYS) as (keyof KeptRules)[]) {
    const raw = globalSetting(db, userId, KEPT_SETTING_KEYS[key]);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

function scoreParams(db: Database.Database): { m: number; c: number } {
  const row = db.prepare('SELECT m, c FROM store_rating_params WHERE id = 1').get() as
    | { m: number; c: number }
    | undefined;
  return row ?? bundle.DEFAULT_SCORE_PARAMS;
}

const DAY = 24 * 60 * 60 * 1000;
/** How long a store page read may wait before the figures include it (ratingsStamp). */
const RATINGS_WINDOW_MS = 10 * 60 * 1000;

/**
 * Changes when a book's ratings may have: a store page read (the triggers write books then),
 * or the score's pull. Each site's newest check comes from the store_ratings_due index.
 */
function ratingsStamp(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT (SELECT MAX(checked_at) FROM store_ratings WHERE site = 'amazon_jp') AS a,
              (SELECT MAX(checked_at) FROM store_ratings WHERE site = 'bookwalker') AS w,
              (SELECT MAX(checked_at) FROM store_ratings WHERE site = 'bookmeter') AS m`,
    )
    .get() as { a: number | null; w: number | null; m: number | null };
  const p = scoreParams(db);
  // The refresher reads a store page every few seconds while it runs: a page read moves the
  // figures at most once per window (book list changes still count at once).
  const w = (t: number | null) => Math.floor((t ?? 0) / RATINGS_WINDOW_MS);
  return `${w(row.a)}:${w(row.w)}:${w(row.m)}:${p.m}:${p.c}`;
}

export interface FigureIndex {
  /** figureKey(library, series id) → that library's series figures. */
  byKey: Map<string, SeriesFigure>;
  /** series id → library → figures. */
  bySeries: Map<number, Map<string, SeriesFigure>>;
}

export interface AuthorOpts {
  libraryId?: string;
  includeMissing?: boolean;
}

// ---- Working them out (on any connection: the search worker's, or the main one) ----------------

/** Every series' figures (the books the Library shows: not missing, enabled libraries). */
export function computeFigureIndex(
  db: Database.Database,
  rules: KeptRules,
  now: number,
): FigureIndex {
  const volumes: FigureVolume[] = [];
  for (const r of db
    .prepare(
      `SELECT b.id, b.library_id, b.series_id, b.series_index, b.rating_x10, b.rating_count,
              b.rating_score, b.readers, b.published_at
         ${FIGURES_BOOK_FROM}
        WHERE s.missing_at IS NULL AND b.series_id IS NOT NULL AND b.series_index IN (1, 2, 3)`,
    )
    .raw()
    .iterate() as IterableIterator<
    [
      string,
      string,
      number,
      number,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ]
  >) {
    volumes.push({
      id: r[0],
      library: r[1],
      series: String(r[2]),
      index: r[3],
      ratingX10: r[4],
      ratingCount: r[5],
      ratingScore: r[6],
      readers: r[7],
      publishedAt: r[8],
    });
  }
  const byKey = bundle.seriesFigures(volumes, rules, now);
  const bySeries = new Map<number, Map<string, SeriesFigure>>();
  for (const v of volumes) {
    const sid = Number(v.series);
    let libs = bySeries.get(sid);
    if (!libs) {
      libs = new Map();
      bySeries.set(sid, libs);
    }
    const f = byKey.get(bundle.figureKey(v.library, v.series));
    if (f) libs.set(v.library, f);
  }
  return { byKey, bySeries };
}

/**
 * Every author's figures over their works: each series once (its figures in that library),
 * each book without a series on its own. With `bookIds`, only those books are read (a
 * collection).
 */
export function computeAuthorFigures(
  db: Database.Database,
  index: FigureIndex,
  opts: AuthorOpts,
  bookIds?: readonly string[],
): Map<number, SeriesFigure> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.libraryId) {
    conds.push('b.library_id = ?');
    params.push(opts.libraryId);
  }
  if (!opts.includeMissing) conds.push('s.missing_at IS NULL');
  if (bookIds) {
    conds.push('b.id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(bookIds));
  }
  const works = new Map<
    number,
    Map<string, { rating: FigureRating | null; readers: number | null }>
  >();
  for (const [authorId, bookId, library, seriesId, x10, count, score, readers] of db
    .prepare(
      `SELECT ba.author_id, b.id, b.library_id, b.series_id, b.rating_x10, b.rating_count,
              b.rating_score, b.readers
         ${FIGURES_BOOK_FROM}
         JOIN book_authors ba ON ba.book_id = b.id
         ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}`,
    )
    .raw()
    .iterate(...params) as IterableIterator<
    [
      number,
      string,
      string,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ]
  >) {
    let mine = works.get(authorId);
    if (!mine) {
      mine = new Map();
      works.set(authorId, mine);
    }
    if (seriesId !== null) {
      const key = `s${bundle.figureKey(library, seriesId)}`;
      if (mine.has(key)) continue;
      const f = index.byKey.get(bundle.figureKey(library, seriesId));
      mine.set(key, { rating: f?.rating ?? null, readers: f?.readers ?? null });
    } else {
      mine.set(`b${bookId}`, {
        rating:
          x10 !== null && count !== null && score !== null ? { avg: x10 / 10, count, score } : null,
        readers,
      });
    }
  }
  const pull = scoreParams(db);
  const out = new Map<number, SeriesFigure>();
  for (const [authorId, mine] of works) out.set(authorId, bundle.worksFigure(mine.values(), pull));
  return out;
}

/** What the search worker is asked to work out (search-worker.ts). */
export interface FiguresJob {
  rules: KeptRules;
  now: number;
  /** Also every author's figures, with these filters. */
  authors: AuthorOpts | null;
}

export interface FiguresAnswer {
  index: FigureIndex;
  authors: Map<number, SeriesFigure> | null;
}

export function computeFigures(db: Database.Database, job: FiguresJob): FiguresAnswer {
  const index = computeFigureIndex(db, job.rules, job.now);
  return {
    index,
    authors: job.authors ? computeAuthorFigures(db, index, job.authors) : null,
  };
}

/** Runs a FiguresJob off the main thread (SearchRunner.figures). */
export interface FiguresWorker {
  figures(job: FiguresJob): Promise<FiguresAnswer>;
}

// ---- The cache (main thread) ---------------------------------------------------------------------

interface Cached {
  key: string;
  index: FigureIndex;
  /** authorKey(opts) → figures. */
  authors: Map<string, Map<number, SeriesFigure>>;
}

const cache = new WeakMap<Database.Database, Cached>();

function cacheKey(db: Database.Database, rules: KeptRules): string {
  return `${bookListVersion(db)}|${ratingsStamp(db)}|${Math.floor(Date.now() / DAY)}|${JSON.stringify(rules)}`;
}

const authorKey = (opts: AuthorOpts) => `${opts.libraryId ?? ''}|${!!opts.includeMissing}`;

function current(
  db: Database.Database,
  userId: string,
): { key: string; rules: KeptRules; hit: Cached | null } {
  const rules = keptRules(db, userId);
  const key = cacheKey(db, rules);
  const hit = cache.get(db);
  return { key, rules, hit: hit && hit.key === key ? hit : null };
}

/**
 * Has the search worker work out what a request will need (`authors`: every author's figures
 * too) unless it is kept already. A worker that fails or isn't there: worked out here.
 */
export async function prepareFigures(
  db: Database.Database,
  userId: string,
  authors: AuthorOpts | null,
  worker: FiguresWorker | null,
): Promise<void> {
  const { key, rules, hit } = current(db, userId);
  if (hit && (!authors || hit.authors.has(authorKey(authors)))) return;
  if (!worker) return;
  let answer: FiguresAnswer;
  try {
    answer = await worker.figures({
      rules,
      now: Date.now(),
      // The index is worked out again with them (a few hundred ms in the worker), so the two agree.
      authors: authors ?? null,
    });
  } catch (err) {
    console.error('Series figures: the search worker failed; worked out on the main thread:', err);
    return;
  }
  const entry: Cached = { key, index: answer.index, authors: new Map() };
  if (authors && answer.authors) entry.authors.set(authorKey(authors), answer.authors);
  // Keep what was there for this key (other author filters) when only the index was asked for.
  const before = cache.get(db);
  if (before && before.key === key) {
    for (const [k, v] of before.authors) if (!entry.authors.has(k)) entry.authors.set(k, v);
  }
  cache.set(db, entry);
}

/** Every series' figures: from the cache, else worked out here (a path that didn't prepare). */
export function figureIndex(db: Database.Database, userId: string): FigureIndex {
  const { key, rules, hit } = current(db, userId);
  if (hit) return hit.index;
  const entry: Cached = {
    key,
    index: computeFigureIndex(db, rules, Date.now()),
    authors: new Map(),
  };
  cache.set(db, entry);
  return entry.index;
}

/**
 * Every author's figures (the cache, else worked out here). With `books`, only those books
 * count (a collection): read for those books only, never kept.
 */
export function authorFigures(
  db: Database.Database,
  userId: string,
  opts: AuthorOpts,
  books?: ReadonlySet<string>,
): Map<number, SeriesFigure> {
  const index = figureIndex(db, userId);
  if (books) return computeAuthorFigures(db, index, opts, [...books]);
  const entry = cache.get(db)!;
  const k = authorKey(opts);
  let figures = entry.authors.get(k);
  if (!figures) {
    figures = computeAuthorFigures(db, index, opts);
    entry.authors.set(k, figures);
  }
  return figures;
}

/** A series group's figures: the library asked for, else the one whose volume 1 has the most readers. */
export function groupFigure(
  index: FigureIndex,
  seriesId: number | null,
  libraryId?: string,
): SeriesFigure | null {
  if (seriesId === null) return null;
  const libs = index.bySeries.get(seriesId);
  if (!libs) return null;
  if (libraryId) return libs.get(libraryId) ?? null;
  return bundle.pickFigure([...libs.values()]);
}

// ---- What a request needs ------------------------------------------------------------------------

const FIGURE_TERMS = new Set(['rating', 'ratings', 'readers']);
const FIGURE_SORTS = new Set(['rating', 'ratings', 'readers', 'kept']);

function parsed(text: string | undefined): ParsedQuery | null {
  if (!text) return null;
  const r = parseQuery(text);
  return r.ok ? r.query : null;
}

/**
 * Whether a request needs the figures (`index`) and every author's (`authors`): a figure sort
 * on the Series or Authors tab, kept: anywhere, rating:/ratings:/readers: on the Series tab. A
 * query that doesn't parse needs nothing (planning reports it).
 */
export function figureNeeds(req: {
  by?: 'series' | 'author' | 'tag';
  sortKey?: string;
  query?: string;
  scope?: string;
  /** A collection's groups: its authors are worked out for its books only. */
  collection?: string;
}): { index: boolean; authors: boolean } {
  const terms = [...(parsed(req.query)?.terms ?? []), ...(parsed(req.scope)?.terms ?? [])];
  const kept = terms.some((t) => t.type === 'kept');
  const seriesTerms =
    req.by === 'series' && (parsed(req.query)?.terms ?? []).some((t) => FIGURE_TERMS.has(t.type));
  const sorted =
    (req.by === 'series' || req.by === 'author') && FIGURE_SORTS.has(req.sortKey ?? '');
  return {
    index: kept || seriesTerms || sorted,
    authors: req.by === 'author' && sorted && !req.scope && !req.collection,
  };
}

/**
 * Search terms on figures: `kept:` everywhere (a book carries its series' figure in its own
 * library); on the Series tab also rating:, ratings: and readers:, which test the series'
 * figures (volume 1) and not each book. Other terms: null (search-sql.ts handles them).
 */
export function figureTerms(
  db: Database.Database,
  userId: string,
  opts: { seriesTab: boolean; libraryId?: string },
): FigureTermSql {
  let index: FigureIndex | null = null;
  const get = () => (index ??= figureIndex(db, userId));
  return {
    termSql(term: QueryTerm): SqlCondition | null {
      const onSeries = opts.seriesTab && FIGURE_TERMS.has(term.type);
      if (term.type !== 'kept' && !onSeries) return null;
      const t = term as Extract<QueryTerm, { min: number | null; max: number | null }>;
      const key = term.type as FigureKey;
      const idx = get();
      if (opts.seriesTab) {
        const ids: number[] = [];
        for (const sid of idx.bySeries.keys()) {
          const value = bundle.figureTermValue(groupFigure(idx, sid, opts.libraryId), key);
          if (bundle.figureMatches(value, t.min, t.max, t.negated)) ids.push(sid);
        }
        return {
          sql: 'b.series_id IN (SELECT value FROM json_each(?))',
          params: [JSON.stringify(ids)],
        };
      }
      const keys: string[] = [];
      for (const [k, f] of idx.byKey) {
        if (bundle.figureMatches(bundle.figureTermValue(f, key), t.min, t.max, t.negated))
          keys.push(k);
      }
      return {
        sql: "(b.library_id || ':' || b.series_id) IN (SELECT value FROM json_each(?))",
        params: [JSON.stringify(keys)],
      };
    },
  };
}
