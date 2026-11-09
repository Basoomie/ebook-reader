/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Parity of the Node loader/counter against books the browser already imported.
 * Opt-in (needs the NAS): `pnpm test:parity`, or set TTU_PARITY_MANIFEST.
 *
 * A (hard): reader counter in Node over the stored elementHtml == stored characters.
 * B (hard): Node import of the paired Calibre EPUB == stored characters and sections
 *           (labels are reported, not failed).
 * C (info): if B fails with the default fix mode, which other fix mode matches.
 * D (hard): the storage server's counter (WP3b) on the same EPUB == stored characters:
 *           the committed bundle in a counter process, read through the server's
 *           read-only file view with image bytes skipped. Also: sections with image
 *           bytes skipped == stored sections, and how much of the file was read.
 *
 * Writes tests/parity/.out/parity-report.{json,md} (gitignored). Books are only read.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  countEpubBlob,
  countEpubFile,
  countStoredHtml,
  defaultEpubImportOptions
} from '$lib/server/epub/count-epub-node';
import { CountWorker } from '../../../storage-server/src/counts/count-worker';
import { readCounterInfo } from '../../../storage-server/src/counts/counter-bundle';
import { openAsBlob, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { EpubHtmlImportOptions } from '$lib/functions/file-loaders/epub/generate-epub-html';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import type { ManifestEntry } from './build-manifest';
import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readStoredBook } from './stored-book';
import { readFileSync } from 'node:fs';

const parityDir = path.dirname(fileURLToPath(import.meta.url));
const enabled = !!process.env.TTU_PARITY_MANIFEST || import.meta.env.MODE === 'parity';
const manifestPath = process.env.TTU_PARITY_MANIFEST || path.join(parityDir, 'manifest.local.json');
const entries: ManifestEntry[] = enabled
  ? JSON.parse(readFileSync(manifestPath, 'utf8')).entries
  : [];

const otherModes: EpubHtmlImportOptions[] = [
  { importHTMLFixMode: ImportHTMLFixMode.STANDARD, restrictImportFixToAnchor: true },
  { importHTMLFixMode: ImportHTMLFixMode.STANDARD, restrictImportFixToAnchor: false },
  { importHTMLFixMode: ImportHTMLFixMode.EXTENDED, restrictImportFixToAnchor: true },
  { importHTMLFixMode: ImportHTMLFixMode.EXTENDED, restrictImportFixToAnchor: false }
];

interface BookReport {
  title: string;
  storedCharacters: number;
  match: ManifestEntry['match'];
  a?: { nodeReaderCount: number; diff: number; pass: boolean };
  b?: {
    nodeCharacters: number;
    diff: number;
    sectionsMatch: boolean;
    firstSectionDiff?: { index: number; stored?: unknown; node?: unknown };
    labelDiffs: number;
    elementHtmlIdentical: boolean;
    pass: boolean;
    error?: string;
  };
  d?: {
    serverCharacters?: number;
    sectionsMatch?: boolean;
    bytesRead?: number;
    fileSize: number;
    durationMs?: number;
    pass: boolean;
    error?: string;
  };
  c?: Array<{
    options: EpubHtmlImportOptions;
    characters?: number;
    sectionsMatch?: boolean;
    error?: string;
  }>;
}

const reports: BookReport[] = [];

let serverWorker: CountWorker | undefined;

/** The storage server's counter process (one for the whole run). */
function getServerWorker() {
  if (!serverWorker) {
    const counter = readCounterInfo();

    serverWorker = new CountWorker({
      counterFile: counter.file,
      expectedVersion: counter.version,
      maxMemoryMb: 768,
      nice: 0,
      booksPerProcess: 500,
      timeoutMs: 5 * 60_000,
      startTimeoutMs: 5 * 60_000
    });
  }

  return serverWorker;
}

/** Section fields that decide counts and navigation; labels are compared separately. */
const structural = (section: Section) => ({
  reference: section.reference,
  charactersWeight: section.charactersWeight,
  parentChapter: section.parentChapter,
  startCharacter: section.startCharacter,
  characters: section.characters
});

