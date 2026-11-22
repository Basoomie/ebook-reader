/**
 * Settings > AI, mounted after requireUser (works whether or not cleanup.db opened):
 *
 *   GET    /ai/status                    settings, keys (set or not), checks, models, this
 *                                        month's spending per feature, earlier months
 *   PUT    /ai/settings                  change provider settings (a partial object; never the
 *                                        prices: they are built in, prices.ts)
 *   PUT    /ai/secrets/:name             save a key ({ value }); never echoed back
 *   DELETE /ai/secrets/:name
 *   POST   /ai/models/check              read each provider's model list now
 *   POST   /ai/models/:model/batch-test  send one tiny batch to the model
 *   GET    /ai/models/available          the chat models each provider offers the key now,
 *                                        with their prices when known (the Add dialog)
 *   POST   /ai/models                    add a model ({ model }): offered, priced, a test request
 *   DELETE /ai/models/:model             take a model off the list (refused while in use)
 *   POST   /ai/models/:model/batch-retry a model whose batches failed: its next batch now
 *
 * Without the AI layer (ttsu.db unavailable) every answer is 503 ai_off.
 */
import express, { Router } from 'express';
import { ApiError, asyncHandler } from '../api/errors';
import type { AiCore } from './core';
import { isBuiltIn, PRICES_CHECKED } from './prices';
import { modeOf } from './runner';
import { isAiSecretName } from './secrets';
import { AiSettingsError } from './settings';
import { providerOf } from './providers';
import { priceOf } from './spend';
import { waitText } from './waits';

/** A model's failing batches for Settings > AI. */
function batchFailing(core: AiCore, model: string) {
  const w = core.batchFailingWait(model);
  if (!w || w.kind !== 'batch_failing') return null;
  return {
    failures: w.failures,
    paused: w.paused,
    reason: w.reason,
    nextAt: w.nextAt,
    fallback: w.fallback,
    text: waitText(w),
  };
}

/** What Settings > AI shows. */
export function aiStatus(core: AiCore) {
  const s = core.settings();
  const checks = core.modelChecks();
  const room = core.room();
  // The list in Settings > AI, in its order; a price the app knows, else one typed before.
  const models = s.models.map((model) => {
    const provider = providerOf(model);
    const c = checks[provider];
    return {
      model,
      provider,
      price: priceOf(s, model),
      builtIn: isBuiltIn(model),
      /** The features' tasks that use it (a model in use can't be deleted). */
      inUse: core.modelUses(model),
      mode: modeOf(s, model),
      offered: c ? (c.models ? c.models.includes(model) : null) : null,
      /** Most estimated prompt tokens in batches at the provider (0 = no cap). */
      batchQueueTokens: s.batchQueueTokens[model] ?? s.batchQueueTokensDefault,
      /** Batches the provider refused lately (null: none), with the page's words. */
      batchFailing: batchFailing(core, model),
    };
  });
  return {
    settings: s,
    keys: core.secrets.info(),
    checks: Object.fromEntries(
      Object.entries(checks).map(([p, c]) => [
        p,
        { checkedAt: c.checkedAt, error: c.error, models: c.models?.length ?? null },
      ]),
    ),
    models,
    pricesChecked: PRICES_CHECKED,
    spend: {
      spentUsd: room.spentUsd,
      reservedUsd: room.reservedUsd,
      limitUsd: room.limitUsd,
      month: room.month,
      resumesOn: room.resumesOn,
      timeZone: core.timeZone(),
    },
    months: core.spending(12),
    features: core.features(),
    waiting: core.waiting(),
    batchTests: core.batchTests(),
  };
}

export function createAiRouter(core: AiCore | null): Router {
  const router = express.Router();
  const ai = (): AiCore => {
    if (!core) throw new ApiError(503, 'ai_off', 'The AI settings are unavailable on the server');
    return core;
  };

  router.get('/ai/status', (_req, res) => {
    res.json(aiStatus(ai()));
  });

  router.put('/ai/settings', (req, res) => {
    const c = ai();
    const body = req.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError(400, 'bad_request', 'Send an object of settings');
    if ('prices' in body)
      throw new ApiError(
        400,
        'invalid_setting',
        "Prices are the providers' list prices, built into the app; they can't be set here",
      );
    if ('models' in body)
      throw new ApiError(400, 'invalid_setting', 'Add or delete models one at a time');
    try {
      c.updateSettings(body);
    } catch (err) {
      if (err instanceof AiSettingsError) throw new ApiError(400, 'invalid_setting', err.message);
      throw err;
    }
    res.json(aiStatus(c));
  });

  router.put('/ai/secrets/:name', (req, res) => {
    const c = ai();
    const name = req.params.name;
    if (!isAiSecretName(name)) throw new ApiError(404, 'not_found', 'No such key');
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== 'string' || value.trim() === '')
      throw new ApiError(400, 'bad_secret', 'Send the key as { value }');
    try {
      c.secrets.put(name, value);
    } catch (err) {
      throw new ApiError(400, 'bad_secret', (err as Error).message);
    }
    // Never echoes the value back.
    res.json(aiStatus(c));
  });

  router.delete('/ai/secrets/:name', (req, res) => {
    const c = ai();
    const name = req.params.name;
    if (!isAiSecretName(name)) throw new ApiError(404, 'not_found', 'No such key');
    c.secrets.remove(name);
    res.json(aiStatus(c));
  });

  router.post(
    '/ai/models/check',
    asyncHandler(async (_req, res) => {
      const c = ai();
      await c.checkModels();
      res.json(aiStatus(c));
    }),
  );

  router.post(
    '/ai/models/:model/batch-test',
    asyncHandler(async (req, res) => {
      const c = ai();
      const model = req.params.model;
      if (!priceOf(c.settings(), model))
        throw new ApiError(409, 'not_available', 'Only a model with a price can be tested');
      try {
        await c.testBatch(model);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(409, 'not_available', (err as Error).message);
      }
      res.json(aiStatus(c));
    }),
  );

  router.get(
    '/ai/models/available',
    asyncHandler(async (_req, res) => {
      res.json({ providers: await ai().availableModels() });
    }),
  );

  router.post(
    '/ai/models',
    asyncHandler(async (req, res) => {
      const c = ai();
      const model = (req.body as { model?: unknown } | undefined)?.model;
      if (typeof model !== 'string') throw new ApiError(400, 'bad_request', 'Send { model }');
      let test: { ms: number; costUsd: number };
      try {
        const r = await c.addModel(model);
        test = { ms: r.ms, costUsd: r.costUsd };
      } catch (err) {
        if (err instanceof AiSettingsError) throw new ApiError(409, 'not_added', err.message);
        throw err;
      }
      res.json({ ...aiStatus(c), test });
    }),
  );

  router.post('/ai/models/:model/batch-retry', (req, res) => {
    const c = ai();
    if (!c.tryBatchesNow(req.params.model))
      throw new ApiError(409, 'nothing_held', `${req.params.model} has no failing batches`);
    res.json(aiStatus(c));
  });

  router.delete('/ai/models/:model', (req, res) => {
    const c = ai();
    try {
      c.deleteModel(req.params.model);
    } catch (err) {
      if (err instanceof AiSettingsError) throw new ApiError(409, 'not_deleted', err.message);
      throw err;
    }
    res.json(aiStatus(c));
  });

  return router;
}
