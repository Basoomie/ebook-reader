/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Writes apps/storage-server/vendor/library-query.cjs (see server-query/build.ts).
 *
 *   pnpm build:server-query
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildServerQuery, serverQueryOutput, webRoot } from './server-query/build';

const { code, buildId } = await buildServerQuery();

await mkdir(path.dirname(serverQueryOutput), { recursive: true });
await writeFile(serverQueryOutput, code, 'utf8');

console.log(
  `Wrote ${path.relative(webRoot, serverQueryOutput)} (build ${buildId}, ${Math.round(code.length / 1024)} KB)`
);
