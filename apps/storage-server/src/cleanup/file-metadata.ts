/**
 * Stage 2 (WP20b): an EPUB's own metadata, read-only through source-fs.
 *
 * Reads META-INF/container.xml and the OPF: titles, creators with their roles (EPUB2
 * `opf:role`, EPUB3 `<meta refines="#id" property="role">`), publishers, languages,
 * identifiers (and the ASIN among them), the declared cover (EPUB3 `cover-image`, EPUB2
 * `<meta name="cover">`, else an image item called "cover"), plus a little text from the
 * start and the end of the spine (title page and colophon) as evidence for stage 4.
 *
 * The cover is read once: its size and difference hash (sharp) and SHA-256 go into the
 * evidence; the bytes themselves are read again only when the sidecar asks for them.
 * Nothing here writes a file.
 */
import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import sharp from 'sharp';
import { openSourceFile, readSourceFile } from '../calibre/source-fs';
import { ZipError, ZipFile, type ZipEntryInfo } from '../migration/zip-read';
import {
  type CoverFacts,
  type FileCreator,
  type FileFacts,
  asinFromIdentifiers,
} from './stage2-rules';

/** Largest cover image read (bigger ones count as no cover, as for uploads). */
export const MAX_COVER_BYTES = 32 * 1024 * 1024;
/** Largest spine document read for the evidence text. */
const MAX_TEXT_DOC_BYTES = 4 * 1024 * 1024;
const FRONT_CHARS = 600;
const COLOPHON_CHARS = 1500;
/** Spine documents read from each end for the evidence text. */
const TEXT_DOCS = 4;

const ARRAY_TAGS = new Set([
  'dc:title',
  'dc:creator',
  'dc:contributor',
  'dc:publisher',
  'dc:language',
  'dc:identifier',
  'meta',
  'item',
  'itemref',
  'rootfile',
  'reference',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name.replace(/^opf:/, '')),
});

type Node = Record<string, unknown>;
const asArray = (v: unknown): unknown[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in v) return String((v as Node)['#text']);
  return '';
}

function attr(v: unknown, name: string): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const n = v as Node;
  const a = n[`@_${name}`] ?? n[`@_opf:${name}`];
  return typeof a === 'string' ? a : undefined;
}

