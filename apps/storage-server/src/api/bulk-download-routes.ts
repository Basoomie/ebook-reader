/**
 * /api/v1 bulk downloads (the library's select mode): the download plan (what the
 * selected books offer and the sizes), and one ZIP of one kind.
 *
 * A ZIP is prepared in the background (POST /books/download-zip starts it; every file is
 * stat'ed, so the archive's exact size is known; GET /books/download-zip/:token reports
 * how far it is, for the page's progress bar) and then fetched by the browser itself
 * from a one-off address (GET /bulk-downloads/:token/<name>.zip), so it goes to the
 * browser's downloads with progress and time left and is never held in the page's
 * memory. The address is an unguessable token that ends after a few hours or when the
 * server restarts.
 */
import { randomBytes } from 'crypto';
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { pipeline } from 'stream/promises';
import type { AudioOptions } from '../audio/routes';
import {
  DOWNLOAD_KINDS,
  type DownloadKind,
  downloadPlan,
  MAX_DOWNLOAD_IDS,
  prepareZip,
} from '../catalog/bulk-download';
import type { CatalogUser } from '../catalog/queries';
import { UUID_RE } from '../sync/kinds';
import { type ZipEntry, zipSize, zipStream } from '../catalog/zip-stream';
import { getAuth } from './auth';
import type { CatalogOptions } from './catalog-routes';
import { ApiError, asyncHandler } from './errors';

/** The routes that take a list of up to MAX_DOWNLOAD_IDS ids (a larger JSON body). */
export const BULK_DOWNLOAD_PATHS = ['/books/download-plan', '/books/download-zip'];
export const BULK_DOWNLOAD_BODY_LIMIT = '16mb';

/** How long a ZIP's address works (a download in progress is never cut off). */
const ZIP_TTL_MS = 6 * 60 * 60 * 1000;
/** ZIPs kept at once (the oldest is dropped). */
const MAX_JOBS = 50;

const ZIP_NAMES: Record<DownloadKind, string> = {
  book: 'Books',
  cover: 'Covers',
  audio: 'Audiobooks',
  subtitles: 'SRT',
};

type JobState = 'preparing' | 'ready' | 'failed' | 'cancelled';

interface ZipJob {
  userId: string;
  kind: DownloadKind;
  state: JobState;
  done: number;
  total: number;
  createdAt: number;
  controller: AbortController;
  entries?: ZipEntry[];
  fileName?: string;
  size?: number;
  skipped?: string[];
  error?: string;
}

/** The ZIP jobs, shared by the token routes and the public download route. */
export class BulkDownloads {
  private jobs = new Map<string, ZipJob>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  add(userId: string, kind: DownloadKind): { token: string; job: ZipJob } {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    const job: ZipJob = {
      userId,
      kind,
      state: 'preparing',
      done: 0,
      total: 0,
      createdAt: this.now(),
      controller: new AbortController(),
    };
    this.jobs.set(token, job);
    while (this.jobs.size > MAX_JOBS) {
      const [oldest, old] = this.jobs.entries().next().value as [string, ZipJob];
      old.controller.abort();
      this.jobs.delete(oldest);
    }
    return { token, job };
  }

  get(token: string): ZipJob | null {
    this.sweep();
    return this.jobs.get(token) ?? null;
  }

  delete(token: string): void {
    const job = this.jobs.get(token);
    job?.controller.abort();
    this.jobs.delete(token);
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, job] of this.jobs) {
      if (now - job.createdAt > ZIP_TTL_MS) this.delete(token);
    }
  }
}

function idsFrom(body: unknown): string[] {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_DOWNLOAD_IDS ||
    !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))
  ) {
    throw new ApiError(
      400,
      'invalid_ids',
      `ids must be a list of at most ${MAX_DOWNLOAD_IDS} book ids`,
    );
  }
  return ids as string[];
}

function audioRoot(audio: AudioOptions): string | null {
  const service = audio.service;
  return service && service.status.enabled ? service.root : null;
}

function zipUrl(token: string, fileName: string): string {
  return `/api/v1/bulk-downloads/${token}/${encodeURIComponent(fileName)}`;
}

