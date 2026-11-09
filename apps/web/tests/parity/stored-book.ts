/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BlobReader, TextWriter, ZipReader, configure } from '@zip.js/zip.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';

configure({ useWebWorkers: false });

/** A book as the browser stored it on the storage server (`<data>/<title>/bookdata_*.zip`). */
export interface StoredBook {
  dir: string;
  zipPath: string;
  /** Number of bookdata zips in the folder (more than one means the newest is used). */
  zipCount: number;
  /** `characters` as encoded in the file name by BaseStorageHandler.getBookFileName. */
  characters: number;
  lastBookModified: number;
  title: string;
  sections: Section[];
  elementHtml: string;
}

const bookDataNameRegex = /^bookdata_(\d+)_(\d+)_(\d+)_(\d+)_(\d+)\.zip$/;

export async function findStoredBookZip(dir: string) {
  const zips = (await readdir(dir))
    .map((name) => ({ name, match: name.match(bookDataNameRegex) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => !!entry.match)
    .sort((a, b) => Number(b.match[4]) - Number(a.match[4]));

  if (!zips.length) {
    return undefined;
  }

  return {
    zipPath: path.join(dir, zips[0].name),
    zipCount: zips.length,
    characters: Number(zips[0].match[3]),
    lastBookModified: Number(zips[0].match[4])
  };
}

/** Reads a stored book (read-only). */
export async function readStoredBook(dir: string): Promise<StoredBook | undefined> {
  const found = await findStoredBookZip(dir);

  if (!found) {
    return undefined;
  }

  const reader = new ZipReader(new BlobReader(new Blob([await readFile(found.zipPath)])));

  try {
    const entries = await reader.getEntries();
    const staticEntry = entries.find((entry) => entry.filename === 'staticdata.json');

    if (!staticEntry?.getData) {
      throw new Error(`staticdata.json missing in ${found.zipPath}`);
    }

    const staticData = JSON.parse(await staticEntry.getData(new TextWriter()));

    return {
      dir,
      ...found,
      title: staticData.title || '',
      sections: staticData.sections || [],
      elementHtml: staticData.elementHtml || ''
    };
  } finally {
    await reader.close();
  }
}
