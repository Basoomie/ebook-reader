/**
 * The library's bulk downloads (select mode's Download menu): which files the selected
 * books offer, their sizes, and the entries of a ZIP of one kind.
 *
 * The same rules as the book page's Download menu (web `book-download.ts`): Book = the
 * EPUB of a book still in the library; Cover = the full-size cover of a book that has one;
 * Audiobook = a link to one audio file that is there; SRT = a linked subtitle file that
 * is there. Sizes come from what the server already stored (the catalog's file size,
 * cover.jpg's size from the thumbnail check, the audio index), so a plan reads no disk.
 * A ZIP's entries are stat'ed when it is prepared, so its exact size is known.
 *
 * Read-only: files are opened through calibre/source-fs.ts, audio/audio-fs.ts and the
 * upload store, never written.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { Readable } from 'stream';
import { openAudioStream, resolveInsideAudio, statAudioFile } from '../audio/audio-fs';
import { getLink, listLinks, resolveLink } from '../audio/audio-links';
import { getAudioFolderByRelPath } from '../audio/audio-index';
import { linkPlayUrl } from '../audio/link-routes';
import { openSourceStream } from '../calibre/source-fs';
import type { ThumbnailService } from '../thumbnails/thumbnails';
import type { UploadStore } from '../uploads/upload-store';
import { locateCalibreFile } from './file-hashes';
import { type CatalogUser, getBookFileFor, SQL_CATALOG_SOURCE } from './queries';
import { uniqueNames, type ZipEntry } from './zip-stream';

export const DOWNLOAD_KINDS = ['book', 'cover', 'audio', 'subtitles'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

/** Most ids one plan or ZIP takes (a whole library of ~60k books fits). */
export const MAX_DOWNLOAD_IDS = 200_000;

export interface KindTotal {
  /** Books that offer this kind. */
  count: number;
  /** The known sizes added up. */
  bytes: number;
  /** Books of `count` whose size isn't known (left out of `bytes`). */
  unknown: number;
}

export interface DownloadPlanItem {
  id: string;
  title: string;
  book: { size: number | null } | null;
  cover: { size: number | null } | null;
  /** The signed URL of the linked file (the same as the book page's). */
  audio: { size: number | null; name: string; url: string } | null;
  subtitles: { size: number | null; name: string } | null;
}

export interface DownloadPlan {
  /** Selected ids the catalog doesn't show (unknown, or a disabled library). */
  unknown: number;
  totals: Record<DownloadKind, KindTotal>;
  items: DownloadPlanItem[];
}

interface BookRow {
  id: string;
  title: string;
  file_path: string | null;
  file_size: number | null;
  has_cover: number;
  missing: number;
  available: number;
  cover_bytes: number | null;
}

const CHUNK = 500;

