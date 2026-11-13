/**
 * WP20a: the apply sidecar (apps/cleanup-apply) against a real storage server on a local
 * port, with a stand-in calibredb (tests/fixtures/wp20a/fake-calibredb.cjs) that changes
 * the test library the way the content server would. Covers the argument rules, a full
 * stage-1 run with the quarantine, the handoff, resuming after the sidecar stops and while
 * the server is away, Undo from the trash and by re-adding, and the safety checks.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildArgs, Calibredb, type Login } from '../../cleanup-apply/src/calibredb';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import {
  firstBlock,
  hasMultipleTextColumn,
  trashHasBook,
  Worker,
} from '../../cleanup-apply/src/worker';
import { getStage } from '../src/cleanup/stages';
import { calibreDate, fingerprint } from './helpers/calibre-fixture';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const PASSWORD = 'calibre-test-password';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (fill: string, n = 4096) => Buffer.alloc(n, fill);
const iso = (y: number) => calibreDate(new Date(Date.UTC(y, 0, 1)));
const quiet = { info: () => {}, error: () => {} };

describe('calibredb arguments', () => {
  const login: Login = {
    contentServerUrl: 'http://c:8081',
    libraryId: 'lib',
    username: 'u',
    password: 'secret-pw',
  };
  it('every call is remote, the password goes through stdin, nothing is permanent', () => {
    for (const cmd of [
      'list',
      'custom_columns',
      'export',
      'remove',
      'trash_list',
      'trash_restore',
      'add',
    ] as const) {
      const args = buildArgs(cmd, login, cmd === 'remove' ? ['12'] : []);
      expect(args).toContain('--with-library');
      expect(args[args.indexOf('--with-library') + 1]).toBe('http://c:8081/#lib');
      expect(args[args.indexOf('--password') + 1]).toBe('<stdin>');
      expect(args.join(' ')).not.toContain('secret-pw');
      expect(args).not.toContain('--permanent');
    }
    expect(buildArgs('libraries', login, [])).toContain('http://c:8081/#-');
    expect(() => buildArgs('remove', login, ['--permanent', '1'])).toThrow(/not allowed/);
    expect(() => buildArgs('add', login, ['--automerge', 'overwrite'])).toThrow(/not allowed/);
    expect(() => buildArgs('set_metadata' as never, login, [])).toThrow(/not allowed/);
  });

  it('parses custom_columns and trash listings', () => {
    const out =
      "illustrator (3)\n  datatype: text\n  is_multiple: {'cache_to_list': '|'}\n\nrating2 (4)\n  datatype: rating\n";
    expect(hasMultipleTextColumn(out, 'illustrator')).toBe(true);
    expect(
      hasMultipleTextColumn(
        'illustrator (3)\n  datatype: text\n  is_multiple: {}\n',
        'illustrator',
      ),
    ).toBe(false);
    expect(hasMultipleTextColumn(out, 'rating2')).toBe(false);
    expect(firstBlock(out, 'nope')).toBeNull();
    expect(trashHasBook('[{"book_id": 7, "title": "x"}]', 7)).toBe(true);
    expect(trashHasBook('[{"book_id": 7}]', 8)).toBe(false);
  });
});

describe('the sidecar with the server', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let serverVersion: string;
  let quarantine: string;
  let log: string;
  let user: string;
  let apply: string;
  let ids: Record<string, number>;
  let uuids: Record<string, string>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const listen = (s: http.Server) =>
    new Promise<number>((resolve) =>
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
    );

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    ids = {
      A1: await env.lib.addBook({
        title: 'A',
        tags: ['PeepoHappyBooks'],
        timestamp: iso(2021),
        epub: bytes('a'),
      }),
      A2: await env.lib.addBook({
        title: 'A',
        tags: ['ln'],
        timestamp: iso(2019),
        epub: bytes('a'),
      }),
      B1: await env.lib.addBook({ title: 'B', timestamp: iso(2019), epub: bytes('b', 5000) }),
      B2: await env.lib.addBook({
        title: 'B',
        timestamp: iso(2021),
        formats: ['EPUB', 'AZW3'],
        epub: bytes('b', 5000),
      }),
      C: await env.lib.addBook({ title: 'C', epub: bytes('c', 6000) }),
    };
    for (let i = 0; i < 15; i++)
      await env.lib.addBook({
        title: `Other ${i}`,
        epub: bytes(String.fromCharCode(100 + i), 7000 + i),
      });
    await made.setup();
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    uuids = {};
    for (const [k, id] of Object.entries(ids)) {
      uuids[k] = (
        mdb.prepare('SELECT uuid FROM books WHERE id = ?').get(id) as { uuid: string }
      ).uuid;
    }
    mdb.close();
    server = http.createServer(env.app);
    serverVersion = '9.18.0';
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', `calibre ${serverVersion}`);
      res.end('<html></html>');
    });
    const port = await listen(server);
    const cport = await listen(calibreServer);
    (env as unknown as { url: string }).url = `http://127.0.0.1:${port}`;
    quarantine = makeTempDir('quarantine');
    log = path.join(makeTempDir('log'), 'calls.log');
    user = env.userToken();
    apply = env.applyToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreLibraryId: 'japanese-library',
        calibreUsername: 'u',
        backup: { confirmedAt: Date.now() },
        pacing: { itemDelaySeconds: 0, batchSize: 500, maxBatchPercent: 10 },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker(
    extra: {
      version?: string;
      illustrator?: boolean;
      fetchImpl?: typeof fetch;
      fail?: string;
    } = {},
  ) {
    const config: SidecarConfig = {
      serverUrl: (env as unknown as { url: string }).url,
      token: apply,
      quarantineDir: quarantine,
      calibredb: process.execPath,
      minFreeMb: 1,
      calibredbTimeoutSeconds: 60,
      checkSeconds: 3600,
      requestTimeoutSeconds: 10,
    };
    const calibredb = new Calibredb({
      program: process.execPath,
      prefixArgs: [FAKE],
      timeoutMs: 60_000,
      env: {
        FAKE_CALIBRE_LIBRARY: env.lib.dir,
        FAKE_PASSWORD: PASSWORD,
        FAKE_VERSION: extra.version ?? '9.18.0',
        FAKE_ILLUSTRATOR: extra.illustrator === false ? '0' : '1',
        FAKE_LOG: log,
        FAKE_FAIL: extra.fail ?? '',
      },
    });
    return new Worker({
      config,
      calibredb,
      log: quiet,
      retryMinMs: 20,
      retryMaxMs: 100,
      fetchImpl: extra.fetchImpl,
    });
  }

  async function turnOn() {
    await request(env.app)
      .put('/api/v1/cleanup/stages/1')
      .set(auth(user))
      .send({ mode: 'on' })
      .expect(200);
    for (let i = 0; i < 100 && getStage(env.cleanupDb, 1).state !== 'ready'; i++) {
      await env.service.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getStage(env.cleanupDb, 1).state).toBe('ready');
  }

  /** Lets the server plan, the sidecar work, and the indexer take it in, until nothing is left. */
  async function runAll(w: Worker, rounds = 10) {
    for (let i = 0; i < rounds; i++) {
      await env.service.tick();
      const r = await w.cycle();
      await env.index();
      await env.service.tick();
      if (r === 'idle' && !env.service.batches.open()) return;
    }
  }

  it('removes the identical copies through calibredb, with the quarantine, the snapshot and the handoff', async () => {
    const a2Reader = env.readerBook(uuids.A2)!.bookId;
    env.addReaderData(a2Reader);
    const w = worker();
    await w.runChecks();
    await w.cycle(); // heartbeat with the checks
    await turnOn();
    await runAll(w);

    // Both duplicates are gone from Calibre, into its trash.
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const left = (mdb.prepare('SELECT id FROM books').all() as { id: number }[]).map((r) => r.id);
    mdb.close();
    expect(left).not.toContain(ids.A2);
    expect(left).not.toContain(ids.B2);
    expect(left).toContain(ids.A1);
    expect(left).toContain(ids.B1);
    expect(fs.readdirSync(path.join(env.lib.dir, '.caltrash', 'b')).sort()).toEqual(
      [String(ids.A2), String(ids.B2)].sort(),
    );
    // The quarantine: batch.json, the snapshot, each export (EPUB identical, extra AZW3 too) and its note.
    const [batchId] = fs.readdirSync(quarantine);
    const files = fs.readdirSync(path.join(quarantine, batchId)).sort();
    expect(files).toEqual(
      [
        'batch.json',
        'metadata.db',
        String(ids.A2),
        `${ids.A2}.json`,
        String(ids.B2),
        `${ids.B2}.json`,
      ].sort(),
    );
    expect(sha(fs.readFileSync(path.join(quarantine, batchId, String(ids.A2), 'book.epub')))).toBe(
      sha(bytes('a')),
    );
    expect(fs.existsSync(path.join(quarantine, batchId, String(ids.B2), 'book.azw3'))).toBe(true);
    expect(
      fs.readFileSync(path.join(quarantine, batchId, String(ids.A2), 'book.opf'), 'utf8'),
    ).toContain('<dc:subject>ln</dc:subject>');
    const snap = new Database(path.join(quarantine, batchId, 'metadata.db'), { readonly: true });
    expect((snap.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n).toBe(20);
    snap.close();
    // Every call was remote, none permanent, the password never in the arguments.
    const calls = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    for (const c of calls) {
      expect(c.join(' ')).not.toContain(PASSWORD);
      expect(c).not.toContain('--permanent');
      if (c[0] !== '--version')
        expect(c[c.indexOf('--with-library') + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#/);
    }
    // The handoff: A2's reader book (with data) now shows A1's Calibre record.
    expect(env.readerBook(uuids.A1)).toEqual({ bookId: a2Reader, missing: false });
    expect(env.readerBook(uuids.A2)!.missing).toBe(true);
    const batch = env.service.batches.list()[0];
    expect(batch.state).toBe('applied');
    expect(batch.ingestedAt).not.toBeNull();
  });

  it('resumes after the sidecar stops mid-batch and while the server is away, without doing a step twice', async () => {
    const w1 = worker();
    await w1.runChecks();
    await w1.cycle();
    await turnOn();
    await env.service.tick();
    // The first sidecar exports, then stops before its removal is acknowledged.
    const original = w1.calibredb.ok.bind(w1.calibredb);
    w1.calibredb.ok = async (cmd, login, args) => {
      if (cmd === 'remove') {
        w1.stop();
        throw new Error('container stopped');
      }
      return original(cmd, login, args);
    };
    await w1.cycle();
    const items = env.cleanupDb.prepare('SELECT state FROM batch_items').all() as {
      state: string;
    }[];
    expect(items.map((i) => i.state)).toContain('exported');
    // Its lease runs out; a new sidecar takes over while the server is down for a moment.
    env.cleanupDb.prepare('UPDATE batches SET lease_expires_at = 1').run();
    let failures = 3;
    const flaky: typeof fetch = (input, init) => {
      if (failures-- > 0) return Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
      return fetch(input, init);
    };
    const w2 = worker({ fetchImpl: flaky });
    await w2.runChecks();
    await runAll(w2);
    const [batchId] = fs.readdirSync(quarantine);
    // One export per copy, not two.
    const dirs = fs
      .readdirSync(path.join(quarantine, batchId))
      .filter((n) => /^\d+(-\d+)?$/.test(n));
    expect(dirs.sort()).toEqual([String(ids.A2), String(ids.B2)].sort());
    const exports = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('["export"'));
    expect(exports.length).toBe(2);
    expect(env.service.batches.list()[0].state).toBe('applied');
  });

  it('Undo restores from the trash with the same id and UUID; the quarantine is never emptied', async () => {
    const w = worker();
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await runAll(w);
    const before = fingerprint(quarantine);
    const [batch] = env.service.batches.list();
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const a2 = mdb.prepare('SELECT id, uuid FROM books WHERE id = ?').get(ids.A2) as {
      id: number;
      uuid: string;
    };
    mdb.close();
    expect(a2).toEqual({ id: ids.A2, uuid: uuids.A2 });
    expect(env.readerBook(uuids.A2)!.missing).toBe(false);
    expect(env.service.batches.get(batch.id)!.state).toBe('undone');
    const after = fingerprint(quarantine);
    for (const [file, fp] of Object.entries(before)) expect(after[file], file).toEqual(fp);
  });

  it('Undo on calibre older than 9.18 re-adds from the quarantine; the reader keeps its book ids', async () => {
    serverVersion = '9.16.0';
    const a2Reader = env.readerBook(uuids.A2)!.bookId;
    env.addReaderData(a2Reader);
    const w = worker({ version: '9.16.0' });
    await w.cycle(); // the first heartbeat brings the Calibre login
    const checks = await w.runChecks();
    expect(checks.find((c) => c.name === 'trash_restore')!.ok).toBe(false);
    expect(checks.find((c) => c.name === 'versions_match')!.ok).toBe(true);
    await w.cycle();
    await turnOn();
    await runAll(w);
    const [batch] = env.service.batches.list();
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    // A2 came back as a new Calibre book (new id and UUID) bound to its old reader book.
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const rows = mdb.prepare(`SELECT id, uuid FROM books WHERE title = 'A' ORDER BY id`).all() as {
      id: number;
      uuid: string;
    }[];
    mdb.close();
    expect(rows).toHaveLength(2);
    const restored = rows.find((r) => r.id !== ids.A1)!;
    expect(restored.id).not.toBe(ids.A2);
    expect(env.readerBook(restored.uuid)).toEqual({ bookId: a2Reader, missing: false });
    expect(env.readerBook(uuids.A1)!.bookId).not.toBe(a2Reader);
    expect(env.service.batches.get(batch.id)!.state).toBe('undone');
  });

  it('nothing is applied while a safety check fails (no #illustrator column)', async () => {
    const w = worker({ illustrator: false });
    await w.cycle();
    const checks = await w.runChecks();
    expect(checks.find((c) => c.name === 'illustrator_column')!.ok).toBe(false);
    await w.cycle();
    await turnOn();
    await env.service.tick();
    expect(env.service.waiting).toMatch(/illustrator/);
    expect(env.service.batches.list()).toEqual([]);
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    expect((mdb.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n).toBe(20);
    mdb.close();
  });
});
