/**
 * /api/v1/uploads (WP7b). Mounted behind requireUser only when the upload adapter is
 * on (createApiRouter); unmounting it disables uploads (decided: a separate source
 * adapter, not a settings toggle).
 *
 *   POST   /uploads?library=<id>&name=<file name>   raw EPUB body -> staged + duplicates
 *   POST   /uploads/:id/add                         add as its own book
 *   DELETE /uploads/:id                             discard (use the library copy / cancel)
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { summariesByIds } from '../catalog/queries';
import { UUID_RE } from '../sync/kinds';
import { UploadError, type UploadService } from './service';

export interface UploadRouteOptions {
  /** The counter's current spec, for charCountStatus. */
  countSpec: () => string | null;
}

function apiError(err: unknown): never {
  if (err instanceof UploadError) throw new ApiError(err.status, err.code, err.message);
  throw err;
}

export function createUploadRouter(
  db: Database.Database,
  uploads: UploadService,
  opts: UploadRouteOptions,
): Router {
  const router = express.Router();

  router.post(
    '/uploads',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      const libraryId = typeof req.query.library === 'string' ? req.query.library : '';
      if (!libraryId) throw new ApiError(400, 'invalid_library', 'library is required');
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > uploads.maxBytes) {
        // Refused without storing anything. The body is read and dropped so the client
        // gets the answer instead of a reset connection (the web app checks the size
        // before sending, so this only happens with other clients).
        await new Promise<void>((resolve) => {
          req.on('end', resolve);
          req.on('error', () => resolve());
          req.resume();
        });
        throw new ApiError(413, 'too_large', 'The file is larger than the upload limit');
      }
      try {
        const { upload, duplicates } = await uploads.stage(user.id, libraryId, name, req);
        const books = summariesByIds(
          db,
          user,
          duplicates.map((d) => d.bookId),
          opts.countSpec(),
        );
        res.status(201).json({
          uploadId: upload.id,
          libraryId: upload.libraryId,
          title: upload.meta.title,
          authors: upload.meta.authors,
          series: upload.meta.series,
          size: upload.staged.size,
          duplicates: duplicates
            .filter((d) => books.has(d.bookId))
            .map((d) => ({ match: d.match, book: books.get(d.bookId) })),
        });
      } catch (err) {
        apiError(err);
      }
    }),
  );

  const idParam = (value: string) => {
    if (!UUID_RE.test(value)) throw new ApiError(404, 'upload_expired', 'Unknown upload');
    return value;
  };

  router.post(
    '/uploads/:id/add',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      try {
        const bookId = await uploads.add(user.id, idParam(req.params.id));
        const book = summariesByIds(db, user, [bookId], opts.countSpec()).get(bookId) ?? null;
        res.status(201).json({ book });
      } catch (err) {
        apiError(err);
      }
    }),
  );

  router.delete(
    '/uploads/:id',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      try {
        await uploads.discard(user.id, idParam(req.params.id));
        res.status(204).end();
      } catch (err) {
        apiError(err);
      }
    }),
  );

  return router;
}
