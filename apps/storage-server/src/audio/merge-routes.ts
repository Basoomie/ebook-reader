/**
 * /api/v1 merge routes (WP15f): "Merge into one file" from a book's Audiobook section.
 * Mounted behind requireUser; a user sees and stops only their own merges.
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError } from '../api/errors';
import { getBookFor } from '../catalog/queries';
import { getAudioFolder } from './audio-index';
import { type MergeJob, MergeRequestError } from './merge-service';
import { type AudioOptions, requireAudio } from './routes';

/** What the client sees of a job (no user id). */
export function jobView(job: MergeJob) {
  const { userId: _userId, ...rest } = job;
  return rest;
}

function badBody(message: string): ApiError {
  return new ApiError(400, 'invalid_body', message);
}

export function createMergeRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();

  const bookOr404 = (userId: string, bookId: string) => {
    if (!getBookFor(db, { id: userId }, bookId)) {
      throw new ApiError(404, 'not_found', 'No such book');
    }
  };

  const merges = () => {
    requireAudio(options);
    if (!options.merges) {
      throw new ApiError(503, 'merge_off', 'Merging is not set up on this server');
    }
    return options.merges;
  };

  router.post('/books/:id/audio-merge', (req, res) => {
    const service = merges();
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const body = req.body as { folderId?: unknown; files?: unknown } | undefined;
    const folderId = body?.folderId;
    if (typeof folderId !== 'number' || !Number.isInteger(folderId) || folderId < 1) {
      throw badBody('folderId must be a positive whole number');
    }
    const folder = getAudioFolder(db, folderId);
    if (!folder) throw new ApiError(404, 'not_found', 'No such audiobook folder');
    try {
      const job = service.enqueue(user.id, req.params.id, folder, body?.files);
      res.status(202).json({ job: jobView(job) });
    } catch (err) {
      if (err instanceof MergeRequestError) throw new ApiError(err.status, err.code, err.message);
      throw err;
    }
  });

  /** The book's latest merge (so the page shows progress after a reload). */
  router.get('/books/:id/audio-merge', (req, res) => {
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const job = options.merges?.latestForBook(user.id, req.params.id) ?? null;
    res.json({ job: job ? jobView(job) : null });
  });

  router.post('/audio/merges/:id/cancel', (req, res) => {
    const service = merges();
    const { user } = getAuth(res);
    const job = service.cancel(user.id, Number(req.params.id));
    if (!job) throw new ApiError(404, 'not_found', 'No such merge');
    res.json({ job: jobView(job) });
  });

  return router;
}
