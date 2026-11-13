/**
 * WP20a routes.
 *
 * - /api/v1/cleanup-apply/*: the apply sidecar only (its own token from cleanup.db,
 *   `cli token cleanup`). Mounted before requireUser. It gets the Calibre login, claims
 *   batches, downloads the batch's metadata.db snapshot and reports each step.
 * - /api/v1/cleanup/*: the /cleanup page (user tokens). Status, settings (secrets are
 *   write-only), stage modes, analysis, review, batches and Undo, spot check.
 */
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { createReadStream } from 'fs';
import { ApiError, asyncHandler, sendError } from '../api/errors';
import { authenticateApplyToken } from './apply-tokens';
import { BatchError, type ItemReport, type ItemState } from './batches';
import type { CleanupService } from './cleanup-service';
import { isSecretName } from './secrets';
import { getSettings, SettingsError, updateSettings } from './settings';
import { getStage, resumeStage, type StageMode } from './stages';

export interface CleanupOptions {
  service: CleanupService | null;
  /** Why the cleanup is off (cleanup.db can't open, no Calibre folder, ...). */
  error?: string;
}

function rethrow(err: unknown): never {
  if (err instanceof BatchError) throw new ApiError(err.status, err.code, err.message);
  if (err instanceof SettingsError) throw new ApiError(400, 'invalid_setting', err.message);
  throw err;
}

function serviceOr503(options: CleanupOptions): CleanupService {
  if (!options.service) {
    throw new ApiError(
      503,
      'cleanup_off',
      `The library cleanup is off: ${options.error ?? 'not set up'}`,
    );
  }
  return options.service;
}

function requireApplyToken(options: CleanupOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.service) {
      sendError(
        res,
        503,
        'cleanup_off',
        `The library cleanup is off: ${options.error ?? 'not set up'}`,
      );
      return;
    }
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const auth = match ? authenticateApplyToken(options.service.db, match[1]) : null;
    if (!auth) {
      sendError(res, 401, 'unauthorized', 'Missing, unknown or revoked cleanup token');
      return;
    }
    next();
  };
}

const STEPS: ItemState[] = [
  'verified',
  'exported',
  'tagged',
  'removed',
  'restored',
  'skipped',
  'failed',
];

function parseReport(body: unknown): ItemReport {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.step !== 'string' || !STEPS.includes(b.step as ItemState)) {
    throw new ApiError(400, 'bad_report', 'step must be one of ' + STEPS.join(', '));
  }
  const report: ItemReport = { step: b.step as ItemState };
  if (typeof b.detail === 'string') report.detail = b.detail;
  if (typeof b.quarantineDir === 'string') report.quarantineDir = b.quarantineDir.slice(0, 1000);
  if (typeof b.exportSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.exportSha256)) {
    report.exportSha256 = b.exportSha256;
  }
  if (b.method === 'trash' || b.method === 'readd') report.method = b.method;
  if (typeof b.calibreId === 'number' && Number.isInteger(b.calibreId))
    report.calibreId = b.calibreId;
  if (typeof b.uuid === 'string' && b.uuid.length <= 100) report.uuid = b.uuid;
  return report;
}

