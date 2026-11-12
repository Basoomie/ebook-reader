/**
 * /api/v1 audio routes (WP15a): the audiobook and subtitle index, match
 * suggestions for a book, search, and streaming of an indexed audio file.
 *
 * Nothing here links a book to an audiobook (that is the user's choice in the
 * picker; links are in link-routes.ts, WP15b). Streaming accepts a signed URL (an <audio> element can't send
 * the token) or the usual Bearer token, like thumbnails.
 */
import type Database from 'better-sqlite3';
import express, { type Request, RequestHandler, type Response, Router } from 'express';
import path from 'path';
import { pipeline } from 'stream/promises';
import { getLibrary, listLibraries } from '../calibre/libraries';
import { CatalogUser, getBookFor } from '../catalog/queries';
import { AUDIO_URL_SECRET, getOrCreateSecret, sign, verify } from '../db/secrets';
import { getAuth, requireUser } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { openAudioStream, resolveInsideAudio, statAudioFile } from './audio-fs';
import {
  type AudioFolder,
  getAudioFolder,
  getScanState,
  listAudioFolders,
  listSubtitleFiles,
  requestAudioScan,
} from './audio-index';
import { looksLikeCopies, rankEntries, searchMatches } from './match';
import type { ClipService } from './clip-service';
import type { MergeService } from './merge-service';
import type { SubtitleJobService } from './subtitle-jobs';
import { DEFAULT_AUDIO } from '../config';
import type { AudioScanService } from './scan-service';
import {
  folderSummary,
  subtitleSummary,
  type FolderSummary,
  type SubtitleSummary,
} from './summary';

export interface AudioOptions {
  /** null = audio linking is off (AUDIOBOOKS_DIR unset or unusable). */
  service: AudioScanService | null;
  /** WP15f: the copies hint thresholds (AUDIO_COPY_HINT_*); defaults when omitted. */
  copyHint?: { minMinutes: number; percent: number };
  /** WP15f: the merge job; null/omitted = merging is off. */
  merges?: MergeService | null;
  /** WP14: sentence-audio clips for Anki; null/omitted = off. */
  clips?: ClipService | null;
  /** WP16: the GPU worker's job queue (SubPlz subtitles); null/omitted = off. */
  jobs?: SubtitleJobService | null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
};

/** A file's version: changes when it is replaced, so an old URL stops working. */
export function fileVersion(size: number, mtimeMs: number): string {
  return `${size.toString(36)}-${mtimeMs.toString(36)}`;
}

function streamMessage(userId: string, folderId: number, index: number, version: string): string {
  return `audio:${userId}:${folderId}:${index}:${version}`;
}

/** Signed URL for one file of an indexed folder (relative to the server origin). */
export function audioFileUrl(
  db: Database.Database,
  user: CatalogUser,
  folder: AudioFolder,
  index: number,
): string {
  const file = folder.files[index];
  const version = fileVersion(file.size, file.mtimeMs);
  const sig = sign(
    getOrCreateSecret(db, AUDIO_URL_SECRET),
    streamMessage(user.id, folder.id, index, version),
  );
  return `/api/v1/audio/files/${folder.id}/${index}?v=${version}&u=${encodeURIComponent(user.id)}&s=${sig}`;
}

function verifyAudioUrl(
  db: Database.Database,
  folderId: number,
  index: number,
  q: { u?: string; v?: string; s?: string },
): CatalogUser | null {
  if (!q.u || !q.v || !q.s) return null;
  const key = getOrCreateSecret(db, AUDIO_URL_SECRET);
  return verify(key, streamMessage(q.u, folderId, index, q.v), q.s) ? { id: q.u } : null;
}

const queryString = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * A single `bytes=` range (RFC 9110). Returns null to send the whole file (no
 * header, or a form we don't serve such as several ranges), or 'unsatisfiable'.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export function requireAudio(options: AudioOptions): AudioScanService {
  const service = options.service;
  if (!service || !service.status.enabled) {
    throw new ApiError(
      503,
      'audio_off',
      `Audiobooks unavailable: ${service?.status.error ?? 'AUDIOBOOKS_DIR is not set'}`,
    );
  }
  return service;
}

function parseId(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new ApiError(404, 'not_found', 'No such audiobook folder');
  return n;
}

/**
 * Streams one file of an indexed folder (single byte ranges, HEAD, `v` = the file version
 * the URL was made for). Read-only. Also used by the GPU worker's download (WP16).
 */
