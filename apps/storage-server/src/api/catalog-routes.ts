/**
 * /api/v1 catalog routes (WP2, WP6): libraries, books, search, EPUB download,
 * full-size covers and cover thumbnails. Everything except the thumbnail is mounted behind
 * requireUser; the thumbnail also accepts a signed URL (see thumbnailAuth).
 */
import type Database from 'better-sqlite3';
import express, { RequestHandler, Response, Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { IndexerStatus } from '../calibre/indexer';
import { openSourceStream, resolveInside, statFile } from '../calibre/source-fs';
import { planGroups } from '../catalog/groups';
import { collectionCards } from '../collections/cards';
import {
  type BookFileLocation,
  CatalogUser,
  getBookFileFor,
  getBookFor,
  GroupBy,
  GroupRef,
  InvalidCursorError,
  listLibrariesFor,
  MAX_LOOKUP_IDS,
  planBooks,
  planCount,
  planLookup,
  PlannedQuery,
  verifyThumbnailUrl,
} from '../catalog/queries';
import { catalogVersion } from '../catalog/catalog-version';
import { BOOK_SORT_KEYS, GROUP_SORT_KEYS, parseBookSort, parseGroupSort } from '../catalog/sort';
import { InvalidQueryError } from '../catalog/query-parser';
import { RegexTimeoutError, SearchRunner } from '../catalog/search-runner';
import { UUID_RE } from '../sync/kinds';
import type { CharCountService } from '../counts/count-service';
import { thumbnailVersion, type ThumbnailService } from '../thumbnails/thumbnails';
import type { UploadService } from '../uploads/service';
import { getAuth, requireUser } from './auth';
import { ApiError, asyncHandler } from './errors';

export interface CatalogOptions {
  thumbnails: ThumbnailService | null;
  /** Background character counts (WP3b); null when the counter is unavailable. */
  counts?: CharCountService | null;
  indexer: IndexerStatus;
  /** Root of the Calibre libraries (read-only); null when the indexer is off. */
  calibreDir?: string | null;
  /** Runs searches that contain a /regex/ (WP7a); without it they run in-process. */
  search?: SearchRunner | null;
  /** Uploads (WP7b); null or absent = the upload adapter is off. */
  uploads?: UploadService | null;
}

const GROUP_BYS: GroupBy[] = ['series', 'author', 'tag'];

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

/** The user and the device of the request's token (on:device answers for that device). */
function askingUser(res: Response): CatalogUser {
  const auth = getAuth(res);
  return { id: auth.user.id, deviceId: auth.token.deviceId };
}

/** Cached list counts per router (oldest dropped first). */
const COUNT_CACHE_SIZE = 500;

/** The user's newest record revision: counts with status:/favorite:/collection depend on it. */
function userRevision(db: Database.Database, userId: string): number {
  const row = db
    .prepare('SELECT MAX(rev) AS rev FROM sync_records WHERE user_id = ?')
    .get(userId) as { rev: number | null } | undefined;
  return row?.rev ?? 0;
}

export function createCatalogRouter(db: Database.Database, catalog: CatalogOptions): Router {
  const router = express.Router();
  const countSpec = () => catalog.counts?.spec ?? null;
  const countCache = new Map<string, { version: string; count: number }>();

  router.get('/libraries', (_req, res) => {
    const { user } = getAuth(res);
    res.json({
      indexer: catalog.indexer,
      libraries: listLibrariesFor(db, user, countSpec()),
      // WP7b: whether this server takes uploads, and their size limit.
      uploads: catalog.uploads
        ? { enabled: true, maxBytes: catalog.uploads.maxBytes }
        : { enabled: false, maxBytes: 0 },
    });
  });

  // Searches with a /regex/ run in the search worker; everything else right here.
  const fallbackRunner = new SearchRunner({ db, file: null, timeoutSeconds: 0 });
  async function run<T>(plan: PlannedQuery<T>): Promise<T> {
    if (!plan.regex) return plan.finish(db.prepare(plan.sql).all(...plan.params));
    return plan.finish(await (catalog.search ?? fallbackRunner).all(plan.sql, plan.params));
  }

  function listLimit(req: express.Request): number | undefined {
    const limitRaw = queryString(req.query.limit);
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ApiError(400, 'invalid_limit', 'limit must be a positive whole number');
    }
    return limit;
  }

  function groupBy(value: unknown): GroupBy {
    if (!GROUP_BYS.includes(value as GroupBy)) {
      throw new ApiError(400, 'invalid_group', `by must be one of ${GROUP_BYS.join(', ')}`);
    }
    return value as GroupBy;
  }

  /** ?by=series|author|tag&group=<name> (or by=series&none=1 for "No series"). */
  function groupRef(req: express.Request): GroupRef | undefined {
    if (req.query.by === undefined) return undefined;
    const by = groupBy(req.query.by);
    if (by === 'series' && queryBool(req.query.none)) return { by, name: null };
    const name = typeof req.query.group === 'string' ? req.query.group : '';
    if (name === '') throw new ApiError(400, 'invalid_group', 'group (a name) is required');
    return { by, name };
  }

  function searchErrors(err: unknown): never {
    if (err instanceof InvalidCursorError) throw new ApiError(400, 'invalid_cursor', err.message);
    if (err instanceof InvalidQueryError) {
      throw new ApiError(400, 'invalid_query', err.message, {
        start: err.info.start,
        end: err.info.end,
      });
    }
    if (err instanceof RegexTimeoutError) {
      throw new ApiError(422, 'regex_timeout', 'That pattern took too long. Try a simpler one.');
    }
    throw err;
  }

  /** ?collection=<id>: one of the user's manual collections (WP19a). */
  function collectionId(req: express.Request): string | undefined {
    const id = queryString(req.query.collection);
    if (id !== undefined && !UUID_RE.test(id)) {
      throw new ApiError(400, 'invalid_collection', 'collection must be a collection id');
    }
    return id;
  }

  /** The filters shared by /books and /books/count. */
  function listFilter(req: express.Request) {
    return {
      libraryId: queryString(req.query.library),
      query: queryString(req.query.q),
      scope: queryString(req.query.scope),
      group: groupRef(req),
      collection: collectionId(req),
      includeMissing: queryBool(req.query.includeMissing),
    };
  }

  router.get(
    '/books',
    asyncHandler(async (req, res) => {
      const user = askingUser(res);
      const limit = listLimit(req);
      const filter = listFilter(req);
      const sort = parseBookSort(queryString(req.query.sort), queryString(req.query.dir));
      if (sort === null) {
        throw new ApiError(
          400,
          'invalid_sort',
          `sort must be one of ${BOOK_SORT_KEYS.join(', ')}; dir asc or desc`,
        );
      }
      try {
        res.json(
          await run(
            planBooks(db, user, {
              ...filter,
              sort,
              limit,
              cursor: queryString(req.query.cursor),
              countSpec: countSpec(),
            }),
          ),
        );
      } catch (err) {
        searchErrors(err);
      }
    }),
  );

  // How many books a list has (WP19a). Counting visits every match, so answers are
  // cached until the catalog or one of the user's records changes.
  router.get(
    '/books/count',
    asyncHandler(async (req, res) => {
      const user = askingUser(res);
      const filter = listFilter(req);
      const version = `${catalogVersion(db)}:${userRevision(db, user.id)}`;
      const key = JSON.stringify([user.id, user.deviceId ?? null, filter]);
      const hit = countCache.get(key);
      if (hit && hit.version === version) {
        res.json({ count: hit.count });
        return;
      }
      try {
        const { count } = await run(planCount(db, user, filter));
        countCache.delete(key);
        countCache.set(key, { version, count });
        if (countCache.size > COUNT_CACHE_SIZE) {
          countCache.delete(countCache.keys().next().value as string);
        }
        res.json({ count });
      } catch (err) {
        searchErrors(err);
      }
    }),
  );

  router.get(
    '/groups',
    asyncHandler(async (req, res) => {
      const user = askingUser(res);
      const limit = listLimit(req);
      const by = groupBy(req.query.by);
      const sort = parseGroupSort(queryString(req.query.sort), queryString(req.query.dir));
      if (sort === null) {
        throw new ApiError(
          400,
          'invalid_sort',
          `sort must be one of ${GROUP_SORT_KEYS.join(', ')}; dir asc or desc`,
        );
      }
      try {
        res.json(
          await run(
            planGroups(db, user, {
              by,
              libraryId: queryString(req.query.library),
              query: queryString(req.query.q),
              sort,
              limit,
              cursor: queryString(req.query.cursor),
              includeMissing: queryBool(req.query.includeMissing),
              countSpec: countSpec(),
            }),
          ),
        );
      } catch (err) {
        searchErrors(err);
      }
    }),
  );

  // A manual collection's books in its own order (WP8b); the order comes from the device.
  router.post(
    '/books/lookup',
    asyncHandler(async (req, res) => {
      const user = askingUser(res);
      const body = (req.body ?? {}) as { ids?: unknown; q?: unknown; includeMissing?: unknown };
      const ids = body.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_LOOKUP_IDS ||
        !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))
      ) {
        throw new ApiError(
          400,
          'invalid_ids',
          `ids must be a list of at most ${MAX_LOOKUP_IDS} book ids`,
        );
      }
      if (body.includeMissing !== undefined && typeof body.includeMissing !== 'boolean') {
        throw new ApiError(400, 'invalid_body', 'includeMissing must be true or false');
      }
      if (body.q !== undefined && typeof body.q !== 'string') {
        throw new ApiError(400, 'invalid_query', 'q must be text', { start: 0, end: 0 });
      }
      try {
        res.json(
          await run(
            planLookup(db, user, ids as string[], {
              query: body.q === '' ? undefined : (body.q as string | undefined),
              countSpec: countSpec(),
              includeMissing: body.includeMissing === true,
            }),
          ),
        );
      } catch (err) {
        searchErrors(err);
      }
    }),
  );

  // Collections page (WP8b): count and collage tiles of every collection.
  router.get(
    '/collections/cards',
    asyncHandler(async (_req, res) => {
      const user = askingUser(res);
      const runner = catalog.search ?? fallbackRunner;
      const cards = await collectionCards(
        db,
        user,
        (sql, params, regex) =>
          regex ? runner.all(sql, params) : Promise.resolve(db.prepare(sql).all(...params)),
        countSpec(),
        (m, err) => console.error(m, err),
      );
      res.json({ cards });
    }),
  );

  router.get('/books/:id', (req, res) => {
    const { user } = getAuth(res);
    const book = getBookFor(db, user, req.params.id, countSpec());
    if (!book) throw new ApiError(404, 'not_found', 'No such book');
    res.json(book);
  });

  // The EPUB itself, streamed read-only from the Calibre library (WP6), or an
  // uploaded book's file from DATA_DIR/.uploads (WP7b).
  router.get(
    '/books/:id/file',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      await sendBookFile(db, catalog, user, req.params.id, res);
    }),
  );

  // The full-size cover image (the book page's Download menu), read-only. Token only:
  // grids keep using the signed thumbnail.
  router.get(
    '/books/:id/cover',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      if (!catalog.thumbnails || !catalog.indexer.enabled) {
        throw new ApiError(503, 'indexer_off', `Covers unavailable: ${catalog.indexer.error}`);
      }
      // Same visibility rules as the book itself.
      if (!getBookFor(db, user, req.params.id)) {
        throw new ApiError(404, 'not_found', 'No such book');
      }
      const cover = await catalog.thumbnails.original(req.params.id);
      if (!cover) throw new ApiError(404, 'not_found', 'No such book');
      if (cover.status === 'none') throw new ApiError(404, 'no_cover', 'This book has no cover');
      if (cover.status === 'error') throw new ApiError(404, 'cover_unreadable', cover.error);
      res.set('Cache-Control', 'private, no-cache');
      res.type(cover.type);
      res.send(cover.data);
    }),
  );

  return router;
}

