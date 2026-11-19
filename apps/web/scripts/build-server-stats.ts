/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Writes apps/storage-server/vendor/stats.cjs (see server-stats/build.ts).
 *
 *   pnpm build:server-stats [--list-inputs]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildServerStats, serverStatsOutput, webRoot } from './server-stats/build';

const { code, buildId, inputs } = await buildServerStats();

await mkdir(path.dirname(serverStatsOutput), { recursive: true });
await writeFile(serverStatsOutput, code, 'utf8');

console.log(
  `Wrote ${path.relative(webRoot, serverStatsOutput)} (build ${buildId}, ${Math.round(code.length / 1024)} KB, ${inputs.length} inputs)`
);

if (process.argv.includes('--list-inputs')) {
  for (const input of inputs) {
    console.log(`  ${input}`);
  }
}