export async function sendAudioFile(
  service: AudioScanService,
  folder: AudioFolder,
  index: number,
  req: Request,
  res: Response,
): Promise<void> {
  if (folder.missingAt !== null) {
    throw new ApiError(410, 'missing', 'This audiobook is no longer in the audiobooks folder');
  }
  const entry = folder.files[index];
  const fileMissing = () => new ApiError(404, 'file_missing', 'The audio file was not found');
  let file: string;
  try {
    file = resolveInsideAudio(service.root, `${folder.relPath}/${entry.name}`);
  } catch {
    throw fileMissing();
  }
  const stat = await statAudioFile(file);
  if (!stat) throw fileMissing();
  const version = fileVersion(stat.size, stat.mtimeMs);
  if (req.query.v !== undefined && req.query.v !== version) {
    throw new ApiError(409, 'changed', 'The audio file changed since this link was made');
  }

  res.set('Accept-Ranges', 'bytes');
  res.set(
    'Content-Type',
    CONTENT_TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
  );
  res.set('ETag', `"${version}"`);
  res.set('Last-Modified', new Date(stat.mtimeMs).toUTCString());
  res.set('Cache-Control', 'private, max-age=86400');
  // The book page's Download menu: the browser saves the file instead of playing it
  // (the web app is on another origin, where <a download> is ignored).
  if (req.query.download === '1') {
    res.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    );
  }

  const range = parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    res.set('Content-Range', `bytes */${stat.size}`);
    throw new ApiError(416, 'range_not_satisfiable', 'Requested range is outside the file');
  }
  if (range) {
    res.status(206);
    res.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.set('Content-Length', String(range.end - range.start + 1));
  } else {
    res.set('Content-Length', String(stat.size));
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  let stream;
  try {
    stream = await openAudioStream(file, range ?? undefined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw fileMissing();
    throw err;
  }
  try {
    await pipeline(stream, res);
  } catch (err) {
    // The player seeked or stopped; nothing to report.
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw err;
  }
}

/** The stream route: signed URL or token. Mounted before requireUser. */
export function audioStreamRoute(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();
  const bearer = requireUser(db);
  const auth: RequestHandler = (req, res, next) => {
    const signed = verifyAudioUrl(db, Number(req.params.folderId), Number(req.params.index), {
      u: queryString(req.query.u),
      v: queryString(req.query.v),
      s: queryString(req.query.s),
    });
    if (signed) {
      next();
      return;
    }
    bearer(req, res, next);
  };

  router.get(
    '/audio/files/:folderId/:index',
    auth,
    asyncHandler(async (req, res) => {
      const service = requireAudio(options);
      const folder = getAudioFolder(db, parseId(req.params.folderId));
      const index = Number(req.params.index);
      if (!folder || !Number.isInteger(index) || index < 0 || index >= folder.files.length) {
        throw new ApiError(404, 'not_found', 'No such audio file');
      }
      await sendAudioFile(service, folder, index, req, res);
    }),
  );
  return router;
}

const MAX_SEARCH_RESULTS = 50;

/** The index, suggestions and search. Mounted behind requireUser. */
export function createAudioRouter(db: Database.Database, options: AudioOptions): Router {
  const router = express.Router();

  router.get('/audio/status', (_req, res) => {
    const service = options.service;
    const libraries = listLibraries(db)
      .filter((l) => l.audioDir || l.srtArchivePath)
      .map((l) => {
        const s = getScanState(db, l.id);
        const pending = listAudioFolders(db, l.id).reduce(
          (n, f) =>
            n + f.files.filter((x) => x.durationSeconds === null && !x.durationFailed).length,
          0,
        );
        return {
          id: l.id,
          name: l.name,
          audioDir: l.audioDir,
          subtitleDir: l.srtArchivePath,
          status: s.status,
          scannedAt: s.scannedAt,
          folders: s.folders,
          subtitles: s.subtitles,
          archivesSkipped: s.archivesSkipped,
          durationsPending: pending,
          scanRequested: s.scanRequestedAt !== null,
          lastError: s.lastError,
          lastErrorAt: s.lastErrorAt,
        };
      });
    res.json({
      enabled: service?.status.enabled ?? false,
      error: service ? service.status.error : 'AUDIOBOOKS_DIR is not set',
      merge: options.merges
        ? options.merges.availability()
        : { available: false, reason: 'Merging is not set up on this server' },
      libraries,
    });
  });

  router.post('/audio/scan', (req, res) => {
    const service = requireAudio(options);
    const libraryId = (req.body as { libraryId?: unknown } | undefined)?.libraryId;
    const targets =
      typeof libraryId === 'string'
        ? [getLibrary(db, libraryId)].filter((l) => l && (l.audioDir || l.srtArchivePath))
        : service.libraries();
    if (targets.length === 0) {
      throw new ApiError(404, 'not_found', 'No library with an audio or subtitle folder');
    }
    for (const lib of targets) requestAudioScan(db, lib!.id);
    service.wake();
    res.status(202).json({ requested: targets.map((l) => l!.id) });
  });

  router.get('/audio/folders/:id', (req, res) => {
    requireAudio(options);
    const { user } = getAuth(res);
    const folder = getAudioFolder(db, parseId(req.params.id));
    if (!folder) throw new ApiError(404, 'not_found', 'No such audiobook folder');
    res.json({
      ...folderSummary(folder),
      metaTitle: folder.metaTitle,
      metaSeries: folder.metaSeries,
      metaSequence: folder.metaSequence,
      looksLikeCopies: looksLikeCopies(
        folder.files.map((f) => f.durationSeconds),
        options.copyHint ?? {
          minMinutes: DEFAULT_AUDIO.copyHintMinMinutes,
          percent: DEFAULT_AUDIO.copyHintPercent,
        },
      ),
      files: folder.files.map((f, index) => ({
        index,
        name: f.name,
        size: f.size,
        durationSeconds: f.durationSeconds,
        url: audioFileUrl(db, user, folder, index),
      })),
    });
  });

  /** Search box: ?q=, ?kind=audio|subtitle (default audio), ?library= (default: every library). */
  router.get('/audio/search', (req, res) => {
    requireAudio(options);
    const q = queryString(req.query.q) ?? '';
    const kind = req.query.kind === 'subtitle' ? 'subtitle' : 'audio';
    const libraryId = queryString(req.query.library);
    const libs = listLibraries(db).filter(
      (l) =>
        (libraryId ? l.id === libraryId : true) &&
        (kind === 'audio' ? l.audioDir : l.srtArchivePath),
    );
    if (q.trim() === '') {
      res.json(kind === 'audio' ? { audio: [] } : { subtitles: [] });
      return;
    }
    if (kind === 'audio') {
      const audio: FolderSummary[] = [];
      for (const l of libs) {
        for (const f of listAudioFolders(db, l.id)) {
          if (
            searchMatches(q, f.name, f.relPath) ||
            (f.metaSeries && searchMatches(q, f.metaSeries, ''))
          ) {
            audio.push(folderSummary(f));
            if (audio.length >= MAX_SEARCH_RESULTS) break;
          }
        }
      }
      res.json({ audio });
    } else {
      const subtitles: SubtitleSummary[] = [];
      for (const l of libs) {
        for (const s of listSubtitleFiles(db, l.id)) {
          if (searchMatches(q, s.name, s.relPath)) {
            subtitles.push(subtitleSummary(s));
            if (subtitles.length >= MAX_SEARCH_RESULTS) break;
          }
        }
      }
      res.json({ subtitles });
    }
  });

  /** Ranked suggestions for the confirmation picker. Never links anything. */
  router.get(
    '/books/:id/audio/candidates',
    asyncHandler(async (req, res) => {
      requireAudio(options);
      const { user } = getAuth(res);
      if (!getBookFor(db, user, req.params.id))
        throw new ApiError(404, 'not_found', 'No such book');
      const book = db
        .prepare(
          `SELECT b.id, b.title, b.library_id, b.series_index, se.name AS series_name
           FROM books b LEFT JOIN series se ON se.id = b.series_id WHERE b.id = ?`,
        )
        .get(req.params.id) as {
        id: string;
        title: string;
        library_id: string;
        series_index: number | null;
        series_name: string | null;
      };
      const lib = getLibrary(db, book.library_id);
      const forMatch = {
        title: book.title,
        seriesName: book.series_name,
        seriesIndex: book.series_name ? book.series_index : null,
      };
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      const audio = lib?.audioDir
        ? rankEntries(forMatch, listAudioFolders(db, lib.id), limit).map((s) => ({
            ...folderSummary(s.entry),
            score: s.score,
            tier: s.tier,
          }))
        : [];
      const subtitles = lib?.srtArchivePath
        ? rankEntries(
            forMatch,
            listSubtitleFiles(db, lib.id).map((s) => ({ ...s, fileCount: 1 })),
            limit,
          ).map((s) => ({ ...subtitleSummary(s.entry), score: s.score, tier: s.tier }))
        : [];
      res.json({
        book: {
          id: book.id,
          title: book.title,
          seriesName: book.series_name,
          seriesIndex: book.series_index,
          libraryId: book.library_id,
        },
        libraryHasAudio: Boolean(lib?.audioDir),
        libraryHasSubtitles: Boolean(lib?.srtArchivePath),
        audio,
        subtitles,
      });
    }),
  );

  return router;
}
