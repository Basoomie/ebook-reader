/**
 * WP17 routes: generated audiobooks, previews, voice presets and the model list.
 *
 * - The worker's routes (/api/v1/worker/…, worker token only; mounted before the WP16
 *   worker router, whose catch-all would answer 404): the text of the job's chapters, the
 *   job's voice clip, chapter uploads and their timings, pausing between chapters, what a
 *   model can do, and the model list (so the PC can delete removed models' files).
 * - The user's routes (behind requireUser): start/see an audiobook or a preview for a book,
 *   the book's chapters, voices (upload a clip with the consent confirmation, describe a
 *   voice, keep a sample, delete), and the model list (add, remove, default).
 * Stop uses the WP16 route (POST /audio/subtitle-jobs/:id/cancel works for every kind).
 */
import type Database from 'better-sqlite3';
import express, { type Request, Router } from 'express';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getAuth, requireWorker } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { getBookFor } from '../catalog/queries';
import { ClipTooLargeError } from '../voices/voice-store';
import { VoiceRequestError, type VoiceService, type Voice } from '../voices/voice-service';
import { JobRequestError } from './subtitle-jobs';
import { type TtsJobService } from './tts-jobs';
import { ModelRequestError, type TtsModelService, modelDirName, type TtsModel } from './tts-models';
import { workerJobView } from './worker-routes';

/** Bodies the JSON parser must skip: chapter audio, chapter timings (large), voice clips. */
export const TTS_RAW_PATHS = [
  /^\/worker\/jobs\/\d+\/chapters\/\d+$/,
  /^\/worker\/jobs\/\d+\/chapters\/\d+\/done$/,
  /^\/voices$/,
];

export interface TtsOptions {
  tts?: TtsJobService | null;
  models?: TtsModelService | null;
  voices?: VoiceService | null;
}

const bigJson = express.json({ limit: '20mb' });

function rethrow(err: unknown): never {
  if (
    err instanceof JobRequestError ||
    err instanceof ModelRequestError ||
    err instanceof VoiceRequestError
  ) {
    throw new ApiError(err.status, err.code, err.message, (err as JobRequestError).details);
  }
  throw err;
}

async function attempt<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrow(err);
  }
}

const id = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(404, 'not_found', 'Not found');
  return n;
};

function ttsOr503(o: TtsOptions): TtsJobService {
  if (!o.tts)
    throw new ApiError(503, 'tts_off', 'Generated audiobooks are not set up on this server');
  return o.tts;
}
function modelsOr503(o: TtsOptions): TtsModelService {
  if (!o.models)
    throw new ApiError(503, 'tts_off', 'Generated audiobooks are not set up on this server');
  return o.models;
}
function voicesOr503(o: TtsOptions): VoiceService {
  if (!o.voices) throw new ApiError(503, 'voices_off', 'Voice presets are off on this server');
  return o.voices;
}

const modelView = (m: TtsModel) => ({
  id: m.id,
  source: m.source,
  revision: m.revision,
  label: m.label,
  note: m.note,
  supportsDescription: m.supportsDescription,
  supportsClip: m.supportsClip,
  isDefault: m.isDefault,
  addedAt: m.addedAt,
});

const voiceView = (v: Voice) => ({
  id: v.id,
  name: v.name,
  kind: v.kind,
  description: v.description,
  modelSource: v.modelSource,
  clipSeconds: v.clipSeconds,
  createdAt: v.createdAt,
});

