/**
 * /api/v1/cleanup-link/* (WP21e-1): the audiobook linking sidecar only, with its own token
 * (`cli token link`, scope 'link' in cleanup.db). Mounted before requireUser, like the apply
 * sidecar's and the fetch container's routes.
 *
 * - heartbeat: the sidecar's state (uid, protected_hardlinks, its mounts) and whether there is
 *   work for it now;
 * - claim: the next batch (a preflight batch of planned torrent files to check, or a build batch
 *   of folders, links and metadata files: only while stage 6 holds the disk lock);
 * - batches/:id/report: the results of a batch (safe to send twice).
 */
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { sendError } from '../../api/errors';
import { authenticateApplyToken } from '../apply-tokens';
import type { CleanupService } from '../cleanup-service';
import type { AudioCleanupService } from './audio-cleanup-service';
import type { LinkOpResult } from './stage6-build';
import { BOOK_ARCHIVE_BATCH_BASE } from '../arrivals/archives';

export interface LinkRouteOptions {
  service: CleanupService | null;
  audio?: AudioCleanupService | null;
  error?: string;
}

function requireLinkToken(options: LinkRouteOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.service || !options.audio) {
      sendError(
        res,
        503,
        'cleanup_off',
        `The audiobook cleanup is off: ${options.error ?? 'not set up'}`,
      );
      return;
    }
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const auth = match
      ? authenticateApplyToken(options.service.db, match[1], Date.now(), 'link')
      : null;
    if (!auth) {
      sendError(res, 401, 'unauthorized', 'Missing, unknown or revoked link token');
      return;
    }
    next();
  };
}

const str = (v: unknown, max = 300) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const KINDS = new Set(['file', 'dir', 'link', 'other']);

/** WP21f-1: an archive listing from the sidecar, checked (at most 100,000 entries). */
function listing(r: Record<string, unknown>): {
  entries?: { name: string; kind: 'file' | 'dir' | 'link' | 'other'; size: number }[];
  encoding?: 'utf8' | 'cp932';
  listProblem?: string | null;
} {
  const out: ReturnType<typeof listing> = {};
  if (Array.isArray(r.entries) && r.entries.length <= 100_000) {
    out.entries = [];
    for (const e of r.entries as Record<string, unknown>[]) {
      if (
        typeof e !== 'object' ||
        e === null ||
        typeof e.name !== 'string' ||
        e.name.length > 4096 ||
        !KINDS.has(e.kind as string) ||
        typeof e.size !== 'number' ||
        !(e.size >= 0)
      )
        continue;
      out.entries.push({ name: e.name, kind: e.kind as 'file', size: e.size });
    }
  }
  if (r.encoding === 'utf8' || r.encoding === 'cp932') out.encoding = r.encoding;
  if ('listProblem' in r) out.listProblem = str(r.listProblem, 500);
  return out;
}

export function createCleanupLinkRouter(options: LinkRouteOptions): Router {
  const router = express.Router();
  router.use('/cleanup-link', requireLinkToken(options));
  const json = express.json({ limit: '4mb' });

  router.post('/cleanup-link/heartbeat', json, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sidecarId = str(b.sidecarId, 100);
    if (!sidecarId) {
      sendError(res, 400, 'bad_heartbeat', 'sidecarId is required');
      return;
    }
    try {
      const hb = {
        sidecarId,
        runId: str(b.runId, 100),
        version: str(b.version, 40),
        problem: str(b.problem, 500),
        info:
          typeof b.info === 'object' && b.info !== null && !Array.isArray(b.info)
            ? (b.info as Record<string, unknown>)
            : null,
      };
      let answer: Record<string, unknown>;
      try {
        answer = options.audio!.linkHeartbeat(hb) as Record<string, unknown>;
      } catch (err) {
        // WP20g: without the audiobook folders the Calibre import still uses the sidecar.
        if (!options.service) throw err;
        answer = options.service.arrivals.linkHeartbeat(hb);
      }
      // WP20g: the Calibre import's archives keep the sidecar polling quickly too.
      res.json(
        options.service?.arrivals.archivesActive()
          ? { ...answer, active: true, pollSeconds: 1 }
          : answer,
      );
    } catch (err) {
      sendError(res, 409, 'not_available', (err as Error).message);
    }
  });

  router.post('/cleanup-link/claim', json, (_req, res) => {
    // The audiobooks' batches first; then the Calibre import's archives (WP20g).
    res.json({
      batch: options.audio!.linkClaim() ?? options.service?.arrivals.archiveClaim() ?? null,
    });
  });

  router.post('/cleanup-link/batches/:id/report', json, (req, res) => {
    const id = Number(req.params.id);
    const results = (req.body as { results?: unknown } | undefined)?.results;
    if (!Number.isInteger(id) || !Array.isArray(results)) {
      sendError(res, 400, 'bad_report', 'A batch id and a results list are required');
      return;
    }
    const clean: LinkOpResult[] = [];
    for (const r of results as Record<string, unknown>[]) {
      if (
        typeof r !== 'object' ||
        r === null ||
        !Number.isInteger(r.id) ||
        typeof r.ok !== 'boolean'
      ) {
        sendError(res, 400, 'bad_report', 'Each result needs an id and ok');
        return;
      }
      clean.push({
        id: r.id as number,
        ok: r.ok,
        problem: str(r.problem, 300),
        error: str(r.error, 500),
        existed: r.existed === true,
        dev: typeof r.dev === 'number' ? r.dev : undefined,
        ino: typeof r.ino === 'number' ? r.ino : undefined,
        // WP21e-2: what the switch's operations report (bytes freed, the re-read SHA-256).
        freed: typeof r.freed === 'number' && r.freed >= 0 ? r.freed : undefined,
        sha256:
          typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : undefined,
        size: typeof r.size === 'number' && r.size >= 0 ? r.size : undefined,
        // WP21f-1: an archive's listing, an unpacked entry's bytes, ABS's rewrite of metadata.json.
        ...listing(r),
        bytes: typeof r.bytes === 'number' && r.bytes >= 0 ? r.bytes : undefined,
        absRewrote: r.absRewrote === true,
      });
    }
    try {
      if (id >= BOOK_ARCHIVE_BATCH_BASE && options.service) {
        res.json(
          options.service.arrivals.archiveReport(
            id,
            clean as unknown as Parameters<typeof options.service.arrivals.archiveReport>[1],
          ),
        );
        return;
      }
      res.json(options.audio!.linkReport(id, clean));
    } catch (err) {
      sendError(res, 404, 'no_batch', (err as Error).message);
    }
  });

  router.use('/cleanup-link', (_req, res) => {
    sendError(res, 404, 'not_found', 'No such route');
  });
  return router;
}
