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
 *
 * Writes tests/parity/.out/parity-report.{json,md} (gitignored). Books are only read.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  countEpubFile,
  countStoredHtml,
  defaultEpubImportOptions
} from '$lib/server/epub/count-epub-node';
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
  c?: Array<{
    options: EpubHtmlImportOptions;
    characters?: number;
    sectionsMatch?: boolean;
    error?: string;
  }>;
}

const reports: BookReport[] = [];

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
    const outDir = path.join(parityDir, '.out');
    const fail = (r: BookReport) => (r.a && !r.a.pass) || (r.b && !r.b.pass);
    const lines = [
      '# WP3a parity report',
      '',
      `Generated ${new Date().toISOString()} from ${manifestPath}`,
      '',
      `Books: ${reports.length}; check A run: ${reports.filter((r) => r.a).length}, failed: ${reports.filter((r) => r.a && !r.a.pass).length}; ` +
        `check B run: ${reports.filter((r) => r.b).length}, failed: ${reports.filter((r) => r.b && !r.b.pass).length}`,
      '',
      '| Book | Pairing | Stored | A: reader count (diff) | B: import count (diff) | B sections | Labels differ | C: matching mode |',
      '|---|---|---:|---:|---:|---|---:|---|'
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
          `${r.b ? r.b.labelDiffs : '-'} | ${r.c ? c || 'none' : '-'} |`
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

      expect.soft(report.a.diff, 'A: reader count in Node vs stored characters').toBe(0);

      if (report.b) {
        expect.soft(report.b.error, 'B: import error').toBeUndefined();
        expect.soft(report.b.diff, 'B: import characters vs stored').toBe(0);
        expect.soft(report.b.firstSectionDiff, 'B: first differing section').toBeUndefined();
      }
    },
    10 * 60_000
  );
});
