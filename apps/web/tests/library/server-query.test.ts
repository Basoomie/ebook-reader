/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { buildServerQuery, serverQueryOutput } from '../../scripts/server-query/build';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { parseQuery } from '$lib/library/query/parse';
import { readFileSync } from 'node:fs';

/**
 * The storage server parses library searches with a bundle of this app's parser
 * (apps/storage-server/vendor/library-query.cjs). These tests prove the bundle is current
 * and gives the same result as the source when loaded by plain CommonJS Node.
 */
const lf = (s: string) => s.replace(/\r\n/g, '\n');

const SAMPLES = [
  '薬屋 author:日向 tag:A,B -status:completed chars:<150k',
  '/^薬屋/i series:=外伝 favorite:yes',
  'status:foo',
  '/(/',
  '"Doe, Jane" Re:ゼロ'
];

describe('server query parser bundle', () => {
  it('is up to date with the web parser (run `pnpm build:server-query`)', async () => {
    const { code } = await buildServerQuery();

    expect(
      lf(readFileSync(serverQueryOutput, 'utf8')) === lf(code),
      'apps/storage-server/vendor/library-query.cjs is stale: run `pnpm build:server-query` in apps/web'
    ).toBe(true);
  });

  it('parses like the source when run by plain Node', () => {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `const q = require(process.argv[1]); process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map((s) => q.parseQuery(s))));`,
        serverQueryOutput,
        JSON.stringify(SAMPLES)
      ],
      { encoding: 'utf8' }
    );

    expect(JSON.parse(out)).toEqual(SAMPLES.map((s) => parseQuery(s)));
  });
});
