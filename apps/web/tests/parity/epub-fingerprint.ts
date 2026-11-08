/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BlobReader, Reader, TextWriter, ZipReader, configure } from '@zip.js/zip.js';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import path from 'path-browserify';

configure({ useWebWorkers: false });

/**
 * Identity facts about a book that do not involve character counting, so pairing a
 * stored book with a Calibre EPUB cannot be biased towards the counter under test.
 */
export interface BookFingerprint {
  /** dc:title as the browser import picks it (first string or #text). */
  title: string;
  /** EPUB-relative image path -> CRC32 (hex). */
  images: Map<string, string>;
  /** Spine idrefs (only for EPUBs). */
  spineIds?: Set<string>;
}

/** Seekable, read-only file reader: only the central directory and the OPF are read. */
class FileHandleReader extends Reader<string> {
  private handle: FileHandle | undefined;

  constructor(private readonly filePath: string) {
    super(filePath);
  }

  async init() {
    this.handle = await open(this.filePath, 'r');
    this.size = (await this.handle.stat()).size;
    (this as unknown as { initialized: boolean }).initialized = true;
  }

  async readUint8Array(index: number, length: number) {
    const buffer = Buffer.alloc(length);

    await this.handle!.read(buffer, 0, length, index);

    return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
  }

  async close() {
    await this.handle?.close();
  }
}

const crcHex = (signature: Uint8Array | number) =>
  typeof signature === 'number'
    ? (signature >>> 0).toString(16)
    : Array.from(signature)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');

const asArray = <T>(value: T | T[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function pickTitle(metadata: Record<string, unknown> | undefined) {
  for (const dcTitle of asArray(metadata?.['dc:title'] as unknown)) {
    if (typeof dcTitle === 'string') return dcTitle;
    if (dcTitle && typeof dcTitle === 'object' && '#text' in dcTitle) {
      return String((dcTitle as Record<string, unknown>)['#text']);
    }
  }

  return '';
}

export async function fingerprintEpub(epubPath: string): Promise<BookFingerprint> {
  const fileReader = new FileHandleReader(epubPath);
  const zip = new ZipReader(fileReader);

  try {
    const entries = await zip.getEntries();
    const byName = new Map(entries.map((entry) => [entry.filename, entry]));
    const parser = new XMLParser({ ignoreAttributes: false });
    const container = parser.parse(
      await byName.get('META-INF/container.xml')!.getData!(new TextWriter())
    );
    const rootFile = asArray(container.container.rootfiles.rootfile)[0];
    const opfPath: string = rootFile['@_full-path'];
    const contentsDirectory = path.dirname(opfPath);
    const opf = parser.parse(await byName.get(opfPath)!.getData!(new TextWriter()));
    const pkg = opf['opf:package'] || opf.package;
    const prefix = opf['opf:package'] ? 'opf:' : '';
    const manifestItems = asArray(pkg[`${prefix}manifest`][`${prefix}item`]) as Array<
      Record<string, string>
    >;
    const spineItems = asArray(pkg[`${prefix}spine`][`${prefix}itemref`]) as Array<
      Record<string, string>
    >;
    const images = new Map<string, string>();

    for (const item of manifestItems) {
      if (!item['@_media-type']?.startsWith('image/')) continue;

      const entry = byName.get(path.join(contentsDirectory, item['@_href']));

      if (entry) {
        images.set(item['@_href'], crcHex(entry.signature as unknown as Uint8Array | number));
      }
    }

    return {
      title: pickTitle(pkg[`${prefix}metadata`]),
      images,
      spineIds: new Set(spineItems.map((item) => item['@_idref']))
    };
  } finally {
    await zip.close();
    await fileReader.close();
  }
}

/** Image CRCs from a stored bookdata zip (`blobs/<EPUB-relative path>`). */
export async function fingerprintStoredZip(zipPath: string, title: string) {
  const zip = new ZipReader(new BlobReader(new Blob([await readFile(zipPath)])));

  try {
    const images = new Map<string, string>();

    for (const entry of await zip.getEntries()) {
      if (entry.filename.startsWith('blobs/')) {
        images.set(
          entry.filename.slice('blobs/'.length),
          crcHex(entry.signature as unknown as Uint8Array | number)
        );
      }
    }

    return { title, images } satisfies BookFingerprint;
  } finally {
    await zip.close();
  }
}

export interface FingerprintComparison {
  titleMatches: boolean;
  imagesMatched: number;
  imagesTotal: number;
  /** Stored section ids (`ttu-<idref>`) that are not in the EPUB spine. */
  missingSpineIds: number;
  verified: boolean;
}

export function compareFingerprints(
  stored: BookFingerprint,
  storedSectionIds: string[],
  epub: BookFingerprint
): FingerprintComparison {
  let imagesMatched = 0;

  for (const [name, crc] of stored.images) {
    if (epub.images.get(name) === crc) imagesMatched += 1;
  }

  const missingSpineIds = storedSectionIds.filter(
    (id) => !epub.spineIds?.has(id.replace(/^ttu-/, ''))
  ).length;
  const titleMatches = stored.title === epub.title;

  return {
    titleMatches,
    imagesMatched,
    imagesTotal: stored.images.size,
    missingSpineIds,
    verified: titleMatches && imagesMatched === stored.images.size && missingSpineIds === 0
  };
}
