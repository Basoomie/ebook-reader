/**
 * /api/v1 audio link routes (WP15b): the user's confirmed audiobook and subtitle file
 * for a book. Mounted behind requireUser.
 *
 * Nothing is ever linked without the user's choice: PUT names the folder (and later the
 * subtitle file) the user tapped in the picker. A link is stored by path; reading it
 * says whether the folder is still there, and never looks for a replacement.
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError } from '../api/errors';
import { getBookFor, summariesByIds } from '../catalog/queries';
import { getAudioFolder, getSubtitleFile } from './audio-index';
import {
  type AudioLink,
  deleteLink,
  getLink,
  listLinks,
  resolveLink,
  type ResolvedAudioLink,
  saveLink,
} from './audio-links';
import { type AudioOptions, requireAudio } from './routes';

function badBody(message: string): ApiError {
  return new ApiError(400, 'invalid_body', message);
}

function positiveId(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw badBody(`${name} must be a positive whole number`);
  }
  return value;
}

/**
 * Applies a PUT body to the current link. Omitted parts are kept. Choosing a different
 * audiobook folder clears the subtitle choice, so the subtitle step asks again.
 */
export function applyLinkChange(
  db: Database.Database,
  bookId: string,
  current: AudioLink | null,
  body: unknown,
  now: number,
): AudioLink {
  if (typeof body !== 'object' || body === null) throw badBody('Expected a JSON object');
  const { audio, subtitle } = body as { audio?: unknown; subtitle?: unknown };
  if (audio === undefined && subtitle === undefined) {
    throw badBody('Nothing to change: send "audio" and/or "subtitle"');
  }

  let next: AudioLink | null = current ? { ...current } : null;

  if (audio !== undefined) {
    const a = audio as { state?: unknown; folderId?: unknown } | null;
    if (a?.state === 'linked') {
      const folder = getAudioFolder(db, positiveId(a.folderId, 'audio.folderId'));
      if (!folder) throw new ApiError(404, 'not_found', 'No such audiobook folder');
      if (folder.missingAt !== null) {
        throw new ApiError(409, 'missing', 'This audiobook is no longer in the audiobooks folder');
      }
      const same = current?.state === 'linked' && current.folderRelPath === folder.relPath;
      next = {
        bookId,
        state: 'linked',
        folderRelPath: folder.relPath,
        fileName: folder.fileCount === 1 ? folder.files[0].name : null,
        subtitleState: same ? current.subtitleState : null,
        subtitleRelPath: same ? current.subtitleRelPath : null,
        source: same ? current.source : 'library',
        confirmedAt: now,
      };
    } else if (a?.state === 'none') {
      next = {
        bookId,
        state: 'none',
        folderRelPath: null,
        fileName: null,
        subtitleState: null,
        subtitleRelPath: null,
        source: 'library',
        confirmedAt: now,
      };
    } else {
      throw badBody('audio.state must be "linked" or "none"');
    }
  }

  if (subtitle !== undefined) {
    if (!next || next.state !== 'linked') {
      throw new ApiError(400, 'no_audiobook', 'Link an audiobook before choosing subtitles');
    }
    const s = subtitle as { state?: unknown; subtitleId?: unknown } | null;
    if (s?.state === 'linked') {
      const file = getSubtitleFile(db, positiveId(s.subtitleId, 'subtitle.subtitleId'));
      if (!file) throw new ApiError(404, 'not_found', 'No such subtitle file');
      if (file.missingAt !== null) {
        throw new ApiError(
          409,
          'missing',
          'This subtitle file is no longer in the subtitle folder',
        );
      }
      next = { ...next, subtitleState: 'linked', subtitleRelPath: file.relPath };
    } else if (s?.state === 'none') {
      next = { ...next, subtitleState: 'none', subtitleRelPath: null };
    } else if (s?.state === null) {
      next = { ...next, subtitleState: null, subtitleRelPath: null };
    } else {
      throw badBody('subtitle.state must be "linked", "none" or null');
    }
  }

  return { ...next!, confirmedAt: now };
}

export interface LinkListEntry extends ResolvedAudioLink {
  book: { title: string; authors: string[]; missing: boolean } | null;
}

/** Problems first (missing, changed, several files), then by title. */
function problemRank(l: ResolvedAudioLink): number {
  if (l.state !== 'linked') return 9;
  if (l.status === 'missing') return 0;
  if (l.status === 'changed') return 1;
  if (l.folder && !l.folder.playable) return 2;
  if (l.subtitleStatus === 'missing') return 3;
  return 5;
}

export function createAudioLinkRouter(
  db: Database.Database,
  options: AudioOptions,
  { now = () => Date.now() }: { now?: () => number } = {},
): Router {
  const router = express.Router();

  const bookOr404 = (userId: string, bookId: string) => {
    const book = getBookFor(db, { id: userId }, bookId);
    if (!book) throw new ApiError(404, 'not_found', 'No such book');
    return book;
  };

  // Only stored data: works while the audiobooks folder is unavailable.
  router.get('/books/:id/audio-link', (req, res) => {
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const link = getLink(db, user.id, req.params.id);
    res.json({ link: link ? resolveLink(db, link) : null });
  });

  router.put('/books/:id/audio-link', (req, res) => {
    requireAudio(options);
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    const saved = db.transaction(() => {
      const next = applyLinkChange(
        db,
        req.params.id,
        getLink(db, user.id, req.params.id),
        req.body,
        now(),
      );
      saveLink(db, user.id, next);
      return next;
    })();
    res.json({ link: resolveLink(db, saved) });
  });

  router.delete('/books/:id/audio-link', (req, res) => {
    const { user } = getAuth(res);
    bookOr404(user.id, req.params.id);
    deleteLink(db, user.id, req.params.id);
    res.status(204).end();
  });

  /** Every link of the user, for the Audiobooks page. */
  router.get('/audio/links', (_req, res) => {
    const { user } = getAuth(res);
    const links = listLinks(db, user.id).map((l) => resolveLink(db, l));
    const summaries = summariesByIds(
      db,
      user,
      links.map((l) => l.bookId),
      null,
    );
    const rawTitle = db.prepare('SELECT title FROM books WHERE id = ?');
    const entries: LinkListEntry[] = links.map((l) => {
      const s = summaries.get(l.bookId);
      if (s) {
        return {
          ...l,
          book: { title: s.title, authors: s.authors.map((a) => a.name), missing: s.missing },
        };
      }
      // A book of a hidden library, or one the catalog no longer knows.
      const row = rawTitle.get(l.bookId) as { title: string } | undefined;
      return { ...l, book: row ? { title: row.title, authors: [], missing: true } : null };
    });
    entries.sort(
      (a, b) =>
        problemRank(a) - problemRank(b) ||
        (a.book?.title ?? a.bookId).localeCompare(b.book?.title ?? b.bookId, 'ja'),
    );
    res.json({ links: entries });
  });

  return router;
}
