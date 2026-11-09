/**
 * The ONLY module that touches the Calibre libraries (CLAUDE.md: Calibre
 * libraries are read-only to this app). Everything here is read-only:
 * stat, one-level readdir, reading or streaming a file, reading a file header and opening
 * a SQLite database read-only for the snapshot copy. There is deliberately no
 * write, mkdir, rename or delete in this file; keep it that way.
 *
 * The container also mounts the libraries read-only, and the indexer refuses
 * to run when the mount is writable (see isWritable).
 */
import Database from 'better-sqlite3';
import { constants, createReadStream, ReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { isInside } from '../db/database';

export const METADATA_DB = 'metadata.db';

export interface SourceStat {
  mtimeMs: number;
  size: number;
}

/** stat of a file, or null if it does not exist. */
export async function statFile(file: string): Promise<SourceStat | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Names of the immediate subfolders of `dir` (one level, never recursive). Skips dot-folders. */
export async function listSubfolders(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

export async function readSourceFile(file: string): Promise<Buffer> {
  return fs.readFile(file, { flag: 'r' });
}

/**
 * Opens a file for streaming (read-only, flag 'r'). Resolves once the file is
 * open, so a missing file is reported before any response is sent.
 */
export function openSourceStream(file: string): Promise<ReadStream> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { flags: 'r' });
    stream.once('open', () => resolve(stream));
    stream.once('error', reject);
  });
}

/** Opens a file for random-access reading (flag 'r'), e.g. an EPUB's ZIP directory (WP5). */
export function openSourceFile(file: string): Promise<fs.FileHandle> {
  return fs.open(file, 'r');
}

/** The first `bytes` bytes of a file (for the SQLite header check). */
export async function readHeader(file: string, bytes = 100): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Opens a Calibre metadata.db read-only. Used only as the source of the snapshot copy. */
export function openSourceDatabase(file: string): Database.Database {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/**
 * True if `dir` is writable by this process. On a read-only mount access(W_OK)
 * fails with EROFS.
 */
export async function isWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Joins a Calibre-relative path (forward slashes, from metadata.db) onto a
 * library folder and refuses anything that would leave the folder.
 */
export function resolveInside(libraryDir: string, relative: string): string {
  const parts = relative.split('/').filter((p) => p !== '' && p !== '.');
  const full = path.resolve(libraryDir, ...parts);
  if (!isInside(libraryDir, full) || full === path.resolve(libraryDir)) {
    throw new Error(`Path leaves the library folder: ${relative}`);
  }
  return full;
}
