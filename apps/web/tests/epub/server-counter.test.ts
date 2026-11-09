/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  buildServerCounter,
  sameCounterCode,
  serverCounterOutput
} from '../../scripts/server-counter/build';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EPUB_COUNT_VERSION } from '$lib/functions/file-loaders/epub/count-epub';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import { countEpubBlob } from '$lib/server/epub/count-epub-node';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The storage server counts characters with a bundle of this app's import code
 * (apps/storage-server/vendor/epub-count.cjs). These tests prove the bundle is current
 * and that the server's path (image bytes skipped, plain CommonJS Node, file-backed
 * input) gives the same results as the browser import.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'fixtures');

/**
 * Runs the committed bundle in plain Node (CommonJS, no Vite), the way the storage
 * server loads it: `node -e RUNNER <bundle> <jobs.json>`, jobs = [{ file, options }],
 * files opened as lazily read file-backed Blobs. Prints { version, results }.
 */
const RUNNER = `
const fs = require('node:fs');
const counter = require(process.argv[1]);
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const results = [];
  for (const job of jobs) {
    try {
      const { characters, sections } = await counter.countEpubForServer(
        await fs.openAsBlob(job.file),
        job.options
      );
      results.push({ characters, sections });
    } catch (error) {
      results.push({ error: String(error) });
    }
  }
  process.stdout.write(JSON.stringify({ version: counter.EPUB_COUNT_VERSION, results }));
})();
`;

interface ExpectedResult {
  characters?: number;
  sections?: unknown[];
  error?: string;
}

const expected = JSON.parse(
  readFileSync(path.join(fixturesDir, 'synthetic.expected.json'), 'utf8')
) as { books: Record<string, Record<string, ExpectedResult>> };

const cases = Object.entries(expected.books).flatMap(([book, modes]) =>
  Object.entries(modes).map(([key, truth]) => {
    const [mode, restrict] = key.split('|');

    return {
      book,
      key,
      truth,
      options: {
        importHTMLFixMode: mode as ImportHTMLFixMode,
        restrictImportFixToAnchor: restrict === 'restrictToAnchor=true'
      }
    };
  })
);

function errorText(truth: ExpectedResult) {
  return (truth.error ?? '').replace(/^Error: /, '');
}

describe('server counter bundle', () => {
  it('is up to date with the web import code (run `pnpm build:server-counter`)', async () => {
    const { code } = await buildServerCounter();
    const committed = readFileSync(serverCounterOutput, 'utf8');

    expect(
      sameCounterCode(committed, code),
      'apps/storage-server/vendor/epub-count.cjs is stale: run `pnpm build:server-counter` in apps/web'
    ).toBe(true);
  });

  it.each(cases)('skipping image bytes keeps the browser result: $book $key', async (c) => {
    const bytes = readFileSync(path.join(fixturesDir, c.book));
    const run = countEpubBlob(new Blob([bytes]), c.options, { imageData: false });

    if (c.truth.error) {
      await expect(run).rejects.toThrow(errorText(c.truth));

      return;
    }

    const result = await run;

    expect(result.characters).toBe(c.truth.characters);
    expect(result.sections).toEqual(c.truth.sections);
  });

  it('gives the browser result when run by plain Node from the committed file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ttu-server-counter-'));

    try {
      const jobsFile = path.join(dir, 'jobs.json');

      writeFileSync(
        jobsFile,
        JSON.stringify(
          cases.map((c) => ({ file: path.join(fixturesDir, c.book), options: c.options }))
        )
      );

      const output = JSON.parse(
        execFileSync(process.execPath, ['-e', RUNNER, serverCounterOutput, jobsFile], {
          encoding: 'utf8'
        })
      ) as { version: number; results: ExpectedResult[] };

      expect(output.version).toBe(EPUB_COUNT_VERSION);
      cases.forEach((c, index) => {
        const result = output.results[index];

        if (c.truth.error) {
          expect(result.error, `${c.book} ${c.key}`).toContain(errorText(c.truth));
        } else {
          expect(result, `${c.book} ${c.key}`).toEqual({
            characters: c.truth.characters,
            sections: c.truth.sections
          });
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
