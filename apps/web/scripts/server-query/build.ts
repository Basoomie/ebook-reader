/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Builds the storage server's search parser from the web app's own parser (WP7a: one
 * parser for both sides). The output is a single dependency-free CommonJS file committed
 * at apps/storage-server/vendor/library-query.cjs. A test fails when the committed file
 * is not what this build produces.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const serverQueryOutput = path.resolve(
  webRoot,
  '..',
  'storage-server',
  'vendor',
  'library-query.cjs'
);

const entry = 'src/lib/library/query/server-entry.ts';

export async function buildServerQuery(): Promise<{ code: string; buildId: string }> {
  const result = await build({
    absWorkingDir: webRoot,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'eof',
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    logLevel: 'silent'
  });
  const body = result.outputFiles[0].text;
  const buildId = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const header =
    '/*\n' +
    ' * GENERATED FILE, DO NOT EDIT. The storage server library search parser, bundled from\n' +
    ` * the web app (apps/web/${entry}).\n` +
    ' * Rebuild with `pnpm build:server-query` in apps/web after changing that code.\n' +
    ` * build: ${buildId}\n` +
    ' */\n';
  return { code: header + body, buildId };
}