/**
 * Streams a book's EPUB: read-only from the Calibre library (WP6), or an uploaded book's
 * file from DATA_DIR/.uploads (WP7b). Also used by the GPU worker's download (WP16).
 */
export async function sendBookFile(
  db: Database.Database,
  catalog: CatalogOptions,
  user: CatalogUser,
  bookId: string,
  res: express.Response,
): Promise<void> {
  const location = getBookFileFor(db, user, bookId);
  if (location?.kind === 'upload') {
    await sendUploadedFile(catalog, location, res);
    return;
  }
  requireIndexer(catalog, 'Book files');
  if (!catalog.calibreDir) {
    throw new ApiError(503, 'indexer_off', 'Book files unavailable: no Calibre folder');
  }
  if (!location) throw new ApiError(404, 'not_found', 'No such book');
  if (location.missing) {
    throw new ApiError(410, 'missing', 'This book is no longer in the Calibre library');
  }
  const fileMissing = () =>
    new ApiError(404, 'file_missing', 'The book file was not found in the library');
  let file: string;
  try {
    file = resolveInside(path.join(catalog.calibreDir, location.libraryFolder), location.filePath);
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
}

async function sendUploadedFile(
  catalog: CatalogOptions,
  location: BookFileLocation,
  res: express.Response,
): Promise<void> {
  const store = catalog.uploads?.store;
  if (!store) throw new ApiError(503, 'uploads_off', 'Uploaded books are unavailable');
  const fileMissing = () => new ApiError(404, 'file_missing', 'The uploaded file was not found');
  const stat = await store.stat(location.filePath).catch(() => null);
  if (!stat) throw fileMissing();
  let stream;
  try {
    stream = await store.openStream(location.filePath);
  } catch {
    throw fileMissing();
  }
  res.set('Content-Type', 'application/epub+zip');
  res.set('Content-Length', String(stat.size));
  res.set('ETag', `"upload-${location.contentHash ?? stat.size}"`);
  res.set('Cache-Control', 'private, no-cache');
  try {
    await pipeline(stream, res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw err;
  }
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
