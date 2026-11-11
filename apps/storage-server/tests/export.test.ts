/**
 * WP18: "Export my data" (GET /api/v1/export).
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createToken, hashToken } from '../src/db/tokens';
import { createPairingCode } from '../src/db/pairing';
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from '../src/export/build-export';
import { makeTestApp } from './helpers/test-app';

function insertBook(db: Database.Database, title: string): string {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO libraries (id, folder, name, discovered_at, updated_at)
     VALUES ('lib1', 'lib', 'Lib', ?, ?)`,
  ).run(now, now);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
     VALUES (?, 'lib1', ?, ?, ?, ?)`,
  ).run(id, title, now, now, now);
  db.prepare('INSERT OR IGNORE INTO authors (name) VALUES (?)').run('夏目漱石');
  const author = db.prepare('SELECT id FROM authors WHERE name = ?').get('夏目漱石') as {
    id: number;
  };
  db.prepare('INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, 0)').run(
    id,
    author.id,
  );
  return id;
}

async function setup() {
  const t = makeTestApp();
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  async function device(token: string, deviceId: string = randomUUID()) {
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(t.app).post('/api/v1/devices/register').set(auth).send({ deviceId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { token, auth, id: res.body.device.id as string };
  }
  const push = async (auth: object, changes: unknown[]) => {
    const res = await request(t.app).post('/api/v1/sync').set(auth).send({ changes });
    expect(res.status).toBe(200);
    for (const r of res.body.results) expect(r.status, JSON.stringify(r)).toBe('applied');
  };
  return { ...t, db, device, push };
}

const statDay = (dateKey: string) => ({
  dateKey,
  charactersRead: 1200,
  readingTime: 600,
  minReadingSpeed: 100,
  altMinReadingSpeed: 100,
  lastReadingSpeed: 120,
  maxReadingSpeed: 150,
  lastStatisticModified: 1_790_000_000_000,
});

const highlight = {
  start: 120,
  end: 128,
  text: '吾輩は猫である',
  before: '一章',
  after: '。名前はまだ無い',
  color: 2,
  chapter: '一',
  createdAt: 1_700_000_000_000,
};

describe('GET /export', () => {
  it('needs a token', async () => {
    const t = await setup();
    expect((await request(t.app).get('/api/v1/export')).status).toBe(401);
  });

  it('exports every record of the user, deletion markers included, and writes nothing', async () => {
    const t = await setup();
    const bookId = insertBook(t.db, '吾輩は猫である');
    const aToken = t.newUserToken('Desktop');
    const a = await t.device(aToken);
    const b = await t.device(t.newUserToken('Boox'));
    const at = 1_790_000_000_000;
    await t.push(a.auth, [
      { kind: 'setting', id: 'global:theme', updatedAt: at, data: { value: 'dark-theme' } },
      { kind: 'setting', id: `device:${a.id}:fontSize`, updatedAt: at, data: { value: 22 } },
      {
        kind: 'position',
        id: `${bookId}:${a.id}`,
        updatedAt: at,
        data: { charPos: 500, progress: 0.25, readThroughId: null },
      },
      { kind: 'stat-day', id: `${bookId}:2026-10-02`, updatedAt: at, data: statDay('2026-10-02') },
      { kind: 'book-status', id: bookId, updatedAt: at, data: { status: 'reading', auto: true } },
      { kind: 'highlight', id: `${bookId}:${randomUUID()}`, updatedAt: at, data: highlight },
    ]);
    const removed = `${bookId}:${randomUUID()}`;
    await t.push(b.auth, [
      { kind: 'setting', id: `device:${b.id}:fontSize`, updatedAt: at, data: { value: 30 } },
      { kind: 'highlight', id: removed, updatedAt: at, data: highlight },
      { kind: 'highlight', id: removed, updatedAt: at + 1, deletedAt: at + 1 },
    ]);

    // Another user's records stay out.
    t.db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u2', 'someone else', 1)").run();
    const other = await t.device(createToken(t.db, 'u2', 'Other').token);
    await t.push(other.auth, [
      { kind: 'setting', id: 'global:theme', updatedAt: at, data: { value: 'other-theme' } },
    ]);
    const owner = t.db.prepare("SELECT id FROM users WHERE id <> 'u2'").get() as { id: string };
    const code = createPairingCode(t.db, owner.id, 'Phone', 10);

    const state = () => ({
      records: t.db.prepare('SELECT * FROM sync_records ORDER BY user_id, kind, id').all(),
      sync: t.db.prepare('SELECT * FROM sync_state ORDER BY user_id').all(),
    });
    const before = state();

    const res = await request(t.app).get('/api/v1/export').set(b.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="ttsu-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(state()).toEqual(before);

    const text = res.text;
    expect(text).toContain('\n  "formatVersion": 1'); // pretty-printed
    const out = JSON.parse(text);
    expect(out.format).toBe(EXPORT_FORMAT);
    expect(out.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(out.user.name).toBeTruthy();
    expect(out.devices.map((d: { name: string }) => d.name)).toEqual(['Desktop', 'Boox']);

    expect(Object.keys(out.records).sort()).toEqual([
      'book-status',
      'device',
      'highlight',
      'position',
      'setting',
      'stat-day',
    ]);
    expect(out.counts.highlight).toEqual({ live: 1, deleted: 1 });
    expect(out.counts.setting).toEqual({ live: 3, deleted: 0 });

    const settings = out.records.setting;
    expect(settings.map((r: { id: string }) => r.id).sort()).toEqual(
      ['global:theme', `device:${a.id}:fontSize`, `device:${b.id}:fontSize`].sort(),
    );
    const global = settings.find((r: { id: string }) => r.id === 'global:theme');
    expect(global).toMatchObject({
      kind: 'setting',
      deviceId: a.id,
      ownerDeviceId: null,
      updatedAt: at,
      deletedAt: null,
      data: { value: 'dark-theme' },
    });
    expect(global.rev).toEqual(expect.any(Number));
    expect(settings.find((r: { id: string }) => r.id === `device:${b.id}:fontSize`)).toMatchObject({
      deviceId: b.id,
      ownerDeviceId: b.id,
      data: { value: 30 },
    });
    expect(out.records.position[0]).toMatchObject({
      id: `${bookId}:${a.id}`,
      bookId,
      deviceId: a.id,
      ownerDeviceId: a.id,
      data: { charPos: 500, progress: 0.25, readThroughId: null },
    });
    expect(out.records['stat-day'][0]).toMatchObject({
      id: `${bookId}:2026-10-02`,
      data: statDay('2026-10-02'),
    });
    const marker = out.records.highlight.find((r: { id: string }) => r.id === removed);
    expect(marker).toMatchObject({ deletedAt: at + 1, deviceId: b.id, bookId, data: {} });

    // Records equal what the sync API serves (plus ownerDeviceId).
    const pulled = await request(t.app).get('/api/v1/sync').set(b.auth).query({ limit: 1000 });
    const exported = Object.values(out.records)
      .flat()
      .map(({ ownerDeviceId: _owner, ...r }: any) => r);
    expect(exported.sort((x: any, y: any) => x.rev - y.rev)).toEqual(pulled.body.records);

    expect(out.books[bookId]).toEqual({
      title: '吾輩は猫である',
      authors: ['夏目漱石'],
      series: null,
      seriesIndex: null,
      sources: [],
    });

    // No secrets and nothing of the other user.
    expect(text).not.toContain('ttsu_');
    expect(text).not.toContain(hashToken(aToken));
    expect(text).not.toContain(code.code.replace('-', ''));
    expect(text).not.toContain(code.code);
    expect(text).not.toContain('other-theme');
    expect(text).not.toContain(other.id);
  });

  it('exports an empty account', async () => {
    const t = await setup();
    const res = await request(t.app)
      .get('/api/v1/export')
      .set({ Authorization: `Bearer ${t.newUserToken()}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ records: {}, counts: {}, books: {}, devices: [] });
  });
});