/** /api/v1/cleanup-apply/*: the sidecar's token only. Mounted before requireUser. */
export function createCleanupApplyRouter(options: CleanupOptions): Router {
  const router = express.Router();
  router.use('/cleanup-apply', requireApplyToken(options));

  router.post('/cleanup-apply/heartbeat', (req, res) => {
    const service = serviceOr503(options);
    service.heartbeat((req.body ?? {}) as Record<string, unknown>);
    const settings = getSettings(service.db);
    res.json({
      calibre: service.sidecarConfig(),
      itemDelaySeconds: settings.pacing.itemDelaySeconds,
      pollSeconds: 15,
    });
  });

  router.post(
    '/cleanup-apply/claim',
    asyncHandler(async (_req, res) => {
      const service = serviceOr503(options);
      if (!service.sidecarConfig()) {
        res.json({ batch: null, wait: 'The Calibre settings are not complete' });
        return;
      }
      res.json(await service.batches.claim());
    }),
  );

  router.get('/cleanup-apply/batches/:id/metadata-snapshot', (req, res) => {
    const service = serviceOr503(options);
    let file: string;
    try {
      file = service.batches.snapshotFileFor(req.params.id);
    } catch (err) {
      rethrow(err);
    }
    const stream = createReadStream(file);
    stream.once('error', () => {
      if (!res.headersSent)
        sendError(res, 404, 'not_found', 'The snapshot is not there; claim again');
      else res.destroy();
    });
    stream.once('open', () => {
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      stream.pipe(res);
    });
  });

  router.post('/cleanup-apply/batches/:id/snapshot-saved', (req, res) => {
    const service = serviceOr503(options);
    const sha = (req.body as { sha256?: unknown } | undefined)?.sha256;
    if (typeof sha !== 'string') throw new ApiError(400, 'bad_request', 'sha256 is required');
    try {
      service.batches.snapshotSaved(req.params.id, sha);
    } catch (err) {
      rethrow(err);
    }
    res.json({ ok: true });
  });

  router.post('/cleanup-apply/batches/:id/progress', (req, res) => {
    const service = serviceOr503(options);
    try {
      service.batches.progress(req.params.id);
    } catch (err) {
      rethrow(err);
    }
    res.json({ ok: true });
  });

  router.post('/cleanup-apply/batches/:id/items/:item', (req, res) => {
    const service = serviceOr503(options);
    const itemId = Number(req.params.item);
    if (!Number.isInteger(itemId)) throw new ApiError(404, 'not_found', 'No such item');
    try {
      res.json(service.batches.report(req.params.id, itemId, parseReport(req.body)));
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/cleanup-apply/batches/:id/finish', (req, res) => {
    const service = serviceOr503(options);
    const error = (req.body as { error?: unknown } | undefined)?.error;
    try {
      const batch = service.batches.finish(
        req.params.id,
        typeof error === 'string' ? error.slice(0, 2000) : null,
      );
      void service.tick();
      res.json({ batch });
    } catch (err) {
      rethrow(err);
    }
  });

  router.use('/cleanup-apply', (_req, res) => sendError(res, 404, 'not_found', 'No such route'));
  return router;
}

function parseStage(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new ApiError(404, 'not_found', 'No such stage');
  return n;
}

function batchView(service: CleanupService, id: string) {
  const batch = service.batches.get(id);
  if (!batch) throw new ApiError(404, 'not_found', 'No such batch');
  return { ...batch, counts: service.batches.itemCounts(id) };
}

function proposalView(r: Record<string, unknown>) {
  const { evidence_json, handoff_json, ...rest } = r as Record<string, unknown> & {
    evidence_json?: string;
    handoff_json?: string | null;
  };
  return {
    ...rest,
    evidence: evidence_json ? (JSON.parse(evidence_json) as unknown) : null,
    handoff: handoff_json ? (JSON.parse(handoff_json) as unknown) : null,
  };
}

/** /api/v1/cleanup/*: the /cleanup page. Behind requireUser. */
export function createCleanupRouter(options: CleanupOptions): Router {
  const router = express.Router();

  router.get('/cleanup/status', (_req, res) => {
    if (!options.service) {
      res.json({ available: false, error: options.error ?? 'not set up' });
      return;
    }
    res.json({ available: true, ...options.service.status() });
  });

  router.get('/cleanup/settings', (_req, res) => {
    const service = serviceOr503(options);
    res.json({ settings: getSettings(service.db), secrets: service.secrets.info() });
  });

  router.put('/cleanup/settings', (req, res) => {
    const service = serviceOr503(options);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'bad_request', 'Send an object of settings');
    }
    try {
      const settings = updateSettings(service.db, body);
      void service.tick();
      res.json({ settings, secrets: service.secrets.info() });
    } catch (err) {
      rethrow(err);
    }
  });

  router.put('/cleanup/secrets/:name', (req, res) => {
    const service = serviceOr503(options);
    const name = req.params.name;
    if (!isSecretName(name)) throw new ApiError(404, 'not_found', 'No such secret');
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ApiError(400, 'bad_request', 'value must be non-empty text');
    }
    try {
      service.secrets.put(name, value);
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
    // Never echoes the value back.
    res.json({ secrets: service.secrets.info() });
  });

  router.delete('/cleanup/secrets/:name', (req, res) => {
    const service = serviceOr503(options);
    const name = req.params.name;
    if (!isSecretName(name)) throw new ApiError(404, 'not_found', 'No such secret');
    service.secrets.remove(name);
    res.json({ secrets: service.secrets.info() });
  });

  router.put('/cleanup/stages/:stage', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(req.params.stage);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on') {
      throw new ApiError(400, 'bad_request', 'mode must be off, analyse or on');
    }
    try {
      service.setMode(stage, mode as StageMode);
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json({ stage: getStage(service.db, stage) });
  });

  router.post('/cleanup/stages/:stage/resume', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(req.params.stage);
    resumeStage(service.db, stage);
    void service.tick();
    res.json({ stage: getStage(service.db, stage) });
  });

  router.post('/cleanup/stages/1/analyse', (_req, res) => {
    const service = serviceOr503(options);
    try {
      res.json({ progress: service.reanalyse() });
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
  });

  // Proposed changes of a stage (what the analysis found), paged.
  router.get('/cleanup/proposals', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(String(req.query.stage ?? '1'));
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = ['stage = ?'];
    const params: unknown[] = [stage];
    if (state) {
      where.push('state = ?');
      params.push(state);
    }
    const rows = service.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, field, class, review_reason, state, batch_id,
                evidence_json, created_at, updated_at
         FROM proposed_changes WHERE ${where.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    const total = (
      service.db
        .prepare(`SELECT COUNT(*) AS n FROM proposed_changes WHERE ${where.join(' AND ')}`)
        .get(...params) as { n: number }
    ).n;
    res.json({ total, items: rows.map(proposalView) });
  });

  // Review queue: proposals of class review that wait for a decision (stage 1 has none).
  router.get('/cleanup/review', (req, res) => {
    const service = serviceOr503(options);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = service.db
      .prepare(
        `SELECT id, stage, calibre_id, calibre_uuid, field, review_reason, evidence_json, old_json, new_json
         FROM proposed_changes WHERE class = 'review' AND state = 'proposed'
         ORDER BY stage, review_reason, id LIMIT 50 OFFSET ?`,
      )
      .all(offset) as Record<string, unknown>[];
    const total = (
      service.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes WHERE class = 'review' AND state = 'proposed'`,
        )
        .get() as { n: number }
    ).n;
    res.json({ total, items: rows.map(proposalView) });
  });

  router.post('/cleanup/review/:id', (req, res) => {
    const service = serviceOr503(options);
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== 'apply' && decision !== 'keep') {
      throw new ApiError(400, 'bad_request', 'decision must be apply or keep');
    }
    const now = Date.now();
    const changed = service.db
      .prepare(
        `UPDATE proposed_changes SET class = CASE WHEN ? = 'apply' THEN 'auto' ELSE class END,
           state = CASE WHEN ? = 'keep' THEN 'kept' ELSE state END,
           decided_by = 'user', decided_at = ?, updated_at = ?
         WHERE id = ? AND class = 'review' AND state = 'proposed'`,
      )
      .run(decision, decision, now, now, Number(req.params.id)).changes;
    if (changed !== 1) throw new ApiError(404, 'not_found', 'No such review item');
    void service.tick();
    res.json({ ok: true });
  });

  router.get('/cleanup/batches', (_req, res) => {
    const service = serviceOr503(options);
    res.json({
      batches: service.batches
        .list(100)
        .map((b) => ({ ...b, counts: service.batches.itemCounts(b.id) })),
    });
  });

  router.get('/cleanup/batches/:id', (req, res) => {
    const service = serviceOr503(options);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      batch: batchView(service, req.params.id),
      items: service.batches.items(req.params.id, offset, 200).map(proposalView),
    });
  });

  router.post('/cleanup/batches/:id/undo', (req, res) => {
    const service = serviceOr503(options);
    try {
      const batch = service.batches.undo(req.params.id);
      void service.tick();
      res.json({ batch: batchView(service, batch.id) });
    } catch (err) {
      rethrow(err);
    }
  });

  // Optional spot check: 30 random applied changes of a stage.
  router.get('/cleanup/spot-check', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(String(req.query.stage ?? '1'));
    const rows = service.db
      .prepare(
        `SELECT c.id, c.calibre_id, c.calibre_uuid, c.state, c.batch_id, c.evidence_json,
                u.handoff_json, u.quarantine_dir
         FROM proposed_changes c LEFT JOIN undo_records u ON u.change_id = c.id
         WHERE c.stage = ? AND c.state = 'applied' ORDER BY RANDOM() LIMIT 30`,
      )
      .all(stage) as Record<string, unknown>[];
    res.json({ items: rows.map(proposalView) });
  });

  router.use('/cleanup', (_req, res) => sendError(res, 404, 'not_found', 'No such route'));
  return router;
}
