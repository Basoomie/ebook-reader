/**
 * WP4: devices, record sync (push/pull), conflict policies, cursors and the CLI.
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../src/db/migrations';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import { DEFAULT_KINDS, KindRegistry, RecordError } from '../src/sync/kinds';
import { decodeCursor, encodeCursor, SyncStore } from '../src/sync/store';
import { makeTempDir } from './helpers/spawn-server';
import { makeTestApp } from './helpers/test-app';

const SERVER_DIR = path.resolve(__dirname, '..');

function insertBook(db: Database.Database): string {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO libraries (id, folder, name, discovered_at, updated_at)
     VALUES ('lib1', 'lib', 'Lib', ?, ?)`,
  ).run(now, now);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
     VALUES (?, 'lib1', 'Book', ?, ?, ?)`,
  ).run(id, now, now, now);
  return id;
}

/** A test app with helpers for registered devices. */
function setup(overrides: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(overrides);
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  async function device(label = 'Phone', deviceId: string = randomUUID()) {
    const token = t.newUserToken(label);
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(t.app).post('/api/v1/devices/register').set(auth).send({ deviceId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { token, auth, id: res.body.device.id as string };
  }
  const push = (auth: object, changes: unknown[]) =>
    request(t.app).post('/api/v1/sync').set(auth).send({ changes });
  const pull = (auth: object, query: Record<string, string | number> = {}) =>
    request(t.app).get('/api/v1/sync').set(auth).query(query);
  return { ...t, db, device, push, pull };
}

describe('migration 4', () => {
  it('adds the sync tables to a version-3 database and keeps tokens', () => {
    const file = path.join(makeTempDir('db'), 'ttsu.db');
    const db = new Database(file);
    for (const m of MIGRATIONS.filter((m) => m.version <= 3)) db.exec(m.sql);
    db.pragma('user_version = 3');
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'owner', 1)").run();
    db.prepare(
      "INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES ('t1', 'u1', 'Phone', 'h', 1)",
    ).run();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT label, device_id FROM api_tokens').all()).toEqual([
      { label: 'Phone', device_id: null },
    ]);
    db.close();
  });
});

describe('device registration', () => {
  it('creates a device with the requested id, named after the token label', async () => {
    const t = setup();
    const id = randomUUID();
    const d = await t.device('Boox', id);
    expect(d.id).toBe(id);
    const list = await request(t.app).get('/api/v1/devices').set(d.auth);
    expect(list.body.devices).toEqual([
      expect.objectContaining({ id, name: 'Boox', current: true }),
    ]);
    // The name is a synced record.
    const pulled = await t.pull(d.auth);
    expect(pulled.body.records).toEqual([
      expect.objectContaining({ kind: 'device', id, deviceId: id, data: { name: 'Boox' } }),
    ]);
  });

  it('is idempotent for the same token and refuses a different id', async () => {
    const t = setup();
    const d = await t.device();
    const again = await request(t.app)
      .post('/api/v1/devices/register')
      .set(d.auth)
      .send({ deviceId: d.id });
    expect(again.status).toBe(200);
    expect(again.body.device.id).toBe(d.id);
    const other = await request(t.app)
      .post('/api/v1/devices/register')
      .set(d.auth)
      .send({ deviceId: randomUUID() });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('token_bound_to_other_device');
  });

  it('re-attaches a known device after re-pairing, keeping its name', async () => {
    const t = setup();
    const first = await t.device('Phone');
    const second = await t.device('Phone (new token)', first.id);
    expect(second.id).toBe(first.id);
    const list = await request(t.app).get('/api/v1/devices').set(second.auth);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].name).toBe('Phone');
  });

  it('creates an id when none is given and rejects a malformed one', async () => {
    const t = setup();
    const token = t.newUserToken('X');
    const res = await request(t.app)
      .post('/api/v1/devices/register')
      .set({ Authorization: `Bearer ${token}` })
      .send({});
    expect(res.body.device.id).toMatch(/^[0-9a-f-]{36}$/);
    const bad = await request(t.app)
      .post('/api/v1/devices/register')
      .set({ Authorization: `Bearer ${t.newUserToken('Y')}` })
      .send({ deviceId: 'not-a-uuid' });
    expect(bad.status).toBe(400);
  });

  it('requires a registered device for /sync', async () => {
    const t = setup();
    const auth = { Authorization: `Bearer ${t.newUserToken()}` };
    expect((await t.pull(auth)).body.error.code).toBe('device_not_registered');
    expect((await t.push(auth, [])).status).toBe(409);
  });
});