function compareSections(stored: Section[], node: Section[]) {
  const length = Math.max(stored.length, node.length);
  let labelDiffs = 0;
  let firstSectionDiff: NonNullable<BookReport['b']>['firstSectionDiff'];

  for (let index = 0; index < length; index += 1) {
    const a = stored[index];
    const b = node[index];

    if (
      !firstSectionDiff &&
      JSON.stringify(a && structural(a)) !== JSON.stringify(b && structural(b))
    ) {
      firstSectionDiff = { index, stored: a && structural(a), node: b && structural(b) };
    }

    if ((a?.label ?? null) !== (b?.label ?? null)) {
      labelDiffs += 1;
    }
  }

  return { sectionsMatch: !firstSectionDiff, firstSectionDiff, labelDiffs };
}

describe.skipIf(!enabled)('parity with stored books', () => {
  afterAll(async () => {
    serverWorker?.close();

    const outDir = path.join(parityDir, '.out');
    const fail = (r: BookReport) => (r.a && !r.a.pass) || (r.b && !r.b.pass) || (r.d && !r.d.pass);
    const withD = reports.filter((r) => r.d?.bytesRead !== undefined);
    const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);
    const lines = [
      '# WP3a parity report',
      '',
      `Generated ${new Date().toISOString()} from ${manifestPath}`,
      '',
      `Books: ${reports.length}; check A run: ${reports.filter((r) => r.a).length}, failed: ${reports.filter((r) => r.a && !r.a.pass).length}; ` +
        `check B run: ${reports.filter((r) => r.b).length}, failed: ${reports.filter((r) => r.b && !r.b.pass).length}; ` +
        `check D run: ${reports.filter((r) => r.d).length}, failed: ${reports.filter((r) => r.d && !r.d.pass).length}`,
      '',
      `Server counter (D): read ${(sum(withD.map((r) => r.d!.bytesRead!)) / 1e6).toFixed(1)} MB of ` +
        `${(sum(withD.map((r) => r.d!.fileSize)) / 1e6).toFixed(1)} MB in ${withD.length} books; ` +
        `median ${median(withD.map((r) => r.d!.durationMs!))} ms per book.`,
      '',
      '| Book | Pairing | Stored | A: reader count (diff) | B: import count (diff) | B sections | Labels differ | C: matching mode | D: server count | D sections | D read (KB of KB) | D ms |',
      '|---|---|---:|---:|---:|---|---:|---|---:|---|---:|---:|'
    ];

    for (const r of reports) {
      const c = r.c
        ?.filter((attempt) => attempt.characters === r.storedCharacters && attempt.sectionsMatch)
        .map(
          (attempt) =>
            `${attempt.options.importHTMLFixMode}/${attempt.options.restrictImportFixToAnchor ? 'anchor' : 'all'}`
        )
        .join(', ');

      lines.push(
        `| ${fail(r) ? '**FAIL** ' : ''}${r.title.replace(/\|/g, '\\|')} | ${r.match} | ${r.storedCharacters} | ` +
          `${r.a ? `${r.a.nodeReaderCount} (${r.a.diff})` : '-'} | ` +
          `${r.b ? (r.b.error ? `error: ${r.b.error}` : `${r.b.nodeCharacters} (${r.b.diff})`) : '-'} | ` +
          `${r.b ? (r.b.sectionsMatch ? 'match' : `differ at #${r.b.firstSectionDiff?.index}`) : '-'} | ` +
          `${r.b ? r.b.labelDiffs : '-'} | ${r.c ? c || 'none' : '-'} | ` +
          `${r.d ? (r.d.error ? `error: ${r.d.error}` : r.d.serverCharacters) : '-'} | ` +
          `${r.d?.sectionsMatch === undefined ? '-' : r.d.sectionsMatch ? 'match' : 'differ'} | ` +
          `${r.d?.bytesRead === undefined ? '-' : `${Math.round(r.d.bytesRead / 1024)} of ${Math.round(r.d.fileSize / 1024)}`} | ` +
          `${r.d?.durationMs ?? '-'} |`
      );
    }

    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, 'parity-report.json'),
      `${JSON.stringify(reports, null, 2)}\n`
    );
    await writeFile(path.join(outDir, 'parity-report.md'), `${lines.join('\n')}\n`);
  });

  it.each(entries.map((entry) => [entry.storedTitle, entry] as const))(
    '%s',
    async (_title, entry) => {
      const stored = await readStoredBook(entry.storedDir);

      expect(stored, `stored book missing in ${entry.storedDir}`).toBeDefined();

      const report: BookReport = {
        title: entry.storedTitle,
        storedCharacters: stored!.characters,
        match: entry.match
      };

      reports.push(report);

      // A: the reader's in-book counter, in Node, over what the browser stored.
      const nodeReaderCount = countStoredHtml(stored!.elementHtml);

      report.a = {
        nodeReaderCount,
        diff: nodeReaderCount - stored!.characters,
        pass: nodeReaderCount === stored!.characters
      };

      // B: full Node import of the verified Calibre EPUB.
      if (entry.epubPath && entry.match.startsWith('verified')) {
        try {
          const result = await countEpubFile(entry.epubPath, defaultEpubImportOptions);
          const sections = compareSections(stored!.sections, result.sections);

          report.b = {
            nodeCharacters: result.characters,
            diff: result.characters - stored!.characters,
            ...sections,
            elementHtmlIdentical: result.elementHtml === stored!.elementHtml,
            pass: result.characters === stored!.characters && sections.sectionsMatch
          };
        } catch (error) {
          report.b = {
            nodeCharacters: 0,
            diff: 0,
            sectionsMatch: false,
            labelDiffs: 0,
            elementHtmlIdentical: false,
            pass: false,
            error: String(error)
          };
        }

        // C: diagnosis only.
        if (!report.b.pass) {
          report.c = [];

          for (const options of otherModes) {
            try {
              const result = await countEpubFile(entry.epubPath, options);

              report.c.push({
                options,
                characters: result.characters,
                sectionsMatch: compareSections(stored!.sections, result.sections).sectionsMatch
              });
            } catch (error) {
              report.c.push({ options, error: String(error) });
            }
          }
        }
      }

      // D: the storage server's counter, exactly as the server runs it.
      if (entry.epubPath && entry.match.startsWith('verified')) {
        const fileSize = statSync(entry.epubPath).size;
        const outcome = await getServerWorker().count(entry.epubPath, defaultEpubImportOptions);
        const skipped = await countEpubBlob(
          await openAsBlob(entry.epubPath),
          defaultEpubImportOptions,
          { imageData: false }
        );
        const sectionsMatch = compareSections(stored!.sections, skipped.sections).sectionsMatch;

        report.d = outcome.ok
          ? {
              serverCharacters: outcome.characters,
              sectionsMatch,
              bytesRead: outcome.bytesRead,
              fileSize,
              durationMs: outcome.durationMs,
              pass: outcome.characters === stored!.characters && sectionsMatch
            }
          : { fileSize, sectionsMatch, pass: false, error: `${outcome.code}: ${outcome.message}` };
      }

      expect.soft(report.a.diff, 'A: reader count in Node vs stored characters').toBe(0);

      if (report.b) {
        expect.soft(report.b.error, 'B: import error').toBeUndefined();
        expect.soft(report.b.diff, 'B: import characters vs stored').toBe(0);
        expect.soft(report.b.firstSectionDiff, 'B: first differing section').toBeUndefined();
      }

      if (report.d) {
        expect.soft(report.d.error, 'D: server counter error').toBeUndefined();
        expect
          .soft(report.d.serverCharacters, 'D: server count vs stored')
          .toBe(stored!.characters);
        expect.soft(report.d.sectionsMatch, 'D: sections with image bytes skipped').toBe(true);
      }
    },
    10 * 60_000
  );
});

function median(values: number[]) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
}
