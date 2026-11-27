/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Series and author figures (docs/design/series-figures.md): what the Series and Authors tabs
 * sort and search by. Pure code, no imports: the storage server runs this same file from the
 * query bundle (apps/storage-server/vendor/library-query.cjs, `pnpm build:server-query`), so
 * the server and the offline Library work the figures out alike.
 *
 * - A series' Rating, Most rated and Most read are its volume 1's (later volumes rate higher:
 *   only the fans stay). Volume 1 is the main volume numbered exactly 1; of two books on 1 the
 *   one with more ratings gives the stars, the one with more readers the readers.
 * - "Went on to vol 2" (`kept`) is vol 2's 読書メーター readers as a whole percent of vol 1's,
 *   left empty when vol 1 has too few readers, vol 2 is new, vol 2 is far under vol 3 (a vol-2
 *   link to a listing almost nobody logs) or the figure is far over 100 % (a wrong link).
 *   100 % up to the cap shows as 100 %.
 * - An author's figures are over their works: each series once (its volume-1 figures), each
 *   book without a series on its own. Rating = the works' stars weighted by their counts,
 *   pulled toward the library median like a book's score; Most rated and Most read the sums.
 * - Figures come from the books the Library shows (not missing, enabled libraries), one set per
 *   library and series. A series group shown across libraries takes the library whose volume 1
 *   has the most readers (`pickFigure`).
 */

/** One book of a series, as the figures read it. */
export interface FigureVolume {
  id: string;
  library: string;
  /** The series id (server) or name (offline); with `library` it names the series. */
  series: string;
  index: number;
  /** The stores' pooled stars x10, their count and the Rating sort's score (x1000). */
  ratingX10: number | null;
  ratingCount: number | null;
  ratingScore: number | null;
  /** 読書メーター's 登録数. */
  readers: number | null;
  /** Publication date (ms). */
  publishedAt: number | null;
}

/** The thresholds of "Went on to vol 2" (synced settings; seriesKeptRules in the web app). */
export interface KeptRules {
  /** Volume 1 needs at least this many 読書メーター readers. */
  minReaders: number;
  /** Volume 2 needs at least this percent of volume 3's readers (when volume 3 has a count). */
  neighbourPercent: number;
  /** A figure over this percent is left empty; 100 % up to it shows as 100 %. */
  maxPercent: number;
  /** Volume 2 published less than this many months ago: empty (an undated volume 2 counts as old). */
  minMonths: number;
}

export const DEFAULT_KEPT_RULES: KeptRules = {
  minReaders: 50,
  neighbourPercent: 70,
  maxPercent: 120,
  minMonths: 6
};

/** Stars as a book's storeRating: `avg` to one decimal, `score` x1000. */
export interface FigureRating {
  avg: number;
  count: number;
  score: number;
}

export interface SeriesFigure {
  rating: FigureRating | null;
  readers: number | null;
  /** "Went on to vol 2", whole percent 0-100; null when unknown. */
  kept: number | null;
}

/** The Rating score's pull (store_rating_params): `c` imaginary ratings at the median `m`. */
export interface ScoreParams {
  m: number;
  c: number;
}

export const DEFAULT_SCORE_PARAMS: ScoreParams = { m: 4.1, c: 20 };

/** The sort keys and search fields that read a figure. */
export type FigureKey = 'rating' | 'ratings' | 'readers' | 'kept';

const MONTH = 30 * 24 * 60 * 60 * 1000;

export function figureKey(library: string, series: string | number): string {
  return `${library}:${series}`;
}

/** Whether a series number is a main volume numbered exactly n. */
function isVolume(index: number, n: number): boolean {
  return Math.abs(index - n) < 1e-9;
}

