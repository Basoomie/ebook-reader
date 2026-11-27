/**
 * /api/v1/ratings (store ratings, 2026-11-25), behind requireUser.
 *
 *   GET /ratings/book/:bookId[?fresh=1]  the book's figures per site and the pooled rating; with
 *                                        fresh=1 old ones are asked for again (answered later:
 *                                        `refreshing`)
 *   GET /ratings/progress                the first fill's and the refresher's progress, settings
 *   PUT /ratings/settings                RatingSettings fields
 */
import express, { Router } from 'express';
import { ApiError } from '../api/errors';
import type { StoreRatings } from './service';
import { RatingSettingsError, saveRatingSettings } from './settings';
import { readScoreParams, type RatingRow } from './store';

export interface SiteFigure {
  /** Stars out of 5 (null on 読書メーター). */
  avg: number | null;
  /** Ratings (Amazon, BOOK☆WALKER, Natively) or 登録数 (読書メーター). */
  count: number | null;
  /** 読書メーター's 感想 count. */
  reviews: number | null;
  state: RatingRow['state'];
  checkedAt: number;
}

function figure(r: RatingRow): SiteFigure {
  return { avg: r.avg, count: r.count, reviews: r.reviews, state: r.state, checkedAt: r.checkedAt };
}

export function createRatingsRouter(ratings: StoreRatings | null): Router {
  const router = express.Router();

  const need = (): StoreRatings => {
    if (!ratings) throw new ApiError(503, 'ratings_off', 'Store ratings are off on this server');
    return ratings;
  };

  router.get('/ratings/book/:bookId', (req, res) => {
    const service = need();
    const bookId = req.params.bookId;
    const book = service.db
      .prepare('SELECT rating_x10, rating_count, readers FROM books WHERE id = ?')
      .get(bookId) as
      | { rating_x10: number | null; rating_count: number | null; readers: number | null }
      | undefined;
    if (!book) throw new ApiError(404, 'not_found', 'No such book');
    const { rows, refreshing } = service.forBook(bookId, req.query.fresh === '1');
    const sites: Record<string, SiteFigure> = {};
    for (const r of rows) sites[r.site] = figure(r);
    res.json({
      pooled:
        book.rating_x10 !== null && book.rating_count !== null
          ? { avg: book.rating_x10 / 10, count: book.rating_count }
          : null,
      readers: book.readers,
      sites,
      refreshing,
    });
  });

  // What the pages show. 読書メーター had its own switch until its link fix (2026-11-25); it is
  // fetched with the other stores now, so its numbers are always shown when there are any.
  // `score`: the Rating score's pull, for the offline Library's author figures (series-figures).
  router.get('/ratings/features', (_req, res) => {
    res.json({
      bookmeter: ratings !== null,
      score: ratings ? readScoreParams(ratings.db) : null,
    });
  });

  router.get('/ratings/progress', (_req, res) => {
    const service = need();
    res.json({
      ...service.progress(),
      settings: service.settings(),
      score: readScoreParams(service.db),
    });
  });

  router.put('/ratings/settings', (req, res, next) => {
    const service = need();
    const before = service.settings();
    try {
      const settings = saveRatingSettings(service.db, (req.body ?? {}) as Record<string, unknown>);
      // A changed score setting is worked out in slices before the answer.
      service
        .settingsChanged(before, settings)
        .then(() => res.json({ settings, score: readScoreParams(service.db) }), next);
    } catch (err) {
      if (err instanceof RatingSettingsError)
        throw new ApiError(400, 'invalid_setting', err.message);
      throw err;
    }
  });

  return router;
}
