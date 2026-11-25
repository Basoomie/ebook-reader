/**
 * Calibre metadata editing from the reader (user tokens, after requireUser):
 *
 *   GET  /books/:id/calibre-edit            the form: values, unconfirmed, yours, status, writer
 *   POST /books/:id/calibre-edit            save (409 shared_rename asks first; 422 refuses)
 *   GET  /books/:id/calibre-edit/status     each field's latest edit (polled while one is pending)
 *   POST /books/:id/calibre-edit/cover      a picture for the next save (its own bytes) → token
 *   GET  /books/:id/calibre-edit/covers     book covers: the pictures the archive keeps (oldest first)
 *   GET  /books/:id/calibre-edit/covers/:sha        one of them (only this book's)
 *   POST /books/:id/calibre-edit/covers/:sha/use    it, for the next save → token
 *   GET  /books/:id/calibre-edit/store-covers       the stores' pictures (?again=1 asks a failed one again)
 *   GET  /books/:id/calibre-edit/store-covers/:store/picture   one store's picture
 *   POST /books/:id/calibre-edit/store-covers/:store/use       it, for the next save → token
 *   GET  /books/:id/history                 the history of changes
 *   POST /books/:id/history/:entry/undo     Undo of one entry (the page asked first)
 *   GET  /calibre-series?library=&name=     the series editor
 *   POST /calibre-series                    its save (one batch)
 *   POST /calibre-series/not-same           "Not the same series"
 *   GET  /calibre-tags                      "Tags you can pick" (Settings and the form)
 *   PUT  /calibre-tags                      one change to the list (writes nothing to books)
 *
 * Off (503) when the cleanup is off: the sidecar that writes to Calibre is the cleanup's.
 */
import express, { Router } from 'express';
import { readFileSync } from 'fs';
import { ApiError, asyncHandler } from '../../api/errors';
import type { CleanupOptions } from '../routes';
import { getSettings, isCustomTag, updateSettings } from '../settings';
import {
  DEFAULT_TAG_LIST,
  TagListError,
  changeTagList,
  tagListView,
  type TagGroup,
} from '../stage5/tag-list';
import { EditError } from './fields';
import { MAX_COVER_BYTES, pictureType } from './edits';

const pictureMime = (b: Buffer): string => {
  const t = pictureType(b);
  return t === 'jpg' ? 'image/jpeg' : t ? `image/${t}` : 'application/octet-stream';
};

function service(options: CleanupOptions) {
  if (!options.service)
    throw new ApiError(
      503,
      'cleanup_off',
      `Editing needs the library cleanup's writer, which is off: ${options.error ?? 'not set up'}`,
    );
  return options.service;
}

function rethrow(err: unknown): never {
  if (err instanceof EditError) throw new ApiError(err.status, err.code, err.message, err.details);
  if (err instanceof TagListError) throw new ApiError(422, 'invalid_tag', err.message);
  throw err;
}

const wrap =
  <T>(fn: () => T) =>
  (): T => {
    try {
      return fn();
    } catch (err) {
      rethrow(err);
    }
  };

