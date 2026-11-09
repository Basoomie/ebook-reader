/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Builds the parity manifest that pairs each stored book with its Calibre EPUB.
 *
 *   NODE_OPTIONS=--experimental-sqlite pnpm exec vite-node tests/parity/build-manifest.ts -- \
 *     --stored <storage-server-data-dir> --library <calibre-library-dir> [--library ...] \
 *     [--out tests/parity/manifest.local.json]
 *
 * Candidates come from titles in a copy of metadata.db. A candidate is accepted only if
 * its fingerprint (dc:title, image CRC32s, spine ids) matches the stored book, which
 * involves no character counting. Review the output before relying on it.
 *
 * Read-only towards Calibre: metadata.db is copied to a temp folder and only the copy
 * is opened; EPUBs are opened read-only (central directory + OPF). The only file
 * written is the manifest, which must be inside tests/parity.
 */

import { compareFingerprints, fingerprintEpub, fingerprintStoredZip } from './epub-fingerprint';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { FingerprintComparison } from './epub-fingerprint';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { readStoredBook } from './stored-book';

export interface ManifestEntry {
  storedDir: string;
  storedTitle: string;
  storedCharacters: number;
  /**
   * verified: exactly one candidate matches the fingerprint.
   * verified-duplicates: several candidates match (identical files); the lowest id is used.
   * unverified: candidates exist but none matches; no EPUB is used.
   * none: no title candidate in Calibre.
   */
  match: 'verified' | 'verified-duplicates' | 'unverified' | 'none';
  epubPath: string | null;
  calibreId: number | null;
  calibreTitle: string | null;
  candidates: Array<{ calibreId: number; title: string; epubPath: string } & FingerprintComparison>;
}

interface CalibreEpub {
  calibreId: number;
  title: string;
  epubPath: string;
  key: string;
  looseKey: string;
}

const parityDir = path.dirname(fileURLToPath(import.meta.url));
const maxCandidates = 40;

function parseArgs() {
  const args = process.argv.slice(2);
  const libraries: string[] = [];
  let stored = '';
  let out = path.join(parityDir, 'manifest.local.json');

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--stored') stored = args[(i += 1)];
    else if (args[i] === '--library') libraries.push(args[(i += 1)]);
    else if (args[i] === '--out') out = path.resolve(args[(i += 1)]);
  }

  if (!stored || !libraries.length) {
    throw new Error('usage: --stored <data dir> --library <calibre library> [--library ...]');
  }

  return { stored, libraries, out: path.resolve(out) };
}

function isInside(child: string, parent: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));

  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The manifest may only be written inside tests/parity, never near books or Calibre. */
function assertSafeOutput(out: string, readOnlyRoots: string[]) {
  if (!isInside(out, parityDir)) {
    throw new Error(`Refusing to write outside ${parityDir}: ${out}`);
  }

  for (const root of readOnlyRoots) {
    if (isInside(out, root)) {
      throw new Error(`Refusing to write inside a read-only root: ${out}`);
    }
  }
}

/** Title key: NFKC, lower case, no whitespace or common punctuation. */
export function titleKey(title: string) {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()[\]{}【】「」『』〈〉《》〔〕:：・、。!?！？~〜～\-‐―]/g, '');
}

/** Like titleKey, but bracketed parts (labels, bonuses, imprint) are dropped first. */
export function looseTitleKey(title: string) {
  return titleKey(title.normalize('NFKC').replace(/【[^】]*】|\([^)]*\)|\[[^\]]*\]/g, ''));
}

async function readCalibreEpubs(library: string): Promise<CalibreEpub[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ttu-parity-'));
  const copy = path.join(tempDir, 'metadata.db');

  try {
    await copyFile(path.join(library, 'metadata.db'), copy);

    const db = new DatabaseSync(copy, { readOnly: true });

    try {
      const rows = db
        .prepare(
          `SELECT b.id AS id, b.title AS title, b.path AS path, d.name AS name
           FROM books b JOIN data d ON d.book = b.id
           WHERE upper(d.format) = 'EPUB'`
        )
        .all() as Array<{ id: number; title: string; path: string; name: string }>;

      return rows.map((row) => ({
        calibreId: row.id,
        title: row.title,
        epubPath: path.join(library, ...row.path.split('/'), `${row.name}.epub`),
        key: titleKey(row.title),
        looseKey: looseTitleKey(row.title)
      }));
    } finally {
      db.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Candidate tiers, tried in order until one yields a verified match. */
function candidateTiers(storedTitle: string, epubs: CalibreEpub[]) {
  const key = titleKey(storedTitle);
  const looseKey = looseTitleKey(storedTitle);
  const contains = (a: string, b: string) =>
    a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));

  return [
    epubs.filter((epub) => epub.key === key),
    epubs.filter((epub) => epub.looseKey === looseKey),
    epubs.filter((epub) => contains(epub.key, key) || contains(epub.looseKey, looseKey))
  ];
}

async function main() {
  const { stored, libraries, out } = parseArgs();

  assertSafeOutput(out, [stored, ...libraries]);

  const epubs = (await Promise.all(libraries.map(readCalibreEpubs))).flat();
  const entries: ManifestEntry[] = [];
  const dirs = (await readdir(stored, { withFileTypes: true }))
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();

  for (const name of dirs) {
    const book = await readStoredBook(path.join(stored, name));

    if (!book) {
      continue;
    }

    const storedPrint = await fingerprintStoredZip(book.zipPath, book.title);
    const sectionIds = book.sections.map((section) => section.reference);
    const entry: ManifestEntry = {
      storedDir: book.dir,
      storedTitle: book.title,
      storedCharacters: book.characters,
      match: 'none',
      epubPath: null,
      calibreId: null,
      calibreTitle: null,
      candidates: []
    };
    const seen = new Set<number>();

    for (const tier of candidateTiers(book.title, epubs)) {
      const fresh = tier.filter((epub) => !seen.has(epub.calibreId)).slice(0, maxCandidates);

      for (const epub of fresh) {
        seen.add(epub.calibreId);

        let comparison: FingerprintComparison;

        try {
          comparison = compareFingerprints(
            storedPrint,
            sectionIds,
            await fingerprintEpub(epub.epubPath)
          );
        } catch (_) {
          comparison = {
            titleMatches: false,
            imagesMatched: 0,
            imagesTotal: storedPrint.images.size,
            missingSpineIds: -1,
            verified: false
          };
        }

        entry.candidates.push({
          calibreId: epub.calibreId,
          title: epub.title,
          epubPath: epub.epubPath,
          ...comparison
        });
      }

      const verified = entry.candidates.filter((candidate) => candidate.verified);

      if (verified.length) {
        verified.sort((a, b) => a.calibreId - b.calibreId);
        entry.match = verified.length === 1 ? 'verified' : 'verified-duplicates';
        entry.epubPath = verified[0].epubPath;
        entry.calibreId = verified[0].calibreId;
        entry.calibreTitle = verified[0].title;
        break;
      }
    }

    if (entry.match === 'none' && entry.candidates.length) {
      entry.match = 'unverified';
    }

    entries.push(entry);
    console.log(`[${entry.match}] ${book.title} (${entry.candidates.length} candidates)`);
  }

  await writeFile(
    out,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)}\n`
  );

  const tally = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.match] = (acc[entry.match] || 0) + 1;

    return acc;
  }, {});

  console.log(`${entries.length} stored books, ${epubs.length} Calibre EPUBs`, tally);
  console.log(`wrote ${out}`);
}

await main();
