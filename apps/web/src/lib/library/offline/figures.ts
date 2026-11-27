/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  figureKey,
  pickFigure,
  seriesFigures,
  worksFigure,
  type FigureRating,
  type KeptRules,
  type ScoreParams,
  type SeriesFigure
} from '$lib/library/series-figures';
import type { CatalogBook } from '$lib/library/types';

/**
 * The offline Library's series and author figures (series-figures.ts, the server's
 * catalog/series-figures.ts): the same rules over the books stored on this device. A series is
 * named by its name here (the server: its id; the name is unique there too).
 */
export interface OfflineFigures {
  /** figureKey(library, series name) → that library's figures. */
  byKey: Map<string, SeriesFigure>;
  /** series name → library → figures. */
  bySeries: Map<string, Map<string, SeriesFigure>>;
}

/** Every series' figures from the books the Library shows (not missing). */
export function offlineFigures(
  books: readonly CatalogBook[],
  rules: KeptRules,
  now: number
): OfflineFigures {
  const volumes = [];
  for (const b of books) {
    if (b.missing || !b.series || b.series.index === null) continue;
    const i = b.series.index;
    if (i !== 1 && i !== 2 && i !== 3) continue;
    volumes.push({
      id: b.id,
      library: b.libraryId,
      series: b.series.name,
      index: i,
      ratingX10: b.storeRating ? Math.round(b.storeRating.avg * 10) : null,
      ratingCount: b.storeRating?.count ?? null,
      ratingScore: b.storeRating?.score ?? null,
      readers: b.readers ?? null,
      publishedAt: b.publishedAt ?? null
    });
  }
  const byKey = seriesFigures(volumes, rules, now);
  const bySeries = new Map<string, Map<string, SeriesFigure>>();
  for (const v of volumes) {
    const f = byKey.get(figureKey(v.library, v.series));
    if (!f) continue;
    let libs = bySeries.get(v.series);
    if (!libs) {
      libs = new Map();
      bySeries.set(v.series, libs);
    }
    libs.set(v.library, f);
  }
  return { byKey, bySeries };
}

/** A series group's figures: the library asked for, else the one whose volume 1 has the most readers. */
export function groupFigureOf(
  figures: OfflineFigures,
  name: string | null,
  library?: string
): SeriesFigure | null {
  if (name === null) return null;
  const libs = figures.bySeries.get(name);
  if (!libs) return null;
  if (library) return libs.get(library) ?? null;
  return pickFigure([...libs.values()]);
}

/** The figures of a book's own series in its own library (kept:). */
export function bookSeriesFigure(figures: OfflineFigures, book: CatalogBook): SeriesFigure | null {
  if (!book.series) return null;
  return figures.byKey.get(figureKey(book.libraryId, book.series.name)) ?? null;
}

/**
 * Each author's figures over their works among `books` (each series once with its figures in
 * that library, each book without a series on its own).
 */
export function authorFiguresOf(
  books: readonly CatalogBook[],
  figures: OfflineFigures,
  params: ScoreParams,
  authorsOf: (book: CatalogBook) => Iterable<string>
): Map<string, SeriesFigure> {
  const works = new Map<
    string,
    Map<string, { rating: FigureRating | null; readers: number | null }>
  >();
  for (const b of books) {
    for (const author of authorsOf(b)) {
      let mine = works.get(author);
      if (!mine) {
        mine = new Map();
        works.set(author, mine);
      }
      if (b.series) {
        const key = `s${figureKey(b.libraryId, b.series.name)}`;
        if (mine.has(key)) continue;
        const f = figures.byKey.get(figureKey(b.libraryId, b.series.name));
        mine.set(key, { rating: f?.rating ?? null, readers: f?.readers ?? null });
      } else {
        mine.set(`b${b.id}`, {
          rating: b.storeRating
            ? {
                avg: Math.round(b.storeRating.avg * 10) / 10,
                count: b.storeRating.count,
                score: b.storeRating.score
              }
            : null,
          readers: b.readers ?? null
        });
      }
    }
  }
  const out = new Map<string, SeriesFigure>();
  for (const [author, mine] of works) out.set(author, worksFigure(mine.values(), params));
  return out;
}
