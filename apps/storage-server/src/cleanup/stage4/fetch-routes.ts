/**
 * /api/v1/cleanup-fetch/* (WP20d): the fetch container only, with its own token (`cli token
 * fetch`, scope 'fetch' in cleanup.db). Mounted before requireUser, like the apply sidecar's.
 *
 * - heartbeat: who is fetching; only one fetcher is active at a time (a second one gets nothing
 *   while the first's heartbeat is fresh), so only one fetcher talks to a site.
 * - claim: one due request per site whose pace allows it (the server keeps the pace).
 * - answers/:id: the answer of a claimed request, as raw bytes (brotli), with its lease token,
 *   HTTP status, time and error in headers. A repeated report of the same lease is refused
 *   harmlessly (the first one counted).
 */
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { sendError } from '../../api/errors';
import { authenticateApplyToken } from '../apply-tokens';
import type { CleanupService } from '../cleanup-service';
import { getSettings } from '../settings';

export interface FetchRouteOptions {
  service: CleanupService | null;
  error?: string;
}

function requireFetchToken(options: FetchRouteOptions) {
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
    const auth = match
      ? authenticateApplyToken(options.service.db, match[1], Date.now(), 'fetch')
      : null;
    if (!auth) {
      sendError(res, 401, 'unauthorized', 'Missing, unknown or revoked fetch token');
      return;
    }
    next();
  };
}

const str = (v: unknown, max = 300) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

export function createCleanupFetchRouter(options: FetchRouteOptions): Router {
  const router = express.Router();
  router.use('/cleanup-fetch', requireFetchToken(options));
  const json = express.json({ limit: '64kb' });

  router.post('/cleanup-fetch/heartbeat', json, (req, res) => {
    const service = options.service!;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fetcherId = str(b.fetcherId, 100);
    if (!fetcherId) {
      sendError(res, 400, 'bad_heartbeat', 'fetcherId is required');
      return;
    }
    const active = service.fetchHeartbeat({
      fetcherId,
      version: str(b.version, 50),
      problem: str(b.problem),
      sudachi: str(b.sudachi, 100),
      runId: str(b.runId, 100),
    });
    const s = getSettings(service.db).fetch;
    res.json({
      active,
      pollSeconds: 30,
      requestTimeoutSeconds: s.requestTimeoutSeconds,
      maxPageBytes: Math.round(s.maxPageMb * 1024 * 1024),
    });
  });

  router.post('/cleanup-fetch/claim', json, (req, res) => {
    const service = options.service!;
    const fetcherId = str(((req.body ?? {}) as Record<string, unknown>).fetcherId, 100);
    // The usual fetcher is slot 0; parallel ones have their own (stage4/fetch-slots.ts).
    const slot = fetcherId ? service.fetcherSlot(fetcherId) : null;
    if (!slot) {
      res.json({
        requests: [],
        waitSeconds: 30,
        waitMs: 30_000,
        wait: 'Another fetcher is active (or no heartbeat yet)',
      });
      return;
    }
    res.json(service.fetchQueue.claim(Date.now(), slot.slot, slot.version));
  });

  const raw = express.raw({ type: () => true, limit: '80mb' });
  router.post('/cleanup-fetch/answers/:id', raw, (req, res) => {
    const service = options.service!;
    const id = Number(req.params.id);
    const lease = req.header('x-lease-token') ?? '';
    if (!Number.isInteger(id) || !lease) {
      sendError(res, 400, 'bad_answer', 'request id and x-lease-token are required');
      return;
    }
    const status = req.header('x-status');
    const ms = req.header('x-ms');
    const error = req.header('x-error');
    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? (req.body as Buffer) : null;
    const result = service.fetchQueue.report(id, lease, {
      status: status && /^\d{3}$/.test(status) ? Number(status) : null,
      ms: ms && /^\d+$/.test(ms) ? Number(ms) : null,
      error: error ? decodeURIComponent(error).slice(0, 300) : null,
      body,
      encoding: req.header('x-encoding') === 'br' ? 'br' : 'identity',
    });
    if (result.accepted) service.answerArrived();
    res.json(result);
  });

  router.use('/cleanup-fetch', (_req, res) => sendError(res, 404, 'not_found', 'No such route'));
  return router;
}
