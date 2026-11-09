/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { countEpubFile, countStoredHtml } from '$lib/server/epub/count-epub-node';
import { describe, expect, it } from 'vitest';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Node import vs. the real browser import of the same files.
 * The expected values were captured from the unmodified browser code (see the
 * `capturedWith` block in the JSON) and must not be edited by hand.
 */
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface ExpectedResult {
  characters?: number;
  readerCount?: number;
  sections?: unknown[];
  error?: string;
}

const expected = JSON.parse(
  readFileSync(path.join(fixturesDir, 'synthetic.expected.json'), 'utf8')
) as { books: Record<string, Record<string, ExpectedResult>> };

function parseModeKey(key: string) {
  const [mode, restrict] = key.split('|');

  return {
    importHTMLFixMode: mode as ImportHTMLFixMode,
    restrictImportFixToAnchor: restrict === 'restrictToAnchor=true'
  };
}

describe.each(Object.entries(expected.books))('%s', (book, modes) => {
  it.each(Object.entries(modes))('matches the browser import with %s', async (key, truth) => {
    const run = countEpubFile(path.join(fixturesDir, book), parseModeKey(key));

    if (truth.error) {
      await expect(run).rejects.toThrow(truth.error.replace(/^Error: /, ''));

      return;
    }

    const result = await run;

    expect(result.characters).toBe(truth.characters);
    expect(result.sections).toEqual(truth.sections);
    expect(countStoredHtml(result.elementHtml)).toBe(truth.readerCount);
  });
});