/** The token routes (mounted behind requireUser). */
export function createBulkDownloadRouter(
  db: Database.Database,
  catalog: CatalogOptions,
  audio: AudioOptions,
  downloads: BulkDownloads,
): Router {
  const router = express.Router();

  // Only stored data (no disk reads): the sizes the select bar's Download menu shows.
  router.post('/books/download-plan', (req, res) => {
    const { user } = getAuth(res);
    const ids = idsFrom(req.body);
    const withItems = (req.body as { items?: unknown }).items === true;
    const plan = downloadPlan(db, user, ids, { audioOn: audioRoot(audio) !== null });
    res.json(withItems ? plan : { unknown: plan.unknown, totals: plan.totals });
  });

  // Starts preparing a ZIP; the answer comes at once (the page then asks how far it is).
  router.post('/books/download-zip', (req, res) => {
    const { user } = getAuth(res);
    const ids = idsFrom(req.body);
    const kind = (req.body as { kind?: unknown }).kind;
    if (!DOWNLOAD_KINDS.includes(kind as DownloadKind)) {
      throw new ApiError(400, 'invalid_kind', `kind must be one of ${DOWNLOAD_KINDS.join(', ')}`);
    }
    const { token, job } = downloads.add(user.id, kind as DownloadKind);
    void runJob(db, user, ids, job, catalog, audio);
    res.status(202).json({ token });
  });

  const jobFor = (token: string, userId: string): ZipJob => {
    const job = downloads.get(token);
    if (!job || job.userId !== userId) {
      throw new ApiError(404, 'not_found', 'This download has ended. Start it again.');
    }
    return job;
  };

  router.get('/books/download-zip/:token', (req, res) => {
    const { user } = getAuth(res);
    const job = jobFor(req.params.token, user.id);
    if (job.state === 'ready') {
      res.json({
        state: 'ready',
        url: zipUrl(req.params.token, job.fileName!),
        fileName: job.fileName,
        size: job.size,
        count: job.entries!.length,
        skipped: job.skipped,
      });
      return;
    }
    res.json({
      state: job.state,
      done: job.done,
      total: job.total,
      ...(job.error ? { error: job.error } : {}),
    });
  });

  // Cancel: stops looking up files; an address already handed out stops working.
  router.delete('/books/download-zip/:token', (req, res) => {
    const { user } = getAuth(res);
    jobFor(req.params.token, user.id);
    downloads.delete(req.params.token);
    res.status(204).end();
  });

  return router;
}

async function runJob(
  db: Database.Database,
  user: CatalogUser,
  ids: string[],
  job: ZipJob,
  catalog: CatalogOptions,
  audio: AudioOptions,
): Promise<void> {
  try {
    const { entries, skipped } = await prepareZip(
      db,
      user,
      ids,
      job.kind,
      {
        calibreDir: catalog.indexer.enabled ? (catalog.calibreDir ?? null) : null,
        uploads: catalog.uploads?.store ?? null,
        thumbnails: catalog.indexer.enabled ? catalog.thumbnails : null,
        audioRoot: audioRoot(audio),
      },
      {
        signal: job.controller.signal,
        onProgress: (done, total) => {
          job.done = done;
          job.total = total;
        },
      },
    );
    if (job.controller.signal.aborted) {
      job.state = 'cancelled';
      return;
    }
    if (!entries.length) {
      job.state = 'failed';
      job.error = skipped.length
        ? 'None of these files could be found.'
        : 'None of the selected books has this to download.';
      return;
    }
    job.entries = entries;
    job.skipped = skipped;
    job.fileName = `${ZIP_NAMES[job.kind]} (${entries.length}).zip`;
    job.size = zipSize(entries);
    job.state = 'ready';
  } catch (err) {
    if (job.controller.signal.aborted) {
      job.state = 'cancelled';
      return;
    }
    console.error('Bulk download: preparing the ZIP failed:', err);
    job.state = 'failed';
    job.error = (err as Error).message;
  }
}

/**
 * GET /bulk-downloads/:token/:name: the prepared ZIP, streamed as an attachment with its
 * exact length. Mounted before requireUser (a plain link can't send the token); the
 * token itself is the permission.
 */
export function bulkDownloadFileRoute(downloads: BulkDownloads): Router {
  const router = express.Router();
  router.get(
    '/bulk-downloads/:token/:name?',
    asyncHandler(async (req, res) => {
      const job = downloads.get(req.params.token);
      if (!job || job.state !== 'ready' || !job.entries) {
        throw new ApiError(404, 'not_found', 'This download has ended. Start it again.');
      }
      const { size, stream } = zipStream(job.entries);
      res.set('Content-Type', 'application/zip');
      res.set('Content-Length', String(size));
      res.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(job.fileName!)}`,
      );
      res.set('Cache-Control', 'no-store');
      try {
        await pipeline(stream, res);
      } catch (err) {
        // The browser cancelled the download: nothing to report.
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        // Headers are sent: the cut-off response marks the download as failed.
        console.error(`Bulk download "${job.fileName}" stopped:`, (err as Error).message);
        res.destroy();
      }
    }),
  );
  return router;
}
