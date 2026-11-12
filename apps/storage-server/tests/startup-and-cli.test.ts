/**
 * End-to-end checks through the real entry points (src/index.ts, src/cli.ts),
 * configured by environment variables like the container.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, runUntilExit, spawnServer } from './helpers/spawn-server';

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

describe('server startup', () => {
  it('creates the database, takes a first snapshot and serves the API', async () => {
    const dbDir = makeTempDir('db');
    const server = await spawnServer({
      AUTH_TOKEN: TOKEN,
      DB_DIR: dbDir,
      CORS_ORIGIN: 'http://tower:3080',
    });
    try {
      const health = await fetch(`${server.baseUrl}/api/v1/health`);
      expect(health.status).toBe(200);
      expect(fs.existsSync(path.join(dbDir, 'ttsu.db'))).toBe(true);

      // WP15e: the old sync's file endpoints are gone.
      const list = await fetch(`${server.baseUrl}/list?path=`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(list.status).toBe(404);
      expect(server.output()).toContain('AUTH_TOKEN is set but no longer used');

      // Catch-up snapshot on first start.
      const deadline = Date.now() + 10_000;
      let snaps: string[] = [];
      while (Date.now() < deadline) {
        snaps = fs.existsSync(path.join(dbDir, 'snapshots'))
          ? fs.readdirSync(path.join(dbDir, 'snapshots'))
          : [];
        if (snaps.some((s) => s.endsWith('Z.db'))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(snaps.filter((s) => /^ttsu-\d{8}-\d{6}Z\.db$/.test(s))).toHaveLength(1);
      expect(server.output()).toContain('CORS origin: http://tower:3080');
      expect(server.output()).not.toContain('allows any origin');
    } finally {
      await server.stop();
    }
  });

  it('starts without AUTH_TOKEN (WP15e: no endpoint uses it) and says nothing about it', async () => {
    const server = await spawnServer({ AUTH_TOKEN: '' });
    try {
      expect((await fetch(`${server.baseUrl}/api/v1/health`)).status).toBe(200);
      expect(server.output()).not.toContain('AUTH_TOKEN');
      for (const [method, url] of [
        ['GET', '/list?path='],
        ['GET', '/file?path=x.txt'],
        ['PUT', '/file?path=x.txt'],
        ['DELETE', '/file?path=x.txt'],
        ['POST', '/mkdir?path=d'],
        ['DELETE', '/rmdir?path=d'],
        ['PUT', '/audio-file?path=b%2Faudio_1.mp3'],
      ]) {
        const res = await fetch(server.baseUrl + url, {
          method,
          body: method === 'PUT' ? 'x' : undefined,
        });
        expect(res.status, `${method} ${url}`).toBe(404);
      }
      expect(fs.readdirSync(server.dataDir)).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('exits with code 1 when DATA_DIR does not exist', async () => {
    const { code, output } = await runUntilExit({
      DATA_DIR: path.join(makeTempDir('data'), 'missing'),
      DB_DIR: makeTempDir('db'),
      PORT: '0',
    });
    expect(code).toBe(1);
    expect(output).toContain('DATA_DIR does not exist');
  });

  it('starts when DB_DIR is missing and reports it', async () => {
    const missing = path.join(makeTempDir('db'), 'not-mounted');
    const server = await spawnServer({ AUTH_TOKEN: TOKEN, DB_DIR: missing });
    try {
      const health = await fetch(`${server.baseUrl}/api/v1/health`);
      expect(health.status).toBe(503);
      expect(server.output()).toContain('database unavailable: DB_DIR does not exist');
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('refuses a DB_DIR inside DATA_DIR and writes nothing into the data folder', async () => {
    const data = makeTempDir('data');
    const server = await spawnServer({ AUTH_TOKEN: TOKEN, DATA_DIR: data, DB_DIR: data });
    try {
      const health = await fetch(`${server.baseUrl}/api/v1/health`);
      expect(health.status).toBe(503);
      expect(fs.readdirSync(data)).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe('token CLI', () => {
  it('creates, lists and revokes tokens that the running server honors', async () => {
    const dbDir = makeTempDir('db');
    const dataDir = makeTempDir('data');
    const env = { DB_DIR: dbDir, DATA_DIR: dataDir };
    const server = await spawnServer({ AUTH_TOKEN: TOKEN, ...env });
    try {
      const created = cli(['token', 'create', 'My', 'Phone'], env);
      expect(created.code, created.out).toBe(0);
      const token = created.out.match(/ttsu_[A-Za-z0-9_-]{43}/)?.[0];
      expect(token).toBeTruthy();
      const id = created.out.match(/\(id ([0-9a-f-]{36})\)/)?.[1];
      expect(id).toBeTruthy();

      const me = await fetch(`${server.baseUrl}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as any).token.label).toBe('My Phone');

      const listed = cli(['token', 'list'], env);
      expect(listed.out).toContain('label="My Phone"');
      expect(listed.out).toContain('active');
      expect(listed.out).not.toContain(token!);

      expect(cli(['token', 'revoke', id!], env).code).toBe(0);
      const after = await fetch(`${server.baseUrl}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(after.status).toBe(401);
      expect(cli(['token', 'revoke', id!], env).code).toBe(1);

      // WP16: a GPU worker token reaches the worker's routes only.
      const worker = cli(['token', 'worker', 'PC', 'GPU', 'worker'], env);
      expect(worker.code, worker.out).toBe(0);
      const workerToken = worker.out.match(/ttsu_[A-Za-z0-9_-]{43}/)?.[0];
      const asWorker = async (p: string, method = 'GET') => {
        const go = () =>
          fetch(`${server.baseUrl}/api/v1${p}`, {
            method,
            headers: { Authorization: `Bearer ${workerToken}` },
          });
        // The CLI call can outlast the server's keep-alive: a reused socket may be reset.
        try {
          return await go();
        } catch {
          return go();
        }
      };
      expect((await asWorker('/me')).status).toBe(403);
      // The worker routes answer (503: no audiobooks folder on this test server).
      expect((await asWorker('/worker/claim', 'POST')).status).toBe(503);
      expect(cli(['token', 'list'], env).out).toMatch(/label="PC GPU worker"\s+scope=worker/);
    } finally {
      await server.stop();
    }
  });

  it('makes a pairing code the running server trades for a token', async () => {
    const dbDir = makeTempDir('db');
    const dataDir = makeTempDir('data');
    const env = { DB_DIR: dbDir, DATA_DIR: dataDir, PAIR_CODE_MINUTES: '5' };
    const server = await spawnServer({ AUTH_TOKEN: TOKEN, ...env });
    try {
      const paired = cli(['token', 'pair', 'Boox'], env);
      expect(paired.code, paired.out).toBe(0);
      expect(paired.out).toContain('within 5 minute(s)');
      const code = paired.out.match(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/m)?.[0];
      expect(code).toBeTruthy();

      const res = await fetch(`${server.baseUrl}/api/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };
      const me = await fetch(`${server.baseUrl}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(((await me.json()) as any).token.label).toBe('Boox');
      expect(cli(['token', 'list'], env).out).toContain('label="Boox"');
      expect(cli(['thumbs', 'rotate-key'], env).code).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('fails clearly on bad usage or a missing database folder', () => {
    const env = { DB_DIR: makeTempDir('db'), DATA_DIR: makeTempDir('data') };
    expect(cli([], env).code).toBe(1);
    expect(cli(['token', 'create'], env).out).toContain('needs a label');
    const missing = cli(['token', 'list'], { ...env, DB_DIR: path.join(env.DB_DIR, 'nope') });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('DB_DIR does not exist');
  });
});
