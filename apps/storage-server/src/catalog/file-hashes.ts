/**
 * Book file hashes (Season 2 §2, "Cached book whose Calibre file changed"): the SHA-256 of
 * a book's current EPUB, so a device can tell whether the file it stored is still the
 * library's file. Calibre's last_modified (and so the download's ETag) changes on any
 * metadata edit, and the cleanup's handoff points a book at another, byte-identical copy;
 * neither changes the hash.
 *
 * - Calibre books: the file is found the same way the download finds it (locateCalibreFile,
 *   including a folder Calibre moved since the last index), stat'ed, and hashed only when
 *   its size or modified time differ from the stored ones (table file_hashes, migration 18;
 *   the path doesn't matter, so a moved folder keeps its hash). Read-only through source-fs.
 * - Uploads: their content hash (written once when uploaded; the file never changes).
 * - A book that is missing, unknown or whose file can't be found: null.
 */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import path from 'path';
import { pipeline } from 'stream/promises';
import { fileIdentity } from '../calibre/file-identity';
import { currentCalibreEpub } from '../calibre/live-lookup';
import { openSourceStream, resolveInside, statFile, type SourceStat } from '../calibre/source-fs';
import { getBookFileFor, type BookFileLocation, type CatalogUser } from './queries';

export interface FileHashAnswer {
  id: string;
  sha256: string | null;
  /** The ETag the download sends for this file now (null when there is no file). */
  etag: string | null;
}

/**
 * Where a Calibre book's EPUB is now, or null when it can't be found. A stored path that
 * would leave the library folder is never followed. A folder Calibre moved since the last
 * index (a title or author change) is found by the book's Calibre UUID.
 */
export async function locateCalibreFile(
  calibreDir: string,
  location: BookFileLocation,
): Promise<{ file: string; stat: SourceStat } | null> {
  const libraryDir = path.join(calibreDir, location.libraryFolder);
  let file: string;
  try {
    file = resolveInside(libraryDir, location.filePath);
  } catch {
    return null;
  }
  let stat = await statFile(file);
  if (!stat && location.calibreUuid) {
    const moved = await currentCalibreEpub(libraryDir, location.calibreUuid, location.calibreId);
    if (moved) {
      try {
        file = resolveInside(libraryDir, moved);
      } catch {
        return null;
      }
      stat = await statFile(file);
    }
  }
  return stat ? { file, stat } : null;
}

/** The download's ETag for a Calibre file (catalog-routes.ts sendBookFile). */
export function calibreEtag(location: BookFileLocation, size: number): string {
  return `"${location.calibreLastModified ?? 0}-${size}"`;
}

/** The download's ETag for an uploaded file. */
export function uploadEtag(location: BookFileLocation, size: number): string {
  return `"upload-${location.contentHash ?? size}"`;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(await openSourceStream(file), hash);
  return hash.digest('hex');
}

interface StoredHash {
  bytes: number;
  mtime_ns: string;
  sha256: string;
}

export interface FileHashOptions {
  calibreDir: string | null;
  /** Size of an uploaded file (the upload store), for its ETag; null when it isn't there. */
  uploadSize?: (filePath: string) => Promise<number | null>;
  now?: () => number;
}

/** The hash of each book's current file, in the given order. */
export async function fileHashes(
  db: Database.Database,
  user: CatalogUser,
  ids: readonly string[],
  options: FileHashOptions,
): Promise<FileHashAnswer[]> {
  const now = options.now ?? Date.now;
  const read = db.prepare('SELECT bytes, mtime_ns, sha256 FROM file_hashes WHERE book_id = ?');
  const write = db.prepare(
    `INSERT INTO file_hashes (book_id, bytes, mtime_ns, sha256, hashed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET bytes = excluded.bytes, mtime_ns = excluded.mtime_ns,
       sha256 = excluded.sha256, hashed_at = excluded.hashed_at`,
  );
  const out: FileHashAnswer[] = [];
  for (const id of ids) {
    const none = { id, sha256: null, etag: null };
    const location = getBookFileFor(db, user, id);
    if (!location || location.missing) {
      out.push(none);
      continue;
    }
    if (location.kind === 'upload') {
      const size = options.uploadSize ? await options.uploadSize(location.filePath) : null;
      out.push(
        size === null
          ? none
          : { id, sha256: location.contentHash, etag: uploadEtag(location, size) },
      );
      continue;
    }
    if (!options.calibreDir) {
      out.push(none);
      continue;
    }
    const found = await locateCalibreFile(options.calibreDir, location);
    const identity = found ? await fileIdentity(found.file) : null;
    if (!found || !identity) {
      out.push(none);
      continue;
    }
    const etag = calibreEtag(location, found.stat.size);
    const stored = read.get(id) as StoredHash | undefined;
    if (stored && stored.bytes === identity.bytes && stored.mtime_ns === identity.mtimeNs) {
      out.push({ id, sha256: stored.sha256, etag });
      continue;
    }
    let sha256: string;
    try {
      sha256 = await sha256Of(found.file);
    } catch {
      out.push(none);
      continue;
    }
    write.run(id, identity.bytes, identity.mtimeNs, sha256, now());
    out.push({ id, sha256, etag });
  }
  return out;
}
