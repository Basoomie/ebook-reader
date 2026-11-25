/**
 * WP20a routes.
 *
 * - /api/v1/cleanup-apply/*: the apply sidecar only (its own token from cleanup.db,
 *   `cli token cleanup`). Mounted before requireUser. It gets the Calibre login, claims
 *   batches, downloads the batch's metadata.db snapshot and reports each step.
 * - /api/v1/cleanup/*: the /cleanup page (user tokens). Status, settings (secrets are
 *   write-only), stage modes, analysis, review, batches and Undo, spot check.
 *
 * Stage 2 (WP20b) adds per-book sidecar routes: verify (what to write), written (what Calibre
 * shows after the write), the EPUB's cover to write and Calibre's old cover to keep.
 */
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { createReadStream } from 'fs';
import { ApiError, asyncHandler, sendError } from '../api/errors';
import { authenticateApplyToken } from './apply-tokens';
import { BatchError, type ItemReport, type ItemState } from './batches';
import { MOVE_STAGE } from './field-stages';
import type { ListedBook, WrittenReport } from './stage2-batches';
import { STAGE2_FIELDS } from './stage2-rules';
import type { CleanupService } from './cleanup-service';
import {
  AudioBusyError,
  type AudioCleanupService,
  type DupDecision,
} from './audio/audio-cleanup-service';
import { isSecretName } from './secrets';
import { ArrivalBatchError } from './arrivals/add-batches';
import { streamSource } from './arrivals/sources-fs';
import { arrivalsList, arrivalsStatus, notImportedCsv } from './arrivals/views';
import { ImportError, importQuarantineCover, quarantineCovers } from './edits/cover-import';
import { MAX_COVER_BYTES } from './edits/edits';
import { getSettings, SettingsError, updateSettings } from './settings';
import {
  CURRENT_PROPOSALS_SQL,
  currentAnalysisId,
  getStage,
  resumeStage,
  type StageMode,
} from './stages';

export interface CleanupOptions {
  service: CleanupService | null;
  /** The audiobook cleanup (WP21a); null when the cleanup itself is off. */
  audio?: AudioCleanupService | null;
  /** Why the cleanup is off (cleanup.db can't open, no Calibre folder, ...). */
  error?: string;
}

function rethrow(err: unknown): never {
  if (err instanceof BatchError) throw new ApiError(err.status, err.code, err.message);
  if (err instanceof ArrivalBatchError) throw new ApiError(err.status, err.code, err.message);
  if (err instanceof SettingsError) throw new ApiError(400, 'invalid_setting', err.message);
  throw err;
}

/**
 * Manga part B: the Calibre library a request is about (?library=<reader library id>, or the
 * body's library), else the primary library. A library the cleanup doesn't work on is refused.
 */
