/**
 * A streamed, uncompressed ZIP (store only) for the library's bulk downloads.
 *
 * Every entry's size is known before the first byte is sent, so the archive's exact size
 * is known too: the response carries a Content-Length and the browser's own downloads
 * show progress and time left. Nothing is held in memory: each file is read once, its
 * CRC-32 computed as it streams and written after it (a data descriptor, flag bit 3).
 * ZIP64 records are written only where a size or an offset needs them (an audiobook of
 * 4 GB or more, an archive past 4 GB, more than 65,535 entries).
 *
 * The writer only reads: callers pass each entry's opener, so they decide which
 * read-only module touches the file (calibre/source-fs.ts, audio/audio-fs.ts, uploads).
 */
import { Readable } from 'stream';
import { crc32 } from 'zlib';

export interface ZipEntry {
  /** The path inside the archive (forward slashes). */
  name: string;
  /** The exact size in bytes; a file that turns out longer or shorter stops the archive. */
  size: number;
  open(): Promise<Readable>;
}

export interface ZipOptions {
  /** The entries' modified time (DOS time, local to the server). */
  date?: Date;
  /** Tests: write the ZIP64 records for every entry and the end, whatever the sizes. */
  forceZip64?: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const DESCRIPTOR_SIG = 0x08074b50;
const END_SIG = 0x06054b50;
const END64_SIG = 0x06064b50;
const LOCATOR64_SIG = 0x07064b50;
/** Bit 3 (sizes and CRC in the data descriptor) and bit 11 (UTF-8 names). */
const FLAGS = 0x0808;
/** Made by: Unix (3), spec 4.5; external attributes: a regular file, rw-r--r--. */
const MADE_BY = (3 << 8) | 45;
const FILE_ATTRS = (0o100644 << 16) >>> 0;

export class ZipSizeError extends Error {
  constructor(name: string, expected: number, got: number) {
    super(`"${name}" changed while it was being sent (expected ${expected} bytes, got ${got})`);
    this.name = 'ZipSizeError';
  }
}

interface Placed {
  entry: ZipEntry;
  name: Buffer;
  /** Sizes of 4 GB or more: ZIP64 sizes in the local header, the descriptor and the directory. */
  zip64Size: boolean;
  offset: number;
}

interface Layout {
  placed: Placed[];
  centralOffset: number;
  centralSize: number;
  zip64End: boolean;
  total: number;
}

function plan(entries: readonly ZipEntry[], force: boolean): Layout {
  let offset = 0;
  const placed: Placed[] = [];
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`"${entry.name}" has no valid size`);
    }
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > MAX16) throw new Error(`"${entry.name}" is too long a name`);
    const zip64Size = force || entry.size >= MAX32;
    placed.push({ entry, name, zip64Size, offset });
    offset += localHeaderLength(name, zip64Size) + entry.size + (zip64Size ? 24 : 16);
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const p of placed) centralSize += 46 + p.name.length + centralExtra(p, force).length;
  const zip64End =
    force || placed.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
  const total = centralOffset + centralSize + (zip64End ? 56 + 20 : 0) + 22;
  return { placed, centralOffset, centralSize, zip64End, total };
}

function localHeaderLength(name: Buffer, zip64Size: boolean): number {
  return 30 + name.length + (zip64Size ? 20 : 0);
}

/** The exact size of the archive these entries make. */
export function zipSize(entries: readonly ZipEntry[], options: ZipOptions = {}): number {
  return plan(entries, options.forceZip64 ?? false).total;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u64(buf: Buffer, value: number, at: number): void {
  buf.writeBigUInt64LE(BigInt(value), at);
}

function localHeader(p: Placed, t: { time: number; date: number }): Buffer {
  const extra = p.zip64Size ? 20 : 0;
  const buf = Buffer.alloc(30 + p.name.length + extra);
  buf.writeUInt32LE(LOCAL_SIG, 0);
  buf.writeUInt16LE(p.zip64Size ? 45 : 20, 4);
  buf.writeUInt16LE(FLAGS, 6);
  buf.writeUInt16LE(0, 8); // stored
  buf.writeUInt16LE(t.time, 10);
  buf.writeUInt16LE(t.date, 12);
  // CRC and sizes follow the data (bit 3); ZIP64 marks its sizes as in the extra field.
  buf.writeUInt32LE(0, 14);
  buf.writeUInt32LE(p.zip64Size ? MAX32 : 0, 18);
  buf.writeUInt32LE(p.zip64Size ? MAX32 : 0, 22);
  buf.writeUInt16LE(p.name.length, 26);
  buf.writeUInt16LE(extra, 28);
  p.name.copy(buf, 30);
  if (p.zip64Size) {
    const at = 30 + p.name.length;
    buf.writeUInt16LE(0x0001, at);
    buf.writeUInt16LE(16, at + 2);
    // Both sizes zero here: the data descriptor has them (spec 4.3.9).
  }
  return buf;
}

function descriptor(p: Placed, crc: number): Buffer {
  const buf = Buffer.alloc(p.zip64Size ? 24 : 16);
  buf.writeUInt32LE(DESCRIPTOR_SIG, 0);
  buf.writeUInt32LE(crc >>> 0, 4);
  if (p.zip64Size) {
    u64(buf, p.entry.size, 8);
    u64(buf, p.entry.size, 16);
  } else {
    buf.writeUInt32LE(p.entry.size, 8);
    buf.writeUInt32LE(p.entry.size, 12);
  }
  return buf;
}

/** The central directory's ZIP64 field: the sizes and the offset that don't fit 32 bits. */
function centralExtra(p: Placed, force: boolean): Buffer {
  const offset64 = force || p.offset >= MAX32;
  const values: number[] = [];
  if (p.zip64Size) values.push(p.entry.size, p.entry.size);
  if (offset64) values.push(p.offset);
  if (!values.length) return Buffer.alloc(0);
  const buf = Buffer.alloc(4 + values.length * 8);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => u64(buf, v, 4 + i * 8));
  return buf;
}

