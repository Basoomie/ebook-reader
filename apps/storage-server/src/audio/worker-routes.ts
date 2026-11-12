/**
 * WP16 routes.
 *
 * - The GPU worker's own routes, /api/v1/worker/*: only a worker token (`cli token worker`)
 *   gets in, and it can read only the EPUB and the audio file of the job it is running.
 *   It never writes anything on the server itself: it uploads the result and the server
 *   saves it (subtitle-jobs.ts, through audio-write.ts). Mounted before requireUser.
 * - The user's routes (behind requireUser): queue "make subtitles" for a book, see the
 *   book's latest job, stop a job, and the worker's status and pause switch for Settings.
 */
import type Database from 'better-sqlite3';
import express, { type Request, Router } from 'express';
import { getAuth, requireWorker } from '../api/auth';
import { type CatalogOptions, sendBookFile } from '../api/catalog-routes';
import { ApiError, asyncHandler, notFound } from '../api/errors';
import { getBookFor } from '../catalog/queries';
import { type AudioOptions, requireAudio, sendAudioFile } from './routes';
import { JobRequestError, type SubtitleJobService, type WorkerJob } from './subtitle-jobs';

/** The worker's upload: its body is the subtitle file (the JSON parser skips it). */
export const WORKER_RESULT_PATH = /^\/worker\/jobs\/[^/]+\/result$/;

/** What a user sees of a job (no user id). */
export function workerJobView(job: WorkerJob) {
  const { userId: _userId, ...rest } = job;
  return rest;
}

function jobsOr503(options: AudioOptions): SubtitleJobService {
  if (!options.jobs) {
    throw new ApiError(503, 'jobs_off', 'The GPU worker queue is not set up on this server');
  }
  return options.jobs;
}

function rethrow(err: unknown): never {
  if (err instanceof JobRequestError) {
    throw new ApiError(err.status, err.code, err.message, err.details);
  }
  throw err;
}

function jobId(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(404, 'not_found', 'No such job');
  return n;
}

/** Reads a raw body up to `maxBytes` (Content-Length is checked first). */
function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = () =>
      new ApiError(
        413,
        'too_large',
        `The subtitle file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`,
      );
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** /api/v1/worker/*: the GPU worker's token only. Mounted before requireUser. */
export function createWorkerRouter(
  db: Database.Database,
  options: AudioOptions,
  catalog: CatalogOptions,
): Router {
  const router = express.Router();
  router.use('/worker', requireWorker(db));

  router.post('/worker/heartbeat', (req, res) => {
    const jobs = jobsOr503(options);
    res.json(jobs.heartbeat((req.body ?? {}) as Record<string, unknown>));
  });

  router.post('/worker/claim', (_req, res) => {
    const jobs = jobsOr503(options);
    res.json({ job: jobs.claim() });
  });

  router.get(
    '/worker/jobs/:id/epub',
    asyncHandler(async (req, res) => {
      const jobs = jobsOr503(options);
      let held;
      try {
        held = jobs.heldJob(jobId(req.params.id));
      } catch (err) {
        rethrow(err);
      }
      await sendBookFile(db, catalog, { id: held.job.userId }, held.job.bookId, res);
    }),
  );

  router.get(
    '/worker/jobs/:id/audio',
    asyncHandler(async (req, res) => {
      const jobs = jobsOr503(options);
      const service = requireAudio(options);
      let held;
      try {
        held = jobs.heldJob(jobId(req.params.id));
      } catch (err) {
        rethrow(err);
      }
      await sendAudioFile(service, held.folder, held.index, req, res);
    }),
  );

  router.post('/worker/jobs/:id/progress', (req, res) => {
    const jobs = jobsOr503(options);
    try {
      res.json(jobs.progress(jobId(req.params.id), (req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/worker/jobs/:id/fail', (req, res) => {
    const jobs = jobsOr503(options);
    try {
      const job = jobs.fail(jobId(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      res.json({ state: job.state });
    } catch (err) {
      rethrow(err);
    }
  });

  router.put(
    '/worker/jobs/:id/result',
    asyncHandler(async (req, res) => {
      const jobs = jobsOr503(options);
      const id = jobId(req.params.id);
      const body = await readBody(req, Math.round(jobs.config.resultMaxMb * 1024 * 1024));
      try {
        const job = await jobs.result(id, body);
        res.json({
          state: job.state,
          outputName: job.outputName,
          linked: job.linked,
          error: job.error,
        });
      } catch (err) {
        rethrow(err);
      }
    }),
  );

  router.use('/worker', notFound);
  return router;
}

/** The user's side. Mounted behind requireUser. */
export function createSubtitleJobRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();

  const bookOr404 = (userId: string, bookId: string) => {
    if (!getBookFor(db, { id: userId }, bookId)) {
      throw new ApiError(404, 'not_found', 'No such book');
    }
  };

  router.post('/books/:id/subtitle-job', (req, res) => {
    const jobs = jobsOr503(options);
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    try {
      const job = jobs.enqueue(user.id, req.params.id, { force });
      res.status(202).json({ job: workerJobView(job) });
    } catch (err) {
      rethrow(err);
    }
  });

  /** The book's latest job (the page shows progress after a reload). */
  router.get('/books/:id/subtitle-job', (req, res) => {
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const job = options.jobs?.latestForBook(user.id, req.params.id) ?? null;
    res.json({ job: job ? workerJobView(job) : null });
  });

  router.post('/audio/subtitle-jobs/:id/cancel', (req, res) => {
    const jobs = jobsOr503(options);
    const { user } = getAuth(res);
    const job = jobs.cancel(user.id, jobId(req.params.id));
    if (!job) throw new ApiError(404, 'not_found', 'No such job');
    res.json({ job: workerJobView(job) });
  });

  /** For Settings > Audiobooks: online, paused, problem, the user's waiting/running jobs. */
  router.get('/gpu-worker', (_req, res) => {
    const { user } = getAuth(res);
    if (!options.jobs) {
      res.json({ available: false });
      return;
    }
    const status = options.jobs.status(user.id);
    res.json({ available: true, ...status, jobs: status.jobs.map(workerJobView) });
  });

  router.put('/gpu-worker/paused', (req, res) => {
    const jobs = jobsOr503(options);
    const paused = (req.body as { paused?: unknown } | undefined)?.paused;
    if (typeof paused !== 'boolean') {
      throw new ApiError(400, 'invalid_body', 'paused must be true or false');
    }
    jobs.setPaused(paused);
    res.json({ paused: jobs.isPaused() });
  });

  return router;
}
