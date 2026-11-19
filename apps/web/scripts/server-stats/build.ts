/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Builds the storage server's copy of the Stats page's pure code (notifications N2: the
 * stats messages must show the Stats page's totals). The output is a single
 * dependency-free CommonJS file committed at apps/storage-server/vendor/stats.cjs. A test
 * fails when the committed file is not what this build produces.
 */

import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const serverStatsOutput = path.resolve(
  webRoot,
  '..',
  'storage-server',
  'vendor',
  'stats.cjs'
);

const entry = 'src/lib/stats/server-entry.ts';

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

export async function buildServerStats(): Promise<{
  code: string;
  buildId: string;
  inputs: string[];
}> {
  const result = await build({
    absWorkingDir: webRoot,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
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
    ' * GENERATED FILE, DO NOT EDIT. The storage server copy of the Stats page code, bundled\n' +
    ` * from the web app (apps/web/${entry}).\n` +
    ' * Rebuild with `pnpm build:server-stats` in apps/web after changing that code.\n' +
    ` * build: ${buildId}\n` +
    ' */\n';
  return { code: header + body, buildId, inputs: Object.keys(result.metafile.inputs).sort() };
}