function centralHeader(
  p: Placed,
  crc: number,
  t: { time: number; date: number },
  force: boolean,
): Buffer {
  const extra = centralExtra(p, force);
  const offset64 = force || p.offset >= MAX32;
  const buf = Buffer.alloc(46 + p.name.length + extra.length);
  buf.writeUInt32LE(CENTRAL_SIG, 0);
  buf.writeUInt16LE(MADE_BY, 4);
  buf.writeUInt16LE(p.zip64Size || offset64 ? 45 : 20, 6);
  buf.writeUInt16LE(FLAGS, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(t.time, 12);
  buf.writeUInt16LE(t.date, 14);
  buf.writeUInt32LE(crc >>> 0, 16);
  buf.writeUInt32LE(p.zip64Size ? MAX32 : p.entry.size, 20);
  buf.writeUInt32LE(p.zip64Size ? MAX32 : p.entry.size, 24);
  buf.writeUInt16LE(p.name.length, 28);
  buf.writeUInt16LE(extra.length, 30);
  buf.writeUInt16LE(0, 32); // comment
  buf.writeUInt16LE(0, 34); // disk
  buf.writeUInt16LE(0, 36); // internal attributes
  buf.writeUInt32LE(FILE_ATTRS, 38);
  buf.writeUInt32LE(offset64 ? MAX32 : p.offset, 42);
  p.name.copy(buf, 46);
  extra.copy(buf, 46 + p.name.length);
  return buf;
}

function endRecords(layout: Layout): Buffer {
  const count = layout.placed.length;
  const parts: Buffer[] = [];
  if (layout.zip64End) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(END64_SIG, 0);
    u64(end64, 44, 4); // the record's size after this field
    end64.writeUInt16LE(MADE_BY, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeUInt32LE(0, 16);
    end64.writeUInt32LE(0, 20);
    u64(end64, count, 24);
    u64(end64, count, 32);
    u64(end64, layout.centralSize, 40);
    u64(end64, layout.centralOffset, 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(LOCATOR64_SIG, 0);
    locator.writeUInt32LE(0, 4);
    u64(locator, layout.centralOffset + layout.centralSize, 8);
    locator.writeUInt32LE(1, 16);
    parts.push(end64, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(layout.zip64End ? MAX16 : count, 8);
  end.writeUInt16LE(layout.zip64End ? MAX16 : count, 10);
  end.writeUInt32LE(layout.zip64End ? MAX32 : layout.centralSize, 12);
  end.writeUInt32LE(layout.zip64End ? MAX32 : layout.centralOffset, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * The archive as a stream of exactly `zipSize(entries)` bytes. A file that can't be
 * opened, or whose length differs from its entry's size, ends the stream with an error
 * (the response is then cut off, and the browser reports the download as failed).
 */
export function zipStream(
  entries: readonly ZipEntry[],
  options: ZipOptions = {},
): { size: number; stream: Readable } {
  const force = options.forceZip64 ?? false;
  const layout = plan(entries, force);
  const t = dosTime(options.date ?? new Date());
  async function* generate(): AsyncGenerator<Buffer> {
    const crcs: number[] = [];
    for (const p of layout.placed) {
      yield localHeader(p, t);
      const source = await p.entry.open();
      let crc = 0;
      let sent = 0;
      try {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          sent += buf.length;
          if (sent > p.entry.size) throw new ZipSizeError(p.entry.name, p.entry.size, sent);
          crc = crc32(buf, crc);
          yield buf;
        }
      } finally {
        source.destroy();
      }
      if (sent !== p.entry.size) throw new ZipSizeError(p.entry.name, p.entry.size, sent);
      crcs.push(crc);
      yield descriptor(p, crc);
    }
    for (let i = 0; i < layout.placed.length; i++) {
      yield centralHeader(layout.placed[i], crcs[i], t, force);
    }
    yield endRecords(layout);
  }
  return { size: layout.total, stream: Readable.from(generate(), { objectMode: false }) };
}

/**
 * Names made unique inside one archive, as Windows compares them (case-insensitively):
 * `name.ext`, then `name (2).ext`, `name (3).ext`, ...
 */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
