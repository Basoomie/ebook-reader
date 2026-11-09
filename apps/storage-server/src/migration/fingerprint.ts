/**
 * Book fingerprints for the WP5 migration, ported from the WP3a parity tool
 * (apps/web/tests/parity/epub-fingerprint.ts and build-manifest.ts). The rules
 * are unchanged: a stored book and a Calibre EPUB match when the EPUB
 * dc:title, every stored image's CRC32 and every stored section's spine id
 * agree. No character counting is involved.
 *
 * Differences from WP3a, none of which changes a result:
 * - ZIPs are read with the dependency-free zip-read.ts (central directory and
 *   a few text entries only) instead of zip.js.
 * - CRCs are compared as numbers instead of zip.js's hex text.
 */
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { ReadOnlyOpener, ZipFile } from './zip-read';

export interface BookFingerprint {
  /** dc:title as the browser import picks it (first string or #text). */
  title: string;
  /** EPUB-relative image path -> CRC32. */
  images: Map<string, number>;
  /** Spine idrefs (only for EPUBs). */
  spineIds?: Set<string>;
}

export interface StoredFingerprint extends BookFingerprint {
  /** Section references of the stored book (`ttu-<idref>`). */
  sectionIds: string[];
}

export interface FingerprintComparison {
  titleMatches: boolean;
  imagesMatched: number;
  imagesTotal: number;
  /** Stored section ids that are not in the EPUB spine (-1 = the EPUB could not be read). */
  missingSpineIds: number;
  verified: boolean;
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function pickTitle(metadata: Record<string, unknown> | undefined): string {
  for (const dcTitle of asArray(metadata?.['dc:title'] as unknown)) {
    if (typeof dcTitle === 'string') return dcTitle;
    if (dcTitle && typeof dcTitle === 'object' && '#text' in dcTitle) {
      return String((dcTitle as Record<string, unknown>)['#text']);
    }
  }
  return '';
}

export async function fingerprintEpub(
  epubPath: string,
  opener: ReadOnlyOpener,
): Promise<BookFingerprint> {
  const zip = await ZipFile.open(epubPath, opener);
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const containerEntry = zip.get('META-INF/container.xml');
    if (!containerEntry) throw new Error('META-INF/container.xml missing');
    const container = parser.parse(await zip.readText(containerEntry));
    const rootFile = asArray(container.container.rootfiles.rootfile)[0] as Record<string, string>;
    const opfPath: string = rootFile['@_full-path'];
    const contentsDirectory = path.posix.dirname(opfPath);
    const opfEntry = zip.get(opfPath);
    if (!opfEntry) throw new Error(`${opfPath} missing`);
    const opf = parser.parse(await zip.readText(opfEntry));
    const pkg = opf['opf:package'] || opf.package;
    const prefix = opf['opf:package'] ? 'opf:' : '';
    const manifestItems = asArray(pkg[`${prefix}manifest`][`${prefix}item`]) as Array<
      Record<string, string>
    >;
    const spineItems = asArray(pkg[`${prefix}spine`][`${prefix}itemref`]) as Array<
      Record<string, string>
    >;
    const images = new Map<string, number>();
    for (const item of manifestItems) {
      if (!item['@_media-type']?.startsWith('image/')) continue;
      const entry = zip.get(path.posix.join(contentsDirectory, item['@_href']));
      if (entry) images.set(item['@_href'], entry.crc32);
    }
    return {
      title: pickTitle(pkg[`${prefix}metadata`]),
      images,
      spineIds: new Set(spineItems.map((item) => item['@_idref'])),
    };
  } finally {
    await zip.close();
  }
}

/**
 * A book as the browser stored it in the old sync (`bookdata_*.zip`): images
 * from `blobs/<EPUB-relative path>`, title and sections from staticdata.json.
 */
export async function fingerprintStoredZip(
  zipPath: string,
  opener: ReadOnlyOpener,
): Promise<StoredFingerprint> {
  const zip = await ZipFile.open(zipPath, opener);
  try {
    const images = new Map<string, number>();
    for (const entry of zip.entries) {
      if (entry.name.startsWith('blobs/'))
        images.set(entry.name.slice('blobs/'.length), entry.crc32);
    }
    const staticEntry = zip.get('staticdata.json');
    if (!staticEntry) throw new Error('staticdata.json missing');
    const staticData = JSON.parse(await zip.readText(staticEntry)) as {
      title?: unknown;
      sections?: Array<{ reference?: unknown }>;
    };
    return {
      title: typeof staticData.title === 'string' ? staticData.title : '',
      images,
      sectionIds: (Array.isArray(staticData.sections) ? staticData.sections : [])
        .map((s) => s?.reference)
        .filter((r): r is string => typeof r === 'string'),
    };
  } finally {
    await zip.close();
  }
}

export function compareFingerprints(
  stored: StoredFingerprint,
  epub: BookFingerprint,
): FingerprintComparison {
  let imagesMatched = 0;
  for (const [name, crc] of stored.images) {
    if (epub.images.get(name) === crc) imagesMatched += 1;
  }
  const missingSpineIds = stored.sectionIds.filter(
    (id) => !epub.spineIds?.has(id.replace(/^ttu-/, '')),
  ).length;
  const titleMatches = stored.title === epub.title;
  return {
    titleMatches,
    imagesMatched,
    imagesTotal: stored.images.size,
    missingSpineIds,
    verified: titleMatches && imagesMatched === stored.images.size && missingSpineIds === 0,
  };
}

/** Title key: NFKC, lower case, no whitespace or common punctuation. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()[\]{}【】「」『』〈〉《》〔〕:：・、。!?！？~〜～\-‐―]/g, '');
}

/** Like titleKey, but bracketed parts (labels, bonuses, imprint) are dropped first. */
export function looseTitleKey(title: string): string {
  return titleKey(title.normalize('NFKC').replace(/【[^】]*】|\([^)]*\)|\[[^\]]*\]/g, ''));
}

export interface TitleKeyed {
  key: string;
  looseKey: string;
}

/** Candidate tiers, tried in order until one yields a verified match (WP3a). */
export function candidateTiers<T extends TitleKeyed>(storedTitle: string, books: T[]): T[][] {
  const key = titleKey(storedTitle);
  const looseKey = looseTitleKey(storedTitle);
  const contains = (a: string, b: string) =>
    a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
  return [
    books.filter((b) => b.key === key),
    books.filter((b) => b.looseKey === looseKey),
    books.filter((b) => contains(b.key, key) || contains(b.looseKey, looseKey)),
  ];
}

/** At most this many candidates are fingerprinted per tier (WP3a). */
export const MAX_CANDIDATES_PER_TIER = 40;
