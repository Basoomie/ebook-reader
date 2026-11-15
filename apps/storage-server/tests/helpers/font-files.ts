/**
 * Small real font containers for tests: an sfnt (ttf) and a woff2 holding a `name` table
 * (copyright, license URL) and padding. Enough for the name-table reader and the format
 * sniff; browsers would not draw text with them.
 */
import { brotliCompressSync } from 'zlib';

function nameTable(entries: Record<number, string>): Buffer {
  const ids = Object.keys(entries)
    .map(Number)
    .sort((a, b) => a - b);
  const strings = ids.map((id) => {
    const text = entries[id];
    const buf = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) buf.writeUInt16BE(text.charCodeAt(i), i * 2);
    return buf;
  });
  const header = Buffer.alloc(6 + ids.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(ids.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  ids.forEach((id, i) => {
    const r = 6 + i * 12;
    header.writeUInt16BE(3, r); // Windows
    header.writeUInt16BE(1, r + 2); // Unicode BMP
    header.writeUInt16BE(0x409, r + 4); // English (US)
    header.writeUInt16BE(id, r + 6);
    header.writeUInt16BE(strings[i].length, r + 8);
    header.writeUInt16BE(offset, r + 10);
    offset += strings[i].length;
  });
  return Buffer.concat([header, ...strings]);
}

export interface TestFontOptions {
  copyright?: string;
  licenseUrl?: string;
  /** Extra bytes in a padding table, so files differ in size and hash. */
  padding?: number;
  seed?: number;
}

function tables(o: TestFontOptions): { tag: string; data: Buffer }[] {
  const entries: Record<number, string> = { 1: 'Test Font', 2: 'Regular' };
  if (o.copyright !== undefined) entries[0] = o.copyright;
  if (o.licenseUrl !== undefined) entries[14] = o.licenseUrl;
  // Pseudo-random bytes, so brotli can't shrink them (sizes stay what the test asks for).
  const pad = Buffer.alloc(o.padding ?? 64);
  let x = ((o.seed ?? 7) * 2654435761 + 1) | 0 || 1;
  for (let i = 0; i < pad.length; i++) {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    pad[i] = x & 0xff;
  }
  // 'name' is known-table index 5; 'zPad' is an arbitrary tag (stored with its tag).
  return [
    { tag: 'name', data: nameTable(entries) },
    { tag: 'zPad', data: pad },
  ];
}

/** A TrueType-flavoured sfnt with the given name entries. */
export function testTtf(o: TestFontOptions = {}): Buffer {
  const list = tables(o);
  const header = Buffer.alloc(12 + list.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(list.length, 4);
  let offset = header.length;
  const bodies: Buffer[] = [];
  list.forEach((t, i) => {
    const r = 12 + i * 16;
    header.write(t.tag, r, 'latin1');
    header.writeUInt32BE(0, r + 4);
    header.writeUInt32BE(offset, r + 8);
    header.writeUInt32BE(t.data.length, r + 12);
    const padded = Buffer.concat([t.data, Buffer.alloc((4 - (t.data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

function base128(n: number): Buffer {
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return Buffer.from(bytes);
}

/** A woff2 with the same tables (null transforms, one brotli stream). */
export function testWoff2(o: TestFontOptions = {}): Buffer {
  const list = tables(o);
  const dir: Buffer[] = [];
  for (const t of list) {
    if (t.tag === 'name') dir.push(Buffer.from([5]));
    else dir.push(Buffer.concat([Buffer.from([0x3f]), Buffer.from(t.tag, 'latin1')]));
    dir.push(base128(t.data.length));
  }
  const directory = Buffer.concat(dir);
  const compressed = brotliCompressSync(Buffer.concat(list.map((t) => t.data)));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(list.length, 12);
  header.writeUInt32BE(compressed.length, 20);
  const body = Buffer.concat([header, directory, compressed]);
  body.writeUInt32BE(body.length, 8);
  return body;
}
