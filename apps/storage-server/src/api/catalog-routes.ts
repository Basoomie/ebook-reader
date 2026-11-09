/**
 * /api/v1 catalog routes (WP2): libraries, books and cover thumbnails.
 * Mounted behind requireUser.
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import fs from 'fs/promises';
import type { IndexerStatus } from '../calibre/indexer';
import { getBookFor, InvalidCursorError, listBooksFor, listLibrariesFor } from '../catalog/queries';
import { thumbnailVersion, type ThumbnailService } from '../thumbnails/thumbnails';
import { getAuth } from './auth';
import { ApiError, asyncHandler } from './errors';

export interface CatalogOptions {
  thumbnails: ThumbnailService | null;
  indexer: IndexerStatus;
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function queryBool(value: unknown): boolean {
  return value === '1' || value === 'true';
}

export function createCatalogRouter(db: Database.Database, catalog: CatalogOptions): Router {
  const router = express.Router();

  router.get('/libraries', (_req, res) => {
    const { user } = getAuth(res);
    res.json({ indexer: catalog.indexer, libraries: listLibrariesFor(db, user) });
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
          limit,
          cursor: queryString(req.query.cursor),
          includeMissing: queryBool(req.query.includeMissing),
        }),
      );
    } catch (err) {
      if (err instanceof InvalidCursorError) throw new ApiError(400, 'invalid_cursor', err.message);
      throw err;
    }
  });

  router.get('/books/:id', (req, res) => {
    const { user } = getAuth(res);
    const book = getBookFor(db, user, req.params.id);
    if (!book) throw new ApiError(404, 'not_found', 'No such book');
    res.json(book);
  });

  router.get(
    '/books/:id/thumbnail',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
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
    }),
  );

  return router;
}
