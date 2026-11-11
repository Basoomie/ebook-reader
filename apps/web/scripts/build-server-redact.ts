/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Writes apps/storage-server/vendor/redact.cjs (see server-redact/build.ts).
 *
 *   pnpm build:server-redact
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildServerRedact, serverRedactOutput, webRoot } from './server-redact/build';

const { code, buildId } = await buildServerRedact();

await mkdir(path.dirname(serverRedactOutput), { recursive: true });
await writeFile(serverRedactOutput, code, 'utf8');

console.log(
  `Wrote ${path.relative(webRoot, serverRedactOutput)} (build ${buildId}, ${Math.round(code.length / 1024)} KB)`
);
