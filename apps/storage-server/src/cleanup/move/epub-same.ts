/**
 * Manga part A: are two EPUBs the same book, file for file? (Read-only.)
 *
 * Calibre's add runs the file-type plugins installed in the user's calibre; DeDRM (10.0.9 on the
 * NAS) packs every EPUB it sees again ("Verifying zip archive integrity"): every file inside stays
 * the same, the ZIP's compression changes, so the stored copy is never the export byte for byte
 * (live run 2026-11-25, proven with real calibre 9.18 and the NAS's DeDRM.zip in
 * `.tmp-e2e/manga/probe2`). Decided with the user 2026-11-25: when the bytes differ, the copy
 * counts as the same EPUB only when it holds exactly the same files (names) and each file's
 * unpacked bytes are the same (size, CRC-32 and SHA-256); how the ZIP is packed is not compared.
 */
import { createHash } from 'crypto';
import fs, { type FileHandle } from 'fs/promises';
import { type ReadOnlyOpener, ZipFile } from '../../migration/zip-read';

/** Largest single file inside an EPUB the check unpacks (a picture is a few MB). */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

export interface EpubComparison {
  same: boolean;
  /** Why not, in a few words (the first difference found). */
  problem: string | null;
  files: number;
}

/** Each file of the ZIP by name: size, CRC-32 and the SHA-256 of its unpacked bytes. */
async function fileDigests(
  file: string,
  opener: ReadOnlyOpener,
): Promise<Map<string, { size: number; crc32: number; sha: string }>> {
  const zip = await ZipFile.open(file, opener);
  try {
    const out = new Map<string, { size: number; crc32: number; sha: string }>();
    for (const e of zip.entries) {
      if (out.has(e.name)) throw new Error(`Two files named ${e.name}`);
      const bytes = await zip.readBytes(e, MAX_ENTRY_BYTES);
      if (bytes.length !== e.size) throw new Error(`Damaged file inside: ${e.name}`);
      out.set(e.name, {
        size: e.size,
        crc32: e.crc32,
        sha: createHash('sha256').update(bytes).digest('hex'),
      });
      // One picture at a time, the event loop let through between them.
      await new Promise((r) => setImmediate(r));
    }
    return out;
  } finally {
    await zip.close().catch(() => {});
  }
}

/**
 * Read once (2026-11-25): the check read each copy twice (its SHA-256, then the files inside),
 * 0.4 s of each move's 6 s on the NAS. A file up to this size is read into memory once and both
 * come from that read; a bigger one is streamed as before.
 */
export const IN_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

/** The whole file, when it is at most `max` bytes (null: bigger, stream it instead). */
export async function readWhole(file: string, max = IN_MEMORY_MAX_BYTES): Promise<Buffer | null> {
  const st = await fs.stat(file);
  return st.size > max ? null : fs.readFile(file);
}

/** SHA-256 of a buffer, a few MB at a time with the event loop let through (lessons 3). */
export async function sha256Of(buf: Buffer): Promise<string> {
  const h = createHash('sha256');
  const step = 8 * 1024 * 1024;
  for (let i = 0; i < buf.length; i += step) {
    h.update(buf.subarray(i, i + step));
    await new Promise((r) => setImmediate(r));
  }
  return h.digest('hex');
}

/** An opener that reads files already in memory (what ZipFile needs of a file handle). */
export function memoryOpener(files: Map<string, Buffer>): ReadOnlyOpener {
  return async (file: string) => {
    const buf = files.get(file);
    if (!buf) throw new Error(`Not read into memory: ${file}`);
    const handle = {
      stat: async () => ({ size: buf.length }),
      read: async (into: Buffer, offset: number, length: number, position: number) => {
        const n = Math.max(0, Math.min(length, buf.length - position));
        buf.copy(into, offset, position, position + n);
        return { bytesRead: n, buffer: into };
      },
      close: async () => {},
    };
    return handle as unknown as FileHandle;
  };
}

/** Compares the files inside two EPUBs (`a` the book's own copy, `b` the one to check). */
export async function sameEpubContents(
  a: string,
  b: string,
  opener: ReadOnlyOpener,
): Promise<EpubComparison> {
  const [x, y] = [await fileDigests(a, opener), await fileDigests(b, opener)];
  for (const name of x.keys())
    if (!y.has(name)) return { same: false, problem: `${name} is missing`, files: x.size };
  for (const name of y.keys())
    if (!x.has(name)) return { same: false, problem: `${name} was added`, files: x.size };
  for (const [name, d] of x) {
    const e = y.get(name)!;
    if (d.size !== e.size || d.crc32 !== e.crc32 || d.sha !== e.sha)
      return { same: false, problem: `${name} differs`, files: x.size };
  }
  return { same: true, problem: null, files: x.size };
}
