/**
 * Season 2 Phase 12 routes (behind requireUser): Enrich's sentence audio read by the PC
 * (sentence-audio.ts) and the PC voice for every book and per book (tts-voice-choice.ts).
 *
 * - POST /books/:id/sentence-audio {text, position, pauses}: queue a clip (202 {clip}).
 * - GET /sentence-audio/:id: {clip, pc} (404 when unknown, fetched already or expired).
 * - GET /sentence-audio/:id/audio: the MP3.
 * - DELETE /sentence-audio/:id: the device has it, or doesn't want it any more.
 * - GET/PUT/DELETE /tts/voice-choice: the choice for every book (none = off).
 * - GET/PUT/DELETE /books/:id/tts-voice-choice: the book's own choice, and which one is used.
 */
import type Database from 'better-sqlite3';
import express, { type Request, Router } from 'express';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { getBookFor } from '../catalog/queries';
import type { AudioOptions } from './routes';
import type { SentenceAudioService } from './sentence-audio';
import { JobRequestError } from './subtitle-jobs';
import type { VoiceChoiceService } from './tts-voice-choice';

function rethrow(err: unknown): never {
  if (err instanceof JobRequestError) {
    throw new ApiError(err.status, err.code, err.message, err.details);
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

function clipsOr503(o: AudioOptions): SentenceAudioService {
  if (!o.sentenceAudio) {
    throw new ApiError(503, 'tts_off', 'Sentence audio from the PC is not set up on this server');
  }
  return o.sentenceAudio;
}

function choicesOr503(o: AudioOptions): VoiceChoiceService {
  if (!o.voiceChoices) {
    throw new ApiError(503, 'tts_off', 'PC voices are not set up on this server');
  }
  return o.voiceChoices;
}

const clipId = (value: string): string => {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new ApiError(404, 'not_found', 'No such clip');
  return value;
};

export function createSentenceAudioRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();
  const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
  const bookOr404 = (userId: string, bookId: string) => {
    if (!getBookFor(db, { id: userId }, bookId))
      throw new ApiError(404, 'not_found', 'No such book');
  };

  // ------------------------------------------------------------ clips

  router.post(
    '/books/:id/sentence-audio',
    asyncHandler(async (req, res) => {
      const clips = clipsOr503(options);
      const { user } = getAuth(res);
      bookOr404(user.id, req.params.id);
      const clip = await attempt(() => clips.queue(user.id, req.params.id, body(req)));
      res.status(202).json({ clip });
    }),
  );

  router.get('/sentence-audio/:id', (req, res) => {
    const clips = clipsOr503(options);
    const { user } = getAuth(res);
    const status = clips.status(user.id, clipId(req.params.id));
    if (!status) throw new ApiError(404, 'not_found', 'No such clip, or it was fetched already');
    res.json(status);
  });

  router.get(
    '/sentence-audio/:id/audio',
    asyncHandler(async (req, res) => {
      const clips = clipsOr503(options);
      const { user } = getAuth(res);
      const file = await clips.audioFile(user.id, clipId(req.params.id));
      if (!file) throw new ApiError(404, 'not_found', 'Not ready or no longer there');
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      try {
        await pipeline(createReadStream(file), res);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        throw err;
      }
    }),
  );

  router.delete(
    '/sentence-audio/:id',
    asyncHandler(async (req, res) => {
      const clips = clipsOr503(options);
      const { user } = getAuth(res);
      if (!(await clips.drop(user.id, clipId(req.params.id)))) {
        throw new ApiError(404, 'not_found', 'No such clip');
      }
      res.status(204).end();
    }),
  );

  // ------------------------------------------------------------ voice choices

  router.get('/tts/voice-choice', (_req, res) => {
    const choices = choicesOr503(options);
    const { user } = getAuth(res);
    res.json({ choice: choices.global(user.id) });
  });

  router.put('/tts/voice-choice', (req, res) => {
    const choices = choicesOr503(options);
    const { user } = getAuth(res);
    try {
      choices.set(user.id, null, body(req));
    } catch (err) {
      rethrow(err);
    }
    res.json({ choice: choices.global(user.id) });
  });

  router.delete('/tts/voice-choice', (_req, res) => {
    const choices = choicesOr503(options);
    const { user } = getAuth(res);
    choices.clear(user.id, null);
    res.status(204).end();
  });

  router.get('/books/:id/tts-voice-choice', (req, res) => {
    const choices = choicesOr503(options);
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    res.json(choices.forBook(user.id, req.params.id));
  });

  router.put('/books/:id/tts-voice-choice', (req, res) => {
    const choices = choicesOr503(options);
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    try {
      choices.set(user.id, req.params.id, body(req));
    } catch (err) {
      rethrow(err);
    }
    res.json(choices.forBook(user.id, req.params.id));
  });

  router.delete('/books/:id/tts-voice-choice', (req, res) => {
    const choices = choicesOr503(options);
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    choices.clear(user.id, req.params.id);
    res.json(choices.forBook(user.id, req.params.id));
  });

  return router;
}
