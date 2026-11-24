/**
 * /api/v1/natively (the Natively level, 2026-11-24), behind requireUser.
 *
 *   GET /natively/level/:bookId[?fresh=1]  the book's saved level; with fresh=1 an old one is
 *                                          read again first (waits up to `wait` ms, default 20 s)
 *   GET /natively/progress                 the first pass's progress and the settings
 *   PUT /natively/settings                 { maxAgeDays?, requestSeconds?, maxBackoffMinutes? }
 *
 * Without the service (tests, or off) the level routes answer the saved value or 503.
 */
import express, { Router } from 'express';
import { ApiError, asyncHandler } from '../api/errors';
import type { NativelyLevels } from './levels';
import { NativelySettingsError, saveNativelySettings } from './settings';

const MAX_WAIT_MS = 30_000;

export function createNativelyRouter(levels: NativelyLevels | null): Router {
  const router = express.Router();

  const need = (): NativelyLevels => {
    if (!levels) throw new ApiError(503, 'natively_off', 'Natively levels are off on this server');
    return levels;
  };

  router.get(
    '/natively/level/:bookId',
    asyncHandler(async (req, res) => {
      const service = need();
      const nativelyId = service.nativelyIdOf(req.params.bookId);
      if (!nativelyId) {
        res.json({ nativelyId: null, level: null, temporary: false, state: null, checkedAt: null });
        return;
      }
      const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(req.query.wait ?? 20_000) || 0));
      const row =
        req.query.fresh === '1'
          ? await service.refresh(nativelyId, wait)
          : service.saved(nativelyId);
      res.json({
        nativelyId,
        level: row?.level ?? null,
        temporary: row?.temporary ?? false,
        state: row?.state ?? null,
        checkedAt: row && row.checkedAt > 0 ? row.checkedAt : null,
      });
    }),
  );

  router.get('/natively/progress', (_req, res) => {
    const service = need();
    res.json({ ...service.progress(), settings: service.settings() });
  });

  router.put('/natively/settings', (req, res) => {
    const service = need();
    try {
      const settings = saveNativelySettings(
        service.db,
        (req.body ?? {}) as Record<string, unknown>,
      );
      res.json({ settings });
    } catch (err) {
      if (err instanceof NativelySettingsError)
        throw new ApiError(400, 'invalid_setting', err.message);
      throw err;
    }
  });

  return router;
}
