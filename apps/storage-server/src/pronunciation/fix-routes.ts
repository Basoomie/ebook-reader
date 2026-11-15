/**
 * Season 2 Phase 12 routes (behind requireUser): the pronunciation fix lists and the text
 * check on a book's page.
 *
 * - GET    /pronunciation-fixes[?bookId=]  the book's list, or the global one
 * - POST   /pronunciation-fixes            {bookId?, kind: 'word'|'pattern', match, reading}
 * - PATCH  /pronunciation-fixes/:id        {kind?, match?, reading?}
 * - DELETE /pronunciation-fixes/:id
 * - GET    /books/:id/pronunciation-check  each entry's places in the book (both lists)
 *
 * A pattern saved to a book's list is first run on that book's text within the time limit
 * (when the book's text can be read), so one that takes too long is refused when saved.
 */
import type Database from 'better-sqlite3';
import express, { type Request, Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import type { AudioOptions } from '../audio/routes';
import { JobRequestError } from '../audio/subtitle-jobs';
import { getBookFor } from '../catalog/queries';
import { FIX_LIMITS, type FixEntry } from './fix-rules';
import { FixRequestError, type FixService } from './fix-service';

function fixesOr503(o: AudioOptions): FixService {
  if (!o.fixes || !o.tts)
    throw new ApiError(503, 'fixes_off', 'Pronunciation fixes need the PC voices on this server');
  return o.fixes;
}

function rethrow(err: unknown): never {
  if (err instanceof FixRequestError || err instanceof JobRequestError) {
    throw new ApiError(err.status, err.code, err.message);
  }
  throw err;
}

async function attempt<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrow(err);
  }
}

const id = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(404, 'not_found', 'No such fix');
  return n;
};

export function createPronunciationRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();
  const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
  const bookOr404 = (userId: string, bookId: string) => {
    if (!getBookFor(db, { id: userId }, bookId))
      throw new ApiError(404, 'not_found', 'No such book');
  };

  /** A new or changed pattern of a book's list, run once on the book's text in time. */
  const trial = async (userId: string, entry: FixEntry) => {
    if (entry.kind !== 'pattern' || entry.bookId === null || !options.tts) return;
    try {
      await options.tts.trialFix(userId, entry.bookId, entry);
    } catch (err) {
      if (err instanceof FixRequestError && err.code === 'fix_timeout') {
        throw new ApiError(
          422,
          'fix_timeout',
          `This pattern takes longer than ${options.fixes?.timeoutSeconds ?? 0} s on this book; make it simpler`,
        );
      }
      // The book's text can't be read now (no EPUB, unreadable): saved without the trial; a
      // job would refuse a pattern that runs too long anyway.
      if (err instanceof JobRequestError) return;
      throw err;
    }
  };

  router.get('/pronunciation-fixes', (req, res) => {
    const { user } = getAuth(res);
    const bookId =
      typeof req.query.bookId === 'string' && req.query.bookId ? req.query.bookId : null;
    if (bookId) bookOr404(user.id, bookId);
    const available = Boolean(options.fixes && options.tts);
    res.json({
      available,
      entries: available ? options.fixes!.list(user.id, bookId) : [],
      limits: { ...FIX_LIMITS, timeoutSeconds: options.fixes?.timeoutSeconds ?? null },
    });
  });

  router.post(
    '/pronunciation-fixes',
    asyncHandler(async (req, res) => {
      const fixes = fixesOr503(options);
      const { user } = getAuth(res);
      const b = body(req);
      const bookId = typeof b.bookId === 'string' && b.bookId ? b.bookId : null;
      if (bookId) bookOr404(user.id, bookId);
      const checked = await attempt(() =>
        fixes.check({ kind: b.kind, match: b.match, reading: b.reading }),
      );
      await trial(user.id, { id: 0, bookId, createdAt: Number.MAX_SAFE_INTEGER, ...checked });
      const entry = await attempt(() => fixes.add(user.id, bookId, checked));
      res.status(201).json({ entry });
    }),
  );

  router.patch(
    '/pronunciation-fixes/:id',
    asyncHandler(async (req, res) => {
      const fixes = fixesOr503(options);
      const { user } = getAuth(res);
      const old = fixes.get(user.id, id(req.params.id));
      if (!old) throw new ApiError(404, 'not_found', 'No such fix');
      const b = body(req);
      const checked = await attempt(() =>
        fixes.check({
          kind: b.kind ?? old.kind,
          match: b.match ?? old.match,
          reading: b.reading ?? old.reading,
        }),
      );
      if (checked.kind !== old.kind || checked.match !== old.match) {
        await trial(user.id, { ...old, ...checked, id: 0 });
      }
      const entry = await attempt(() => fixes.update(user.id, old.id, checked));
      res.json({ entry });
    }),
  );

  router.delete('/pronunciation-fixes/:id', (req, res) => {
    const fixes = fixesOr503(options);
    const { user } = getAuth(res);
    try {
      fixes.remove(user.id, id(req.params.id));
    } catch (err) {
      rethrow(err);
    }
    res.status(204).end();
  });

  router.get(
    '/books/:id/pronunciation-check',
    asyncHandler(async (req, res) => {
      fixesOr503(options);
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      res.json(await attempt(() => options.tts!.pronunciationCheck(user.id, req.params.id)));
    }),
  );

  return router;
}