/** A title made safe for a file name, as the web app's `fileTitle` does. */
export function fileTitle(title: string | undefined, max = 100): string {
  return (title ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

const COVER_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The names the book page's Download menu gives (web `book-download.ts`). */
export function epubName(title: string): string {
  return `${fileTitle(title) || 'book'}.epub`;
}

export function coverName(title: string, type = 'image/jpeg'): string {
  return `${fileTitle(title) || 'book'}-cover.${COVER_EXTENSIONS[type] ?? 'jpg'}`;
}

/**
 * What each selected book offers, and the totals per kind. `audioOn` = the audiobooks
 * folder is mounted (without it nothing can be streamed, so no audio or SRT is offered).
 */
export function downloadPlan(
  db: Database.Database,
  user: CatalogUser,
  ids: readonly string[],
  { audioOn }: { audioOn: boolean },
): DownloadPlan {
  const unique = [...new Set(ids)];
  const rows = new Map<string, BookRow>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const found = db
      .prepare(
        `SELECT b.id, b.title, s.file_path, s.file_size, s.has_cover,
                (s.missing_at IS NOT NULL) AS missing, l.available, t.cover_bytes
           FROM books b
           JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
           JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
           LEFT JOIN thumbnails t ON t.book_id = b.id
          WHERE b.id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as BookRow[];
    for (const r of found) rows.set(r.id, r);
  }
  const links = new Map(audioOn ? listLinks(db, user.id).map((l) => [l.bookId, l] as const) : []);
  const totals = Object.fromEntries(
    DOWNLOAD_KINDS.map((k) => [k, { count: 0, bytes: 0, unknown: 0 }]),
  ) as Record<DownloadKind, KindTotal>;
  const add = (kind: DownloadKind, size: number | null) => {
    totals[kind].count++;
    if (size === null) totals[kind].unknown++;
    else totals[kind].bytes += size;
  };
  const items: DownloadPlanItem[] = [];
  for (const id of unique) {
    const row = rows.get(id);
    if (!row) continue;
    const present = row.missing === 0;
    const item: DownloadPlanItem = {
      id,
      title: row.title,
      book: present && row.file_path ? { size: row.file_size } : null,
      cover:
        present && row.has_cover === 1 && row.available === 1 ? { size: row.cover_bytes } : null,
      audio: null,
      subtitles: null,
    };
    const link = links.get(id);
    if (link) {
      const resolved = resolveLink(db, link);
      const url = linkPlayUrl(db, user, resolved);
      if (url && resolved.file) {
        item.audio = { size: resolved.file.size, name: resolved.file.name, url };
      }
      if (
        resolved.state === 'linked' &&
        resolved.subtitleState === 'linked' &&
        resolved.subtitleStatus === 'ok' &&
        resolved.subtitleRelPath
      ) {
        item.subtitles = {
          size: resolved.subtitle?.size ?? null,
          name: resolved.subtitle?.name || path.posix.basename(resolved.subtitleRelPath),
        };
      }
    }
    if (item.book) add('book', item.book.size);
    if (item.cover) add('cover', item.cover.size);
    if (item.audio) add('audio', item.audio.size);
    if (item.subtitles) add('subtitles', item.subtitles.size);
    items.push(item);
  }
  return { unknown: unique.length - items.length, totals, items };
}

export interface ZipSources {
  calibreDir: string | null;
  uploads: UploadStore | null;
  thumbnails: ThumbnailService | null;
  /** The audiobooks folder, or null when it isn't mounted. */
  audioRoot: string | null;
}

export interface PreparedZip {
  entries: ZipEntry[];
  /** Titles of the books whose file couldn't be found (left out of the archive). */
  skipped: string[];
}

/** How many files are stat'ed at once while a ZIP is prepared. */
const STAT_CONCURRENCY = 8;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type Located = { name: string; size: number; open: () => Promise<Readable> } | null;

/**
 * The entries of a ZIP of one kind for the given books, each file stat'ed now (its size
 * then is the entry's size). Books that don't offer the kind are not part of it; a file
 * that can't be found is reported in `skipped`.
 */
export async function prepareZip(
  db: Database.Database,
  user: CatalogUser,
  ids: readonly string[],
  kind: DownloadKind,
  sources: ZipSources,
  {
    signal,
    onProgress,
  }: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<PreparedZip> {
  const plan = downloadPlan(db, user, ids, { audioOn: sources.audioRoot !== null });
  const offered = plan.items.filter((item) => item[kind] !== null);
  let done = 0;
  onProgress?.(0, offered.length);
  const located = await mapLimited(offered, STAT_CONCURRENCY, async (item) => {
    if (signal?.aborted) return null;
    try {
      return await locate(db, user, item, kind, sources);
    } catch {
      return null;
    } finally {
      onProgress?.(++done, offered.length);
    }
  });
  if (signal?.aborted) throw new Error('aborted');
  const found: { item: DownloadPlanItem; file: NonNullable<Located> }[] = [];
  const skipped: string[] = [];
  offered.forEach((item, i) => {
    const file = located[i];
    if (file) found.push({ item, file });
    else skipped.push(item.title);
  });
  const names = uniqueNames(found.map((f) => f.file.name));
  return {
    entries: found.map((f, i) => ({ name: names[i], size: f.file.size, open: f.file.open })),
    skipped,
  };
}

async function locate(
  db: Database.Database,
  user: CatalogUser,
  item: DownloadPlanItem,
  kind: DownloadKind,
  sources: ZipSources,
): Promise<Located> {
  switch (kind) {
    case 'book': {
      const location = getBookFileFor(db, user, item.id);
      if (!location || location.missing) return null;
      const name = epubName(item.title);
      if (location.kind === 'upload') {
        const store = sources.uploads;
        const st = store ? await store.stat(location.filePath).catch(() => null) : null;
        if (!store || !st) return null;
        return { name, size: st.size, open: () => store.openStream(location.filePath) };
      }
      if (!sources.calibreDir) return null;
      const found = await locateCalibreFile(sources.calibreDir, location);
      if (!found) return null;
      return { name, size: found.stat.size, open: () => openSourceStream(found.file) };
    }
    case 'cover': {
      const cover = await sources.thumbnails?.coverForDownload(item.id);
      if (!cover) return null;
      if (cover.kind === 'data') {
        const data = cover.data;
        return {
          name: coverName(item.title, cover.type),
          size: data.length,
          open: async () => Readable.from([data]),
        };
      }
      // Calibre saves every cover as JPEG (cover.jpg).
      const file = cover.file;
      return { name: coverName(item.title), size: cover.size, open: () => openSourceStream(file) };
    }
    case 'audio': {
      const root = sources.audioRoot;
      const link = root ? listLinkFor(db, user, item.id) : null;
      if (!root || !link?.folderRelPath || !link.fileName) return null;
      const folder = getAudioFolderByRelPath(db, link.folderRelPath);
      if (!folder || folder.missingAt !== null) return null;
      return audioFile(root, `${folder.relPath}/${link.fileName}`, link.fileName);
    }
    case 'subtitles': {
      const root = sources.audioRoot;
      const link = root ? listLinkFor(db, user, item.id) : null;
      if (!root || !link?.subtitleRelPath || !item.subtitles) return null;
      return audioFile(root, link.subtitleRelPath, item.subtitles.name);
    }
  }
}

function listLinkFor(db: Database.Database, user: CatalogUser, bookId: string) {
  return getLink(db, user.id, bookId);
}

async function audioFile(root: string, relPath: string, name: string): Promise<Located> {
  let file: string;
  try {
    file = resolveInsideAudio(root, relPath);
  } catch {
    return null;
  }
  const st = await statAudioFile(file);
  if (!st) return null;
  const size = st.size;
  return {
    name,
    size,
    // Only the stat'ed length is read; a file that got shorter stops the archive.
    open: () => openAudioStream(file, size > 0 ? { start: 0, end: size - 1 } : undefined),
  };
}
