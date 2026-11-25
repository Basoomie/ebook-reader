/**
 * Next in your series (docs/design/next-in-series.md): the SQL rule on the shared fixture
 * (the web app's offline rule runs the same file), `status:next` in searches, the Home
 * row's order (GET /next-in-series) and the series-next-hide record.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { nextInSeriesIds } from '../src/catalog/next-in-series';
import { listUsers } from '../src/db/users';
import { makeTestApp } from './helpers/test-app';

interface FixtureBook {
  id: string;
  library: string;
  series: string | null;
  index: number | null;
  added?: number;
  missing?: boolean;
}

interface FixtureCase {
  name: string;
  books: FixtureBook[];
  status?: Record<string, string>;
  finished?: Record<string, string | null>;
  hidden?: [string, string][];
  settings?: { on?: boolean; bonus?: boolean };
  next: string[];
}

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'next-in-series.json'), 'utf8'),
) as { cases: FixtureCase[] };

const T0 = Date.UTC(2026, 10, 1);

function setup() {
  const t = makeTestApp();
  if (!t.database.ok) throw new Error('no database');
  const db = t.database.db;
  const token = t.newUserToken();
  const userId = listUsers(db)[0].id;
  let rev = 1;

  function clear() {
    for (const table of ['sync_records', 'book_sources', 'books', 'series', 'libraries']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const [lib, enabled] of [
      ['L', 1],
      ['M', 1],
      ['D', 0],
    ] as const) {
      db.prepare(
        `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
         VALUES (?, ?, ?, 'ja', ?, 0, 0)`,
      ).run(lib, lib, lib, enabled);
    }
  }

  function record(kind: string, id: string, bookId: string | null, data: object, at = T0 + rev) {
    db.prepare(
      `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
       VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)`,
    ).run(userId, kind, id, bookId, at, rev++, JSON.stringify(data), at);
  }

  /** Loads a case; returns fixture name ↔ book id maps. */
  function load(c: FixtureCase) {
    clear();
    const ids = new Map<string, string>();
    const names = new Map<string, string>();
    c.books.forEach((b, i) => {
      const id = randomUUID();
      ids.set(b.id, id);
      names.set(id, b.id);
      let seriesId: number | null = null;
      if (b.series !== null) {
        db.prepare('INSERT OR IGNORE INTO series (name) VALUES (?)').run(b.series);
        seriesId = (
          db.prepare('SELECT id FROM series WHERE name = ?').get(b.series) as { id: number }
        ).id;
      }
      const added = T0 + (b.added ?? i) * 60_000;
      db.prepare(
        `INSERT INTO books (id, library_id, title, series_id, series_index, added_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
      ).run(id, b.library, b.id, seriesId, b.index, added);
      db.prepare(
        `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, missing_at, created_at, updated_at)
         VALUES (?, ?, 'calibre', ?, ?, ?, 0, 0)`,
      ).run(randomUUID(), id, b.library, randomUUID(), b.missing ? 1 : null);
    });
    for (const [name, status] of Object.entries(c.status ?? {})) {
      record('book-status', ids.get(name)!, ids.get(name)!, { status, auto: false });
    }
    for (const [name, finishedOn] of Object.entries(c.finished ?? {})) {
      const id = ids.get(name)!;
      record('read-through', `${id}:1`, id, {
        number: 1,
        origin: 'completion',
        startedOn: null,
        finished: true,
        finishedOn,
        manual: false,
        charCount: null,
      });
    }
    for (const [i, [library, name]] of (c.hidden ?? []).entries()) {
      record('series-next-hide', `000000000000000${i}`, null, { library, name, hiddenAt: T0 });
    }
    const setting = (key: string, value: boolean) =>
      record('setting', `global:${key}`, null, { value: value ? '1' : '0' });
    if (c.settings?.on !== undefined) setting('nextInSeriesOn', c.settings.on);
    if (c.settings?.bonus !== undefined) setting('nextInSeriesBonus', c.settings.bonus);
    return { ids, names };
  }

  return { app: t.app, db: db as Database.Database, userId, token, load, record };
}

describe('next in your series: the shared fixture', () => {
  let env: ReturnType<typeof setup>;
  beforeAll(() => {
    env = setup();
  });

  for (const c of FIXTURE.cases) {
    it(c.name, async () => {
      const { names } = env.load(c);
      const got = nextInSeriesIds(env.db, env.userId).map((id) => names.get(id));
      expect([...got].sort()).toEqual([...c.next].sort());

      // The same books through a search.
      const res = await request(env.app)
        .get('/api/v1/books')
        .query({ q: 'status:next', limit: 200 })
        .set({ Authorization: `Bearer ${env.token}` });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const searched = (res.body.books as { id: string }[]).map((b) => names.get(b.id));
      expect(searched.sort()).toEqual([...c.next].sort());
    });
  }
});

describe('next in your series: searches, order and records', () => {
  let env: ReturnType<typeof setup>;
  beforeAll(() => {
    env = setup();
  });
  const auth = () => ({ Authorization: `Bearer ${env.token}` });
  const search = async (q: string) => {
    const res = await request(env.app).get('/api/v1/books').query({ q, limit: 200 }).set(auth());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.books as { id: string }[];
  };

  const SERIES: FixtureCase = {
    name: 'two series',
    books: [
      { id: 'a1', library: 'L', series: 'A', index: 1 },
      { id: 'a2', library: 'L', series: 'A', index: 2 },
      { id: 'b1', library: 'L', series: 'B', index: 1 },
      { id: 'b2', library: 'L', series: 'B', index: 2 },
      { id: 'r', library: 'L', series: null, index: null },
    ],
    status: { r: 'reading' },
    finished: { a1: '2026-11-03', b1: '2026-11-10' },
    next: [],
  };

  it('orders the row by the series finished last', async () => {
    const { names } = env.load(SERIES);
    expect(nextInSeriesIds(env.db, env.userId).map((id) => names.get(id))).toEqual(['b2', 'a2']);
    const res = await request(env.app).get('/api/v1/next-in-series').set(auth());
    expect(res.status).toBe(200);
    expect((res.body.ids as string[]).map((id) => names.get(id))).toEqual(['b2', 'a2']);
  });

  it('combines with other statuses, other terms and negation', async () => {
    const { names } = env.load(SERIES);
    const named = (books: { id: string }[]) => books.map((b) => names.get(b.id)).sort();
    expect(named(await search('status:next,reading'))).toEqual(['a2', 'b2', 'r']);
    env.db.prepare('UPDATE books SET char_count = 100 WHERE title = ?').run('b2');
    expect(named(await search('status:next chars:<200'))).toEqual(['b2']);
    expect(named(await search('-status:next'))).toEqual(['a1', 'b1', 'r']);
    expect(named(await search('status:unread,next'))).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('validates series-next-hide records', async () => {
    const registered = await request(env.app)
      .post('/api/v1/devices/register')
      .set(auth())
      .send({ deviceId: randomUUID() });
    expect(registered.status).toBe(200);
    const push = async (change: object) => {
      const r = (
        await request(env.app)
          .post('/api/v1/sync')
          .set(auth())
          .send({ changes: [{ updatedAt: Date.now(), ...change }] })
      ).body.results[0] as { status: string; error?: { code: string } };
      return { status: r.status, code: r.error?.code };
    };
    const kind = 'series-next-hide';
    expect(
      (
        await push({
          kind,
          id: '0123456789abcdef',
          data: { library: 'L', name: 'A', hiddenAt: 1 },
        })
      ).status,
    ).toBe('applied');
    expect(
      (await push({ kind, id: 'nothex', data: { library: 'L', name: 'A', hiddenAt: 1 } })).code,
    ).toBe('invalid_id');
    expect(
      (await push({ kind, id: '0123456789abcdee', data: { library: 'L', name: '', hiddenAt: 1 } }))
        .code,
    ).toBe('invalid_data');
    expect(
      (
        await push({
          kind,
          id: '0123456789abcded',
          data: { library: 'L', name: 'A', hiddenAt: 1, extra: 1 },
        })
      ).code,
    ).toBe('invalid_data');
  });
});
