/**
 * Book summaries session 2: the accuracy test's routes (/api/v1/summaries-test/*), behind the
 * user's token. Only on the PC's test copy (SUMMARIES_TEST=1); elsewhere they answer 404.
 */
import express, { type Router } from 'express';
import { asyncHandler, ApiError } from '../api/errors';
import type { AiCore } from '../ai/core';
import { SETUP_LABELS, type SetupId, type SummaryTestService } from './test-service';

export function createSummaryTestRouter(
  svc: SummaryTestService | null,
  core: AiCore | null,
): Router {
  const router = express.Router();
  if (!svc) return router;
  const need = <T>(v: T | undefined | null, what: string): T => {
    if (v === undefined || v === null || v === '')
      throw new ApiError(400, 'bad_request', `${what} is required`);
    return v;
  };

  router.get('/summaries-test', (_req, res) => {
    const room = core?.room() ?? null;
    res.json({
      setups: SETUP_LABELS,
      books: svc.books(),
      runs: svc
        .runs()
        .map((r) => ({ ...r, progress: svc.progress(r), languages: svc.languages(r.id) })),
      budget: room
        ? { spentUsd: room.spentUsd, reservedUsd: room.reservedUsd, limitUsd: room.limitUsd }
        : null,
      wait: svc.pump.lastWait,
    });
  });

  router.post('/summaries-test/books', (req, res) => {
    const b = req.body as {
      key?: string;
      title?: string;
      series?: string | null;
      volume?: number | null;
    };
    try {
      res.status(201).json({
        book: svc.addByTitle(
          need(b.key, 'key'),
          need(b.title, 'title'),
          b.series ?? null,
          b.volume ?? null,
        ),
      });
    } catch (e) {
      throw new ApiError(404, 'not_found', (e as Error).message);
    }
  });

  router.post('/summaries-test/runs', (req, res) => {
    const b = req.body as { book?: string; setup?: SetupId; background?: boolean; round?: string };
    const setup = need(b.setup, 'setup');
    if (!(setup in SETUP_LABELS)) throw new ApiError(400, 'bad_request', 'unknown setup');
    try {
      res
        .status(202)
        .json({ run: svc.start(need(b.book, 'book'), setup, !!b.background, b.round ?? 'round1') });
    } catch (e) {
      throw new ApiError(409, 'not_started', (e as Error).message);
    }
  });

  router.post(
    '/summaries-test/judging/prepare',
    asyncHandler(async (req, res) => {
      const b = req.body as { book?: string; scope?: string; runs?: string[] };
      await svc.prepareJudging(need(b.book, 'book'), need(b.scope, 'scope'), need(b.runs, 'runs'));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/summaries-test/translate',
    asyncHandler(async (req, res) => {
      const b = req.body as { run?: string; lang?: string };
      const s = await svc.translateRun(need(b.run, 'run'), need(b.lang, 'lang'));
      res.json({ summary: s });
    }),
  );

  router.get(
    '/summaries-test/items',
    asyncHandler(async (req, res) => {
      const book = need(req.query.book as string, 'book');
      const j = svc.itemJudging(book, (req.query.scope as string) || 'round1');
      const map = await svc.chapters(book).catch(() => ({ chapters: [], characters: 0 }));
      res.json({ ...j, ...map });
    }),
  );

  router.put('/summaries-test/items/mark', (req, res) => {
    const b = req.body as { run?: string; ref?: string; mark?: string | null };
    if (b.mark !== null && !['right', 'mistake', 'not_needed', 'unsure'].includes(b.mark as string))
      throw new ApiError(
        400,
        'bad_request',
        'mark must be right, mistake, not_needed, unsure or null',
      );
    try {
      svc.markItem(need(b.run, 'run'), need(b.ref, 'ref'), (b.mark ?? null) as never);
    } catch (e) {
      throw new ApiError(404, 'not_found', (e as Error).message);
    }
    res.json({ ok: true });
  });

  router.get('/summaries-test/judging', (req, res) => {
    const book = need(req.query.book as string, 'book');
    const scope = (req.query.scope as string) || 'round1';
    const j = svc.judging(book, scope);
    const runs = svc.runs().filter((r) => r.bookKey === book);
    res.json({
      book: svc.book(book),
      ...j,
      scores: svc.scores(book, scope),
      runs: runs.map((r) => ({
        id: r.id,
        setup: r.setup,
        background: r.background,
        label: `${SETUP_LABELS[r.setup]}${r.background ? ' · with earlier volumes' : ''}`,
        state: r.state,
      })),
    });
  });

  router.put('/summaries-test/marks/:group', (req, res) => {
    const b = req.body as { mark?: 'right' | 'wrong' | 'unsure' | null; note?: string | null };
    if (b.mark !== null && !['right', 'wrong', 'unsure'].includes(b.mark as string))
      throw new ApiError(400, 'bad_request', 'mark must be right, wrong, unsure or null');
    svc.mark(Number(req.params.group), b.mark ?? null, b.note ?? null);
    res.json({ ok: true });
  });

  router.put('/summaries-test/claims/:id/mark', (req, res) => {
    const b = req.body as { mark?: 'right' | 'wrong' | 'unsure' | null };
    if (b.mark !== null && !['right', 'wrong', 'unsure'].includes(b.mark as string))
      throw new ApiError(400, 'bad_request', 'mark must be right, wrong, unsure or null');
    try {
      svc.markClaim(Number(req.params.id), b.mark ?? null);
      res.json({ ok: true });
    } catch (e) {
      throw new ApiError(404, 'not_found', (e as Error).message);
    }
  });

  router.post('/summaries-test/claims/:id/move', (req, res) => {
    const to = (req.body as { to?: number | 'new' }).to;
    try {
      res.json({
        group: svc.moveClaim(Number(req.params.id), to === 'new' ? 'new' : Number(need(to, 'to'))),
      });
    } catch (e) {
      throw new ApiError(409, 'not_moved', (e as Error).message);
    }
  });

  router.post('/summaries-test/groups/merge', (req, res) => {
    const b = req.body as { from?: number; into?: number };
    try {
      svc.mergeGroups(Number(need(b.from, 'from')), Number(need(b.into, 'into')));
    } catch (e) {
      throw new ApiError(409, 'not_merged', (e as Error).message);
    }
    res.json({ ok: true });
  });

  router.post('/summaries-test/missing', (req, res) => {
    const b = req.body as {
      book?: string;
      scope?: string;
      text?: string;
      run?: string | null;
      section?: string | null;
    };
    const text = need(b.text?.trim(), 'text');
    res.status(201).json({
      id: svc.addMissing(
        need(b.book, 'book'),
        b.scope || 'round1',
        text,
        b.run ?? null,
        b.section ?? null,
      ),
    });
  });

  router.put('/summaries-test/missing/:id', (req, res) => {
    const b = req.body as { text?: string; run?: string | null; section?: string | null };
    try {
      svc.updateMissing(Number(req.params.id), need(b.text?.trim(), 'text'), b.run, b.section);
    } catch (e) {
      throw new ApiError(404, 'not_found', (e as Error).message);
    }
    res.json({ ok: true });
  });

  router.delete('/summaries-test/missing/:id', (req, res) => {
    svc.removeMissing(Number(req.params.id));
    res.json({ ok: true });
  });

  router.get(
    '/summaries-test/summary',
    asyncHandler(async (req, res) => {
      const runId = need(req.query.run as string, 'run');
      const lang = (req.query.lang as string) || 'ja';
      const run = svc.run(runId);
      const summary = svc.summary(runId, lang);
      if (!run || !summary) throw new ApiError(404, 'not_found', 'No such summary');
      const book = svc.book(run.bookKey);
      const map = await svc.chapters(run.bookKey).catch(() => ({ chapters: [], characters: 0 }));
      res.json({
        run: {
          ...run,
          label: `${SETUP_LABELS[run.setup]}${run.background ? ' · with earlier volumes' : ''}`,
        },
        book,
        summary,
        languages: svc.languages(runId),
        ...map,
      });
    }),
  );

  return router;
}