function child(node: Node | undefined, name: string): unknown {
  if (!node) return undefined;
  return node[name] ?? node[`opf:${name}`];
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function findEntry(zip: ZipFile, dir: string, href: string): ZipEntryInfo | undefined {
  const name = path.posix.normalize(path.posix.join(dir, decodeHref(href.split('#')[0])));
  const exact = zip.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return zip.entries.find((e) => e.name.toLowerCase() === lower);
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Visible text of an XHTML document: ruby readings dropped, tags removed, entities decoded. */
export function xhtmlText(html: string): string {
  const body = /<body[\s>][\s\S]*$/i.exec(html)?.[0] ?? html;
  return body
    .replace(/<(script|style|rt|rp)[\s>][\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

/** 64-bit difference hash (9×8 greyscale), as 16 hex digits. */
export async function differenceHash(image: Buffer): Promise<string | null> {
  try {
    const { data } = await sharp(image, { failOn: 'none', limitInputPixels: 100_000_000 })
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let hex = '';
    for (let row = 0; row < 8; row++) {
      let nibbles = 0;
      for (let col = 0; col < 8; col++) {
        const bit = data[row * 9 + col] < data[row * 9 + col + 1] ? 1 : 0;
        nibbles = (nibbles << 1) | bit;
      }
      hex += nibbles.toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null;
  }
}

/** Width, height and difference hash of an image, or null when sharp can't read it. */
export async function imageFacts(image: Buffer): Promise<CoverFacts | null> {
  try {
    const meta = await sharp(image, { failOn: 'none', limitInputPixels: 100_000_000 }).metadata();
    if (!meta.width || !meta.height) return null;
    // EXIF orientations 5-8 swap the visible width and height.
    const swap = (meta.orientation ?? 1) >= 5;
    return {
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      dhash: await differenceHash(image),
    };
  } catch {
    return null;
  }
}

interface Opf {
  zip: ZipFile;
  dir: string;
  metadata: Node;
  manifest: Node[];
  spine: Node[];
}

async function openOpf(zip: ZipFile): Promise<Opf> {
  const containerEntry = zip.get('META-INF/container.xml');
  if (!containerEntry) throw new ZipError('META-INF/container.xml missing');
  const container = parser.parse(stripBom(await zip.readText(containerEntry))) as Node;
  const rootfilesNode = child(child(container, 'container') as Node | undefined, 'rootfiles') as
    | Node
    | undefined;
  const rootfiles = asArray(rootfilesNode?.rootfile);
  const opfPath = rootfiles.map((r) => attr(r, 'full-path')).find((p) => !!p);
  if (!opfPath) throw new ZipError('No package document in container.xml');
  const opfEntry =
    zip.get(opfPath) ?? zip.entries.find((e) => e.name.toLowerCase() === opfPath.toLowerCase());
  if (!opfEntry) throw new ZipError(`${opfPath} missing`);
  const opf = parser.parse(stripBom(await zip.readText(opfEntry))) as Node;
  const pkg = (opf['opf:package'] ?? opf.package) as Node | undefined;
  if (!pkg) throw new ZipError('The package document has no <package>');
  return {
    zip,
    dir: path.posix.dirname(opfEntry.name),
    metadata: (child(pkg, 'metadata') ?? {}) as Node,
    manifest: asArray(child(child(pkg, 'manifest') as Node, 'item')) as Node[],
    spine: asArray(child(child(pkg, 'spine') as Node, 'itemref')) as Node[],
  };
}

/** MARC relator codes from EPUB3 refines (`#id` → role). */
function refinedRoles(metas: Node[]): Map<string, string> {
  const roles = new Map<string, string>();
  for (const m of metas) {
    if (attr(m, 'property') !== 'role') continue;
    const ref = attr(m, 'refines');
    const role = text(m).trim().toLowerCase();
    if (ref && role && !roles.has(ref.replace(/^#/, ''))) roles.set(ref.replace(/^#/, ''), role);
  }
  return roles;
}

function readCreators(metadata: Node, metas: Node[]): FileCreator[] {
  const roles = refinedRoles(metas);
  const out: FileCreator[] = [];
  for (const c of asArray(metadata['dc:creator'])) {
    const name = text(c).trim();
    if (!name) continue;
    const id = attr(c, 'id');
    const role =
      (attr(c, 'role') ?? (id ? roles.get(id) : undefined))?.trim().toLowerCase() || null;
    out.push({ name, role });
  }
  // dc:contributor is never an author; only an illustrator role is kept from it.
  for (const c of asArray(metadata['dc:contributor'])) {
    const name = text(c).trim();
    const id = attr(c, 'id');
    const role =
      (attr(c, 'role') ?? (id ? roles.get(id) : undefined))?.trim().toLowerCase() || null;
    if (name && role === 'ill') out.push({ name, role });
  }
  return out;
}

function readTitle(metadata: Node, metas: Node[]): string | null {
  const titles = asArray(metadata['dc:title']);
  const mainIds = new Set(
    metas
      .filter((m) => attr(m, 'property') === 'title-type' && text(m).trim() === 'main')
      .map((m) => (attr(m, 'refines') ?? '').replace(/^#/, '')),
  );
  const main = titles.find((t) => mainIds.has(attr(t, 'id') ?? '') && text(t).trim() !== '');
  const first = main ?? titles.find((t) => text(t).trim() !== '');
  return first ? text(first).trim() : null;
}

function readIdentifiers(metadata: Node): string[] {
  const out: string[] = [];
  for (const i of asArray(metadata['dc:identifier'])) {
    const value = text(i).trim();
    if (!value) continue;
    const scheme = attr(i, 'scheme');
    // A scheme attribute names the kind; keep the value as written, plus "<scheme>:<value>"
    // when the value doesn't carry it, so asinFromIdentifiers sees e.g. "ASIN:B0…".
    out.push(value);
    if (scheme && !value.toLowerCase().startsWith(`${scheme.toLowerCase()}:`))
      out.push(`${scheme}:${value}`);
  }
  return [...new Set(out)];
}

function coverItem(opf: Opf, metas: Node[]): Node | undefined {
  const isImage = (i: Node) => (attr(i, 'media-type') ?? '').toLowerCase().startsWith('image/');
  const byProperty = opf.manifest.find((i) =>
    (attr(i, 'properties') ?? '').split(/\s+/).includes('cover-image'),
  );
  if (byProperty && isImage(byProperty)) return byProperty;
  const coverId = metas.find((m) => attr(m, 'name') === 'cover')?.['@_content'];
  if (typeof coverId === 'string') {
    const byMeta = opf.manifest.find((i) => attr(i, 'id') === coverId);
    if (byMeta && isImage(byMeta)) return byMeta;
  }
  return opf.manifest.find(
    (i) => isImage(i) && /cover/i.test(`${attr(i, 'id') ?? ''} ${attr(i, 'href') ?? ''}`),
  );
}

async function spineText(opf: Opf, from: 'start' | 'end', chars: number): Promise<string> {
  const ids = opf.spine.map((s) => attr(s, 'idref')).filter((x): x is string => !!x);
  const order = from === 'start' ? ids.slice(0, TEXT_DOCS) : ids.slice(-TEXT_DOCS).reverse();
  const parts: string[] = [];
  let total = 0;
  for (const id of order) {
    const item = opf.manifest.find((i) => attr(i, 'id') === id);
    const href = item ? attr(item, 'href') : undefined;
    const entry = href ? findEntry(opf.zip, opf.dir, href) : undefined;
    if (!entry || entry.size > MAX_TEXT_DOC_BYTES) continue;
    const t = xhtmlText((await opf.zip.readBytes(entry, MAX_TEXT_DOC_BYTES)).toString('utf8'));
    if (!t) continue;
    if (from === 'start') parts.push(t);
    else parts.unshift(t);
    total += t.length;
    if (total >= chars) break;
  }
  const all = parts.join('\n');
  return from === 'start' ? all.slice(0, chars) : all.slice(-chars);
}

export interface ReadFileMetadataOptions {
  /** Read the spine text for the evidence (default true). */
  text?: boolean;
}

/** Reads an EPUB's metadata and cover facts. Throws ZipError (or parse errors) for a damaged file. */
export async function readFileMetadata(
  file: string,
  options: ReadFileMetadataOptions = {},
): Promise<FileFacts> {
  const zip = await ZipFile.open(file, openSourceFile);
  try {
    const opf = await openOpf(zip);
    const md = opf.metadata;
    const metas = [...asArray(md.meta), ...asArray(md['opf:meta'])] as Node[];
    const identifiers = readIdentifiers(md);
    const facts: FileFacts = {
      title: readTitle(md, metas),
      creators: readCreators(md, metas),
      publishers: asArray(md['dc:publisher'])
        .map((p) => text(p).trim())
        .filter((p) => p !== ''),
      languages: asArray(md['dc:language'])
        .map((l) => text(l).trim())
        .filter((l) => l !== ''),
      identifiers,
      asin: asinFromIdentifiers(identifiers),
      cover: null,
    };
    const item = coverItem(opf, metas);
    const href = item ? attr(item, 'href') : undefined;
    const entry = href ? findEntry(zip, opf.dir, href) : undefined;
    if (item && entry && entry.size <= MAX_COVER_BYTES && entry.size > 0) {
      try {
        const bytes = await zip.readBytes(entry, MAX_COVER_BYTES);
        const img = await imageFacts(bytes);
        if (img) {
          facts.cover = {
            entry: entry.name,
            mediaType: (attr(item, 'media-type') ?? 'image/jpeg').toLowerCase(),
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            ...img,
          };
        }
      } catch {
        // A cover that can't be read counts as no cover.
      }
    }
    if (options.text !== false) {
      try {
        facts.frontText = await spineText(opf, 'start', FRONT_CHARS);
        facts.colophonText = await spineText(opf, 'end', COLOPHON_CHARS);
      } catch {
        // Evidence text is optional.
      }
    }
    return facts;
  } finally {
    await zip.close();
  }
}

/** The cover's bytes, read again for the sidecar; null when the entry is gone or too large. */
export async function readCoverBytes(file: string, entryName: string): Promise<Buffer | null> {
  const zip = await ZipFile.open(file, openSourceFile);
  try {
    const entry = zip.get(entryName);
    if (!entry || entry.size > MAX_COVER_BYTES) return null;
    return await zip.readBytes(entry, MAX_COVER_BYTES);
  } finally {
    await zip.close();
  }
}

/** Calibre's own cover.jpg facts (read-only), or null when it can't be read. */
export async function calibreCoverFacts(coverFile: string): Promise<CoverFacts | null> {
  try {
    return await imageFacts(await readSourceFile(coverFile));
  } catch {
    return null;
  }
}

export interface CoverForCalibre {
  bytes: Buffer;
  /** File extension for the sidecar's temp file (jpg or png). */
  ext: 'jpg' | 'png';
  converted: boolean;
  sha256: string;
}

/**
 * The bytes the sidecar hands to calibre (D1): JPEG and PNG up to `maxBytes` and
 * `maxSide` pass through unchanged; anything else, or larger, becomes a JPEG (quality 92)
 * no longer than `maxSide` on its longest side.
 */
export async function coverForCalibre(
  bytes: Buffer,
  limits: { maxBytes: number; maxSide: number },
): Promise<CoverForCalibre> {
  const meta = await sharp(bytes, { failOn: 'none', limitInputPixels: 100_000_000 }).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const passThrough =
    (meta.format === 'jpeg' || meta.format === 'png') &&
    bytes.length <= limits.maxBytes &&
    longest <= limits.maxSide;
  const out = passThrough
    ? bytes
    : await sharp(bytes, { failOn: 'none', limitInputPixels: 100_000_000 })
        .rotate()
        .resize({
          width: limits.maxSide,
          height: limits.maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 92 })
        .toBuffer();
  return {
    bytes: out,
    ext: passThrough && meta.format === 'png' ? 'png' : 'jpg',
    converted: !passThrough,
    sha256: createHash('sha256').update(out).digest('hex'),
  };
}