interface Collect {
  stars: FigureVolume | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
  pub2: number | null;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Figures of every series, keyed by figureKey(library, series). */
export function seriesFigures(
  volumes: Iterable<FigureVolume>,
  rules: KeptRules,
  now: number
): Map<string, SeriesFigure> {
  const by = new Map<string, Collect>();
  for (const v of volumes) {
    let n: 1 | 2 | 3;
    if (isVolume(v.index, 1)) n = 1;
    else if (isVolume(v.index, 2)) n = 2;
    else if (isVolume(v.index, 3)) n = 3;
    else continue;
    const key = figureKey(v.library, v.series);
    let c = by.get(key);
    if (!c) {
      c = { stars: null, r1: null, r2: null, r3: null, pub2: null };
      by.set(key, c);
    }
    if (n === 1) {
      c.r1 = maxOf(c.r1, v.readers);
      if (v.ratingCount !== null && v.ratingX10 !== null && v.ratingScore !== null) {
        const s = c.stars;
        if (
          !s ||
          v.ratingCount > (s.ratingCount ?? 0) ||
          (v.ratingCount === s.ratingCount && v.id < s.id)
        ) {
          c.stars = v;
        }
      }
    } else if (n === 2) {
      c.r2 = maxOf(c.r2, v.readers);
      c.pub2 = maxOf(c.pub2, v.publishedAt);
    } else {
      c.r3 = maxOf(c.r3, v.readers);
    }
  }
  const out = new Map<string, SeriesFigure>();
  for (const [key, c] of by) {
    const s = c.stars;
    out.set(key, {
      rating:
        s && s.ratingX10 !== null && s.ratingCount !== null && s.ratingScore !== null
          ? { avg: s.ratingX10 / 10, count: s.ratingCount, score: s.ratingScore }
          : null,
      readers: c.r1,
      kept: keptOf(c, rules, now)
    });
  }
  return out;
}

function keptOf(c: Collect, rules: KeptRules, now: number): number | null {
  if (c.r1 === null || c.r2 === null || c.r1 <= 0 || c.r1 < rules.minReaders) return null;
  if (c.pub2 !== null && c.pub2 > now - rules.minMonths * MONTH) return null;
  if (c.r3 !== null && c.r3 > 0 && c.r2 * 100 < rules.neighbourPercent * c.r3) return null;
  const percent = (c.r2 * 100) / c.r1;
  if (percent > rules.maxPercent) return null;
  return Math.min(100, Math.round(percent));
}

/**
 * One figure for a series shown across libraries: the library whose volume 1 has the most
 * readers, then the most ratings (undefined entries are libraries without the series).
 */
export function pickFigure(figures: readonly (SeriesFigure | undefined)[]): SeriesFigure | null {
  let best: SeriesFigure | null = null;
  for (const f of figures) {
    if (!f) continue;
    if (
      !best ||
      (f.readers ?? -1) > (best.readers ?? -1) ||
      ((f.readers ?? -1) === (best.readers ?? -1) &&
        (f.rating?.count ?? -1) > (best.rating?.count ?? -1))
    ) {
      best = f;
    }
  }
  return best;
}

/** One work of an author: a series' figures, or a book's own. */
export interface WorkFigure {
  rating: FigureRating | null;
  readers: number | null;
}

/** An author's figures over their works (each counted once). */
export function worksFigure(works: Iterable<WorkFigure>, params: ScoreParams): SeriesFigure {
  let count = 0;
  let weighted = 0;
  let readers: number | null = null;
  for (const w of works) {
    if (w.rating && w.rating.count > 0) {
      count += w.rating.count;
      weighted += w.rating.avg * w.rating.count;
    }
    if (w.readers !== null) readers = (readers ?? 0) + w.readers;
  }
  const rating =
    count > 0
      ? {
          avg: Math.round((weighted * 10) / count) / 10,
          count,
          score: Math.round((1000 * (params.c * params.m + weighted)) / (params.c + count))
        }
      : null;
  return { rating, readers, kept: null };
}

/** The value a sort orders by (null: none, always last). */
export function figureSortValue(f: SeriesFigure | null | undefined, key: FigureKey): number | null {
  if (!f) return null;
  if (key === 'rating') return f.rating?.score ?? null;
  if (key === 'ratings') return f.rating?.count ?? null;
  if (key === 'readers') return f.readers;
  return f.kept;
}

/** The value a search term compares (rating: stars x10, as the parser's bounds). */
export function figureTermValue(f: SeriesFigure | null | undefined, key: FigureKey): number | null {
  if (!f) return null;
  if (key === 'rating') return f.rating ? Math.round(f.rating.avg * 10) : null;
  return figureSortValue(f, key);
}

/**
 * Whether a figure is inside a term's inclusive bounds. A value of null never matches, negated
 * or not (as the book terms).
 */
export function figureMatches(
  value: number | null,
  min: number | null,
  max: number | null,
  negated: boolean
): boolean {
  if (value === null) return false;
  const inside = (min === null || value >= min) && (max === null || value <= max);
  return negated ? !inside : inside;
}
