/**
 * The ONLY module that touches the audiobooks folder (WP15). Like the Calibre
 * libraries (calibre/source-fs.ts), the audiobooks folder is read-only to this
 * app: everything here is stat, readdir, positioned reads and read-only
 * streams. There is deliberately no write, mkdir, rename or delete in this file;
 * keep it that way. (WP16 writes its output folders through its own module.)
 *
 * The container mounts the folder read-only too, and the scanner refuses to
 * run when the mount is writable (see isWritable).
 */
import { constants, createReadStream, Dirent, ReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { isInside } from '../db/database';

export interface AudioStat {
  mtimeMs: number;
  size: number;
}

/** stat of a file, or null if it does not exist. */
export async function statAudioFile(file: string): Promise<AudioStat | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** True if `dir` exists and is a folder. */
export async function isFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** One level of a folder (never recursive; the scanner walks it itself). */
export async function readFolder(dir: string): Promise<Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true });
}

/** A small file read whole (e.g. Audiobookshelf's metadata.json); null if larger than `maxBytes`. */
export async function readSmallFile(file: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) return null;
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** Positioned reads on one open file (read-only), e.g. for the duration of an m4b. */
export interface AudioReader {
  readonly size: number;
  /** Up to `length` bytes at `position` (fewer at the end of the file). */
  read(position: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export async function openAudioReader(file: string): Promise<AudioReader> {
  const handle = await fs.open(file, 'r');
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (err) {
    await handle.close();
    throw err;
  }
  let closed = false;
  return {
    size,
    async read(position, length) {
      const n = Math.max(0, Math.min(length, size - position));
      const buf = Buffer.alloc(n);
      let offset = 0;
      while (offset < n) {
        const { bytesRead } = await handle.read(buf, offset, n - offset, position + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buf.subarray(0, offset);
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/**
 * Opens a byte range of a file for streaming (read-only, flag 'r'). Resolves
 * once the file is open, so a missing file is reported before any response.
 */
export function openAudioStream(
  file: string,
  range?: { start: number; end: number },
): Promise<ReadStream> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { flags: 'r', ...(range ?? {}) });
    stream.once('open', () => resolve(stream));
    stream.once('error', reject);
  });
}

/** True if `dir` is writable by this process. On a read-only mount access(W_OK) fails. */
export async function isWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Joins a root-relative path (forward slashes, as stored in the index) onto the
 * audiobooks root and refuses anything that would leave it.
 */
export function resolveInsideAudio(root: string, relative: string): string {
  const parts = relative.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..'))
    throw new Error(`Path leaves the audiobooks folder: ${relative}`);
  const full = path.resolve(root, ...parts);
  if (!isInside(root, full)) throw new Error(`Path leaves the audiobooks folder: ${relative}`);
  return full;
}
