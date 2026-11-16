/**
 * Season 2 Phase 12 session 3: live read-aloud routes (read-aloud.ts).
 *
 * The device (behind requireUser):
 * - POST /read-aloud/sessions {bookId|null, pauses}: start (takes over any other session).
 * - POST /read-aloud/sessions/:id/batches {sentences, replace?}: sentences to read next.
 * - GET /read-aloud/sessions/:id?after=&wait=&playing=: the session, held open until it
 *   changes (410 `ended` with the reason once it is over).
 * - GET /read-aloud/sessions/:id/batches/:seq/audio: a batch's MP3.
 * - DELETE /read-aloud/sessions/:id: Stop.
 *
 * The PC (worker token, /api/v1/worker/live/*; mounted before the WP16 worker router):
 * - POST /worker/live/next {engine, take, wait}: the session and the next batch to read.
 * - GET /worker/live/voice/:sha256: the session's voice clip.
 * - PUT /worker/live/:session/:seq: the batch's FLAC (raw body).
 * - POST /worker/live/:session/:seq/done {durationMs, cues}; POST …/fail {error}.
 */
import type Database from 'better-sqlite3';
import express, { type Request, Router } from 'express';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getAuth, requireWorker } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import type { ReadAloudService } from './read-aloud';
import type { AudioOptions } from './routes';
import { JobRequestError } from './subtitle-jobs';
import { TooLargeError } from './tts-workdir';

/** The batch upload's body is the FLAC itself (the JSON parser skips it). */
export const READ_ALOUD_RAW_PATHS = [/^\/worker\/live\/[0-9a-f]{32}\/\d+$/];

function rethrow(err: unknown): never {
  if (err instanceof JobRequestError) {
    throw new ApiError(err.status, err.code, err.message, err.details);
  }
  if (err instanceof TooLargeError) throw new ApiError(413, 'too_large', err.message);
  throw err;
}

async function attempt<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrow(err);
  }
}

function serviceOr503(o: AudioOptions): ReadAloudService {
  if (!o.readAloud) {
    throw new ApiError(503, 'tts_off', 'Read-aloud with the PC voice is not set up on this server');
  }
  return o.readAloud;
}

const sessionId = (value: string): string => {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new ApiError(404, 'not_found', 'No such session');
  return value;
};

const seqOf = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(404, 'not_found', 'No such batch');
  return n;
};

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Whether the client went away before the answer. A request's own 'close' fires as soon as
 * its body is read, so the response's is the one to watch.
 */
function closedFlag(res: express.Response): () => boolean {
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) closed = true;
  });
  return () => closed;
}

async function sendFile(res: express.Response, file: string, type: string): Promise<void> {
  res.set('Content-Type', type);
  res.set('Cache-Control', 'no-store');
  try {
    await pipeline(createReadStream(file), res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw err;
  }
}

/** /api/v1/worker/live/*: the GPU worker's token only. */
export function createReadAloudWorkerRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();
  router.use('/worker/live', requireWorker(db));
  const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

  router.post(
    '/worker/live/next',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const closed = closedFlag(res);
      const next = await attempt(() => service.next(body(req), closed));
      if (!closed()) res.json(next ?? { end: true });
    }),
  );

  router.get(
    '/worker/live/voice/:sha',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      if (!options.voices) throw new ApiError(503, 'voices_off', 'Voice presets are off');
      const { relative } = await attempt(() => service.voiceClip(req.params.sha));
      const st = await options.voices.store.stat(relative);
      if (!st) throw new ApiError(410, 'missing', 'The voice clip is missing');
      res.set('Content-Length', String(st.size));
      await sendFile(res, options.voices.store.resolve(relative), 'audio/wav');
    }),
  );

  router.put(
    '/worker/live/:session/:seq',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const bytes = await attempt(() =>
        service.receive(sessionId(req.params.session), seqOf(req.params.seq), req),
      );
      res.json({ bytes });
    }),
  );

  router.post(
    '/worker/live/:session/:seq/done',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      res.json(
        await attempt(() =>
          service.finish(sessionId(req.params.session), seqOf(req.params.seq), body(req)),
        ),
      );
    }),
  );

  router.post('/worker/live/:session/:seq/fail', (req, res) => {
    const service = serviceOr503(options);
    try {
      service.fail(sessionId(req.params.session), seqOf(req.params.seq), body(req));
    } catch (err) {
      rethrow(err);
    }
    res.json({ ok: true });
  });

  return router;
}

/** The device's side. Mounted behind requireUser. */
export function createReadAloudRouter(_db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();
  const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

  router.post(
    '/read-aloud/sessions',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { user } = getAuth(res);
      res.status(201).json({ session: await attempt(() => service.open(user.id, body(req))) });
    }),
  );

  router.post(
    '/read-aloud/sessions/:id/batches',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { user } = getAuth(res);
      res
        .status(202)
        .json(await attempt(() => service.addBatch(user.id, sessionId(req.params.id), body(req))));
    }),
  );

  router.get(
    '/read-aloud/sessions/:id',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { user } = getAuth(res);
      const closed = closedFlag(res);
      const playing = req.query.playing === '1' ? true : req.query.playing === '0' ? false : null;
      const view = await attempt(() =>
        service.poll(
          user.id,
          sessionId(req.params.id),
          {
            after: Math.max(0, Math.floor(num(req.query.after, 0))),
            wait: Math.max(0, num(req.query.wait, 0)),
            playing,
          },
          closed,
        ),
      );
      if (!closed()) res.json({ session: view });
    }),
  );

  router.get(
    '/read-aloud/sessions/:id/batches/:seq/audio',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { user } = getAuth(res);
      const file = await attempt(() =>
        service.audioFile(user.id, sessionId(req.params.id), seqOf(req.params.seq)),
      );
      if (!file) throw new ApiError(404, 'not_found', 'Not ready or no longer there');
      await sendFile(res, file, 'audio/mpeg');
    }),
  );

  router.delete(
    '/read-aloud/sessions/:id',
    asyncHandler(async (req, res) => {
      const service = serviceOr503(options);
      const { user } = getAuth(res);
      await service.close(user.id, sessionId(req.params.id));
      res.status(204).end();
    }),
  );

  return router;
}
