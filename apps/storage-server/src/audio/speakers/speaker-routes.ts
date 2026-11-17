/**
 * Season 2 Phase 12 session 5 routes: per-character voices.
 *
 * - The PC's routes (worker token; mounted before the WP16 worker router, whose catch-all
 *   answers 404): the next request of a speaker job, its answer, making way (release), and
 *   the speaker model list (so the PC deletes removed models' files). Progress and failures
 *   use the WP16 routes.
 * - The user's routes (behind requireUser): a book's speakers (overview, run, characters,
 *   quotes, who reads the narration) and the speaker model list (Settings > Audiobooks).
 * Stop uses the WP16 route (POST /audio/subtitle-jobs/:id/cancel works for every kind).
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth, requireWorker } from '../../api/auth';
import { ApiError, asyncHandler } from '../../api/errors';
import { getBookFor } from '../../catalog/queries';
import { JobRequestError } from '../subtitle-jobs';
import { ModelRequestError } from '../tts-models';
import { workerJobView } from '../worker-routes';
import { parseBelow, type SpeakerBookService } from './speaker-book';
import type { SpeakerJobService } from './speaker-jobs';
import { speakerModelDir, type SpeakerModel, type SpeakerModelService } from './speaker-models';
import { SpeakerEditError, type SpeakerStore } from './speaker-store';
import type { SpeakerVoices, VoiceLookup } from './speaker-voices';

/** Bodies the JSON parser must skip: a speaker answer (with token probabilities) is large. */
export const SPEAKER_RAW_PATHS = [/^\/worker\/jobs\/\d+\/speakers\/\d+$/];

export interface SpeakerOptions {
  speakerJobs?: SpeakerJobService | null;
  speakerBook?: SpeakerBookService | null;
  speakerModels?: SpeakerModelService | null;
  speakerStore?: SpeakerStore | null;
  speakerVoices?: SpeakerVoices | null;
  /** Voice presets (a character's voice must be one). */
  voices?: VoiceLookup | null;
}

const answerJson = express.json({ limit: '8mb' });