describe('push', () => {
  it('applies, deduplicates retries and reports stale writes (lww)', async () => {
    const t = setup();
    const a = await t.device('A');
    const b = await t.device('B');
    const base = Date.now() - 10_000;
    const change = {
      kind: 'setting',
      id: 'global:theme',
      updatedAt: base,
      data: { value: 'dark' },
    };

    const first = await t.push(a.auth, [change]);
    expect(first.body.results[0]).toMatchObject({ status: 'applied' });
    const rev = first.body.results[0].rev;

    // Same write again (a retry after a lost response): no new rev.
    const retry = await t.push(a.auth, [change]);
    expect(retry.body.results[0]).toEqual({
      kind: 'setting',
      id: 'global:theme',
      status: 'duplicate',
      rev,
    });

    // B wrote earlier: stale, gets the server copy.
    const older = await t.push(b.auth, [{ ...change, updatedAt: base - 1, data: { value: 'x' } }]);
    expect(older.body.results[0]).toMatchObject({
      status: 'stale',
      record: { deviceId: a.id, data: { value: 'dark' }, rev },
    });

    // B wrote later: wins.
    const newer = await t.push(b.auth, [
      { ...change, updatedAt: base + 1, data: { value: 'sepia' } },
    ]);
    expect(newer.body.results[0]).toMatchObject({ status: 'applied' });
    expect(newer.body.results[0].rev).toBeGreaterThan(rev);
  });

  it('breaks equal timestamps by device id, the same way for everyone', async () => {
    const t = setup();
    const lo = await t.device('lo', '00000000-0000-4000-8000-000000000000');
    const hi = await t.device('hi', 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    const at = Date.now() - 1000;
    const c = (v: string) => ({
      kind: 'setting',
      id: 'global:k',
      updatedAt: at,
      data: { value: v },
    });
    await t.push(lo.auth, [c('lo')]);
    expect((await t.push(hi.auth, [c('hi')])).body.results[0].status).toBe('applied');
    expect((await t.push(lo.auth, [c('lo')])).body.results[0].status).toBe('stale');
  });

  it('keeps deletion markers and lets a newer edit revive a record', async () => {
    const t = setup();
    const a = await t.device('A');
    const at = Date.now() - 10_000;
    await t.push(a.auth, [{ kind: 'setting', id: 'global:k', updatedAt: at, data: { value: 1 } }]);
    await t.push(a.auth, [
      { kind: 'setting', id: 'global:k', updatedAt: at + 1, deletedAt: at + 1, data: {} },
    ]);
    let rec = (await t.pull(a.auth)).body.records.find((r: any) => r.id === 'global:k');
    expect(rec).toMatchObject({ deletedAt: at + 1, data: {} });
    await t.push(a.auth, [
      { kind: 'setting', id: 'global:k', updatedAt: at + 2, data: { value: 2 } },
    ]);
    rec = (await t.pull(a.auth)).body.records.find((r: any) => r.id === 'global:k');
    expect(rec).toMatchObject({ deletedAt: null, data: { value: 2 } });
  });

  it('only lets the owning device write positions and device settings', async () => {
    const t = setup();
    const a = await t.device('A');
    const b = await t.device('B');
    const book = insertBook(t.db);
    const at = Date.now();
    const res = await t.push(b.auth, [
      {
        kind: 'position',
        id: `${book}:${a.id}`,
        updatedAt: at,
        data: { charPos: 5, progress: 0.1 },
      },
      { kind: 'setting', id: `device:${a.id}:fontSize`, updatedAt: at, data: { value: 30 } },
      {
        kind: 'position',
        id: `${book}:${b.id}`,
        updatedAt: at,
        data: { charPos: 9, progress: 0.2 },
      },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['rejected', 'rejected', 'applied']);
    expect(res.body.results[0].error.code).toBe('not_owner');
  });

  it('rejects bad changes one by one without failing the push', async () => {
    const t = setup();
    const a = await t.device('A');
    const at = Date.now();
    const res = await t.push(a.auth, [
      { kind: 'nope', id: 'x', updatedAt: at, data: {} },
      { kind: 'setting', id: 'bad id', updatedAt: at, data: { value: 1 } },
      { kind: 'setting', id: 'global:k', updatedAt: 'yesterday', data: { value: 1 } },
      { kind: 'setting', id: 'global:k', updatedAt: at, data: {} },
      { kind: 'position', id: `${randomUUID()}:${a.id}`, updatedAt: at, data: { charPos: 1 } },
      { kind: 'device', id: a.id, updatedAt: at, deletedAt: at, data: {} },
      { kind: 'setting', id: 'global:big', updatedAt: at, data: { value: 'x'.repeat(70_000) } },
      'not an object',
      { kind: 'setting', id: 'global:ok', updatedAt: at, data: { value: true } },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.error?.code ?? r.status)).toEqual([
      'unknown_kind',
      'invalid_id',
      'invalid_change',
      'invalid_data',
      'unknown_book',
      'not_deletable',
      'too_large',
      'invalid_change',
      'applied',
    ]);
  });

  it('validates position payloads', async () => {
    const t = setup();
    const a = await t.device('A');
    const book = insertBook(t.db);
    const at = Date.now();
    const id = `${book}:${a.id}`;
    const statuses = async (data: unknown) =>
      (await t.push(a.auth, [{ kind: 'position', id, updatedAt: at, data }])).body.results[0];
    expect((await statuses({ charPos: -1, progress: 0 })).error.code).toBe('invalid_data');
    expect((await statuses({ charPos: 1.5, progress: 0 })).error.code).toBe('invalid_data');
    expect((await statuses({ charPos: 1, progress: 2 })).error.code).toBe('invalid_data');
    expect((await statuses({ charPos: 10, progress: null })).status).toBe('applied');
    const rec = (await t.pull(a.auth)).body.records.find((r: any) => r.kind === 'position');
    expect(rec).toMatchObject({
      bookId: book,
      data: { charPos: 10, progress: null, readThroughId: null },
    });
  });

  it('clamps timestamps from a clock far ahead to the server time', async () => {
    const t = setup({ sync: { maxClockSkewSeconds: 60 } });
    const a = await t.device('A');
    const b = await t.device('B');
    const future = Date.now() + 2 * 24 * 3600 * 1000;
    const before = Date.now();
    await t.push(a.auth, [
      { kind: 'setting', id: 'global:k', updatedAt: future, data: { value: 'a' } },
    ]);
    const rec = (await t.pull(a.auth)).body.records.find((r: any) => r.id === 'global:k');
    expect(rec.updatedAt).toBeGreaterThanOrEqual(before);
    expect(rec.updatedAt).toBeLessThanOrEqual(Date.now());
    // A genuinely later edit from a correct clock still wins.
    const later = await t.push(b.auth, [
      { kind: 'setting', id: 'global:k', updatedAt: Date.now() + 5, data: { value: 'b' } },
    ]);
    expect(later.body.results[0].status).toBe('applied');
  });

  it('refuses more than 500 changes and non-list bodies', async () => {
    const t = setup();
    const a = await t.device('A');
    const many = Array.from({ length: 501 }, (_, i) => ({
      kind: 'setting',
      id: `global:k${i}`,
      updatedAt: 1,
      data: { value: i },
    }));
    expect((await t.push(a.auth, many)).body.error.code).toBe('too_many_changes');
    const bad = await request(t.app).post('/api/v1/sync').set(a.auth).send({ changes: 'x' });
    expect(bad.status).toBe(400);
  });

  it('accepts a push larger than the default 100 kB JSON limit', async () => {
    const t = setup();
    const a = await t.device('A');
    const changes = Array.from({ length: 300 }, (_, i) => ({
      kind: 'setting',
      id: `global:k${i}`,
      updatedAt: 1,
      data: { value: 'x'.repeat(1000) },
    }));
    const res = await t.push(a.auth, changes);
    expect(res.status).toBe(200);
    expect(res.body.results.every((r: any) => r.status === 'applied')).toBe(true);
  });
});

describe('append policy (engine level, for stat sessions later)', () => {
  it('stores the first write and treats later writes to the id as duplicates', () => {
    const db = openDatabase(path.join(makeTempDir('db'), 'ttsu.db'));
    const kinds: KindRegistry = {
      ...DEFAULT_KINDS,
      session: {
        policy: () => 'append',
        deletable: false,
        validate: (_id, data) => {
          if (typeof (data as any)?.seconds !== 'number')
            throw new RecordError('invalid_data', 'x');
          return { bookId: null, data: data as Record<string, unknown> };
        },
      },
    };
    const store = new SyncStore(db, { maxClockSkewMs: 0, kinds });
    const [owner] = listUsers(db);
    const dev = randomUUID();
    const first = store.push(owner.id, dev, [
      { kind: 'session', id: 's1', updatedAt: 1, data: { seconds: 10 } },
    ]);
    expect(first[0].status).toBe('applied');
    const second = store.push(owner.id, randomUUID(), [
      { kind: 'session', id: 's1', updatedAt: 5, data: { seconds: 99 } },
    ]);
    expect(second[0].status).toBe('duplicate');
    expect(store.getRecord(owner.id, 'session', 's1')?.data).toEqual({ seconds: 10 });
    db.close();
  });

  it('rolls back the whole push when the database fails mid-batch', () => {
    const db = openDatabase(path.join(makeTempDir('db'), 'ttsu.db'));
    let calls = 0;
    const kinds: KindRegistry = {
      ...DEFAULT_KINDS,
      boom: {
        policy: () => 'lww',
        deletable: false,
        validate: () => {
          calls += 1;
          throw new Error('disk on fire');
        },
      },
    };
    const store = new SyncStore(db, { maxClockSkewMs: 0, kinds });
    const [owner] = listUsers(db);
    expect(() =>
      store.push(owner.id, randomUUID(), [
        { kind: 'setting', id: 'global:a', updatedAt: 1, data: { value: 1 } },
        { kind: 'boom', id: 'x', updatedAt: 1, data: {} },
      ]),
    ).toThrow('disk on fire');
    expect(calls).toBe(1);
    expect(store.getRecord(owner.id, 'setting', 'global:a')).toBeNull();
    expect(store.getState(owner.id).lastRev).toBe(0);
    db.close();
  });
});

describe('pull', () => {
  it('pages in rev order and returns an empty page at the end', async () => {
    const t = setup();
    const a = await t.device('A');
    const changes = Array.from({ length: 5 }, (_, i) => ({
      kind: 'setting',
      id: `global:k${i}`,
      updatedAt: 1,
      data: { value: i },
    }));
    await t.push(a.auth, changes);
    const seen: string[] = [];
    let cursor: string | undefined;
    let more = true;
    let pages = 0;
    while (more) {
      const res = await t.pull(a.auth, cursor ? { cursor, limit: 2 } : { limit: 2 });
      expect(res.status).toBe(200);
      seen.push(...res.body.records.map((r: any) => r.id));
      cursor = res.body.cursor;
      more = res.body.more;
      pages += 1;
    }
    expect(pages).toBe(3); // device record + 5 settings = 6 records
    expect(seen).toEqual([a.id, 'global:k0', 'global:k1', 'global:k2', 'global:k3', 'global:k4']);
    const end = await t.pull(a.auth, { cursor: cursor! });
    expect(end.body).toMatchObject({ records: [], more: false, cursor });
    expect(typeof end.body.serverTime).toBe('number');
  });

  it('returns only changes after the cursor, including updates to old records', async () => {
    const t = setup();
    const a = await t.device('A');
    await t.push(a.auth, [{ kind: 'setting', id: 'global:k', updatedAt: 1, data: { value: 1 } }]);
    const { cursor } = (await t.pull(a.auth)).body;
    await t.push(a.auth, [{ kind: 'setting', id: 'global:k', updatedAt: 2, data: { value: 2 } }]);
    const res = await t.pull(a.auth, { cursor });
    expect(res.body.records).toEqual([
      expect.objectContaining({ id: 'global:k', data: { value: 2 } }),
    ]);
  });

  it('answers cursor_reset for another epoch or a cursor ahead of the server', async () => {
    const t = setup();
    const a = await t.device('A');
    const { cursor } = (await t.pull(a.auth)).body;
    const { epoch, rev } = decodeCursor(cursor)!;
    const ahead = await t.pull(a.auth, { cursor: encodeCursor(epoch, rev + 10) });
    expect(ahead.status).toBe(409);
    expect(ahead.body.error.code).toBe('cursor_reset');

    new SyncStore(t.db).newEpoch();
    const stale = await t.pull(a.auth, { cursor });
    expect(stale.body.error.code).toBe('cursor_reset');
    expect((await t.pull(a.auth)).status).toBe(200);

    expect((await t.pull(a.auth, { cursor: 'garbage!!' })).body.error.code).toBe('invalid_cursor');
    expect((await t.pull(a.auth, { limit: 0 })).body.error.code).toBe('invalid_limit');
  });

  it('keeps users apart', async () => {
    const t = setup();
    const a = await t.device('A');
    t.db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u2', 'other', 1)").run();
    const otherToken = createToken(t.db, 'u2', 'Other').token;
    const other = { Authorization: `Bearer ${otherToken}` };
    await request(t.app).post('/api/v1/devices/register').set(other).send({});
    await t.push(a.auth, [{ kind: 'setting', id: 'global:k', updatedAt: 1, data: { value: 1 } }]);
    const res = await t.pull(other);
    expect(res.body.records.map((r: any) => r.kind)).toEqual(['device']);
    // Another user's device id can't be taken over.
    const steal = await request(t.app)
      .post('/api/v1/devices/register')
      .set({ Authorization: `Bearer ${createToken(t.db, 'u2', 'Thief').token}` })
      .send({ deviceId: a.id });
    expect(steal.body.error.code).toBe('device_id_taken');
  });
});

describe('sync CLI', () => {
  function cli(args: string[], env: Record<string, string>) {
    const res = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', path.join('src', 'cli.ts'), ...args],
      { cwd: SERVER_DIR, env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it('shows status, dumps records and starts a new epoch', async () => {
    const t = setup();
    const a = await t.device('Boox');
    const book = insertBook(t.db);
    await t.push(a.auth, [
      {
        kind: 'position',
        id: `${book}:${a.id}`,
        updatedAt: 1,
        data: { charPos: 42, progress: 0.5 },
      },
    ]);
    const env = { DB_DIR: t.config.dbDir, DATA_DIR: t.config.dataRoot };

    const status = cli(['sync', 'status'], env);
    expect(status.code, status.out).toBe(0);
    expect(status.out).toContain('position: 1 (+0 deleted)');
    expect(status.out).toContain('name="Boox"');

    const dump = cli(['sync', 'dump', '--kind', 'position', '--book', book], env);
    expect(dump.out).toContain('"charPos":42');
    expect(dump.out).not.toContain('kind=device');

    const { cursor } = (await t.pull(a.auth)).body;
    expect(cli(['sync', 'new-epoch'], env).code).toBe(0);
    expect((await t.pull(a.auth, { cursor })).status).toBe(409);
  });
});