async function sendFile(res: express.Response, file: string, type: string): Promise<void> {
  res.set('Content-Type', type);
  res.set('Cache-Control', 'private, no-cache');
  try {
    await pipeline(createReadStream(file), res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw err;
  }
}

const declaredLength = (req: Request): number | null => {
  const n = Number(req.headers['content-length']);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** /api/v1/worker/*: the GPU worker's token only. Mounted before the WP16 worker router. */
export function createTtsWorkerRouter(db: Database.Database, options: TtsOptions): Router {
  const router = express.Router();
  router.use('/worker/jobs/:id/script', requireWorker(db));
  router.use('/worker/jobs/:id/voice', requireWorker(db));
  router.use('/worker/jobs/:id/chapters', requireWorker(db));
  router.use('/worker/jobs/:id/release', requireWorker(db));
  router.use('/worker/models', requireWorker(db));

  router.get(
    '/worker/jobs/:id/script',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      res.json(await attempt(() => tts.workerScript(id(req.params.id))));
    }),
  );

  router.get(
    '/worker/jobs/:id/voice',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const voices = voicesOr503(options);
      const { relative } = await attempt(() => tts.voiceClip(id(req.params.id)));
      const st = await voices.store.stat(relative);
      if (!st) throw new ApiError(410, 'missing', 'The voice clip is missing');
      res.set('Content-Length', String(st.size));
      await sendFile(res, voices.store.resolve(relative), 'audio/wav');
    }),
  );

  router.put(
    '/worker/jobs/:id/chapters/:idx',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const result = await attempt(() =>
        tts.receiveChapter(id(req.params.id), id(req.params.idx), req, declaredLength(req)),
      );
      res.json(result);
    }),
  );

  router.post(
    '/worker/jobs/:id/chapters/:idx/done',
    bigJson,
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const job = await attempt(() =>
        tts.finishChapter(id(req.params.id), id(req.params.idx), (req.body ?? {}) as object),
      );
      res.json({ state: job.state, chaptersDone: job.chaptersDone });
    }),
  );

  router.post('/worker/jobs/:id/release', (req, res) => {
    const tts = ttsOr503(options);
    try {
      const job = tts.release(id(req.params.id));
      res.json({ state: job.state });
    } catch (err) {
      rethrow(err);
    }
  });

  router.get('/worker/models', (_req, res) => {
    const models = modelsOr503(options);
    res.json({
      models: models
        .list()
        .map((m) => ({ ...modelView(m), dir: modelDirName(m.source, m.revision) })),
      removed: models.removed().map((m) => ({
        source: m.source,
        revision: m.revision,
        dir: modelDirName(m.source, m.revision),
      })),
    });
  });

  router.post('/worker/models/capabilities', (req, res) => {
    ttsOr503(options).recordCapabilities((req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true });
  });

  return router;
}