export function createEditRouter(options: CleanupOptions): Router {
  const router = express.Router();
  const rawCover = express.raw({ type: () => true, limit: MAX_COVER_BYTES });

  router.get('/books/:id/calibre-edit', (req, res) => {
    const s = service(options);
    res.json(wrap(() => s.edits.form(req.params.id))());
  });

  router.post('/books/:id/calibre-edit', (req, res) => {
    const s = service(options);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = wrap(() =>
      s.edits.save(req.params.id, {
        base: body.base as Record<string, unknown> | undefined,
        values: body.values as Record<string, unknown> | undefined,
        coverToken: typeof body.coverToken === 'string' ? body.coverToken : null,
        confirm: Array.isArray(body.confirm) ? (body.confirm as string[]) : [],
        acceptRenames: body.acceptRenames === true,
      }),
    )();
    void s.tick();
    res.json({ ...result, status: wrap(() => s.edits.status(req.params.id))() });
  });

  router.get('/books/:id/calibre-edit/status', (req, res) => {
    const s = service(options);
    res.json({
      status: wrap(() => s.edits.status(req.params.id))(),
      writer: s.edits.writer(),
    });
  });

  router.post('/books/:id/calibre-edit/cover', rawCover, (req, res) => {
    const s = service(options);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Only a Calibre book can take a cover from here.
    wrap(() => s.edits.form(req.params.id))();
    res.json(wrap(() => s.edits.storeCover(bytes))());
  });

  // Book covers (docs/design/book-covers.md): the earlier covers the archive keeps and the
  // stores' pictures, both written like an upload when picked.
  router.get(
    '/books/:id/calibre-edit/covers',
    asyncHandler(async (req, res) => {
      const s = service(options);
      try {
        res.json(await s.edits.earlierCovers(req.params.id));
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  router.get('/books/:id/calibre-edit/covers/:sha', (req, res) => {
    const s = service(options);
    const file = wrap(() => s.edits.archivedPicture(req.params.id, req.params.sha))();
    if (!file) throw new ApiError(404, 'not_found', 'That cover is not in the archive');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(file);
  });

  // Picking an earlier cover: kept for the next save like an upload (its token).
  router.post('/books/:id/calibre-edit/covers/:sha/use', (req, res) => {
    const s = service(options);
    const file = wrap(() => s.edits.archivedPicture(req.params.id, req.params.sha))();
    if (!file) throw new ApiError(404, 'not_found', 'That cover is not in the archive');
    res.json(wrap(() => s.edits.storeCover(readFileSync(file)))());
  });

  router.get(
    '/books/:id/calibre-edit/store-covers',
    asyncHandler(async (req, res) => {
      const s = service(options);
      wrap(() => s.edits.form(req.params.id))();
      try {
        res.json(await s.storeCovers.view(req.params.id, req.query.again === '1'));
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  router.get('/books/:id/calibre-edit/store-covers/:store/picture', (req, res) => {
    const s = service(options);
    const bytes = wrap(() => s.storeCovers.picture(req.params.id, req.params.store))();
    res.setHeader('Content-Type', pictureMime(bytes));
    res.setHeader('Cache-Control', 'private, no-cache');
    res.end(bytes);
  });

  // Picking a store's picture: kept for the next save like an upload (its token).
  router.post('/books/:id/calibre-edit/store-covers/:store/use', (req, res) => {
    const s = service(options);
    wrap(() => s.edits.form(req.params.id))();
    const bytes = wrap(() => s.storeCovers.picture(req.params.id, req.params.store))();
    res.json(wrap(() => s.edits.storeCover(bytes))());
  });

  router.get('/books/:id/history', (req, res) => {
    const s = service(options);
    res.json({ entries: wrap(() => s.edits.history(req.params.id))() });
  });

  router.post('/books/:id/history/:entry/undo', (req, res) => {
    const s = service(options);
    const result = wrap(() => s.edits.undo(req.params.id, req.params.entry))();
    void s.tick();
    res.json(result);
  });

  router.get('/calibre-series', (req, res) => {
    const s = service(options);
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const library =
      typeof req.query.library === 'string' && req.query.library !== ''
        ? req.query.library
        : s.targetLibrary();
    if (!name || !library) throw new ApiError(400, 'bad_request', 'A series name is needed');
    res.json(wrap(() => s.edits.seriesView(library, name))());
  });

  router.post('/calibre-series', (req, res) => {
    const s = service(options);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const libraryId = typeof b.libraryId === 'string' ? b.libraryId : s.targetLibrary();
    if (typeof b.name !== 'string' || !libraryId)
      throw new ApiError(400, 'bad_request', 'A series name is needed');
    const result = wrap(() =>
      s.edits.saveSeries({
        libraryId,
        name: b.name as string,
        rename: typeof b.rename === 'string' ? b.rename : null,
        books: Array.isArray(b.books) ? (b.books as never) : [],
        confirm: Array.isArray(b.confirm) ? (b.confirm as string[]) : [],
        merge: typeof b.merge === 'string' ? b.merge : null,
        acceptRenames: b.acceptRenames === true,
      }),
    )();
    void s.tick();
    res.json(result);
  });

  router.post('/calibre-series/not-same', (req, res) => {
    const s = service(options);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const libraryId = typeof b.libraryId === 'string' ? b.libraryId : s.targetLibrary();
    if (typeof b.name !== 'string' || typeof b.other !== 'string' || !libraryId)
      throw new ApiError(400, 'bad_request', 'Two series names are needed');
    s.edits.notSameSeries(libraryId, b.name, b.other);
    res.json({ ok: true });
  });

  /** The list, with each pattern of the user's own tags resolved to the library's tags. */
  const tagList = (s: ReturnType<typeof service>) => {
    const settings = getSettings(s.db);
    const view = tagListView(settings.tagList, settings.customTags);
    const names = (
      s.main.prepare('SELECT name FROM tags ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name);
    const yours = names.filter((n) => isCustomTag(n, settings.customTags));
    return { ...view, yoursInLibrary: yours };
  };

  router.get('/calibre-tags', (_req, res) => {
    res.json(tagList(service(options)));
  });

  router.put('/calibre-tags', (req, res) => {
    const s = service(options);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const settings = getSettings(s.db);
    if (b.reset === true) {
      // Back to the vocabulary and the user's own tags as they first were (writes no book).
      updateSettings(s.db, {
        tagList: DEFAULT_TAG_LIST,
        customTags: ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'],
      });
      res.json(tagList(s));
      return;
    }
    const next = wrap(() =>
      changeTagList(settings.tagList, settings.customTags, {
        group: b.group as TagGroup,
        add: typeof b.add === 'string' ? b.add : undefined,
        remove: typeof b.remove === 'string' ? b.remove : undefined,
      }),
    )();
    updateSettings(s.db, { tagList: next.tagList, customTags: next.customTags });
    res.json(tagList(s));
  });

  return router;
}
