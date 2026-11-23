/**
 * The ONLY module of the Calibre library's import (WP20g) that touches the source folders
 * (torrents/books/…, mounted read-only at CLEANUP_BOOK_SOURCES_DIR). Everything here reads:
 * lstat, readdir, the first bytes of a file, read streams, hashing, an access check. There is
 * deliberately no write, mkdir, rename, link, unlink, chmod or utimes in this file; a test fails
 * if one appears or if another module of the import touches the folders some other way. The
 * container mounts the folders read-only and the import refuses to run when they are writable.
 * The only new files under /torrents (archives unpacked into <source folder>/_extracted/) are
 * made by the linking sidecar.
 *
 * Names are read as bytes: a name that is not valid UTF-8 keeps its exact bytes (hex).
 */
import { createHash } from 'crypto';
import { createReadStream, type ReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

export interface SourceEntryStat {
  isFile: boolean;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export async function lstatSource(file: string | Buffer): Promise<SourceEntryStat | null> {
  try {
    const st = await fs.lstat(file, { bigint: true });
    return {
      isFile: st.isFile(),
      isDir: st.isDirectory(),
      isLink: st.isSymbolicLink(),
      size: Number(st.size),
      mtimeMs: Math.floor(Number(st.mtimeMs)),
      dev: Number(st.dev),
      ino: Number(st.ino),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

export interface SourceDirEntry {
  name: string;
  /** The exact bytes as hex when they are not valid UTF-8, else null. */
  rawHex: string | null;
  fullPath: string | Buffer;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** One level of a folder, names as bytes. */
export async function readSourceDir(dir: string | Buffer): Promise<SourceDirEntry[]> {
  const names = (await fs.readdir(dir, { encoding: 'buffer' })) as Buffer[];
  return names.map((b) => {
    let name: string;
    let rawHex: string | null = null;
    try {
      name = utf8.decode(b);
    } catch {
      name = b.toString('utf8');
      rawHex = b.toString('hex');
    }
    const full =
      rawHex === null && typeof dir === 'string'
        ? path.join(dir, name)
        : Buffer.concat([Buffer.isBuffer(dir) ? dir : Buffer.from(dir), Buffer.from('/'), b]);
    return { name, rawHex, fullPath: full };
  });
}

/** The first `n` bytes of a file (fewer for a short file); null when it can't be opened. */
export async function readHead(file: string | Buffer, n: number): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True when this process may write to `dir` (on a read-only mount it may not). */
export async function sourcesWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Token bucket for a MB/s limit (0 = none). */
export class SourcePacer {
  private allowance = 0;
  private last = Date.now();
  constructor(readonly bytesPerSecond: number) {}

  async take(bytes: number): Promise<void> {
    if (this.bytesPerSecond <= 0) return;
    const now = Date.now();
    this.allowance = Math.min(
      this.bytesPerSecond,
      this.allowance + ((now - this.last) / 1000) * this.bytesPerSecond,
    );
    this.last = now;
    this.allowance -= bytes;
    if (this.allowance < 0) {
      await new Promise((r) =>
        setTimeout(r, Math.min((-this.allowance / this.bytesPerSecond) * 1000, 5000)),
      );
    }
  }
}

/** SHA-256 of a whole file (read-only stream); null when `shouldStop` turned true on the way. */
export async function hashSource(
  file: string | Buffer,
  pacer: SourcePacer,
  shouldStop: () => boolean = () => false,
): Promise<{ sha256: string; bytes: number } | null> {
  const stream = createReadStream(file, { flags: 'r', highWaterMark: 1024 * 1024 });
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.length;
      await pacer.take(buf.length);
      if (shouldStop()) return null;
    }
  } finally {
    stream.destroy();
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** A read-only stream of a source file (sent to the apply sidecar, which adds it to Calibre). */
export function streamSource(file: string | Buffer): ReadStream {
  return createReadStream(file, { flags: 'r', highWaterMark: 1024 * 1024 });
}

/** Joins a stored root-relative path (forward slashes) onto a root; refuses anything that leaves it. */
export function insideSources(
  root: string,
  rel: string,
  rawHex: string | null = null,
): string | Buffer {
  if (rawHex !== null) {
    const bytes = Buffer.from(rawHex, 'hex');
    const parts = bytes.toString('latin1').split('/');
    if (parts.some((p) => p === '..' || p === '')) throw new Error('Path leaves the root');
    return Buffer.concat([Buffer.from(root), Buffer.from('/'), bytes]);
  }
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error(`Path leaves the root: ${rel}`);
  const full = path.resolve(root, ...parts);
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error(`Path leaves the root: ${rel}`);
  return full;
}
