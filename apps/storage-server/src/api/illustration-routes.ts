/**
 * Season 2 §6: the book page's illustrations (catalog/illustrations.ts).
 *
 * - GET /books/:id/illustrations (token): 200 {status:'ready', items:[{n, width, height,
 *   beforeToc, thumbUrl, url}]}, 202 {status:'preparing'} (ask again shortly) or 200
 *   {status:'failed', message}.
 * - GET /books/:id/illustrations/:version/:n/thumb and .../:n/full: a signed URL (a plain
 *   <img> can't send the token) or the token. The signature unlocks only this book's
 *   pictures of this list version. Responses are immutable (the version is in the path).
 */
import type Database from 'better-sqlite3';
import express, { RequestHandler, Router } from 'express';
import type { CatalogUser } from '../catalog/queries';
import type { IllustrationService, SourceProblem } from '../catalog/illustrations';
import { getOrCreateSecret, sign, THUMBNAIL_URL_SECRET, verify } from '../db/secrets';
import { getAuth, requireUser } from './auth';
import { ApiError, asyncHandler } from './errors';

export interface IllustrationOptions {
  illustrations?: IllustrationService | null;
}

function message(userId: string, bookId: string, version: string): string {
  return `illustrations:${userId}:${bookId}:${version}`;
}

/** The signed address of one picture of a book's list. */
export function illustrationUrl(
  db: Database.Database,
  user: CatalogUser,
  bookId: string,
  version: string,
  n: number,
  kind: 'thumb' | 'full',
): string {
  const key = getOrCreateSecret(db, THUMBNAIL_URL_SECRET);
  const s = sign(key, message(user.id, bookId, version));
  return `/api/v1/books/${bookId}/illustrations/${version}/${n}/${kind}?u=${encodeURIComponent(user.id)}&s=${s}`;
}

function sourceError(problem: SourceProblem): ApiError {
  switch (problem) {
    case 'missing':
      return new ApiError(410, 'missing', 'This book is no longer in the Calibre library');
    case 'file_missing':
      return new ApiError(404, 'file_missing', 'The book file was not found in the library');
    case 'off':
      return new ApiError(503, 'indexer_off', 'Book files are unavailable');
    default:
      return new ApiError(404, 'not_found', 'No such book');
  }
}

function service(options: IllustrationOptions): IllustrationService {
  if (!options.illustrations) {
    throw new ApiError(503, 'illustrations_off', 'Illustrations are unavailable');
  }
  return options.illustrations;
}

/** The list (mounted behind requireUser). */
export function createIllustrationRouter(
  db: Database.Database,
  options: IllustrationOptions,
): Router {
  const router = express.Router();
  router.get(
    '/books/:id/illustrations',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      const bookId = req.params.id;
      const answer = await service(options).list(user, bookId);
      res.set('Cache-Control', 'private, no-store');
      if (answer.status === 'problem') throw sourceError(answer.problem);
      if (answer.status === 'preparing') {
        res.status(202).json({ status: 'preparing' });
        return;
      }
      if (answer.status === 'failed') {
        res.json({ status: 'failed', message: answer.message });
        return;
      }
      res.json({
        status: 'ready',
        items: answer.items.map((item, n) => ({
          n,
          width: item.width,
          height: item.height,
          beforeToc: item.beforeToc,
          thumbUrl: illustrationUrl(db, user, bookId, answer.version, n, 'thumb'),
          url: illustrationUrl(db, user, bookId, answer.version, n, 'full'),
        })),
      });
    }),
  );
  return router;
}

/** Signed URL or token, like the cover thumbnail. */
function illustrationAuth(db: Database.Database): RequestHandler {
  const bearer = requireUser(db);
  return (req, res, next) => {
    const u = typeof req.query.u === 'string' ? req.query.u : '';
    const s = typeof req.query.s === 'string' ? req.query.s : '';
    if (u && s) {
      const key = getOrCreateSecret(db, THUMBNAIL_URL_SECRET);
      if (verify(key, message(u, req.params.id, req.params.version), s)) {
        res.locals.catalogUser = { id: u } satisfies CatalogUser;
        next();
        return;
      }
    }
    bearer(req, res, () => {
      res.locals.catalogUser = getAuth(res).user;
      next();
    });
  };
}

/** The pictures (mounted before requireUser: they take a signed URL). */
export function illustrationImageRoute(
  db: Database.Database,
  options: IllustrationOptions,
): Router {
  const router = express.Router();
  router.get(
    '/books/:id/illustrations/:version/:n/:kind(thumb|full)',
    illustrationAuth(db),
    asyncHandler(async (req, res) => {
      const user = res.locals.catalogUser as CatalogUser;
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 0) throw new ApiError(404, 'not_found', 'No such picture');
      const kind = req.params.kind as 'thumb' | 'full';
      const answer = await service(options).image(user, req.params.id, req.params.version, n, kind);
      if (!answer.ok) {
        if (answer.problem === 'stale') {
          throw new ApiError(404, 'stale', 'This list of pictures is out of date');
        }
        if (answer.problem === 'changed') {
          throw new ApiError(409, 'changed', 'The book file changed; load the list again');
        }
        if (answer.problem === 'unreadable') {
          throw new ApiError(422, 'unreadable', answer.message ?? 'The picture could not be read');
        }
        throw sourceError(answer.problem);
      }
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      // A picture from a book is only ever shown as an image, never run (an SVG could
      // hold a script when opened by itself).
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.type(answer.type);
      res.send(answer.data);
    }),
  );
  return router;
}
