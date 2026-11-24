/**
 * Book summaries (session 3): /api/v1/summaries/*, behind the user's token. What session 4's
 * book page uses: the current summary in a language, Regenerate with AI, Write my own, edits of
 * items, Delete, earlier versions and Restore, a language chosen, the bulk estimate, the
 * summaries' settings and their jobs. Every change is told to the devices by the book's
 * "book-summary" record.
 */
import express, { type Router } from 'express';
import { ApiError } from '../api/errors';
import { SummarySettingsError } from './settings';
import type { SummaryService } from './service';
import { EditError, SECTION_ORDER, type SectionKey } from './store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSummaryRouter(svc: SummaryService | null): Router {
  const router = express.Router();
  if (!svc) {
    router.use('/summaries', () => {
      throw new ApiError(503, 'summaries_off', 'Book summaries are off on this server');
    });
    return router;
  }

  /** The handler with the store's errors as API errors. */
  const h =
    (fn: (req: express.Request, res: express.Response) => void) =>
    (req: express.Request, res: express.Response) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err instanceof EditError) throw new ApiError(err.status, err.code, err.message);
        if (err instanceof SummarySettingsError) throw new ApiError(400, 'invalid', err.message);
        throw err;
      }
    };

  const bookId = (req: express.Request): string => {
    const id = req.params.bookId;
    if (!UUID_RE.test(id)) throw new ApiError(400, 'invalid_id', 'Not a book id');
    return id;
  };
  const intParam = (v: string, what: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'invalid_id', `Not ${what}`);
    return n;
  };

  // Registered before /summaries/:bookId so these names are never taken for a book id.
  router.get(
    '/summaries/settings',
    h((_req, res) => res.json({ settings: svc.settings(), costPer100kChars: svc.costPer100k() })),
  );
  router.put(
    '/summaries/settings',
    h((req, res) => res.json({ settings: svc.updateSettings(req.body) })),
  );
  router.get(
    '/summaries/jobs',
    h((_req, res) => res.json({ jobs: svc.jobs() })),
  );
  // Session 5: the series recap ("story so far"), by series name.
  const seriesName = (v: unknown): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > 300)
      throw new ApiError(400, 'invalid', 'series must be a series name');
    return v;
  };
  router.get(
    '/summaries/series-recap',
    h((req, res) => {
      const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
      res.json(svc.recaps.get(seriesName(req.query.series), lang));
    }),
  );
  router.post(
    '/summaries/series-recap/regenerate',
    h((req, res) =>
      res.status(202).json({
        job: svc.recaps.regenerate(seriesName((req.body as { series?: unknown })?.series)),
      }),
    ),
  );
  router.post(
    '/summaries/series-recap/translate',
    h((req, res) => {
      const b = (req.body ?? {}) as { series?: unknown; lang?: unknown };
      svc.recaps.translate(seriesName(b.series), b.lang);
      res.status(202).end();
    }),
  );
  router.post(
    '/summaries/estimate',
    h((req, res) => res.json(svc.estimate((req.body as { bookIds?: unknown })?.bookIds))),
  );

  router.get(
    '/summaries/:bookId',
    h((req, res) => {
      const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
      res.json(svc.get(bookId(req), lang));
    }),
  );
  // Session 4b: the book's description in a language (translated like a summary).
  router.get(
    '/summaries/:bookId/description',
    h((req, res) => res.json(svc.descriptionView(bookId(req), req.query.lang))),
  );
  router.post(
    '/summaries/:bookId/description/translate',
    h((req, res) => {
      const v = svc.translateDescription(bookId(req), (req.body as { lang?: unknown })?.lang);
      res.status(v.state === 'done' ? 200 : 202).json(v);
    }),
  );
  router.get(
    '/summaries/:bookId/jobs',
    h((req, res) => res.json({ jobs: svc.jobs(bookId(req)) })),
  );
  router.post(
    '/summaries/:bookId/regenerate',
    h((req, res) => res.status(202).json({ job: svc.regenerate(bookId(req)) })),
  );
  router.put(
    '/summaries/:bookId/own',
    h((req, res) => res.json({ summary: svc.writeOwn(bookId(req), req.body) })),
  );
  router.put(
    '/summaries/:bookId/overview',
    h((req, res) =>
      res.json({ item: svc.editOverview(bookId(req), (req.body as { text?: unknown })?.text) }),
    ),
  );
  router.post(
    '/summaries/:bookId/items',
    h((req, res) => {
      const b = (req.body ?? {}) as {
        section?: unknown;
        text?: unknown;
        heading?: unknown;
        between?: unknown;
        label?: unknown;
        chapter?: unknown;
        chapterTitle?: unknown;
      };
      if (typeof b.section !== 'string' || !SECTION_ORDER.includes(b.section as SectionKey))
        throw new ApiError(400, 'invalid', `section must be one of ${SECTION_ORDER.join(', ')}`);
      res.status(201).json({
        item: svc.addItem(bookId(req), b.section as SectionKey, {
          text: b.text as string,
          heading: b.heading as string | null | undefined,
          between: b.between as [string, string] | null | undefined,
          label: b.label as string | null | undefined,
          chapter: b.chapter as number | null | undefined,
          chapterTitle: b.chapterTitle as string | null | undefined,
        }),
      });
    }),
  );
  router.put(
    '/summaries/:bookId/items/:itemId',
    h((req, res) => {
      const b = (req.body ?? {}) as {
        text?: unknown;
        heading?: unknown;
        between?: unknown;
        label?: unknown;
      };
      res.json({
        item: svc.editItem(bookId(req), intParam(req.params.itemId, 'an item id'), {
          text: b.text as string,
          ...(b.heading !== undefined ? { heading: b.heading as string } : {}),
          ...(b.between !== undefined ? { between: b.between as [string, string] } : {}),
          ...(b.label !== undefined ? { label: b.label as string | null } : {}),
        }),
      });
    }),
  );
  router.delete(
    '/summaries/:bookId/items/:itemId',
    h((req, res) => {
      svc.deleteItem(bookId(req), intParam(req.params.itemId, 'an item id'));
      res.status(204).end();
    }),
  );
  router.delete(
    '/summaries/:bookId',
    h((req, res) => {
      svc.deleteCurrent(bookId(req));
      res.status(204).end();
    }),
  );
  router.get(
    '/summaries/:bookId/versions',
    h((req, res) => res.json({ versions: svc.store.versions(bookId(req)) })),
  );
  router.get(
    '/summaries/:bookId/versions/:id',
    h((req, res) => {
      const id = intParam(req.params.id, 'a version id');
      const m = svc.store.metaById(id);
      if (!m || m.bookId !== bookId(req)) throw new ApiError(404, 'no_version', 'No such version');
      const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
      res.json({ summary: svc.store.view(id, lang) });
    }),
  );
  router.post(
    '/summaries/:bookId/versions/:id/restore',
    h((req, res) => {
      svc.restore(bookId(req), intParam(req.params.id, 'a version id'));
      res.status(204).end();
    }),
  );
  router.delete(
    '/summaries/:bookId/versions/:id',
    h((req, res) => {
      svc.deleteVersion(bookId(req), intParam(req.params.id, 'a version id'));
      res.status(204).end();
    }),
  );
  router.post(
    '/summaries/:bookId/translate',
    h((req, res) => {
      svc.translate(bookId(req), (req.body as { lang?: unknown })?.lang);
      res.status(202).end();
    }),
  );
  return router;
}
