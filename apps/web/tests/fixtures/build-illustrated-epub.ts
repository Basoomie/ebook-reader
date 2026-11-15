/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Writes the illustrated EPUB fixture (illustrated-epub.ts) for the storage server's tests:
 * apps/storage-server/tests/fixtures/illustrations/illustrated.epub.
 *
 * Run from apps/web: `pnpm exec vite-node tests/fixtures/build-illustrated-epub.ts`
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildIllustratedEpub } from './illustrated-epub';

const out = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../storage-server/tests/fixtures/illustrations/illustrated.epub'
);

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, await buildIllustratedEpub());
console.log(`Wrote ${out}`);
