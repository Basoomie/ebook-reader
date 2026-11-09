/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Writes apps/storage-server/vendor/epub-count.cjs (see server-counter/build.ts).
 *
 *   pnpm build:server-counter [--list-inputs]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildServerCounter, serverCounterOutput, webRoot } from './server-counter/build';

const { code, buildId, inputs } = await buildServerCounter();

await mkdir(path.dirname(serverCounterOutput), { recursive: true });
await writeFile(serverCounterOutput, code, 'utf8');

console.log(
  `Wrote ${path.relative(webRoot, serverCounterOutput)} (build ${buildId}, ${Math.round(code.length / 1024)} KB, ${inputs.length} inputs)`
);

if (process.argv.includes('--list-inputs')) {
  for (const input of inputs) {
    console.log(`  ${input}`);
  }
}