function libOf(service: CleanupService, req: Request): string | null {
  const q = (req.query as Record<string, unknown>).library;
  const b = (req.body as { library?: unknown } | undefined)?.library;
  try {
    return service.libraryOr(typeof q === 'string' && q ? q : b);
  } catch (err) {
    throw new ApiError(400, 'bad_library', (err as Error).message);
  }
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
  // A move's added copy: the fields the sidecar compared (kept for Undo), those it wrote again.
  if (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) {
    const json = JSON.stringify(b.fields);
    if (json.length <= 200_000) report.fields = b.fields as Record<string, unknown>;
  }
  if (Array.isArray(b.fixed) && b.fixed.every((f) => typeof f === 'string'))
    report.fixed = (b.fixed as string[]).slice(0, 50).map((f) => f.slice(0, 50));
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
      // 1.6.0: the library the move puts books in (the sidecar checks its columns), or null.
      moveTarget: service.moveTargetForSidecar(),
      // 1.7.0 (manga part B): every library the cleanup works on (their #illustrator is checked).
      cleanupLibraries: service
        .cleanupLibraries()
        .map((lib) => service.calibreLibraryOf(lib))
        .filter((id): id is string => !!id),
    });
  });

  router.post(
    '/cleanup-apply/claim',
    asyncHandler(async (_req, res) => {
      const service = serviceOr503(options);
      const login = service.sidecarConfig();
      if (!login?.libraryId) {
        res.json({
          batch: null,
          wait: login
            ? 'The library on the content server is not known yet'
            : 'The Calibre settings are not complete',
        });
        return;
      }
      res.json(await service.batches.claim());
    }),
  );

  // 1.5.0: the user's edits from the reader, asked for between the chunks of a running batch.
  router.post(
    '/cleanup-apply/edits/claim',
    asyncHandler(async (_req, res) => {
      const service = serviceOr503(options);
      if (!service.sidecarConfig()?.libraryId) {
        res.json({ batch: null, wait: null });
        return;
      }
      res.json(await service.batches.claim(Date.now(), { editsOnly: true }));
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

  // Manga part A: the server's half of the check after a move's add (the stored EPUB, the
  // cover and the title sort, read from the read-only library mounts).
  router.post(
    '/cleanup-apply/batches/:id/items/:item/move-check',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const itemId = Number(req.params.item);
      const b = (req.body ?? {}) as { calibreId?: unknown; uuid?: unknown };
      if (
        !Number.isInteger(itemId) ||
        typeof b.calibreId !== 'number' ||
        typeof b.uuid !== 'string'
      )
        throw new ApiError(400, 'bad_request', 'calibreId and uuid are required');
      try {
        res.json(
          await service.batches.moves.checkArrived(req.params.id, itemId, {
            calibreId: b.calibreId,
            uuid: b.uuid.slice(0, 100),
          }),
        );
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  const bookParams = (req: Request): { batchId: string; calibreId: number } => {
    const calibreId = Number(req.params.book);
    if (!Number.isInteger(calibreId)) throw new ApiError(404, 'not_found', 'No such book');
    return { batchId: req.params.id, calibreId };
  };
  const listed = (v: unknown): ListedBook | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as ListedBook) : null;
  // A file the sidecar kept in its quarantine (an absolute path; the sidecar itself only
  // ever writes a cover back from inside its quarantine folder).
  const quarantinePath = (v: unknown): string | null =>
    typeof v === 'string' &&
    v.length < 1000 &&
    /^(\/|[A-Za-z]:[\\/])/.test(v) &&
    !v.split(/[\\/]/).includes('..')
      ? v
      : null;

  // Stage 2: what Calibre shows now → what to write for this book.
  // Book covers: Calibre's current picture is kept in the server's cover archive before any
  // cover write is answered (a cover is not written when it can't be kept).
  router.post(
    '/cleanup-apply/batches/:id/books/:book/verify',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { batchId, calibreId } = bookParams(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const writer = service.batches.writerOf(batchId);
        const current = listed(body.current);
        const kept = await writer.keepCurrentCover(batchId, calibreId, current);
        res.json(
          writer.verify(
            batchId,
            calibreId,
            current,
            quarantinePath(body.oldCoverPath),
            Date.now(),
            kept,
          ),
        );
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  // Stage 2: what Calibre shows after the write.
  router.post('/cleanup-apply/batches/:id/books/:book/written', (req, res) => {
    const service = serviceOr503(options);
    const { batchId, calibreId } = bookParams(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const report: WrittenReport = {
      current: listed(b.current),
      error: typeof b.error === 'string' ? b.error.slice(0, 2000) : null,
      final: b.final === true,
      oldCoverPath: quarantinePath(b.oldCoverPath),
      coverSkipped: typeof b.coverSkipped === 'string' ? b.coverSkipped.slice(0, 500) : null,
    };
    try {
      res.json(service.batches.writerOf(batchId).writtenReport(batchId, calibreId, report));
    } catch (err) {
      rethrow(err);
    }
  });

  // Stage 2: the EPUB's own cover, ready for calibredb (D1). Read-only; no file is written.
  router.get(
    '/cleanup-apply/batches/:id/books/:book/cover',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { batchId, calibreId } = bookParams(req);
      try {
        const cover = await service.batches.writerOf(batchId).coverFor(batchId, calibreId);
        res.setHeader('Content-Type', cover.ext === 'png' ? 'image/png' : 'image/jpeg');
        res.setHeader('X-Cover-Ext', cover.ext);
        res.setHeader('X-Cover-Sha256', cover.sha256);
        res.end(cover.bytes);
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  // Stage 2: Calibre's cover.jpg before it is replaced (kept in the quarantine for Undo).
  router.get(
    '/cleanup-apply/batches/:id/books/:book/old-cover',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { batchId, calibreId } = bookParams(req);
      try {
        const bytes = await service.batches.writerOf(batchId).oldCover(batchId, calibreId);
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(bytes);
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  // Book covers: the one-time import of the quarantine's earlier covers into the server's cover
  // archive (the sidecar's `node /app/dist/import-covers.js`; edits/cover-import.ts).
  router.get('/cleanup-apply/cover-archive/quarantine', (_req, res) => {
    const service = serviceOr503(options);
    res.json({ covers: quarantineCovers(service.db) });
  });

  router.post(
    '/cleanup-apply/cover-archive/quarantine/:changeId',
    express.raw({ type: () => true, limit: MAX_COVER_BYTES }),
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const changeId = Number(req.params.changeId);
      if (!Number.isInteger(changeId) || changeId <= 0)
        throw new ApiError(400, 'bad_request', 'A change id is needed');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sha = req.header('x-sha256') ?? null;
      try {
        res.json(
          await importQuarantineCover(service.db, service.coverArchive, changeId, bytes, sha),
        );
      } catch (err) {
        if (err instanceof ImportError) throw new ApiError(err.status, err.code, err.message);
        throw err;
      }
    }),
  );

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

  // WP20g: the import's add batches (the sidecar's arrivals.ts).
  router.post('/cleanup-apply/arrivals/claim', (_req, res) => {
    const service = serviceOr503(options);
    const login = service.sidecarConfig();
    // A cleanup batch goes first; an add batch never runs beside one.
    if (!login?.libraryId || service.batches.open()) {
      res.json({ batch: null });
      return;
    }
    res.json({
      batch: service.arrivals.addBatches.claim(
        Date.now(),
        (lib) => service.calibreLibraryOf(lib),
        login.libraryId,
      ),
    });
  });

  router.post('/cleanup-apply/arrivals/items/:id', (req, res) => {
    const service = serviceOr503(options);
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(
        service.arrivals.addBatches.report(id, {
          step: typeof b.step === 'string' ? b.step : '',
          calibreId: typeof b.calibreId === 'number' ? b.calibreId : undefined,
          uuid: typeof b.uuid === 'string' ? b.uuid.slice(0, 100) : undefined,
          quarantineDir:
            typeof b.quarantineDir === 'string' ? b.quarantineDir.slice(0, 1000) : undefined,
          detail: typeof b.detail === 'string' ? b.detail.slice(0, 1000) : undefined,
        }),
      );
      void service.tick();
    } catch (err) {
      rethrow(err);
    }
  });

  // The file to add, read only from the sources mount; the sidecar checks its SHA-256.
  router.get('/cleanup-apply/arrivals/items/:id/file', (req, res) => {
    const service = serviceOr503(options);
    try {
      const f = service.arrivals.fileForItem(Number(req.params.id));
      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader('Content-Length', String(f.size));
      res.setHeader('X-File-Sha256', f.sha256);
      const stream = streamSource(f.path);
      stream.on('error', (err) => res.destroy(err));
      stream.pipe(res);
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/cleanup-apply/arrivals/batches/:id/finish', (req, res) => {
    const service = serviceOr503(options);
    const error = (req.body as { error?: unknown } | undefined)?.error;
    try {
      service.arrivals.addBatches.finish(
        Number(req.params.id),
        typeof error === 'string' ? error.slice(0, 2000) : null,
      );
      void service.tick();
      res.json({ ok: true });
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
  const { evidence_json, handoff_json, old_json, new_json, ...rest } = r as Record<
    string,
    unknown
  > & {
    evidence_json?: string;
    handoff_json?: string | null;
    old_json?: string | null;
    new_json?: string | null;
  };
  return {
    ...rest,
    evidence: evidence_json ? (JSON.parse(evidence_json) as unknown) : null,
    handoff: handoff_json ? (JSON.parse(handoff_json) as unknown) : null,
    ...(old_json !== undefined ? { old: old_json ? (JSON.parse(old_json) as unknown) : null } : {}),
    ...(new_json !== undefined ? { new: new_json ? (JSON.parse(new_json) as unknown) : null } : {}),
  };
}

function audioOr503(options: CleanupOptions): AudioCleanupService {
  if (!options.audio) {
    throw new ApiError(
      503,
      'cleanup_off',
      `The audiobook cleanup is off: ${options.error ?? 'not set up'}`,
    );
  }
  return options.audio;
}

function page(req: Request): { offset: number; limit: number } {
  return {
    offset: Math.max(0, Number(req.query.offset) || 0),
    limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)),
  };
}

/**
 * /api/v1/cleanup/audio/*: the audiobook cleanup (WP21a). Analysis only; Audiobookshelf is
 * only read.
 */
function addAudioRoutes(router: Router, options: CleanupOptions): void {
  router.get('/cleanup/audio/status', (_req, res) => {
    if (!options.audio) {
      res.json({ available: false, error: options.error ?? 'not set up' });
      return;
    }
    res.json({ available: true, ...options.audio.status() });
  });

  router.put(
    '/cleanup/audio/stages/:stage',
    asyncHandler(async (req, res) => {
      const audio = audioOr503(options);
      const stage = Number(req.params.stage);
      const mode = (req.body as { mode?: unknown } | undefined)?.mode;
      if (mode !== 'off' && mode !== 'analyse' && mode !== 'on') {
        throw new ApiError(400, 'bad_request', 'mode must be off, analyse or on');
      }
      try {
        await audio.setMode(stage, mode);
      } catch (err) {
        throw new ApiError(409, 'not_available', (err as Error).message);
      }
      res.json(audio.status());
    }),
  );

  router.post('/cleanup/audio/stages/:stage/analyse', (req, res) => {
    const audio = audioOr503(options);
    try {
      audio.reanalyse(Number(req.params.stage));
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json(audio.status());
  });

  router.post('/cleanup/audio/abs-snapshots', (_req, res) => {
    const audio = audioOr503(options);
    try {
      void audio.takeSnapshot();
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.status(202).json(audio.status());
  });

  router.get('/cleanup/audio/abs-snapshots/:id', (req, res) => {
    const audio = audioOr503(options);
    const m = /^(\d+)(?:\.(json|csv))?$/.exec(req.params.id);
    if (!m) throw new ApiError(404, 'not_found', 'No such snapshot');
    const id = Number(m[1]);
    const format = m[2] ?? 'json';
    if (format === 'csv') {
      const csv = audio.snapshotCsv(id);
      if (csv === null) throw new ApiError(404, 'not_found', 'No such snapshot');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audiobookshelf-progress-${id}.csv"`,
      );
      res.send(csv);
      return;
    }
    const data = audio.snapshot(id);
    if (!data) throw new ApiError(404, 'not_found', 'No such snapshot');
    if (m[2] === 'json') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audiobookshelf-snapshot-${id}.json"`,
      );
    }
    res.json(data);
  });

  router.get('/cleanup/audio/files', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.files(String(req.query.list ?? ''), page(req)));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  router.get('/cleanup/audio/books', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.books(String(req.query.list ?? ''), page(req)));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  // Stage 3 (WP21b): duplicate groups and review items, the user's choices, short clips.
  router.get('/cleanup/audio/dups', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.dups(String(req.query.list ?? ''), page(req)));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  router.post('/cleanup/audio/dups/:id', (req, res) => {
    const audio = audioOr503(options);
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (typeof decision !== 'string') {
      throw new ApiError(400, 'bad_request', 'decision must be keep_all, keep:<copy> or clear');
    }
    try {
      audio.decideDup(Number(req.params.id), decision as DupDecision);
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
    res.json({ ok: true });
  });

  router.get('/cleanup/audio/clip/:copyId/:at', (req, res, next) => {
    const audio = audioOr503(options);
    const at = req.params.at;
    const copyId = Number(req.params.copyId);
    if ((at !== 'start' && at !== 'end') || !Number.isInteger(copyId)) {
      throw new ApiError(400, 'bad_request', 'Ask for /clip/<copy id>/start or /end');
    }
    audio
      .clip(copyId, at)
      .then((buf) => {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'private, max-age=600');
        res.send(buf);
      })
      .catch((err: Error) => {
        if (err instanceof AudioBusyError) {
          res.setHeader('Retry-After', '15');
          next(new ApiError(503, 'calibre_busy', err.message));
        } else next(new ApiError(404, 'not_found', err.message));
      });
  });

  // Stage 4 (WP21c): the online lookups' lists and "Ask again" for a site. A paused site is
  // resumed through the Calibre cleanup's existing route (the queue is shared).
  router.get('/cleanup/audio/online', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.online(String(req.query.list ?? ''), page(req)));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  router.post('/cleanup/audio/online/sites/:site/retry', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.retryOnlineSite(req.params.site));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  // Stage 5 (WP21d): the metadata lists (read only: no editing in WP21d).
  router.get('/cleanup/audio/meta', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.meta(String(req.query.list ?? ''), page(req)));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  // Stage 6 (WP21e-1): the build's lists, the move list and the plan as CSV, "Check again".
  router.get('/cleanup/audio/build', (req, res) => {
    const audio = audioOr503(options);
    res.json(audio.build(String(req.query.list ?? ''), page(req)));
  });

  router.get('/cleanup/audio/build/:file', (req, res) => {
    const audio = audioOr503(options);
    const file = req.params.file;
    if (file !== 'moves.csv' && file !== 'plan.csv')
      throw new ApiError(404, 'not_found', 'No such file');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file === 'moves.csv' ? 'audiobooks-move-list.csv' : 'audiobooks-build-plan.csv'}"`,
    );
    res.send(audio.buildCsv(file === 'moves.csv' ? 'moves' : 'plan'));
  });

  router.post('/cleanup/audio/build/check-again', (_req, res) => {
    const audio = audioOr503(options);
    try {
      audio.buildCheckAgain();
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json(audio.status());
  });

  // Stage 7 (WP21f-1): the new arrivals' lists, review choices, Resume and the plan as CSV.
  // Run now is POST /cleanup/audio/stages/7/analyse.
  router.get('/cleanup/audio/arrivals', (req, res) => {
    const audio = audioOr503(options);
    res.json(audio.arrivals(String(req.query.list ?? 'new'), page(req)));
  });

  router.get('/cleanup/audio/arrivals/plan.csv', (_req, res) => {
    const audio = audioOr503(options);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audiobooks-new-arrivals-plan.csv"');
    res.send(audio.arrivalsCsv());
  });

  router.post('/cleanup/audio/arrivals/reviews/:id', (req, res) => {
    const audio = audioOr503(options);
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (typeof decision !== 'string') throw new ApiError(400, 'bad_request', 'decision is missing');
    try {
      audio.arrivalsDecide(Number(req.params.id), decision);
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
    res.json({ ok: true });
  });

  // WP21f-2: a review choice for a book of the library changes: a field 'mine' | 'ours' (your
  // ABS edit or the cleanup's value), or 'rename' 'now' (rename its links although someone is
  // listening: the place moves). Applied at the next run.
  router.post('/cleanup/audio/library-changes/:bookId/choice', (req, res) => {
    const audio = audioOr503(options);
    const body = (req.body ?? {}) as { field?: unknown; choice?: unknown };
    if (typeof body.field !== 'string' || typeof body.choice !== 'string')
      throw new ApiError(400, 'bad_request', 'field and choice are needed');
    try {
      audio.libraryChoice(Number(req.params.bookId), body.field, body.choice);
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
    res.json({ ok: true });
  });

  // Stage 8 (WP21g): the pairs with the Calibre ebooks (lists, CSV) and your review choices:
  // field 'pair' (a Calibre id, or null for "no ebook") or 'series' ('calibre' | 'none').
  router.get('/cleanup/audio/ebooks', (req, res) => {
    const audio = audioOr503(options);
    try {
      res.json(audio.ebooks(String(req.query.list ?? 'auto'), page(req)));
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  router.get('/cleanup/audio/ebooks/pairs.csv', (_req, res) => {
    const audio = audioOr503(options);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audiobooks-ebook-pairs.csv"');
    res.send(audio.ebooksCsv());
  });

  router.post('/cleanup/audio/ebooks/choice', (req, res) => {
    const audio = audioOr503(options);
    const body = (req.body ?? {}) as { unit?: unknown; field?: unknown; value?: unknown };
    if (typeof body.unit !== 'string' || typeof body.field !== 'string' || !('value' in body))
      throw new ApiError(400, 'bad_request', 'unit, field and value are needed');
    try {
      audio.ebookChoice(body.unit, body.field, body.value);
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
    res.json({ ok: true });
  });

  router.post('/cleanup/audio/arrivals/resume', (_req, res) => {
    const audio = audioOr503(options);
    try {
      audio.arrivalsResume();
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json(audio.status());
  });

  // The switch (WP21e-2): Switch, Undo, Delete japanese-old (each asked first on the page),
  // Continue after a pause, Cancel before anything is renamed or deleted, the link report.
  router.post(
    '/cleanup/audio/switch/start',
    asyncHandler(async (req, res) => {
      const audio = audioOr503(options);
      const action = (req.body as { action?: unknown } | undefined)?.action;
      if (action !== 'switch' && action !== 'undo' && action !== 'delete')
        throw new ApiError(400, 'invalid_body', 'action must be switch, undo or delete');
      try {
        await audio.switchStart(action);
      } catch (err) {
        throw new ApiError(409, 'not_available', (err as Error).message);
      }
      res.json(audio.status());
    }),
  );

  router.post('/cleanup/audio/switch/resume', (_req, res) => {
    const audio = audioOr503(options);
    try {
      audio.switchResume();
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json(audio.status());
  });

  router.post(
    '/cleanup/audio/switch/cancel',
    asyncHandler(async (_req, res) => {
      const audio = audioOr503(options);
      try {
        await audio.switchCancel();
      } catch (err) {
        throw new ApiError(409, 'not_available', (err as Error).message);
      }
      res.json(audio.status());
    }),
  );

  router.get('/cleanup/audio/switch/links', (req, res) => {
    const audio = audioOr503(options);
    const changed = req.query.changed === '1';
    res.json(
      audio.switcher?.links({ ...page(req), changedOnly: changed }) ?? { total: 0, items: [] },
    );
  });

  // Covers (WP21e-2 stop 3): set through Audiobookshelf's API, only when asked from the page.
  router.post('/cleanup/audio/switch/covers', (req, res) => {
    const audio = audioOr503(options);
    const what = (req.body as { action?: unknown } | undefined)?.action;
    try {
      if (what === 'start') audio.coversStart();
      else if (what === 'resume') audio.coversResume();
      else throw new ApiError(400, 'invalid_body', 'action must be start or resume');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json(audio.status());
  });

  router.get('/cleanup/audio/switch/covers', (req, res) => {
    const audio = audioOr503(options);
    res.json(audio.covers?.list(page(req)) ?? { total: 0, items: [] });
  });

  router.get('/cleanup/audio/switch/links.csv', (_req, res) => {
    const audio = audioOr503(options);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audiobooks-switch-links.csv"');
    res.send(audio.switcher?.linksCsv() ?? '');
  });

  // The cleanup's AI choices (WP21d): the model per task, the steps, this month's spending. The
  // keys, provider settings, Check models and Test batch are Settings > AI (/ai/*, src/ai/).
  router.get('/cleanup/ai/status', (_req, res) => {
    res.json(audioOr503(options).aiStatus());
  });
}

/** /api/v1/cleanup/*: the /cleanup page. Behind requireUser. */
export function createCleanupRouter(options: CleanupOptions): Router {
  const router = express.Router();
  addAudioRoutes(router, options);

  // Manga part B: the libraries the cleanup works on, one line each (the page's picker or
  // columns); light (each library's stage rows and its cached book count).
  router.get('/cleanup/libraries', (_req, res) => {
    const service = serviceOr503(options);
    res.json({
      libraries: service.cleanupLibraries().map((id) => service.librarySummary(id)),
    });
  });

  router.get('/cleanup/status', (req, res) => {
    if (!options.service) {
      res.json({ available: false, error: options.error ?? 'not set up' });
      return;
    }
    res.json({ available: true, ...options.service.status(libOf(options.service, req)) });
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

  router.put(
    '/cleanup/secrets/:name',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const name = req.params.name;
      if (!isSecretName(name)) throw new ApiError(404, 'not_found', 'No such secret');
      const value = (req.body as { value?: unknown } | undefined)?.value;
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ApiError(400, 'bad_request', 'value must be non-empty text');
      }
      // Audiobookshelf's key is asked about first: a value it refuses never replaces a working key.
      if (name === 'absApiKey' && options.audio) {
        const refusal = await options.audio.absKeyRefusal(value);
        if (refusal) throw new ApiError(400, 'abs_key_refused', refusal);
      }
      try {
        service.secrets.put(name, value);
      } catch (err) {
        throw new ApiError(400, 'bad_request', (err as Error).message);
      }
      // Never echoes the value back.
      res.json({ secrets: service.secrets.info() });
    }),
  );

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
      service.setMode(libOf(service, req), stage, mode as StageMode);
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json({ stage: getStage(service.db, libOf(service, req) ?? '', stage) });
  });

  router.post('/cleanup/stages/:stage/resume', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(req.params.stage);
    resumeStage(service.db, libOf(service, req) ?? '', stage);
    void service.tick();
    res.json({ stage: getStage(service.db, libOf(service, req) ?? '', stage) });
  });

  router.post('/cleanup/stages/:stage/analyse', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(req.params.stage);
    try {
      res.json({ progress: service.reanalyse(libOf(service, req), stage) });
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
  });

  // Stage 2: resume one paused field (a gate pause lifts only with a new analysis that passes).
  router.post('/cleanup/stages/:stage/fields/:field/resume', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(req.params.stage);
    if (!(STAGE2_FIELDS as readonly string[]).includes(req.params.field)) {
      throw new ApiError(404, 'not_found', 'No such field');
    }
    try {
      service.resumeField(libOf(service, req), stage, req.params.field);
    } catch (err) {
      throw new ApiError(409, 'not_available', (err as Error).message);
    }
    res.json({ ok: true });
  });

  // Proposed changes of a stage (what the analysis found), paged.
  router.get('/cleanup/proposals', (req, res) => {
    const service = serviceOr503(options);
    const stage = parseStage(String(req.query.stage ?? '1'));
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    // Only what counts now: the current analysis's copies plus every queued, removed, brought
    // back or kept copy (older analyses' leftovers stay in their batches' history).
    // Manga part B: the proposals of the library asked about.
    const lib = libOf(service, req) ?? '';
    const where = [
      'stage = ?',
      'library_id = ?',
      `(${CURRENT_PROPOSALS_SQL} OR decided_by IS NOT NULL)`,
    ];
    const params: unknown[] = [stage, lib, currentAnalysisId(service.db, lib, stage)];
    if (state) {
      where.push('state = ?');
      params.push(state);
    }
    for (const key of ['field', 'class', 'source'] as const) {
      const v = req.query[key];
      if (typeof v === 'string' && v !== '') {
        where.push(`${key} = ?`);
        params.push(v);
      }
    }
    const rows = service.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, field, class, review_reason, state, batch_id, source,
                old_json, new_json, evidence_json, created_at, updated_at
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
    const lib = libOf(service, req) ?? '';
    const rows = service.db
      .prepare(
        `SELECT id, stage, calibre_id, calibre_uuid, field, class, state, review_reason, source, evidence_json,
                old_json, new_json
         FROM proposed_changes INDEXED BY proposed_changes_stage
         WHERE class = 'review' AND state = 'proposed' AND decided_by IS NULL AND library_id = ?
         ORDER BY stage, review_reason, id LIMIT 50 OFFSET ?`,
      )
      .all(lib, offset) as Record<string, unknown>[];
    const total = (
      service.db
        .prepare(
          // Manga part B: named, or SQLite walks the library's every proposal (3 s on the live
          // copy; this covering index: about 80 ms, as before the library was named).
          `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
           WHERE class = 'review' AND state = 'proposed' AND decided_by IS NULL AND library_id = ?`,
        )
        .get(lib) as { n: number }
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

  // Stage 3 (content duplicates): pairs by list, your decision on a pair, books, the gate.
  router.get('/cleanup/stage3/pairs', (req, res) => {
    const service = serviceOr503(options);
    const view = typeof req.query.view === 'string' ? req.query.view : 'review';
    try {
      res.json(
        service.stage3Pairs(libOf(service, req), view, {
          cls: typeof req.query.class === 'string' ? req.query.class : undefined,
          offset: Math.max(0, Number(req.query.offset) || 0),
          limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)),
        }),
      );
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  router.post('/cleanup/stage3/pairs/:id', (req, res) => {
    const service = serviceOr503(options);
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (
      decision !== 'keep_both' &&
      decision !== 'remove_a' &&
      decision !== 'remove_b' &&
      decision !== 'clear'
    ) {
      throw new ApiError(
        400,
        'bad_request',
        'decision must be keep_both, remove_a, remove_b or clear',
      );
    }
    try {
      service.decidePair(libOf(service, req), Number(req.params.id), decision);
    } catch (err) {
      throw new ApiError(404, 'not_found', (err as Error).message);
    }
    res.json({ ok: true });
  });

  router.get('/cleanup/stage3/books', (req, res) => {
    const service = serviceOr503(options);
    try {
      res.json(
        service.stage3Books(
          libOf(service, req),
          typeof req.query.view === 'string' ? req.query.view : 'omnibus',
          {
            offset: Math.max(0, Number(req.query.offset) || 0),
            limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)),
          },
        ),
      );
    } catch (err) {
      throw new ApiError(400, 'bad_request', (err as Error).message);
    }
  });

  router.get('/cleanup/stage3/gate', (req, res) => {
    const service = serviceOr503(options);
    res.json({ gate: service.stage3Gate(libOf(service, req)) });
  });

  // ---------------------------------------------------------------- stage 4 (WP20d)

  router.get('/cleanup/stage4/proposals', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    res.json(
      service.stage4Proposals(libOf(service, req), {
        field: q.field ?? null,
        cls: q.class === 'auto' || q.class === 'review' ? q.class : null,
        source: q.source ?? null,
        offset,
        limit,
      }),
    );
  });

  // ---- More Bookmeter coverage (step 2): the pass over stage 4's stored answers ----

  const bookmeterOr503 = (req: Request) => {
    const service = serviceOr503(options);
    const lib = libOf(service, req);
    const pass = service.lp(lib).bookmeter;
    if (!pass) throw new ApiError(503, 'no_calibre', 'No Calibre library is set up');
    return { service, pass, lib };
  };

  router.get('/cleanup/bookmeter', (req, res) => {
    const { service } = bookmeterOr503(req);
    res.json(service.bookmeterStatus(libOf(service, req)));
  });

  router.put('/cleanup/bookmeter/mode', (req, res) => {
    const { service, pass } = bookmeterOr503(req);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on')
      throw new ApiError(400, 'bad_mode', 'mode must be off, analyse or on');
    try {
      pass.setMode(mode);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.bookmeterChanged(libOf(service, req));
    res.json(service.bookmeterStatus(libOf(service, req)));
  });

  router.get('/cleanup/bookmeter/matches', (req, res) => {
    const { service, pass } = bookmeterOr503(req);
    const lib = libOf(service, req);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    const source =
      q.source === 'rules' || q.source === 'ai' || q.source === 'second' ? q.source : null;
    if (!lib) {
      res.json({ total: 0, items: [] });
      return;
    }
    res.json(pass.listMatches(lib, pass.state().progress.run, source, offset, limit));
  });

  router.get('/cleanup/bookmeter/spot', (req, res) => {
    const { service, pass } = bookmeterOr503(req);
    const lib = libOf(service, req);
    res.json({
      items: lib ? pass.listSpot(lib, pass.state().progress.run) : [],
      counts: pass.spotCounts(),
      passed: pass.spotPassed(),
    });
  });

  router.put('/cleanup/bookmeter/spot/:uuid', (req, res) => {
    const { service, pass } = bookmeterOr503(req);
    const v = (req.body as { verdict?: unknown } | undefined)?.verdict;
    if (v !== 'right' && v !== 'wrong' && v !== null)
      throw new ApiError(400, 'bad_verdict', 'verdict must be right, wrong or null');
    try {
      pass.setVerdict(String(req.params.uuid), v);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.bookmeterChanged(libOf(service, req));
    res.json({ counts: pass.spotCounts(), passed: pass.spotPassed() });
  });

  // ---- More direct links: the pass over stage 4's stored store records ----

  const linksOr503 = (req: Request) => {
    const service = serviceOr503(options);
    const lib = libOf(service, req);
    const pass = service.lp(lib).links;
    if (!pass) throw new ApiError(503, 'no_calibre', 'No Calibre library is set up');
    return { service, pass, lib };
  };
  const linkSite = (v: unknown) =>
    v === 'amazon' || v === 'ranobedb' || v === 'bookwalker' ? v : null;

  router.get('/cleanup/links', (req, res) => {
    const { service } = linksOr503(req);
    res.json(service.linksStatus(libOf(service, req)));
  });

  router.put('/cleanup/links/mode', (req, res) => {
    const { service, pass } = linksOr503(req);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on')
      throw new ApiError(400, 'bad_mode', 'mode must be off, analyse or on');
    try {
      pass.setMode(mode);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.linksChanged(libOf(service, req));
    res.json(service.linksStatus(libOf(service, req)));
  });

  router.post('/cleanup/links/again', (req, res) => {
    const { service, pass } = linksOr503(req);
    try {
      pass.again();
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.linksChanged(libOf(service, req));
    res.json(service.linksStatus(libOf(service, req)));
  });

  router.get('/cleanup/links/list', (req, res) => {
    const { service, pass } = linksOr503(req);
    const lib = libOf(service, req);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    const state =
      q.state === 'clash' || q.state === 'differs' || q.state === 'saved' ? q.state : 'ok';
    const how = q.how === 'record' || q.how === 'series' ? q.how : null;
    if (!lib) {
      res.json({ total: 0, items: [] });
      return;
    }
    res.json(
      pass.listLinks(
        lib,
        pass.state().progress.run,
        { state, site: linkSite(q.site), how },
        offset,
        limit,
      ),
    );
  });

  router.get('/cleanup/links/spot', (req, res) => {
    const { service, pass } = linksOr503(req);
    const lib = libOf(service, req);
    res.json({
      items: lib ? pass.listSpot(lib, pass.state().progress.run) : [],
      counts: pass.spotCounts(),
      passed: pass.spotPassed(),
    });
  });

  router.put('/cleanup/links/spot/:uuid/:site', (req, res) => {
    const { service, pass } = linksOr503(req);
    const v = (req.body as { verdict?: unknown } | undefined)?.verdict;
    const site = linkSite(req.params.site);
    if (v !== 'right' && v !== 'wrong' && v !== null)
      throw new ApiError(400, 'bad_verdict', 'verdict must be right, wrong or null');
    if (!site) throw new ApiError(400, 'bad_site', 'site must be amazon, ranobedb or bookwalker');
    try {
      pass.setVerdict(String(req.params.uuid), site, v);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.linksChanged(libOf(service, req));
    res.json({ counts: pass.spotCounts(), passed: pass.spotPassed() });
  });

  // ---- Bookmeter links: the listing readers log (bookmeter-listings.md) ----

  const listingsOr503 = (req: Request) => {
    const service = serviceOr503(options);
    const lib = libOf(service, req);
    const pass = service.lp(lib).listings;
    if (!pass) throw new ApiError(503, 'no_calibre', 'No Calibre library is set up');
    return { service, pass, lib };
  };
  const LISTING_STATES = [
    'change',
    'keep',
    'adaptation',
    'unseen',
    'unsearched',
    'ai',
    'nofacts',
    'yours',
  ] as const;

  router.get('/cleanup/bookmeter-links', (req, res) => {
    const { service } = listingsOr503(req);
    res.json(service.listingsStatus(libOf(service, req)));
  });

  router.put('/cleanup/bookmeter-links/mode', (req, res) => {
    const { service, pass } = listingsOr503(req);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on')
      throw new ApiError(400, 'bad_mode', 'mode must be off, analyse or on');
    try {
      pass.setMode(mode);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.listingsChanged(libOf(service, req));
    res.json(service.listingsStatus(libOf(service, req)));
  });

  router.post('/cleanup/bookmeter-links/again', (req, res) => {
    const { service, pass } = listingsOr503(req);
    try {
      pass.again();
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.listingsChanged(libOf(service, req));
    res.json(service.listingsStatus(libOf(service, req)));
  });

  router.get('/cleanup/bookmeter-links/list', (req, res) => {
    const { service, pass } = listingsOr503(req);
    const lib = libOf(service, req);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    const state = (LISTING_STATES as readonly string[]).includes(q.state ?? '')
      ? (q.state as (typeof LISTING_STATES)[number])
      : 'change';
    if (!lib) {
      res.json({ total: 0, items: [] });
      return;
    }
    res.json(pass.listBooks(lib, pass.state().progress.run, state, offset, limit));
  });

  router.get('/cleanup/bookmeter-links/spot', (req, res) => {
    const { service, pass } = listingsOr503(req);
    const lib = libOf(service, req);
    res.json({
      items: lib ? pass.listSpot(lib, pass.state().progress.run) : [],
      counts: pass.spotCounts(),
      passed: pass.spotPassed(),
    });
  });

  router.put('/cleanup/bookmeter-links/spot/:uuid', (req, res) => {
    const { service, pass } = listingsOr503(req);
    const v = (req.body as { verdict?: unknown } | undefined)?.verdict;
    if (v !== 'right' && v !== 'wrong' && v !== null)
      throw new ApiError(400, 'bad_verdict', 'verdict must be right, wrong or null');
    try {
      pass.setVerdict(String(req.params.uuid), v);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.listingsChanged(libOf(service, req));
    res.json({ counts: pass.spotCounts(), passed: pass.spotPassed() });
  });

  // ---- Tier 4, Part 3: series under a short and a full name ----

  const seriesPairsOr503 = (req: Request) => {
    const service = serviceOr503(options);
    const lib = libOf(service, req);
    const pass = service.lp(lib).seriesPairs;
    if (!pass) throw new ApiError(503, 'no_calibre', 'No Calibre library is set up');
    return { service, pass, lib };
  };

  router.get('/cleanup/series-pairs', (req, res) => {
    const { service } = seriesPairsOr503(req);
    res.json(service.seriesPairsStatus(libOf(service, req)));
  });

  router.put('/cleanup/series-pairs/mode', (req, res) => {
    const { service, pass } = seriesPairsOr503(req);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on')
      throw new ApiError(400, 'bad_mode', 'mode must be off, analyse or on');
    pass.setMode(mode);
    service.seriesPairsChanged(libOf(service, req));
    res.json(service.seriesPairsStatus(libOf(service, req)));
  });

  router.post('/cleanup/series-pairs/again', (req, res) => {
    const { service, pass } = seriesPairsOr503(req);
    pass.again();
    service.seriesPairsChanged(libOf(service, req));
    res.json(service.seriesPairsStatus(libOf(service, req)));
  });

  router.get('/cleanup/series-pairs/pairs', (req, res) => {
    const { service, pass } = seriesPairsOr503(req);
    const lib = libOf(service, req);
    const q = req.query as Record<string, string | undefined>;
    const view =
      q.view === 'merge' || q.view === 'separate' || q.view === 'decided' ? q.view : 'review';
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    res.json(lib ? pass.list(lib, view, offset, limit) : { total: 0, pairs: [] });
  });

  router.post('/cleanup/series-pairs/pairs/:id', (req, res) => {
    const { service, pass } = seriesPairsOr503(req);
    const lib = libOf(service, req);
    if (!lib) throw new ApiError(409, 'not_now', 'No library is chosen for the cleanup');
    const choice = (req.body as { choice?: unknown } | undefined)?.choice;
    if (choice !== 'merge' && choice !== 'separate' && choice !== 'clear')
      throw new ApiError(400, 'bad_choice', 'choice must be merge, separate or clear');
    let pair;
    try {
      pair = pass.decidePair(lib, Number(req.params.id), choice);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.seriesPairsChanged(libOf(service, req));
    res.json(pair);
  });

  // ---- Manga part A: moving the manga and image-only books to the manga library ----

  router.get('/cleanup/move', (_req, res) => {
    res.json(serviceOr503(options).moveStatus());
  });

  router.put('/cleanup/move/mode', (req, res) => {
    const service = serviceOr503(options);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on')
      throw new ApiError(400, 'bad_mode', 'mode must be off, analyse or on');
    try {
      service.move.setMode(mode);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.moveChanged();
    res.json(service.moveStatus());
  });

  router.post('/cleanup/move/again', (_req, res) => {
    const service = serviceOr503(options);
    if (service.batches.open() && service.batches.open()!.stage === MOVE_STAGE)
      throw new ApiError(409, 'not_now', 'A move batch is being applied; try again after it');
    service.move.again();
    service.moveChanged();
    res.json(service.moveStatus());
  });

  router.post('/cleanup/move/resume', (_req, res) => {
    const service = serviceOr503(options);
    service.move.resume();
    service.moveChanged();
    res.json(service.moveStatus());
  });

  router.get('/cleanup/move/held', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    const p = service.move.state().progress;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    const reason = ['real_text', 'no_epub', 'no_count', 'too_long', 'not_in_reader'].includes(
      q.reason ?? '',
    )
      ? (q.reason as Parameters<typeof service.move.heldList>[4])
      : undefined;
    res.json(
      p.libraryId
        ? service.move.heldList(p.libraryId, p.run, offset, limit, reason)
        : { total: 0, books: [] },
    );
  });

  router.post('/cleanup/move/held/:id', (req, res) => {
    const service = serviceOr503(options);
    const choice = (req.body as { choice?: unknown } | undefined)?.choice;
    if (choice !== 'move' && choice !== 'keep')
      throw new ApiError(400, 'bad_choice', 'choice must be move or keep');
    try {
      service.move.choose(Number(req.params.id), choice);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    service.moveChanged();
    res.json(service.moveStatus());
  });

  router.get('/cleanup/move/spot', (_req, res) => {
    res.json({ books: serviceOr503(options).move.spotList() });
  });

  router.put('/cleanup/move/spot/:uuid', (req, res) => {
    const service = serviceOr503(options);
    const verdict = (req.body as { verdict?: unknown } | undefined)?.verdict;
    if (verdict !== 'right' && verdict !== 'wrong' && verdict !== null)
      throw new ApiError(400, 'bad_verdict', 'verdict must be right, wrong or null');
    try {
      service.move.setVerdict(req.params.uuid, verdict);
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    res.json(service.moveStatus());
  });

  // ---- WP20g: the Calibre library's new arrivals ----

  router.get('/cleanup/arrivals', (req, res) => {
    const service = serviceOr503(options);
    res.json(arrivalsStatus(service.arrivals, service.db, libOf(service, req)));
  });

  router.put('/cleanup/arrivals/mode', (req, res) => {
    const service = serviceOr503(options);
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'off' && mode !== 'analyse' && mode !== 'on')
      throw new ApiError(400, 'bad_mode', 'mode must be off, analyse or on');
    service.arrivals.setMode(mode, libOf(service, req));
    void service.tick();
    res.json(arrivalsStatus(service.arrivals, service.db, libOf(service, req)));
  });

  router.post('/cleanup/arrivals/run-now', (req, res) => {
    const service = serviceOr503(options);
    try {
      service.arrivals.requestRun(libOf(service, req));
    } catch (err) {
      throw new ApiError(409, 'not_now', (err as Error).message);
    }
    void service.tick();
    res.json(arrivalsStatus(service.arrivals, service.db, libOf(service, req)));
  });

  router.post('/cleanup/arrivals/stop', (req, res) => {
    const service = serviceOr503(options);
    service.arrivals.stopRun();
    res.json(arrivalsStatus(service.arrivals, service.db, libOf(service, req)));
  });

  router.post('/cleanup/arrivals/resume', (req, res) => {
    const service = serviceOr503(options);
    service.arrivals.resume(libOf(service, req));
    void service.tick();
    res.json(arrivalsStatus(service.arrivals, service.db, libOf(service, req)));
  });

  router.get('/cleanup/arrivals/lists/:list', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    try {
      const page = arrivalsList(
        service.db,
        req.params.list,
        Number(q.offset ?? 0) || 0,
        Number(q.limit ?? 50) || 50,
        libOf(service, req),
      );
      // Manga part B: a matched book's library by name (the other library's copies).
      const names = new Map<string, string>();
      const nameOf = (id: string) => {
        if (!names.has(id)) names.set(id, service.libraryName(id));
        return names.get(id)!;
      };
      res.json({
        ...page,
        items: page.items.map((it) => {
          const lib = (it as { calibre_library_id?: unknown }).calibre_library_id;
          return typeof lib === 'string' && lib
            ? { ...(it as object), calibre_library_name: nameOf(lib) }
            : it;
        }),
      });
    } catch (err) {
      throw new ApiError(404, 'no_list', (err as Error).message);
    }
  });

  router.get('/cleanup/arrivals/not-imported.csv', (_req, res) => {
    const service = serviceOr503(options);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="not-imported.csv"');
    res.send('\ufeff' + notImportedCsv(service.db));
  });

  router.post('/cleanup/arrivals/reviews/:id', (req, res) => {
    const service = serviceOr503(options);
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (typeof decision !== 'string')
      throw new ApiError(400, 'bad_decision', 'decision is required');
    try {
      service.arrivals.decide(Number(req.params.id), decision);
    } catch (err) {
      throw new ApiError(400, 'bad_decision', (err as Error).message);
    }
    res.json({ ok: true });
  });

  router.post('/cleanup/arrivals/batches/:id/undo', (req, res) => {
    const service = serviceOr503(options);
    try {
      const id = service.arrivals.addBatches.planUndo(Number(req.params.id));
      void service.tick();
      res.json({ undo: id });
    } catch (err) {
      rethrow(err);
    }
  });

  router.get('/cleanup/stage4/guesses', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    res.json(
      service.stage4Guesses(
        libOf(service, req),
        q.kind === 'other' ? 'other' : 'series',
        offset,
        limit,
      ),
    );
  });

  router.get('/cleanup/titles/shortened', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    res.json(service.titleFits(libOf(service, req), offset, limit));
  });

  router.get('/cleanup/stage4/readings', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    res.json(service.stage4Readings(q.state ?? null, offset));
  });

  router.post('/cleanup/stage4/sites/:site/resume', (req, res) => {
    const service = serviceOr503(options);
    service.fetchQueue.resume(req.params.site);
    res.json({ ok: true });
  });

  router.post('/cleanup/stage4/ai/ask-again', (req, res) => {
    const service = serviceOr503(options);
    res.json(service.askStage4AiAgain(libOf(service, req)));
  });

  router.post('/cleanup/stage4/repropose-undone', async (req, res, next) => {
    try {
      const service = serviceOr503(options);
      res.json(await service.reproposeStage4Undone(libOf(service, req)));
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------- stage 5 (WP20f)

  router.get('/cleanup/stage5/proposals', (req, res) => {
    const service = serviceOr503(options);
    const q = req.query as Record<string, string | undefined>;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const state = ['proposed', 'queued', 'applied', 'skipped', 'undone'].includes(q.state ?? '')
      ? (q.state as string)
      : 'proposed';
    const outside = q.outside === '1' ? true : q.outside === '0' ? false : null;
    res.json(service.stage5Proposals(libOf(service, req), { state, outside, offset, limit }));
  });

  router.post('/cleanup/stage5/ai/ask-again', (req, res) => {
    const service = serviceOr503(options);
    res.json(service.askStage5AiAgain(libOf(service, req)));
  });

  router.post('/cleanup/stage4/sites/:site/retry', (req, res) => {
    const service = serviceOr503(options);
    res.json({ retried: service.retryStage4Site(libOf(service, req), req.params.site) });
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
    const lib = libOf(service, req) ?? '';
    const rows = service.db
      .prepare(
        stage === 2
          ? `SELECT c.id, c.calibre_id, c.calibre_uuid, c.state, c.batch_id, c.field, c.source,
                    c.old_json, c.new_json, c.evidence_json, f.last_modified_after
             FROM proposed_changes c LEFT JOIN field_undo f ON f.change_id = c.id AND f.batch_id = c.batch_id
             WHERE c.stage = 2 AND c.library_id = ? AND c.state = 'applied' ORDER BY RANDOM() LIMIT 30`
          : `SELECT c.id, c.calibre_id, c.calibre_uuid, c.state, c.batch_id, c.evidence_json,
                u.handoff_json, u.quarantine_dir
         FROM proposed_changes c LEFT JOIN undo_records u ON u.change_id = c.id
         WHERE c.stage = ? AND c.library_id = ? AND c.state = 'applied' ORDER BY RANDOM() LIMIT 30`,
      )
      .all(...(stage === 2 ? [lib] : [stage, lib])) as Record<string, unknown>[];
    res.json({ items: rows.map(proposalView) });
  });

  router.use('/cleanup', (_req, res) => sendError(res, 404, 'not_found', 'No such route'));
  return router;
}
