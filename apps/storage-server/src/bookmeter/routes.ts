/**
 * /api/v1/bookmeter (Bookmeter sync, 2026-11-25, docs/design/bookmeter-sync.md), behind
 * requireUser.
 *
 *   GET    /bookmeter/status                     settings, each account's lists and last checks
 *   PUT    /bookmeter/settings                   enabled, quickMinutes, fullHours, askAbove
 *   POST   /bookmeter/accounts                   { user (id or profile URL), libraries?,
 *                                                statuses?, wish? }: checked and read at once
 *   PUT    /bookmeter/accounts/:id               { libraries?, statuses?, wish? }
 *   DELETE /bookmeter/accounts/:id
 *   POST   /bookmeter/accounts/:id/reviewed      the first changes were applied or skipped
 *   POST   /bookmeter/check-now[?account=]       a full check ahead of the routine
 *   GET    /bookmeter/accounts/:id/unmatched     entries no book matched, with near books, and
 *                                                those marked Not in my library
 *   GET    /bookmeter/accounts/:id/books?q=      library books by title (the Link dialog)
 *   PUT    /bookmeter/accounts/:id/choices/:listing  { bookId: id | null } Link / Not in my library
 *   DELETE /bookmeter/accounts/:id/choices/:listing  Forget my choice
 *   GET    /bookmeter/finished-here              Completed here, not on 読んだ本
 */
import express, { Router, type NextFunction } from 'express';
import { ApiError } from '../api/errors';
import { getAuth } from '../api/auth';
import { userIdFrom } from './parse';
import { BookmeterError, type BookmeterSync } from './service';
import { BookmeterSettingsError, saveBookmeterSettings } from './settings';

export function createBookmeterRouter(service: BookmeterSync | null): Router {
  const router = express.Router();

  const need = (): BookmeterSync => {
    if (!service) throw new ApiError(503, 'bookmeter_off', 'Bookmeter sync is off on this server');
    return service;
  };

  const run = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof BookmeterSettingsError)
        throw new ApiError(400, 'invalid_setting', err.message);
      if (err instanceof BookmeterError) throw new ApiError(err.status, err.code, err.message);
      throw err;
    }
  };

  router.get('/bookmeter/status', (_req, res) => {
    res.json(need().status());
  });

  router.put('/bookmeter/settings', (req, res) => {
    const s = need();
    run(() => saveBookmeterSettings(s.db, (req.body ?? {}) as Record<string, unknown>));
    void s.tick();
    res.json(s.status());
  });

  router.post('/bookmeter/accounts', (req, res) => {
    const s = need();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.user === 'string' ? userIdFrom(body.user) : null;
    if (!userId)
      throw new ApiError(
        400,
        'invalid_user',
        'Give the Bookmeter user’s number or profile link (bookmeter.com/users/…)',
      );
    const account = run(() =>
      s.addAccount({
        userId,
        libraries: body.libraries,
        statuses: body.statuses,
        wish: body.wish,
      }),
    );
    res.status(201).json({ account, ...s.status() });
  });

  router.put('/bookmeter/accounts/:id', (req, res) => {
    const s = need();
    const account = run(() =>
      s.updateAccount(req.params.id, (req.body ?? {}) as Record<string, unknown>),
    );
    res.json({ account, ...s.status() });
  });

  router.delete('/bookmeter/accounts/:id', (req, res) => {
    const s = need();
    run(() => s.removeAccount(req.params.id));
    res.json(s.status());
  });

  router.post('/bookmeter/accounts/:id/reviewed', (req, res) => {
    const s = need();
    const account = run(() => s.markReviewed(req.params.id));
    res.json({ account });
  });

  router.post('/bookmeter/check-now', (req, res) => {
    const s = need();
    const account = typeof req.query.account === 'string' ? req.query.account : undefined;
    run(() => s.checkNow(account));
    res.json(s.status());
  });

  // These read the library index: it is built first, in slices (built in one go after the book
  // list changed, it held the server for seconds; 2026-11-26).
  const withIndex = (s: BookmeterSync, next: NextFunction, f: () => void) => {
    s.indexReady().then(f).catch(next);
  };

  router.get('/bookmeter/accounts/:id/unmatched', (req, res, next) => {
    const s = need();
    withIndex(s, next, () => res.json(run(() => s.unmatched(req.params.id))));
  });

  router.get('/bookmeter/accounts/:id/books', (req, res, next) => {
    const s = need();
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    withIndex(s, next, () => res.json({ books: run(() => s.searchBooks(req.params.id, q)) }));
  });

  router.put('/bookmeter/accounts/:id/choices/:listing', (req, res, next) => {
    const s = need();
    const bookId = (req.body ?? {}).bookId;
    if (bookId !== null && typeof bookId !== 'string')
      throw new ApiError(400, 'invalid_book', 'bookId must be a book id or null');
    withIndex(s, next, () => {
      run(() => s.choose(req.params.id, req.params.listing, bookId));
      res.json({ ok: true });
    });
  });

  router.delete('/bookmeter/accounts/:id/choices/:listing', (req, res, next) => {
    const s = need();
    withIndex(s, next, () => {
      run(() => s.choose(req.params.id, req.params.listing, undefined));
      res.json({ ok: true });
    });
  });

  router.get('/bookmeter/finished-here', (req, res, next) => {
    const s = need();
    withIndex(s, next, () => res.json({ books: s.finishedHere(getAuth(res).user.id) }));
  });

  return router;
}
