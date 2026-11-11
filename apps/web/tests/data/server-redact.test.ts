/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { buildServerRedact, serverRedactOutput } from '../../scripts/server-redact/build';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { redactText, redactValue } from '$lib/data/redact';
import { readFileSync } from 'node:fs';

/**
 * The storage server removes secrets from its log lines with a bundle of this app's
 * redaction (apps/storage-server/vendor/redact.cjs, WP18). These tests prove the bundle is
 * current and removes the same things when loaded by plain CommonJS Node.
 */
const lf = (s: string) => s.replace(/\r\n/g, '\n');

const SAMPLES = [
  'Authorization: Bearer ttsu_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  'GET /file?token=legacy-token&name=x',
  'Pairing: code 7K3M-Q9TZ, {"code":"7k3m-q9tz"}, {"code":"cursor_reset"}',
  '薬屋のひとりごと 5e7d2c1a-8b4f-4c3e-9a6d-0f1b2c3d4e5f legacy-token'
];

describe('server redaction bundle', () => {
  it('is up to date with the web code (run `pnpm build:server-redact`)', async () => {
    const { code } = await buildServerRedact();
    expect(
      lf(readFileSync(serverRedactOutput, 'utf8')) === lf(code),
      'apps/storage-server/vendor/redact.cjs is stale: run `pnpm build:server-redact` in apps/web'
    ).toBe(true);
  });

  it('removes the same things when run by plain Node', () => {
    const options = { secrets: ['legacy-token'] };
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `const r = require(process.argv[1]); const [s, o] = JSON.parse(process.argv[2]);
         process.stdout.write(JSON.stringify([s.map((t) => r.redactText(t, o)), r.redactValue({ token: 'x', s }, o)]));`,
        serverRedactOutput,
        JSON.stringify([SAMPLES, options])
      ],
      { encoding: 'utf8' }
    );
    expect(JSON.parse(out)).toEqual([
      SAMPLES.map((s) => redactText(s, options)),
      redactValue({ token: 'x', s: SAMPLES }, options)
    ]);
  });
});