/** The user's side. Mounted behind requireUser. */
export function createTtsRouter(db: Database.Database, options: TtsOptions): Router {
  const router = express.Router();
  const bookOr404 = (userId: string, bookId: string) => {
    if (!getBookFor(db, { id: userId }, bookId))
      throw new ApiError(404, 'not_found', 'No such book');
  };
  const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

  // ------------------------------------------------------------ books

  router.get(
    '/books/:id/audiobook-chapters',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      res.json(await attempt(() => tts.chapters(user.id, req.params.id)));
    }),
  );

  router.post(
    '/books/:id/audiobook-job',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      const job = await attempt(() => tts.startAudiobook(user.id, req.params.id, body(req)));
      res.status(202).json({ job: workerJobView(job) });
    }),
  );

  router.get('/books/:id/audiobook-job', (req, res) => {
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const job = options.tts?.latest(user.id, req.params.id, 'generate_audiobook') ?? null;
    res.json({ job: job ? workerJobView(job) : null });
  });

  router.post(
    '/books/:id/audiobook-preview',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      const job = await attempt(() => tts.startPreview(user.id, req.params.id, body(req)));
      res.status(202).json({ job: workerJobView(job) });
    }),
  );

  router.get('/books/:id/audiobook-preview', (req, res) => {
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const job = options.tts?.latest(user.id, req.params.id, 'preview_audiobook') ?? null;
    res.json({ job: job ? workerJobView(job) : null });
  });

  /** The audio of a finished preview or voice sample (FLAC). */
  router.get(
    '/audio/tts-jobs/:id/audio',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const { user } = getAuth(res);
      const file = await tts.resultFile(user.id, id(req.params.id));
      if (!file) throw new ApiError(404, 'not_found', 'Not ready or no longer there');
      await sendFile(res, file, 'audio/flac');
    }),
  );

  // ------------------------------------------------------------ voices

  router.get('/voices', (_req, res) => {
    const { user } = getAuth(res);
    res.json({
      available: Boolean(options.voices),
      voices: options.voices ? options.voices.list(user.id).map(voiceView) : [],
      limits: options.voices
        ? {
            maxMb: options.voices.config.voiceClipMaxMb,
            minSeconds: options.voices.config.voiceClipMinSeconds,
            maxSeconds: options.voices.config.voiceClipMaxSeconds,
          }
        : null,
    });
  });

  /** Upload a clip: the body is the audio file; ?name=…&consent=1. */
  router.post(
    '/voices',
    asyncHandler(async (req, res) => {
      const voices = voicesOr503(options);
      const { user } = getAuth(res);
      const max = Math.round(voices.config.voiceClipMaxMb * 1024 * 1024);
      const declared = declaredLength(req);
      if (declared !== null && declared > max) {
        req.resume();
        throw new ApiError(
          413,
          'too_large',
          `The file is larger than ${voices.config.voiceClipMaxMb} MB`,
        );
      }
      let tmp: string;
      try {
        tmp = await voices.store.receive(req, max);
      } catch (err) {
        if (err instanceof ClipTooLargeError) {
          throw new ApiError(
            413,
            'too_large',
            `The file is larger than ${voices.config.voiceClipMaxMb} MB`,
          );
        }
        throw err;
      }
      const voice = await attempt(() =>
        voices.addClip(user.id, tmp, {
          name: typeof req.query.name === 'string' ? req.query.name : undefined,
          consent: req.query.consent === '1' || req.query.consent === 'true',
        }),
      );
      res.status(201).json({ voice: voiceView(voice) });
    }),
  );

  router.get(
    '/voices/:id/clip',
    asyncHandler(async (req, res) => {
      const voices = voicesOr503(options);
      const { user } = getAuth(res);
      const voice = voices.get(user.id, req.params.id);
      if (!voice) throw new ApiError(404, 'not_found', 'No such voice');
      const rel = voices.clipRelative(voice.id);
      const st = await voices.store.stat(rel);
      if (!st) throw new ApiError(410, 'missing', 'The clip is missing');
      res.set('Content-Length', String(st.size));
      await sendFile(res, voices.store.resolve(rel), 'audio/wav');
    }),
  );

  router.delete(
    '/voices/:id',
    asyncHandler(async (req, res) => {
      const voices = voicesOr503(options);
      const { user } = getAuth(res);
      if (!(await voices.remove(user.id, req.params.id))) {
        throw new ApiError(404, 'not_found', 'No such voice');
      }
      res.status(204).end();
    }),
  );

  router.post(
    '/voices/samples',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const { user } = getAuth(res);
      const job = await attempt(() => tts.startVoiceSample(user.id, body(req)));
      res.status(202).json({ job: workerJobView(job) });
    }),
  );

  router.get('/voices/samples/latest', (_req, res) => {
    const { user } = getAuth(res);
    const job = options.tts?.latestSample(user.id) ?? null;
    res.json({ job: job ? workerJobView(job) : null });
  });

  router.post(
    '/voices/samples/:id/keep',
    asyncHandler(async (req, res) => {
      const tts = ttsOr503(options);
      const { user } = getAuth(res);
      const voice = await attempt(() => tts.keepSample(user.id, id(req.params.id)));
      res.status(201).json({ voice: voiceView(voice) });
    }),
  );

  // ------------------------------------------------------------ models

  router.get('/tts/models', (_req, res) => {
    res.json({
      available: Boolean(options.models && options.tts),
      models: options.models ? options.models.list().map(modelView) : [],
    });
  });

  router.post(
    '/tts/models',
    asyncHandler(async (req, res) => {
      const models = modelsOr503(options);
      const model = await attempt(() => models.add(body(req)));
      res.status(201).json({ model: modelView(model) });
    }),
  );

  router.delete('/tts/models/:id', (req, res) => {
    const models = modelsOr503(options);
    if (!models.remove(id(req.params.id))) throw new ApiError(404, 'not_found', 'No such model');
    res.status(204).end();
  });

  router.put('/tts/models/:id/default', (req, res) => {
    const models = modelsOr503(options);
    if (!models.setDefault(id(req.params.id)))
      throw new ApiError(404, 'not_found', 'No such model');
    res.json({ models: models.list().map(modelView) });
  });

  return router;
}
