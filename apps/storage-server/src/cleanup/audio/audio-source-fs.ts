/**
 * The ONLY module of the audiobook cleanup that touches the two audiobook roots
 * (torrents/audiobooks/japanese and media/audiobooks/japanese; WP21a). Everything here reads:
 * lstat, readdir, positioned reads, read streams, access checks. There is deliberately no
 * write, mkdir, rename, link, unlink, chmod or utimes in this file; a test fails if one appears
 * or if another module reads the roots some other way. The container also mounts both roots
 * read-only, and the cleanup refuses to run when either is writable.
 *
 * Names are read as bytes (`encoding: 'buffer'`): a name that is not valid UTF-8 keeps its
 * exact bytes (hex) beside a readable form.
 */
import { constants, createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

export interface EntryStat {
  isFile: boolean;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export async function lstatEntry(file: string | Buffer): Promise<EntryStat | null> {
  try {
    const st = await fs.lstat(file, { bigint: true });
    return {
      isFile: st.isFile(),
      isDir: st.isDirectory(),
      isLink: st.isSymbolicLink(),
      size: Number(st.size),
      mtimeMs: Number(st.mtimeMs),
      dev: Number(st.dev),
      ino: Number(st.ino),
      nlink: Number(st.nlink),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

export interface DirEntry {
  /** The name as text (invalid UTF-8 bytes become U+FFFD here). */
  name: string;
  /** The exact bytes as hex when they are not valid UTF-8, else null. */
  rawHex: string | null;
  /** The path to open it (built from the exact bytes). */
  fullPath: string | Buffer;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** One level of a folder, names as bytes. */
export async function readDir(dir: string | Buffer): Promise<DirEntry[]> {
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

/** True when this process may write to `dir` (on a read-only mount it may not). */
export async function isWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A small file read whole (e.g. ABS's metadata.json); null when missing or larger than maxBytes. */
export async function readSmall(file: string | Buffer, maxBytes: number): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return null;
  }
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

/** Token bucket for a MB/s limit (0 = none). */
export class ReadPacer {
  private allowance = 0;
  private last = Date.now();
  constructor(private readonly bytesPerSecond: number) {}

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

/**
 * SHA-256 of a whole file (read-only stream, 1 MB chunks). Returns null when `shouldStop`
 * turned true on the way (e.g. a Calibre job waits for the disk); the file is read again later.
 */
export async function hashFile(
  file: string | Buffer,
  pacer: ReadPacer,
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

/**
 * Opens a file read-only for ffprobe/ffmpeg: on Linux the tools get only this descriptor
 * (`/dev/fd/3`), never the path, so they can't write to the audiobook roots even by mistake.
 */
export function openReadOnly(file: string | Buffer): Promise<fs.FileHandle> {
  return fs.open(file, constants.O_RDONLY);
}

/** Joins a stored root-relative path (forward slashes) onto a root; refuses anything that leaves it. */
export function insideRoot(
  root: string,
  rel: string,
  rawHex: string | null = null,
): string | Buffer {
  if (rawHex !== null) {
    // Exact bytes of a non-UTF-8 path: checked on the bytes.
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
