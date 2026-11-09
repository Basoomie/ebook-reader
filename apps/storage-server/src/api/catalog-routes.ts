/**
 * /api/v1 catalog routes (WP2, WP6): libraries, books, search, EPUB download
 * and cover thumbnails. Everything except the thumbnail is mounted behind
 * requireUser; the thumbnail also accepts a signed URL (see thumbnailAuth).
 */
import type Database from 'better-sqlite3';
import express, { RequestHandler, Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { IndexerStatus } from '../calibre/indexer';
import { openSourceStream, resolveInside, statFile } from '../calibre/source-fs';
import {
  CatalogUser,
  getBookFileFor,
  getBookFor,
  InvalidCursorError,
  listBooksFor,
  listLibrariesFor,
  verifyThumbnailUrl,
} from '../catalog/queries';
import type { CharCountService } from '../counts/count-service';
import { thumbnailVersion, type ThumbnailService } from '../thumbnails/thumbnails';
import { getAuth, requireUser } from './auth';
import { ApiError, asyncHandler } from './errors';

export interface CatalogOptions {
  thumbnails: ThumbnailService | null;
  /** Background character counts (WP3b); null when the counter is unavailable. */
  counts?: CharCountService | null;
  indexer: IndexerStatus;
  /** Root of the Calibre libraries (read-only); null when the indexer is off. */
  calibreDir?: string | null;
}

/** Longest accepted search text; longer input is cut. */
const MAX_QUERY_LENGTH = 200;

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function queryBool(value: unknown): boolean {
  return value === '1' || value === 'true';
}

function requireIndexer(catalog: CatalogOptions, what: string): void {
  if (!catalog.indexer.enabled) {
    throw new ApiError(503, 'indexer_off', `${what} unavailable: ${catalog.indexer.error}`);
  }
}

export function createCatalogRouter(db: Database.Database, catalog: CatalogOptions): Router {
  const router = express.Router();
  const countSpec = () => catalog.counts?.spec ?? null;

  router.get('/libraries', (_req, res) => {
    const { user } = getAuth(res);
    res.json({ indexer: catalog.indexer, libraries: listLibrariesFor(db, user, countSpec()) });
  });

  router.get('/books', (req, res) => {
    const { user } = getAuth(res);
    const limitRaw = queryString(req.query.limit);
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ApiError(400, 'invalid_limit', 'limit must be a positive whole number');
    }
    try {
      res.json(
        listBooksFor(db, user, {
          libraryId: queryString(req.query.library),
          query: queryString(req.query.q)?.slice(0, MAX_QUERY_LENGTH),
          limit,
          cursor: queryString(req.query.cursor),
          includeMissing: queryBool(req.query.includeMissing),
          countSpec: countSpec(),
        }),
      );
    } catch (err) {
      if (err instanceof InvalidCursorError) throw new ApiError(400, 'invalid_cursor', err.message);
      throw err;
    }
  });

  router.get('/books/:id', (req, res) => {
    const { user } = getAuth(res);
    const book = getBookFor(db, user, req.params.id, countSpec());
    if (!book) throw new ApiError(404, 'not_found', 'No such book');
    res.json(book);
  });

  // The EPUB itself, streamed read-only from the Calibre library (WP6).
  router.get(
    '/books/:id/file',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      requireIndexer(catalog, 'Book files');
      if (!catalog.calibreDir) {
        throw new ApiError(503, 'indexer_off', 'Book files unavailable: no Calibre folder');
      }
      const location = getBookFileFor(db, user, req.params.id);
      if (!location) throw new ApiError(404, 'not_found', 'No such book');
      if (location.missing) {
        throw new ApiError(410, 'missing', 'This book is no longer in the Calibre library');
      }
      const fileMissing = () =>
        new ApiError(404, 'file_missing', 'The book file was not found in the library');
      let file: string;
      try {
        file = resolveInside(
          path.join(catalog.calibreDir, location.libraryFolder),
          location.filePath,
        );
      } catch {
        // A stored path that would leave the library folder is never followed.
        throw fileMissing();
      }
      const stat = await statFile(file);
      if (!stat) throw fileMissing();
      let stream;
      try {
        stream = await openSourceStream(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw fileMissing();
        throw err;
      }
      res.set('Content-Type', 'application/epub+zip');
      res.set('Content-Length', String(stat.size));
      res.set('ETag', `"${location.calibreLastModified ?? 0}-${stat.size}"`);
      res.set('Cache-Control', 'private, no-cache');
      try {
        await pipeline(stream, res);
      } catch (err) {
        // The device cancelled the download; nothing to report.
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        throw err;
      }
    }),
  );

  return router;
}

/**
 * Lets the thumbnail route accept either a signed URL (so a plain <img> works,
 * decided in WP6) or the usual Bearer token. A present but wrong signature is
 * not an error by itself: the request can still pass with a token.
 */
export function thumbnailAuth(db: Database.Database): RequestHandler {
  const bearer = requireUser(db);
  return (req, res, next) => {
    const signed = verifyThumbnailUrl(db, req.params.id, {
      u: queryString(req.query.u),
      v: queryString(req.query.v),
      s: queryString(req.query.s),
    });
    if (signed) {
      res.locals.catalogUser = signed;
      next();
      return;
    }
    bearer(req, res, () => {
      res.locals.catalogUser = getAuth(res).user;
      next();
    });
  };
}

export function thumbnailHandler(db: Database.Database, catalog: CatalogOptions): RequestHandler {
  return asyncHandler(async (req, res) => {
    const user = res.locals.catalogUser as CatalogUser;
    if (!catalog.thumbnails || !catalog.indexer.enabled) {
      throw new ApiError(503, 'indexer_off', `Thumbnails unavailable: ${catalog.indexer.error}`);
    }
    // Same visibility rules as the book itself.
    if (!getBookFor(db, user, req.params.id)) {
      throw new ApiError(404, 'not_found', 'No such book');
    }
    const result = await catalog.thumbnails.ensure(req.params.id);
    if (!result) throw new ApiError(404, 'not_found', 'No such book');
    const { record, file } = result;
    if (record.status === 'none') throw new ApiError(404, 'no_cover', 'This book has no cover');
    if (record.status === 'error' || !file) {
      throw new ApiError(404, 'cover_unreadable', record.error ?? 'The cover could not be read');
    }
    const version = thumbnailVersion(record.sourceKey, record.spec);
    res.set('ETag', `"${version}"`);
    res.set(
      'Cache-Control',
      req.query.v === version ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    );
    res.type('image/webp');
    res.send(await fs.readFile(file));
  });
}
