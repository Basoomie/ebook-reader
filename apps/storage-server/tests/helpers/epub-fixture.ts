/**
 * Builds small EPUBs and old-sync book folders for the WP5 migration tests.
 * Only tests write these files; the code under test must never write to them.
 */
import fs from 'fs';
import path from 'path';
import { crc32, deflateRawSync } from 'zlib';

export interface ZipInput {
  name: string;
  data: Buffer | string;
  /** Deflate this entry (default: stored). */
  deflate?: boolean;
}

/** A minimal ZIP writer (stored or deflated entries, UTF-8 names). */
export function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export interface BookSpec {
  title: string;
  /** EPUB-relative image path (relative to the OPF folder) -> bytes. */
  images: Record<string, Buffer>;
  /** Spine idrefs. */
  spine: string[];
}

export function image(seed: number, size = 200): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}

export function makeEpub(spec: BookSpec): Buffer {
  const items = [
    ...spec.spine.map(
      (id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
    ...Object.keys(spec.images).map(
      (href, i) => `<item id="img${i}" href="${href}" media-type="image/jpeg"/>`,
    ),
  ];
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${spec.title}</dc:title>
  </metadata>
  <manifest>${items.join('')}</manifest>
  <spine>${spec.spine.map((id) => `<itemref idref="${id}"/>`).join('')}</spine>
</package>`;
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      deflate: true,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate: true },
    ...spec.spine.map((id) => ({
      name: `OEBPS/${id}.xhtml`,
      data: `<html><body><p>${id}</p></body></html>`,
      deflate: true,
    })),
    ...Object.entries(spec.images).map(([href, data]) => ({ name: `OEBPS/${href}`, data })),
  ]);
}

/** The browser's stored book: blobs/<href>, staticdata.json (deflated, like zip.js). */
export function makeStoredZip(spec: BookSpec): Buffer {
  return makeZip([
    {
      name: 'staticdata.json',
      data: JSON.stringify({
        title: spec.title,
        styleSheet: '',
        elementHtml: '<div>text</div>',
        sections: spec.spine.map((id) => ({ reference: `ttu-${id}`, charactersWeight: 1 })),
      }),
      deflate: true,
    },
    ...Object.entries(spec.images).map(([href, data]) => ({ name: `blobs/${href}`, data })),
  ]);
}

/** Same as the web app's BaseStorageHandler.sanitizeForFilename. */
export function sanitizeForFilename(title: string): string {
  return title
    .replace(/[ ]$/, '~ttu-spc~')
    .replace(/[.]$/, '~ttu-dend~')
    .replace(/\*/g, '~ttu-star~')
    .replace(/[/?<>\\:*|%"]/g, (match) => encodeURIComponent(match));
}

export interface LegacyFolderSpec {
  /** Stored book; omitted = a folder with only progress/statistics. */
  book?: BookSpec;
  /** Raw bytes for the bookdata zip instead of a real one (damaged data). */
  rawBookData?: Buffer;
  characters?: number;
  progress?: { exploredCharCount: number; progress: number; lastBookmarkModified: number };
  statistics?: Array<Record<string, unknown>>;
  audio?: boolean;
}

/** Writes one book folder the way the selfhost handler does; returns the folder name. */
export function writeLegacyFolder(dataRoot: string, title: string, spec: LegacyFolderSpec): string {
  const folder = sanitizeForFilename(title);
  const dir = path.join(dataRoot, folder);
  fs.mkdirSync(dir, { recursive: true });
  const chars = spec.characters ?? 1000;
  if (spec.book || spec.rawBookData) {
    fs.writeFileSync(
      path.join(dir, `bookdata_1_6_${chars}_1700000000000_1700000000001.zip`),
      spec.rawBookData ?? makeStoredZip(spec.book!),
    );
  }
  if (spec.progress) {
    fs.writeFileSync(
      path.join(
        dir,
        `progress_1_6_${spec.progress.lastBookmarkModified}_${spec.progress.progress}.json`,
      ),
      JSON.stringify({ dataId: 7, ...spec.progress }),
    );
  }
  if (spec.statistics) {
    const modified = Math.max(...spec.statistics.map((s) => Number(s.lastStatisticModified) || 0));
    fs.writeFileSync(
      path.join(dir, `statistics_1_6_${modified}_0_0_0_0_0_0_0_0_0_0_0_0_na.json`),
      JSON.stringify(spec.statistics.map((s) => ({ title, ...s }))),
    );
  }
  if (spec.audio) {
    fs.writeFileSync(path.join(dir, 'audioBook_1_6_1700000000000_12.5.json'), '{}');
    fs.writeFileSync(path.join(dir, 'subtitles_1_6_1700000000000_3.json'), '{}');
  }
  return folder;
}

export function statRow(dateKey: string, chars: number, seconds: number, modified: number) {
  return {
    dateKey,
    charactersRead: chars,
    readingTime: seconds,
    minReadingSpeed: 0,
    altMinReadingSpeed: 0,
    lastReadingSpeed: 0,
    maxReadingSpeed: 0,
    lastStatisticModified: modified,
  };
}