function rethrow(err: unknown): never {
  if (
    err instanceof JobRequestError ||
    err instanceof ModelRequestError ||
    err instanceof SpeakerEditError
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

const num = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(404, 'not_found', 'Not found');
  return n;
};

function off(): never {
  throw new ApiError(503, 'speakers_off', 'Per-character voices are not set up on this server');
}

export function modelView(m: SpeakerModel) {
  return {
    id: m.id,
    repo: m.repo,
    file: m.file,
    revision: m.revision,
    size: m.size,
    label: m.label,
    isDefault: m.isDefault,
  };
}

export function createSpeakerWorkerRouter(db: Database.Database, o: SpeakerOptions): Router {
  const router = express.Router();
  router.use('/worker/jobs/:id/speakers', requireWorker(db));
  router.use('/worker/speaker-models', requireWorker(db));

  router.post('/worker/jobs/:id/speakers/next', (req, res) => {
    const jobs = o.speakerJobs ?? off();
    try {
      res.json(jobs.next(num(req.params.id)));
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/worker/jobs/:id/speakers/release', (req, res) => {
    const jobs = o.speakerJobs ?? off();
    try {
      res.json({ state: jobs.release(num(req.params.id)).state });
    } catch (err) {
      rethrow(err);
    }
  });

  // Worker 1.4.0: still on a long request; keeps the lease and says whether to stop or make way.
  router.post('/worker/jobs/:id/speakers/working', (req, res) => {
    const jobs = o.speakerJobs ?? off();
    try {
      res.json(jobs.working(num(req.params.id)));
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/worker/jobs/:id/speakers/:seq', answerJson, (req, res) => {
    const jobs = o.speakerJobs ?? off();
    try {
      res.json(jobs.answer(num(req.params.id), num(req.params.seq), req.body));
    } catch (err) {
      rethrow(err);
    }
  });

  router.get('/worker/speaker-models', (_req, res) => {
    const models = o.speakerModels ?? off();
    res.json({
      models: models
        .list()
        .map((m) => ({ ...modelView(m), sha256: m.sha256, dir: speakerModelDir(m) })),
      removed: models.removed().map((m) => ({ dir: speakerModelDir(m) })),
    });
  });

  return router;
}

export function createSpeakerRouter(db: Database.Database, o: SpeakerOptions): Router {
  const router = express.Router();

  const bookOr404 = (userId: string, bookId: string) => {
    if (!getBookFor(db, { id: userId }, bookId))
      throw new ApiError(404, 'not_found', 'No such book');
  };
  const changed = (userId: string, bookId: string) => o.speakerVoices?.changed(userId, bookId);

  router.get(
    '/books/:id/speakers',
    asyncHandler(async (req, res) => {
      const book = o.speakerBook ?? off();
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      const view = await attempt(() =>
        book.overview(user.id, req.params.id, parseBelow(req.query.below)),
      );
      res.json({
        ...view,
        job: view.job ? workerJobView(view.job) : null,
        models: view.models.map(modelView),
      });
    }),
  );

  router.post(
    '/books/:id/speakers/run',
    asyncHandler(async (req, res) => {
      const jobs = o.speakerJobs ?? off();
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      const modelId = (req.body as { modelId?: unknown } | undefined)?.modelId;
      const job = await attempt(() => jobs.enqueue(user.id, req.params.id, modelId));
      res.status(202).json({ job: workerJobView(job) });
    }),
  );

  router.get(
    '/books/:id/speakers/quotes',
    asyncHandler(async (req, res) => {
      const book = o.speakerBook ?? off();
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      res.json(await attempt(() => book.quotes(user.id, req.params.id, req.query)));
    }),
  );

  router.patch('/books/:id/speakers/quotes/:quote', (req, res) => {
    const store = o.speakerStore ?? off();
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    try {
      const q = store.setQuoteSpeaker(
        user.id,
        req.params.id,
        num(req.params.quote),
        req.body ?? {},
      );
      changed(user.id, req.params.id);
      res.json({ quote: q });
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/books/:id/speakers/characters', (req, res) => {
    const store = o.speakerStore ?? off();
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    try {
      const c = store.addCharacter(user.id, req.params.id, (req.body as { name?: unknown })?.name);
      changed(user.id, req.params.id);
      res.status(201).json({ character: c });
    } catch (err) {
      rethrow(err);
    }
  });

  router.patch('/books/:id/speakers/characters/:cid', (req, res) => {
    const store = o.speakerStore ?? off();
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    try {
      const c = store.editCharacter(
        user.id,
        req.params.id,
        num(req.params.cid),
        req.body ?? {},
        (voiceId) => !!o.voices?.byId(voiceId),
      );
      changed(user.id, req.params.id);
      res.json({ character: c });
    } catch (err) {
      rethrow(err);
    }
  });

  router.post('/books/:id/speakers/characters/:cid/merge', (req, res) => {
    const store = o.speakerStore ?? off();
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    try {
      const into = Number((req.body as { into?: unknown })?.into);
      if (!Number.isInteger(into))
        throw new ApiError(400, 'invalid_body', 'Choose the character to merge into');
      const c = store.merge(user.id, req.params.id, num(req.params.cid), into);
      changed(user.id, req.params.id);
      res.json({ character: c });
    } catch (err) {
      rethrow(err);
    }
  });

  router.put('/books/:id/speakers/narration', (req, res) => {
    const store = o.speakerStore ?? off();
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    try {
      const by = store.setNarrationBy(user.id, req.params.id, (req.body as { by?: unknown })?.by);
      changed(user.id, req.params.id);
      res.json({ narrationBy: by });
    } catch (err) {
      rethrow(err);
    }
  });

  // Settings > Audiobooks: the speaker model list.
  router.get('/speaker-models', (_req, res) => {
    const models = o.speakerModels ?? off();
    res.json({ models: models.list().map(modelView) });
  });

  router.post(
    '/speaker-models',
    asyncHandler(async (req, res) => {
      const models = o.speakerModels ?? off();
      const body = (req.body ?? {}) as { repo?: unknown; file?: unknown; label?: unknown };
      const m = await attempt(() => models.add(body));
      res.status(201).json({ model: modelView(m) });
    }),
  );

  router.delete('/speaker-models/:mid', (req, res) => {
    const models = o.speakerModels ?? off();
    if (!models.remove(num(req.params.mid))) throw new ApiError(404, 'not_found', 'No such model');
    res.json({ ok: true });
  });

  router.put('/speaker-models/:mid/default', (req, res) => {
    const models = o.speakerModels ?? off();
    if (!models.setDefault(num(req.params.mid)))
      throw new ApiError(404, 'not_found', 'No such model');
    res.json({ ok: true });
  });

  return router;
}
