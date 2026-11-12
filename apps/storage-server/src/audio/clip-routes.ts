/**
 * /api/v1 sentence-audio route (WP14 "Enrich last card"). Mounted behind requireUser.
 *
 * GET /books/:id/audio-clip?start=<s>&end=<s> answers the MP3 of that time range of the
 * book's linked audiobook file. Only a link that plays (one file, still there) is used;
 * the device works out the time range from the subtitles. Read-only (see clip-service.ts).
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { getBookFor } from '../catalog/queries';
import { resolveInsideAudio } from './audio-fs';
import { getAudioFolderByRelPath } from './audio-index';
import { getLink, resolveLink } from './audio-links';
import { ClipError } from './clip-service';
import { type AudioOptions, requireAudio } from './routes';

function seconds(value: unknown, name: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(400, 'invalid_query', `${name} must be a number of seconds`);
  }
  return n;
}

export function createAudioClipRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();

  router.get(
    '/books/:id/audio-clip',
    asyncHandler(async (req, res) => {
      const service = requireAudio(options);
      const clips = options.clips;
      if (!clips)
        throw new ApiError(503, 'clip_off', 'Sentence audio is not set up on this server');
      const { user } = getAuth(res);
      if (!getBookFor(db, { id: user.id }, req.params.id)) {
        throw new ApiError(404, 'not_found', 'No such book');
      }
      const start = seconds(req.query.start, 'start');
      const end = seconds(req.query.end, 'end');
      if (end <= start) throw new ApiError(400, 'invalid_query', 'end must be after start');
      if (end - start > clips.maxSeconds) {
        throw new ApiError(
          400,
          'too_long',
          `Sentence audio can be at most ${clips.maxSeconds} seconds long`,
        );
      }

      const link = getLink(db, user.id, req.params.id);
      if (!link || link.state !== 'linked') {
        throw new ApiError(409, 'no_audiobook', 'This book has no linked audiobook');
      }
      const resolved = resolveLink(db, link);
      if (resolved.status === 'missing') {
        throw new ApiError(409, 'missing', 'The linked audiobook is no longer there');
      }
      if (resolved.status === 'changed') {
        throw new ApiError(409, 'changed', 'The linked audio file is no longer in its folder');
      }
      if (!resolved.playable || resolved.fileName === null || resolved.folderRelPath === null) {
        throw new ApiError(
          409,
          'not_one_file',
          'This audiobook is in several files; choose one file or merge them first',
        );
      }
      const duration = resolved.file?.durationSeconds ?? null;
      if (duration !== null && start >= duration) {
        throw new ApiError(400, 'out_of_range', 'start is after the end of the audiobook');
      }
      const folder = getAudioFolderByRelPath(db, resolved.folderRelPath);
      if (!folder || folder.missingAt !== null) {
        throw new ApiError(409, 'missing', 'The linked audiobook is no longer there');
      }
      const file = resolveInsideAudio(service.root, `${folder.relPath}/${resolved.fileName}`);
      let clip: Buffer;
      try {
        clip = await clips.cut(file, start, duration !== null ? Math.min(end, duration) : end);
      } catch (err) {
        if (err instanceof ClipError) throw new ApiError(err.status, err.code, err.message);
        throw err;
      }
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Length', String(clip.length));
      res.end(clip);
    }),
  );

  return router;
}
