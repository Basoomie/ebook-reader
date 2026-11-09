/**
 * End to end through the real entry points (src/index.ts, src/cli.ts), the way
 * the container runs them: discovery, the language gate, indexing on the poll,
 * the CLI requests and the API.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { copyRealFixture, fingerprint } from './helpers/calibre-fixture';
import { makeTempDir, spawnServer, SpawnedServer } from './helpers/spawn-server';

const SERVER_DIR = path.resolve(__dirname, '..');
const TOKEN = 'legacy-token';

function cli(args: string[], env: Record<string, string>) {
  const res = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', path.join('src', 'cli.ts'), ...args],
    { cwd: SERVER_DIR, env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

async function waitForOutput(server: SpawnedServer, text: string, count = 1, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (server.output().split(text).length - 1 >= count) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for "${text}" x${count}:\n${server.output()}`);
}

describe('Calibre indexer end to end', () => {
  it('discovers, waits for a language, indexes on the poll and serves the catalog', async () => {
    const { root } = copyRealFixture();
    const before = fingerprint(root);
    const env = { DB_DIR: makeTempDir('db'), DATA_DIR: makeTempDir('data') };
    const server = await spawnServer({
      AUTH_TOKEN: TOKEN,
      ...env,
      CALIBRE_DIR: root,
      CACHE_DIR: makeTempDir('cache'),
      CALIBRE_REQUIRE_READONLY: 'false',
      CALIBRE_SETTLE_SECONDS: '0',
      CALIBRE_POLL_SECONDS: '5',
    });
    try {
      await waitForOutput(server, 'Calibre: found library "japanese-test"');

      const listed = cli(['library', 'list'], env);
      expect(listed.code, listed.out).toBe(0);
      expect(listed.out).toContain('language=(not set)  disabled');
      const id = listed.out.match(/^([0-9a-f-]{36})\s/m)?.[1];
      expect(id).toBeTruthy();

      const refused = cli(['library', 'set', id!, '--enable'], env);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('Set a language');
      expect(cli(['library', 'set', id!, '--language', 'japanese'], env).code).toBe(1);

      const set = cli(
        ['library', 'set', id!, '--language', 'ja', '--name', '日本語', '--enable'],
        env,
      );
      expect(set.code, set.out).toBe(0);
      expect(set.out).toContain('language=ja  enabled');

      await waitForOutput(server, 'Calibre: indexed library "日本語"');
      const status = cli(['index', 'status'], env);
      expect(status.out).toContain('status=idle  books=5  missing=0');

      const created = cli(['token', 'create', 'Test'], env);
      const token = created.out.match(/ttsu_[A-Za-z0-9_-]{43}/)![0];
      const auth = { Authorization: `Bearer ${token}` };
      const books = (await (
        await fetch(`${server.baseUrl}/api/v1/books`, { headers: auth })
      ).json()) as {
        books: { title: string; thumbnail: string | null }[];
      };
      expect(books.books).toHaveLength(5);
      const thumb = await fetch(`${server.baseUrl}${books.books[0].thumbnail}`, { headers: auth });
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get('content-type')).toBe('image/webp');

      const run = cli(['index', 'run', id!], env);
      expect(run.out).toContain('Reindex requested');
      await waitForOutput(server, 'Calibre: indexed library "日本語"', 2);

      expect(cli(['thumbs', 'rebuild'], env).code).toBe(1);
      const rebuild = cli(['thumbs', 'rebuild', '--library', id!], env);
      expect(rebuild.code, rebuild.out).toBe(0);

      // The legacy file API is unaffected.
      const legacy = await fetch(`${server.baseUrl}/list?path=`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(await legacy.json()).toEqual([]);
    } finally {
      await server.stop();
    }
    expect(fingerprint(root)).toEqual(before);
  }, 90_000);

  it('stays off, with everything else working, when the Calibre folder is writable', async () => {
    const { root } = copyRealFixture();
    const server = await spawnServer({
      AUTH_TOKEN: TOKEN,
      CALIBRE_DIR: root,
      CACHE_DIR: makeTempDir('cache'),
    });
    try {
      await waitForOutput(server, 'Calibre indexer is off');
      expect(server.output()).toContain('is writable');
      expect((await fetch(`${server.baseUrl}/api/v1/health`)).status).toBe(200);
      const legacy = await fetch(`${server.baseUrl}/list?path=`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(legacy.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
