/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Shared harness for tests that run the real storage server as a separate
 * process (exactly as in the container) and sync "devices" against it: each
 * Device is a SyncEngine with its own IndexedDB (fake-indexeddb, imported by
 * the test), its own token, a network switch and its own clock.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncApi } from '$lib/sync/sync-api';
import { openSyncDb } from '$lib/sync/sync-db';
import { SyncEngine } from '$lib/sync/sync-engine';

const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../storage-server'
);
const TS_NODE = ['-r', 'ts-node/register/transpile-only'];

export function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ttsu-web-${prefix}-`));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export function runServerScript(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [...TS_NODE, ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  if (res.status !== 0) throw new Error(`${args.join(' ')} failed:\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

/** The storage server as a child process (src/index.ts, like the container). */
export class TestServer {
  private child: ChildProcess | null = null;
  readonly dataDir = tempDir('data');
  readonly dbDir = tempDir('db');
  port = 0;

  /** Extra environment for the server (e.g. CALIBRE_DIR for the WP5 migration test). */
  constructor(private readonly extraEnv: Record<string, string> = {}) {}

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    if (!this.port) this.port = await freePort();
    const child = spawn(process.execPath, [...TS_NODE, path.join('src', 'index.ts')], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        AUTH_TOKEN: 'legacy',
        PORT: String(this.port),
        DATA_DIR: this.dataDir,
        DB_DIR: this.dbDir,
        CORS_ORIGIN: '*',
        SYNC_MAX_CLOCK_SKEW_SECONDS: '60',
        ...this.extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    let out = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
      const onData = (d: Buffer) => {
        out += d.toString();
        if (out.includes('running on port')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}):\n${out}`));
      });
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }

  cli(...args: string[]) {
    return runServerScript([path.join('src', 'cli.ts'), ...args], {
      DB_DIR: this.dbDir,
      DATA_DIR: this.dataDir
    });
  }

  /** Database files (the main file plus WAL), for snapshot/restore. */
  dbFiles() {
    return ['ttsu.db', 'ttsu.db-wal', 'ttsu.db-shm'].map((f) => path.join(this.dbDir, f));
  }
}

let dbRun = 0;

/** One device: its own local database, token, network switch and clock. */
export class Device {
  online = true;
  clockSkewMs = 0;
  /** When set, the next push reaches the server but its answer is lost. */
  dropNextPushResponse = false;
  engine!: SyncEngine;
  api!: SyncApi;

  constructor(
    readonly name: string,
    private readonly token: string,
    private readonly server: TestServer
  ) {}

  async open() {
    dbRun += 1;
    const dbName = `two-devices-${this.name}-${dbRun}`;
    this.engine = await SyncEngine.open({
      openDb: () => openSyncDb(dbName),
      now: () => Date.now() + this.clockSkewMs,
      warn: () => {}
    });
    this.connect();
  }

  /** (Re)creates the transport, e.g. after the server restarted. */
  connect() {
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!this.online) throw new TypeError('Failed to fetch (offline)');
      const response = await fetch(input, init);
      if (this.dropNextPushResponse && init?.method === 'POST' && String(input).endsWith('/sync')) {
        this.dropNextPushResponse = false;
        await response.arrayBuffer();
        throw new TypeError('Failed to fetch (connection reset)');
      }
      return response;
    };
    this.api = new SyncApi(this.server.url, this.token, 10, fetchImpl);
  }

  sync() {
    return this.engine.sync(this.api);
  }

  /** The value a setting record holds on this device (undefined = deleted or absent). */
  async setting(id: string) {
    const record = await this.engine.get('setting', id);
    return record && record.deletedAt === null ? record.data.value : undefined;
  }
}

/**
 * Seeds the server's database with one catalog book and `count` device tokens. With
 * `catalog`, the book is visible in catalog lists and searches (WP7a).
 */
export function seedServer(
  server: TestServer,
  count: number,
  options: { catalog?: boolean } = {}
): { bookId: string; tokens: string[] } {
  const output = runServerScript([
    path.join('tests', 'helpers', 'seed-sync-fixture.ts'),
    server.dbDir,
    String(count),
    ...(options.catalog ? ['catalog'] : [])
  ]);
  const seedLine = output.split(/\r?\n/).find((line) => line.startsWith('SEED '));
  if (!seedLine) throw new Error(`seed script printed no result:\n${output}`);
  return JSON.parse(seedLine.slice(5)) as { bookId: string; tokens: string[] };
}
