/**
 * WP20a: the apply sidecar (apps/cleanup-apply) against a real storage server on a local
 * port, with a stand-in calibredb (tests/fixtures/wp20a/fake-calibredb.cjs) that changes
 * the test library the way the content server would. Covers the argument rules, a full
 * stage-1 run with the quarantine, the handoff, resuming after the sidecar stops and while
 * the server is away, Undo from the trash and by re-adding, and the safety checks.
 */
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'child_process';
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
  latestRestorePlan,
  notInTrashIds,
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
      const args = buildArgs(cmd, login, cmd === 'remove' || cmd === 'trash_restore' ? ['12'] : []);
      expect(args).toContain('--with-library');
      expect(args[args.indexOf('--with-library') + 1]).toBe('http://c:8081/#lib');
      expect(args[args.indexOf('--password') + 1]).toBe('<stdin>');
      expect(args.join(' ')).not.toContain('secret-pw');
      expect(args).not.toContain('--permanent');
    }
    expect(buildArgs('libraries', login, [])).toContain('http://c:8081/#-');
    expect(() => buildArgs('remove', login, ['--permanent', '1'])).toThrow(/not allowed/);
    expect(() => buildArgs('add', login, ['--automerge', 'overwrite'])).toThrow(/not allowed/);
    // One whole book at a time: no lists, ranges or other options.
    expect(() => buildArgs('remove', login, ['1,2'])).toThrow(/exactly one book id/);
    expect(() => buildArgs('remove', login, ['1', '2'])).toThrow(/exactly one book id/);
    // Trash restore: whole books, plain ids (all of an Undo batch in one call, comma joined);
    // never --formats, never a range.
    expect(buildArgs('trash_restore', login, ['12', '15', '7']).at(-1)).toBe('12,15,7');
    expect(() => buildArgs('trash_restore', login, ['--formats', '12'])).toThrow(/book ids/);
    expect(() => buildArgs('trash_restore', login, ['10-20'])).toThrow(/book ids/);
    expect(() => buildArgs('trash_restore', login, ['1,2'])).toThrow(/book ids/);
    expect(() => buildArgs('trash_restore', login, [])).toThrow(/book ids/);
    expect(() => buildArgs('set_metadata' as never, login, [])).toThrow(/not allowed/);
    // Tags only: the one metadata write (your tags onto the kept copy, and back on Undo).
    const tags = buildArgs('set_tags', login, ['12', 'PeepoHappyBooks,TMW-collection-11']);
    expect(tags[0]).toBe('set_metadata');
    expect(tags.slice(-3)).toEqual(['12', '--field', 'tags:PeepoHappyBooks,TMW-collection-11']);
    expect(() => buildArgs('set_tags', login, ['12'])).toThrow(/book id and a tag list/);
    expect(() => buildArgs('set_tags', login, ['x', 'a'])).toThrow(/book id and a tag list/);
    expect(() => buildArgs('set_tags', login, ['12', 'a', '--field'])).toThrow(
      /book id and a tag list/,
    );
  });

  it("reads calibre's trash refusal and the saved restore plans", async () => {
    expect(notInTrashIds('No entries in the trash bin for the books: 14')).toEqual([14]);
    expect(notInTrashIds('x\nNo entries in the trash bin for the books: 3, 4,17\n')).toEqual([
      3, 4, 17,
    ]);
    expect(notInTrashIds('HTTP Error 408: Request Timeout')).toEqual([]);
    const dir = makeTempDir('plans');
    expect(await latestRestorePlan(dir)).toBeNull();
    fs.writeFileSync(
      path.join(dir, 'trash-restore-100.json'),
      JSON.stringify({ requested: [1], notInTrash: [], requestedAt: 100 }),
    );
    fs.writeFileSync(
      path.join(dir, 'trash-restore-200.json'),
      JSON.stringify({ requested: [1, 2], notInTrash: [3], requestedAt: 200 }),
    );
    fs.writeFileSync(path.join(dir, 'trash-restore-300.json'), '{"requested": [1'); // half written
    expect(await latestRestorePlan(dir)).toEqual({
      requested: [1, 2],
      notInTrash: [3],
      requestedAt: 200,
    });
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
    // calibre 9.18's real output (seen from its content server in the WP20a e2e run).
    const real = [
      'illustrator',
      '',
      "{'datatype': 'text',",
      " 'display': {},",
      " 'editable': True,",
      " 'is_multiple': True,",
      " 'label': 'illustrator',",
      " 'multiple_seps': {'cache_to_list': '|', 'list_to_ui': ', ', 'ui_to_list': ','},",
      " 'name': 'Illustrator',",
      " 'normalized': True,",
      " 'num': 1}",
      '',
      '',
    ].join('\n');
    expect(hasMultipleTextColumn(real, 'illustrator')).toBe(true);
    expect(
      hasMultipleTextColumn(
        real.replace("'is_multiple': True", "'is_multiple': False"),
        'illustrator',
      ),
    ).toBe(false);
    expect(
      hasMultipleTextColumn(
        real.replace("'datatype': 'text'", "'datatype': 'comments'"),
        'illustrator',
      ),
    ).toBe(false);
    expect(hasMultipleTextColumn(real, 'illustrators')).toBe(false);
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
      // One custom tag each: a tie, so the older E1 stays and E2's PeepoHappyBooks is
      // copied onto it (decided with the user 2026-11-13).
      E1: await env.lib.addBook({
        title: 'E',
        tags: ['TMW-collection-11'],
        timestamp: iso(2019),
        epub: bytes('e', 6500),
      }),
      E2: await env.lib.addBook({
        title: 'E',
        tags: ['PeepoHappyBooks', 'needs-metadata'],
        timestamp: iso(2022),
        epub: bytes('e', 6500),
      }),
    };
    // 35 books: 10 % allows 3 copies per batch, so the 3 copies are one batch.
    for (let i = 0; i < 28; i++)
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

  /** A file the stand-in counts down: that many book lookups answer 408 first. */
  function list408File(count: number | undefined): string {
    if (!count) return '';
    const file = path.join(makeTempDir('list408'), 'count');
    fs.writeFileSync(file, String(count));
    return file;
  }

  function worker(
    extra: {
      version?: string;
      illustrator?: boolean;
      fetchImpl?: typeof fetch;
      fail?: string;
      failLong?: boolean;
      /** Calibre's trash restore answers HTTP 408: "after" it restores anyway, "never" not. */
      trash408?: 'after' | 'never';
      /** Calibre's remove times out: "after" it removes anyway, "never" not. */
      removeTimeout?: 'after' | 'never';
      /** Calibre's add times out: "after" it adds anyway, "never" not. */
      addTimeout?: 'after' | 'never';
      /** This many book lookups answer 408 first (Calibre busy). */
      list408?: number;
      /** How long Undo waits for books to come back from the trash (s). */
      wait?: number;
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
      trashRestoreWaitSeconds: extra.wait ?? 3,
      removeWaitSeconds: extra.wait ?? 3,
      waitPollSeconds: 0.1,
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
        FAKE_FAIL_LONG: extra.failLong ? '1' : '0',
        FAKE_TRASH_408: extra.trash408 ?? '',
        FAKE_REMOVE_TIMEOUT: extra.removeTimeout ?? '',
        FAKE_ADD_TIMEOUT: extra.addTimeout ?? '',
        FAKE_LIST_408_FILE: list408File(extra.list408),
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

  /** A book's tags in the test library, sorted. */
  function tagsOf(id: number): string[] {
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const rows = mdb
      .prepare(
        'SELECT t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = ? ORDER BY t.name',
      )
      .all(id) as { name: string }[];
    mdb.close();
    return rows.map((r) => r.name);
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
    expect(left).not.toContain(ids.E2);
    expect(left).toContain(ids.A1);
    expect(left).toContain(ids.B1);
    expect(left).toContain(ids.E1);
    expect(fs.readdirSync(path.join(env.lib.dir, '.caltrash', 'b')).sort()).toEqual(
      [String(ids.A2), String(ids.B2), String(ids.E2)].sort(),
    );
    // E2's own tag now sits on the kept E1 (its other tag, needs-metadata, is not one of yours).
    expect(tagsOf(ids.E1)).toEqual(['PeepoHappyBooks', 'TMW-collection-11']);
    // A2's "ln" is not one of your tags: A1 doesn't get it.
    expect(tagsOf(ids.A1)).toEqual(['PeepoHappyBooks']);
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
        String(ids.E2),
        `${ids.E2}.json`,
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
    expect((snap.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n).toBe(35);
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
    expect(items.map((i) => i.state)).toContain('tagged');
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
    expect(dirs.sort()).toEqual([String(ids.A2), String(ids.B2), String(ids.E2)].sort());
    const exports = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('["export"'));
    expect(exports.length).toBe(3);
    expect(tagsOf(ids.E1)).toEqual(['PeepoHappyBooks', 'TMW-collection-11']);
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
    // The tag copied onto E1 is taken off again; E2 is back with its own tags.
    expect(tagsOf(ids.E1)).toEqual(['TMW-collection-11']);
    expect(tagsOf(ids.E2)).toEqual(['needs-metadata', 'PeepoHappyBooks']);
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

  it('a very long calibredb error marks the copy failed (short text) instead of stopping the batch', async () => {
    const w = worker({ fail: 'export', failLong: true });
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await runAll(w);
    const batch = env.service.batches.list()[0];
    expect(batch.state).toBe('failed');
    expect(batch.error ?? '').not.toMatch(/too large/i);
    const items = env.cleanupDb.prepare('SELECT state, detail FROM batch_items').all() as {
      state: string;
      detail: string | null;
    }[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.state).toBe('failed');
      expect(i.detail).toMatch(/simulated failure of export/);
      expect(i.detail).toMatch(/end$/);
      expect(i.detail!.length).toBeLessThanOrEqual(1500);
    }
    // Nothing was removed from Calibre.
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    expect((mdb.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n).toBe(35);
    mdb.close();
  });

  /** The open batch's (single) copy and the copy it would be kept against. */
  function openPair(): { batchId: string; removedId: number; keptId: number } {
    const open = env.service.batches.open()!;
    expect(open).not.toBeNull();
    const row = env.cleanupDb
      .prepare(
        `SELECT c.calibre_id, c.evidence_json FROM batch_items i
         JOIN proposed_changes c ON c.id = i.change_id WHERE i.batch_id = ? ORDER BY i.id LIMIT 1`,
      )
      .get(open.id) as { calibre_id: number; evidence_json: string };
    return {
      batchId: open.id,
      removedId: row.calibre_id,
      keptId: (JSON.parse(row.evidence_json) as { kept: { calibreId: number } }).kept.calibreId,
    };
  }

  /** The Calibre ids calibredb was asked to remove in this test. */
  function removeCalls(): number[] {
    return fs
      .readFileSync(log, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as string[])
      .filter((c) => c[0] === 'remove')
      .map((c) => Number(c[c.length - 1]));
  }

  function epubsOf(id: number): number {
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    const n = (
      mdb.prepare("SELECT COUNT(*) AS n FROM data WHERE book = ? AND format = 'EPUB'").get(id) as {
        n: number;
      }
    ).n;
    mdb.close();
    return n;
  }

  it('the copy to keep losing its EPUB before the sidecar starts: nothing is removed', async () => {
    const w = worker();
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await env.service.tick(); // the server's check passes and plans a batch
    const { batchId, removedId, keptId } = openPair();
    env.lib.removeFormat(keptId); // outside the cleanup, after the server's check
    await w.cycle();
    const item = env.cleanupDb
      .prepare('SELECT state, detail FROM batch_items WHERE batch_id = ?')
      .get(batchId);
    expect(item).toEqual({
      state: 'skipped',
      detail: 'The copy to keep has no EPUB in Calibre any more',
    });
    expect(epubsOf(removedId)).toBe(1);
    expect(removeCalls()).not.toContain(removedId);
  });

  it('the copy to keep losing its EPUB between the export and the removal: nothing is removed', async () => {
    let keptId = -1;
    const fetchImpl: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { step?: string }) : {};
      if (String(input).includes('/items/') && body.step === 'tagged') env.lib.removeFormat(keptId);
      return res;
    };
    const w = worker({ fetchImpl });
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await env.service.tick();
    const pair = openPair();
    keptId = pair.keptId;
    await w.cycle();
    const item = env.cleanupDb
      .prepare('SELECT state, detail FROM batch_items WHERE batch_id = ?')
      .get(pair.batchId);
    expect(item).toEqual({
      state: 'skipped',
      detail: 'The copy to keep has no EPUB in Calibre any more',
    });
    // The removed copy is still in Calibre with its EPUB; its export stays in the quarantine.
    expect(epubsOf(pair.removedId)).toBe(1);
    expect(
      fs.existsSync(path.join(quarantine, pair.batchId, String(pair.removedId), 'book.epub')),
    ).toBe(true);
    expect(removeCalls()).not.toContain(pair.removedId);
  });

  it('a remove that times out while Calibre removes the copy anyway is recorded as removed (handoff, Undo)', async () => {
    // As on the NAS 2026-11-14 (Calibre #9503): "urlopen error timed out", copy gone anyway.
    const a2Reader = env.readerBook(uuids.A2)!.bookId;
    env.addReaderData(a2Reader);
    const w = worker({ removeTimeout: 'after' });
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await runAll(w);
    const items = env.cleanupDb
      .prepare(
        `SELECT c.calibre_id, i.state FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id`,
      )
      .all() as { calibre_id: number; state: string }[];
    expect(items.length).toBe(3);
    for (const i of items) expect(i.state).toBe('removed');
    // The reading-data handoff happened, and every removal has its Undo record.
    expect(env.readerBook(uuids.A1)!.bookId).toBe(a2Reader);
    const records = env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM undo_records').get() as {
      n: number;
    };
    expect(records.n).toBe(3);
  });

  it('a remove that times out and Calibre keeps the copy: the item fails after the wait', async () => {
    const w = worker({ removeTimeout: 'never', wait: 1 });
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await runAll(w, 2);
    const items = env.cleanupDb
      .prepare(
        `SELECT c.calibre_id, i.state, i.detail FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id`,
      )
      .all() as { calibre_id: number; state: string; detail: string }[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.state).toBe('failed');
      expect(i.detail).toMatch(/urlopen error timed out/);
      expect(epubsOf(i.calibre_id)).toBe(1); // still in Calibre
    }
    expect(
      (env.cleanupDb.prepare('SELECT COUNT(*) AS n FROM undo_records').get() as { n: number }).n,
    ).toBe(0);
  });

  it('keeps sending heartbeats while it is busy, and never throws when the server is away', async () => {
    const w = worker();
    await w.cycle();
    env.cleanupDb.prepare('UPDATE sidecar_status SET last_seen_at = 1').run();
    await w.keepAlive();
    const seen = (
      env.cleanupDb.prepare('SELECT last_seen_at FROM sidecar_status').get() as {
        last_seen_at: number;
      }
    ).last_seen_at;
    expect(Date.now() - seen).toBeLessThan(5000);
    const away = worker({
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    await expect(away.keepAlive()).resolves.toBeUndefined();
  });

  it("Undo after Calibre's trash was emptied (9.18) re-adds from the quarantine", async () => {
    const w = worker();
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await runAll(w);
    // The trash check no longer lists the trash (minutes with thousands of entries).
    expect((await w.runChecks()).find((c) => c.name === 'trash_restore')!.ok).toBe(true);
    fs.rmSync(path.join(env.lib.dir, '.caltrash'), { recursive: true, force: true });
    const [batch] = env.service.batches.list();
    await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(w);
    const undo = env.service.batches.list().find((b) => b.kind === 'undo')!;
    const items = env.cleanupDb
      .prepare('SELECT state, method FROM batch_items WHERE batch_id = ?')
      .all(undo.id) as { state: string; method: string }[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i).toEqual({ state: 'restored', method: 'readd' });
  });

  /** The calibredb calls of this test, as argument lists. */
  function calls(): string[][] {
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as string[]);
  }
  const trashRestores = () => calls().filter((c) => c[0] === 'trash' && c[1] === 'restore');
  const adds = () => calls().filter((c) => c[0] === 'add');

  /** Removes the copies (all batches), then asks to undo the biggest batch. */
  async function removeThenUndo(w: Worker) {
    await w.runChecks();
    await w.cycle();
    await turnOn();
    await runAll(w);
    const batch = env.service.batches
      .list()
      .filter((b) => b.kind === 'apply')
      .sort((a, b) => b.itemCount - a.itemCount)[0];
    expect(batch.itemCount).toBeGreaterThan(1);
    const res = await request(env.app)
      .post(`/api/v1/cleanup/batches/${batch.id}/undo`)
      .set(auth(user))
      .expect(200);
    const ids = env.cleanupDb
      .prepare(
        `SELECT c.calibre_id FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         WHERE i.batch_id = ? ORDER BY c.calibre_id`,
      )
      .all(batch.id)
      .map((r) => (r as { calibre_id: number }).calibre_id);
    fs.writeFileSync(log, ''); // count only the Undo's calls from here on
    return { applyBatch: batch, undoId: res.body.batch.id as string, ids };
  }

  function undoItems(undoId: string) {
    return env.cleanupDb
      .prepare(
        `SELECT c.calibre_id, i.state, i.method, i.detail FROM batch_items i
         JOIN proposed_changes c ON c.id = i.change_id WHERE i.batch_id = ? ORDER BY c.calibre_id`,
      )
      .all(undoId) as { calibre_id: number; state: string; method: string; detail: string }[];
  }

  it("Undo asks Calibre's trash once for the whole batch and waits out its 408 timeout", async () => {
    const { undoId, ids } = await removeThenUndo(worker());
    // Like the NAS: the request times out (HTTP 408) but Calibre restores the books anyway.
    await runAll(worker({ trash408: 'after' }));
    const items = undoItems(undoId);
    expect(items.map((i) => i.calibre_id)).toEqual(ids);
    for (const i of items) expect([i.state, i.method]).toEqual(['restored', 'trash']);
    expect(trashRestores()).toHaveLength(1);
    expect(trashRestores()[0].at(-1)).toBe(ids.join(','));
    expect(adds()).toEqual([]);
    // The same books (ids and UUIDs) are back in Calibre.
    const mdb = new Database(env.lib.dbFile, { readonly: true });
    for (const id of ids) {
      expect(mdb.prepare('SELECT id FROM books WHERE id = ?').get(id)).toBeTruthy();
    }
    mdb.close();
  });

  it('when Calibre never brings the books back: the items fail after the wait, nothing is added twice, and Undo again works', async () => {
    const { applyBatch, undoId, ids } = await removeThenUndo(worker());
    await runAll(worker({ trash408: 'never', wait: 1 }), 3);
    for (const i of undoItems(undoId)) {
      expect(i.state).toBe('failed');
      expect(i.detail).toMatch(
        /hasn't brought this book back from its trash within .* Undo again later/,
      );
    }
    expect(adds()).toEqual([]);
    // Undo again (Calibre is fine now): the books come back from the trash.
    const again = await request(env.app)
      .post(`/api/v1/cleanup/batches/${applyBatch.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(worker());
    const items = undoItems(again.body.batch.id);
    expect(items.map((i) => i.calibre_id)).toEqual(ids);
    for (const i of items) expect([i.state, i.method]).toEqual(['restored', 'trash']);
    expect(adds()).toEqual([]);
  });

  it("a book gone from Calibre's trash is re-added; the others still come from the trash", async () => {
    const { undoId, ids } = await removeThenUndo(worker());
    const gone = ids[0];
    fs.rmSync(path.join(env.lib.dir, '.caltrash', 'b', String(gone)), { recursive: true });
    await runAll(worker());
    const items = undoItems(undoId);
    for (const i of items) {
      expect([i.state, i.method.split(':')[0]]).toEqual([
        'restored',
        i.calibre_id === gone ? 'readd' : 'trash',
      ]);
    }
    // The server saw the book is no longer in Calibre's trash folder: the trash was asked only
    // for the others, in one call.
    expect(trashRestores().map((c) => c.at(-1))).toEqual([
      ids.filter((id) => id !== gone).join(','),
    ]);
    expect(adds()).toHaveLength(1);
  });

  it('a book gone from the trash while Calibre answers 408 (the NAS): the others still come back', async () => {
    // On the NAS every trash restore answers 408, which also hides calibre's refusal of a
    // request naming a book that isn't in its trash; nothing would come back if it were asked.
    const { undoId, ids } = await removeThenUndo(worker());
    const gone = ids[0];
    fs.rmSync(path.join(env.lib.dir, '.caltrash', 'b', String(gone)), { recursive: true });
    await runAll(worker({ trash408: 'after' }));
    for (const i of undoItems(undoId)) {
      expect([i.state, i.method.split(':')[0]]).toEqual([
        'restored',
        i.calibre_id === gone ? 'readd' : 'trash',
      ]);
    }
    expect(trashRestores()).toHaveLength(1);
    expect(adds()).toHaveLength(1);
  });

  it('lookups that time out while Calibre is busy are retried, not counted as failures', async () => {
    const { undoId } = await removeThenUndo(worker());
    await runAll(worker({ trash408: 'after', list408: 4 }));
    for (const i of undoItems(undoId)) expect([i.state, i.method]).toEqual(['restored', 'trash']);
    expect(adds()).toEqual([]);
  });

  it('a re-add that times out while Calibre adds the book anyway is recorded, not added twice', async () => {
    const { undoId, ids } = await removeThenUndo(worker());
    fs.rmSync(path.join(env.lib.dir, '.caltrash'), { recursive: true, force: true });
    await runAll(worker({ addTimeout: 'after' }));
    const items = undoItems(undoId);
    expect(items.map((i) => i.calibre_id)).toEqual(ids);
    for (const i of items) expect([i.state, i.method.split(':')[0]]).toEqual(['restored', 'readd']);
    expect(adds()).toHaveLength(ids.length); // one add per book, no second try
  });

  it('a re-add Calibre finished only after the Undo failed: Undo again finds it instead of adding again', async () => {
    const { applyBatch, undoId, ids } = await removeThenUndo(worker());
    fs.rmSync(path.join(env.lib.dir, '.caltrash'), { recursive: true, force: true });
    // The add times out and nothing appears within the wait: the items fail.
    await runAll(worker({ addTimeout: 'never', wait: 1 }), 3);
    for (const i of undoItems(undoId)) expect(i.state).toBe('failed');
    // Calibre finishes those adds later (as the add calls the sidecar made would).
    for (const id of ids) {
      const exportDir = fs
        .readdirSync(quarantine, { recursive: true, withFileTypes: true })
        .find((e) => e.isDirectory() && e.name === String(id));
      const dir = path.join(
        exportDir!.parentPath ?? (exportDir as unknown as { path: string }).path,
        exportDir!.name,
      );
      const r = spawnSync(
        process.execPath,
        [
          FAKE,
          'add',
          '--with-library',
          'http://127.0.0.1:1/#japanese-library',
          '--username',
          'u',
          '--password',
          '<stdin>',
          '--duplicates',
          '--one-book-per-directory',
          dir,
        ],
        {
          input: `${PASSWORD}\n`,
          encoding: 'utf8',
          env: { ...process.env, FAKE_CALIBRE_LIBRARY: env.lib.dir, FAKE_PASSWORD: PASSWORD },
        },
      );
      expect(r.status).toBe(0);
    }
    fs.writeFileSync(log, '');
    const again = await request(env.app)
      .post(`/api/v1/cleanup/batches/${applyBatch.id}/undo`)
      .set(auth(user))
      .expect(200);
    await runAll(worker());
    for (const i of undoItems(again.body.batch.id)) {
      expect([i.state, i.method.split(':')[0]]).toEqual(['restored', 'readd']);
    }
    expect(adds()).toEqual([]); // found the earlier copies, added nothing
  });

  it("when the server can't tell what is in Calibre's trash, the old behavior stays (refusal read)", async () => {
    const { undoId, ids } = await removeThenUndo(worker());
    const gone = ids[0];
    fs.rmSync(path.join(env.lib.dir, '.caltrash', 'b', String(gone)), { recursive: true });
    // An older server sends no inCalibreTrash: the sidecar asks for all, reads the refusal,
    // and asks again without that id.
    const strip: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith('/claim')) return res;
      const body = (await res.json()) as { batch: { items: Record<string, unknown>[] } | null };
      for (const it of body.batch?.items ?? []) delete it.inCalibreTrash;
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    };
    await runAll(worker({ fetchImpl: strip }));
    for (const i of undoItems(undoId)) {
      expect(i.state).toBe('restored');
    }
    expect(trashRestores().map((c) => c.at(-1))).toEqual([
      ids.join(','),
      ids.filter((id) => id !== gone).join(','),
    ]);
  });

  it('after a restart, a trash restore asked for earlier is waited on, not asked again', async () => {
    const { undoId, ids } = await removeThenUndo(worker());
    // The sidecar had asked just before it stopped (its plan is in the quarantine folder) and
    // Calibre is still working: the books come back a moment later.
    fs.mkdirSync(path.join(quarantine, undoId), { recursive: true });
    fs.writeFileSync(
      path.join(quarantine, undoId, `trash-restore-${Date.now()}.json`),
      JSON.stringify({ requested: ids, notInTrash: [], requestedAt: Date.now() }),
    );
    const later = new Promise<void>((resolve) => {
      setTimeout(() => {
        const child = spawn(
          process.execPath,
          [
            FAKE,
            'trash',
            'restore',
            '--with-library',
            'http://127.0.0.1:1/#japanese-library',
            '--username',
            'u',
            '--password',
            '<stdin>',
            ids.join(','),
          ],
          {
            env: { ...process.env, FAKE_CALIBRE_LIBRARY: env.lib.dir, FAKE_PASSWORD: PASSWORD },
          },
        );
        child.stdin.end(`${PASSWORD}\n`);
        child.on('close', () => resolve());
      }, 700);
    });
    await runAll(worker({ wait: 30 }));
    await later;
    const items = undoItems(undoId);
    for (const i of items) expect([i.state, i.method]).toEqual(['restored', 'trash']);
    expect(trashRestores()).toEqual([]); // the sidecar didn't ask a second time
    expect(adds()).toEqual([]);
  });

  it('an unexpected trash-restore error: the items wait, then fail; nothing is re-added', async () => {
    const { undoId } = await removeThenUndo(worker());
    await runAll(worker({ fail: 'trash restore', wait: 1 }), 3);
    for (const i of undoItems(undoId)) {
      expect(i.state).toBe('failed');
      expect(i.detail).toMatch(/Undo again later/);
    }
    expect(adds()).toEqual([]);
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
    expect((mdb.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n).toBe(35);
    mdb.close();
  });
});
