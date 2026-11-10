/**
 * Metadata of an uploaded EPUB (WP7b), read from META-INF/container.xml and the OPF
 * only: dc:title, every dc:creator, Calibre's series metadata when present, and the
 * cover image. No tags (dc:subject is ignored); editing metadata is future work.
 *
 * ZIPs are read with the migration's zip-read.ts (imported, unchanged); binary
 * entries (the cover) with readEntryBytes below, the same format rules.
 */
import { XMLParser } from 'fast-xml-parser';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { inflateRawSync } from 'zlib';
import { type ReadOnlyOpener, ZipError, ZipFile, type ZipEntryInfo } from '../migration/zip-read';

export interface EpubMeta {
  title: string;
  authors: string[];
  series: { name: string; index: number | null } | null;
  /** ZIP entry name of the cover image, or null. */
  coverEntry: string | null;
}

/** Largest cover image read (bigger ones are treated as no cover). */
export const MAX_COVER_BYTES = 32 * 1024 * 1024;

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as Record<string, unknown>)['#text']);
  }
  return '';
}

function decodeEntry(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The OPF of an open EPUB, parsed, with its folder. */
async function readOpf(zip: ZipFile) {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const containerEntry = zip.get('META-INF/container.xml');
  if (!containerEntry) throw new ZipError('META-INF/container.xml missing');
  const container = parser.parse(await zip.readText(containerEntry));
  const rootFile = asArray(container?.container?.rootfiles?.rootfile)[0] as
    | Record<string, string>
    | undefined;
  const opfPath = rootFile?.['@_full-path'];
  if (!opfPath) throw new ZipError('No package document in container.xml');
  const opfEntry = zip.get(opfPath);
  if (!opfEntry) throw new ZipError(`${opfPath} missing`);
  const opf = parser.parse(await zip.readText(opfEntry));
  const pkg = opf['opf:package'] || opf.package;
  if (!pkg) throw new ZipError('The package document has no <package>');
  const prefix = opf['opf:package'] ? 'opf:' : '';
  return { pkg, prefix, dir: path.posix.dirname(opfPath) };
}

/** Reads the upload's metadata. Throws (ZipError or parse errors) for a damaged EPUB. */
export async function readEpubMeta(
  file: string,
  opener: ReadOnlyOpener,
  fallbackTitle: string,
): Promise<EpubMeta> {
  const zip = await ZipFile.open(file, opener);
  try {
    const { pkg, prefix, dir } = await readOpf(zip);
    const metadata = (pkg[`${prefix}metadata`] ?? {}) as Record<string, unknown>;
    const title = asArray(metadata['dc:title'])
      .map(text)
      .find((t) => t.trim() !== '');
    const authors = asArray(metadata['dc:creator'])
      .map((c) => text(c).trim())
      .filter((a) => a !== '');
    const metas = [
      ...asArray(metadata.meta as unknown),
      ...asArray(metadata['opf:meta'] as unknown),
    ] as Record<string, unknown>[];
    const metaContent = (name: string) =>
      metas.find((m) => m?.['@_name'] === name)?.['@_content'] as string | undefined;
    const seriesName = metaContent('calibre:series')?.trim();
    const seriesIndexRaw = Number(metaContent('calibre:series_index'));
    const items = asArray(pkg[`${prefix}manifest`]?.[`${prefix}item`]) as Record<string, string>[];
    let cover = items.find((i) => (i['@_properties'] ?? '').split(/\s+/).includes('cover-image'));
    if (!cover) {
      const coverId = metaContent('cover');
      cover = items.find((i) => i['@_id'] === coverId);
    }
    let coverEntry: string | null = null;
    if (cover?.['@_href'] && (cover['@_media-type'] ?? '').startsWith('image/')) {
      const name = path.posix.join(dir, decodeEntry(cover['@_href']));
      if (zip.get(name)) coverEntry = name;
    }
    return {
      title: (title ?? fallbackTitle).trim() || fallbackTitle,
      authors: [...new Set(authors)],
      series: seriesName
        ? { name: seriesName, index: Number.isFinite(seriesIndexRaw) ? seriesIndexRaw : null }
        : null,
      coverEntry,
    };
  } finally {
    await zip.close();
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError('Unexpected end of file');
    done += bytesRead;
  }
  return buf;
}

/** One entry's bytes (stored or deflated), at most `maxBytes`. */
export async function readEntryBytes(
  file: string,
  opener: ReadOnlyOpener,
  entry: ZipEntryInfo,
  maxBytes: number,
): Promise<Buffer> {
  if (entry.flags & 0x1) throw new ZipError(`Encrypted entry: ${entry.name}`);
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) {
    throw new ZipError(`Entry too large: ${entry.name}`);
  }
  const handle = await opener(file);
  try {
    const header = await readAt(handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) {
      throw new ZipError(`Damaged local header: ${entry.name}`);
    }
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = await readAt(handle, start, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: maxBytes });
    throw new ZipError(`Unsupported compression ${entry.method}: ${entry.name}`);
  } finally {
    await handle.close();
  }
}

/** The cover image of an uploaded EPUB, or null when it has none. */
export async function readEpubCover(file: string, opener: ReadOnlyOpener): Promise<Buffer | null> {
  const meta = await readEpubMeta(file, opener, '');
  if (!meta.coverEntry) return null;
  const zip = await ZipFile.open(file, opener);
  let entry: ZipEntryInfo | undefined;
  try {
    entry = zip.get(meta.coverEntry);
  } finally {
    await zip.close();
  }
  return entry ? readEntryBytes(file, opener, entry, MAX_COVER_BYTES) : null;
}
