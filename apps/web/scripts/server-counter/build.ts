/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Builds the storage server's character counter from the web app's own EPUB import and
 * counting code (design R1: one counter for both sides). The output is a single CommonJS
 * file committed at apps/storage-server/vendor/epub-count.cjs; jsdom stays external and
 * is a pinned dependency of the server. A test fails when the committed file is not what
 * this build produces, so the server can never run stale counting rules unnoticed.
 */

import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EPUB_COUNT_VERSION } from '../../src/lib/functions/file-loaders/epub/count-epub';

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const serverCounterOutput = path.resolve(
  webRoot,
  '..',
  'storage-server',
  'vendor',
  'epub-count.cjs'
);

const entry = 'src/lib/server/epub/server-counter.ts';

/** Resolves SvelteKit's `$lib/...` imports to `src/lib/...`. */
const libAlias: Plugin = {
  name: 'lib-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\$lib(\/|$)/ }, (args) => {
      const rest = args.path.slice('$lib'.length).replace(/^\//, '');

      return pluginBuild.resolve(`./${rest}`, {
        kind: args.kind,
        resolveDir: path.join(webRoot, 'src', 'lib')
      });
    });
  }
};

export interface ServerCounterBuild {
  /** The complete file content, header included. */
  code: string;
  /** First 16 hex digits of the SHA-256 of the bundle body (shown by the server). */
  buildId: string;
  /** Source files bundled into the counter, relative to apps/web (for review). */
  inputs: string[];
}

export async function buildServerCounter(): Promise<ServerCounterBuild> {
  const result = await build({
    absWorkingDir: webRoot,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['jsdom'],
    charset: 'utf8',
    legalComments: 'eof',
    // Independent of apps/web/tsconfig.json (which extends the generated .svelte-kit config).
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [libAlias]
  });
  const body = result.outputFiles[0].text;
  const buildId = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const header =
    '/*\n' +
    ' * GENERATED FILE, DO NOT EDIT. The storage server character counter, bundled from the\n' +
    ' * web app EPUB import and counting code (apps/web/' +
    entry +
    ').\n' +
    ' * Rebuild with `pnpm build:server-counter` in apps/web after changing that code.\n' +
    ` * epub-count-version: ${EPUB_COUNT_VERSION}\n` +
    ` * build: ${buildId}\n` +
    ' */\n';

  return {
    code: header + body,
    buildId,
    inputs: Object.keys(result.metafile.inputs).sort()
  };
}

/** Line-ending-insensitive comparison (the working copy may use CRLF on Windows). */
export function sameCounterCode(a: string, b: string) {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}
