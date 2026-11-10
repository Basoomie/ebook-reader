/**
 * WP8b: collection kinds, the once-per-user "Planned" collection, collection cards,
 * `scope` on /books and /books/lookup.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_COLLECTIONS, collageFromMembers } from '../src/collections/cards';
import {
  PLANNED_COLLECTION_ID,
  PLANNED_SEED,
  seedPlannedCollections,
} from '../src/collections/seed';
import { createApp } from '../src/app';
import { listUsers } from '../src/db/users';
import { SyncStore } from '../src/sync/store';
import { calibreDate, CalibreRoot, FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTestApp } from './helpers/test-app';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);

async function register(app: ReturnType<typeof createApp>, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const res = await request(app)
    .post('/api/v1/devices/register')
    .set(auth)
    .send({ deviceId: randomUUID() });
  expect(res.status).toBe(200);
  return auth;
}

/** Books are added one minute apart in list order (the last one is the newest). */
async function catalogEnv(books: FixtureBook[], timeoutSeconds?: number) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  for (const [i, b] of books.entries()) {
    await lib.addBook({ timestamp: calibreDate(new Date(BASE + i * 60_000)), ...b });
  }
  const e = makeIndexerEnv(
    root.dir,
    {},
    timeoutSeconds ? { search: { regexTimeoutSeconds: timeoutSeconds } } : {},
  );
  envs.push(e);
  await e.indexer.start({ timer: false });
  enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const user = listUsers(e.db)[0];
  const auth = await register(e.app, e.token());
  const ids = new Map(
    (e.db.prepare('SELECT id, title FROM books').all() as { id: string; title: string }[]).map(
      (r) => [r.title, r.id],
    ),
  );
  const id = (title: string) => {
    const v = ids.get(title);
    if (!v) throw new Error(`no book ${title}`);
    return v;
  };
  let at = BASE;
  const push = async (changes: object[]) => {
    const res = await request(e.app)
      .post('/api/v1/sync')
      .set(auth)
      .send({ changes: changes.map((c) => ({ updatedAt: ++at, ...c })) });
    expect(res.status).toBe(200);
    return res.body.results as { status: string; error?: { code: string } }[];
  };
  const pushOk = async (changes: object[]) => {
    const results = await push(changes);
    expect(results.map((r) => r.error?.code ?? r.status)).toEqual(changes.map(() => 'applied'));
  };
  const status = (title: string, value: string) =>
    pushOk([{ kind: 'book-status', id: id(title), data: { status: value, auto: false } }]);
  const item = (collection: string, title: string, key = 'V') => ({
    kind: 'collection-item',
    id: `${collection}:${id(title)}`,
    data: { key },
  });
  const cards = async () => {
    const res = await request(e.app).get('/api/v1/collections/cards').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return new Map(
      (res.body.cards as { id: string }[]).map((c) => [c.id, c as Record<string, any>]),
    );
  };
  const tileTitles = (card: Record<string, any>) =>
    (card.tiles as { bookId: string }[]).map(
      (t) => [...ids.entries()].find(([, v]) => v === t.bookId)?.[0],
    );
  return { e, user, auth, id, push, pushOk, status, item, cards, tileTitles };
}

const BOOKS: FixtureBook[] = [
  { title: '巻 1', authors: ['A'], series: { name: 'S', index: 1 } },
  { title: '巻 2', authors: ['A'], series: { name: 'S', index: 2 } },
  { title: '単発', authors: ['B'], tags: ['SF'] },
  { title: '別 1', authors: ['C'], series: { name: 'T', index: 1 } },
  { title: '新しい本', authors: ['D'], tags: ['SF'] },
  { title: 'a'.repeat(40) + '!', authors: ['E'] },
];

describe('collection kinds', () => {
  it('validates collections', async () => {
    const t = makeTestApp();
    const auth = await register(t.app, t.newUserToken('d'));
    const now = Date.now();
    const id = randomUUID();
    const res = await request(t.app)
      .post('/api/v1/sync')
      .set(auth)
      .send({
        changes: [
          { kind: 'collection', id, updatedAt: now, data: { name: ' Planned ', type: 'manual' } },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: 'SF', type: 'smart', query: 'tag:SF chars:<100000' },
          },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: '', type: 'manual' },
          },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: 'x'.repeat(201), type: 'manual' },
          },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: 'x', type: 'shelf' },
          },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: 'x', type: 'manual', query: 'tag:SF' },
          },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: 'x', type: 'smart' },
          },
          {
            kind: 'collection',
            id: randomUUID(),
            updatedAt: now,
            data: { name: 'x', type: 'smart', query: '/usr/bin' },
          },
          {
            kind: 'collection',
            id: 'not-a-uuid',
            updatedAt: now,
            data: { name: 'x', type: 'manual' },
          },
          { kind: 'collection', id: randomUUID(), updatedAt: now, deletedAt: now },
        ],
      });
    expect(res.status).toBe(200);
    expect(
      (res.body.results as { status: string; error?: { code: string } }[]).map(
        (r) => r.error?.code ?? r.status,
      ),
    ).toEqual([
      'applied',
      'applied',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_id',
      'applied',
    ]);
    const pulled = (await request(t.app).get('/api/v1/sync').set(auth)).body.records as {
      id: string;
      data: unknown;
      bookId: string | null;
    }[];
    const stored = pulled.find((r) => r.id === id);
    expect(stored?.data).toEqual({ name: 'Planned', type: 'manual' });
    expect(stored?.bookId).toBeNull();
  });

  it('validates collection items, sets the book and revives a removed one', async () => {
    const c = await catalogEnv(BOOKS.slice(0, 2));
    const col = randomUUID();
    const results = await c.push([
      c.item(col, '巻 1', 'V'),
      c.item(col, '巻 2', 'a0Zz9'),
      { kind: 'collection-item', id: `${col}:${randomUUID()}`, data: { key: 'V' } },
      { kind: 'collection-item', id: `${col}:${c.id('巻 1')}:x`, data: { key: 'V' } },
      { kind: 'collection-item', id: c.id('巻 1'), data: { key: 'V' } },
      { ...c.item(col, '巻 1'), data: { key: '' } },
      { ...c.item(col, '巻 1'), data: { key: 'a-b' } },
      { ...c.item(col, '巻 1'), data: { key: 'V'.repeat(201) } },
      { ...c.item(col, '巻 1'), data: {} },
    ]);
    expect(results.map((r) => r.error?.code ?? r.status)).toEqual([
      'applied',
      'applied',
      'unknown_book',
      'invalid_id',
      'invalid_id',
      'invalid_data',
      'invalid_data',
      'invalid_data',
      'invalid_data',
    ]);
    const row = c.e.db
      .prepare("SELECT book_id FROM sync_records WHERE kind = 'collection-item' AND id = ?")
      .get(`${col}:${c.id('巻 1')}`) as { book_id: string };
    expect(row.book_id).toBe(c.id('巻 1'));

    const itemId = `${col}:${c.id('巻 1')}`;
    expect(
      (await c.push([{ kind: 'collection-item', id: itemId, deletedAt: BASE + 100 }]))[0].status,
    ).toBe('applied');
    expect((await c.push([c.item(col, '巻 1', 'W')]))[0].status).toBe('applied');
    const revived = c.e.db
      .prepare(
        "SELECT deleted_at, data FROM sync_records WHERE kind = 'collection-item' AND id = ?",
      )
      .get(itemId) as { deleted_at: number | null; data: string };
    expect(revived.deleted_at).toBeNull();
    expect(JSON.parse(revived.data)).toEqual({ key: 'W' });
  });
});

describe('"Planned" collection', () => {
  it('is created once per user, survives restarts and stays deleted', async () => {
    const t = makeTestApp({}, undefined, { seedDefaults: true });
    if (!t.database.ok) throw new Error('no database');
    const db = t.database.db;
    const auth = await register(t.app, t.newUserToken('d'));
    const records = async () =>
      (await request(t.app).get('/api/v1/sync').set(auth)).body.records as {
        kind: string;
        id: string;
        data: Record<string, unknown>;
        deletedAt: number | null;
      }[];
    let planned = (await records()).filter((r) => r.kind === 'collection');
    expect(planned).toHaveLength(1);
    expect(planned[0].id).toBe(PLANNED_COLLECTION_ID);
    expect(planned[0].data).toEqual({ name: 'Planned', type: 'manual' });
    const serverDevice = (await records()).find(
      (r) => r.kind === 'device' && r.data.name === 'Server',
    );
    expect(serverDevice).toBeTruthy();

    // A restart (a new app on the same database) writes nothing.
    const revBefore = (db.prepare('SELECT MAX(rev) AS r FROM sync_records').get() as { r: number })
      .r;
    createApp({ config: t.config, database: t.database, version: 'x', seedDefaults: true });
    expect((db.prepare('SELECT MAX(rev) AS r FROM sync_records').get() as { r: number }).r).toBe(
      revBefore,
    );

    // Deleted by the user: never written again, even without the seed row.
    const now = Date.now();
    const del = await request(t.app)
      .post('/api/v1/sync')
      .set(auth)
      .send({
        changes: [
          { kind: 'collection', id: PLANNED_COLLECTION_ID, updatedAt: now, deletedAt: now },
        ],
      });
    expect(del.body.results[0].status).toBe('applied');
    createApp({ config: t.config, database: t.database, version: 'x', seedDefaults: true });
    db.prepare('DELETE FROM user_seeds').run();
    const store = new SyncStore(db);
    expect(seedPlannedCollections(db, store)).toEqual([]);
    planned = (await records()).filter((r) => r.kind === 'collection');
    expect(planned).toHaveLength(1);
    expect(planned[0].deletedAt).not.toBeNull();
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM user_seeds WHERE name = ?').get(PLANNED_SEED) as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('is not created when seeding is off', async () => {
    const t = makeTestApp();
    const auth = await register(t.app, t.newUserToken('d'));
    const records = (await request(t.app).get('/api/v1/sync').set(auth)).body.records as {
      kind: string;
    }[];
    expect(records.filter((r) => r.kind === 'collection')).toEqual([]);
  });
});

describe('collection cards (GET /api/v1/collections/cards)', () => {
  it('counts built-ins, saved searches and lists across the library', async () => {
    const c = await catalogEnv(BOOKS);
    await c.status('巻 1', 'reading');
    await c.status('単発', 'completed');
    await c.pushOk([{ kind: 'book-favorite', id: c.id('別 1'), data: { favorite: true } }]);
    const list = randomUUID();
    const sf = randomUUID();
    await c.pushOk([
      { kind: 'collection', id: list, data: { name: 'Queue', type: 'manual' } },
      { kind: 'collection', id: sf, data: { name: 'SF', type: 'smart', query: 'tag:SF' } },
      c.item(list, '巻 2', 'a'),
      c.item(list, '単発', 'b'),
      c.item(list, '別 1', 'c'),
      { ...c.item(list, '別 1', 'c'), updatedAt: BASE + 1000, deletedAt: BASE + 1000 },
    ]);
    const cards = await c.cards();
    expect([...cards.keys()].slice(0, 5)).toEqual(BUILTIN_COLLECTIONS.map((b) => b.id));
    expect(cards.get('reading')).toMatchObject({
      builtin: true,
      query: 'status:reading',
      bookCount: 1,
    });
    expect(cards.get('completed')?.bookCount).toBe(1);
    expect(cards.get('dropped')?.bookCount).toBe(0);
    expect(cards.get('unread')?.bookCount).toBe(BOOKS.length - 2);
    expect(cards.get('favorites')?.bookCount).toBe(1);
    expect(cards.get(sf)).toMatchObject({ builtin: false, query: 'tag:SF', bookCount: 2 });
    expect(cards.get(list)).toMatchObject({ builtin: false, bookCount: 2 });
    expect(cards.get(list)?.query).toBeUndefined();
    expect(cards.get(list)?.tiles).toHaveLength(2);
    expect(cards.get('dropped')?.tiles).toEqual([]);

    // A new record changes the answer (the cache follows the user's records).
    await c.status('巻 2', 'reading');
    expect((await c.cards()).get('reading')?.bookCount).toBe(2);
  });

  it('leaves out missing books and deleted collections', async () => {
    const c = await catalogEnv(BOOKS.slice(0, 3));
    const list = randomUUID();
    const gone = randomUUID();
    await c.pushOk([
      { kind: 'collection', id: list, data: { name: 'L', type: 'manual' } },
      { kind: 'collection', id: gone, data: { name: 'G', type: 'manual' } },
      c.item(list, '巻 1'),
      c.item(list, '巻 2'),
      { kind: 'collection', id: gone, deletedAt: BASE + 500 },
    ]);
    c.e.db.prepare('UPDATE book_sources SET missing_at = 1 WHERE book_id = ?').run(c.id('巻 2'));
    const cards = await c.cards();
    expect(cards.has(gone)).toBe(false);
    expect(cards.get(list)?.bookCount).toBe(1);
  });

  it('puts opened books first, then one first volume per series, then the newest', async () => {
    const c = await catalogEnv(BOOKS.slice(0, 5));
    const list = randomUUID();
    await c.pushOk([
      { kind: 'collection', id: list, data: { name: 'L', type: 'manual' } },
      ...['巻 1', '巻 2', '単発', '別 1', '新しい本'].map((t) => c.item(list, t)),
    ]);
    expect(c.tileTitles((await c.cards()).get(list)!)).toEqual([
      '別 1',
      '巻 1',
      '新しい本',
      '単発',
    ]);
    // Opening a book (a position record) moves it to the front.
    await c.pushOk([
      {
        kind: 'position',
        id: `${c.id('巻 2')}:${await deviceOf(c)}`,
        data: { charPos: 5, progress: 0.1, readThroughId: null },
      },
    ]);
    expect(c.tileTitles((await c.cards()).get(list)!)).toEqual([
      '巻 2',
      '別 1',
      '新しい本',
      '単発',
    ]);
  });

  it('reports a broken saved search on its own card', async () => {
    const c = await catalogEnv(BOOKS, 1);
    const broken = randomUUID();
    const slow = randomUUID();
    // Written directly: the kind would refuse an unparsable query (a parser change could
    // still make an old one fail).
    c.e.db
      .prepare(
        `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, 'collection', ?, NULL, 'dev', 1, NULL, 9000, ?, 1)`,
      )
      .run(c.user.id, broken, JSON.stringify({ name: 'B', type: 'smart', query: '/usr/bin' }));
    await c.pushOk([
      { kind: 'collection', id: slow, data: { name: 'S', type: 'smart', query: '/^(a+)+$/' } },
    ]);
    const cards = await c.cards();
    expect(cards.get(broken)?.error?.code).toBe('invalid_query');
    expect(cards.get(slow)?.error?.code).toBe('regex_timeout');
    expect(cards.get('unread')?.bookCount).toBe(BOOKS.length);
    expect(cards.get('unread')?.error).toBeUndefined();
  }, 30_000);

  it('picks collage tiles in the decided order', () => {
    const m = (id: string, series: number | null, index: number | null, added: number) => ({
      id,
      series_id: series,
      series_index: index,
      added_at: added,
    });
    const members = [m('n4', 2, 3, 9), m('n3', 1, 2, 8), m('n2', null, null, 7), m('n1', 1, 1, 1)];
    expect(collageFromMembers(members, [])).toEqual(['n4', 'n1', 'n3', 'n2']);
    expect(collageFromMembers(members, ['x', 'n2'])).toEqual(['n2', 'n4', 'n1', 'n3']);
    expect(collageFromMembers([], ['x'])).toEqual([]);
  });
});

async function deviceOf(c: Awaited<ReturnType<typeof catalogEnv>>): Promise<string> {
  const res = await request(c.e.app).get('/api/v1/me').set(c.auth);
  return res.body.token.deviceId as string;
}

describe('GET /api/v1/books?scope=', () => {
  it('applies the scope and the search together', async () => {
    const c = await catalogEnv(BOOKS);
    await c.status('巻 1', 'reading');
    await c.status('別 1', 'reading');
    const titles = async (query: Record<string, string>) => {
      const res = await request(c.e.app).get('/api/v1/books').query(query).set(c.auth);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.books as { title: string }[]).map((b) => b.title);
    };
    expect(await titles({ scope: 'status:reading' })).toEqual(['別 1', '巻 1']);
    expect(await titles({ scope: 'status:reading', q: '巻' })).toEqual(['巻 1']);
    expect(await titles({ scope: 'tag:SF', q: '-新しい' })).toEqual(['単発']);
    const bad = await request(c.e.app)
      .get('/api/v1/books')
      .query({ scope: '/usr/bin' })
      .set(c.auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_query');
  });
});

describe('POST /api/v1/books/lookup', () => {
  it('returns visible books in the given order, filtered by the search', async () => {
    const c = await catalogEnv(BOOKS);
    const lookup = (body: object) =>
      request(c.e.app).post('/api/v1/books/lookup').set(c.auth).send(body);
    const order = ['単発', '巻 2', '巻 1', '新しい本'];
    const res = await lookup({ ids: [...order.map(c.id), randomUUID()] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.books as { title: string }[]).map((b) => b.title)).toEqual(order);
    const filtered = await lookup({ ids: order.map(c.id), q: '巻' });
    expect((filtered.body.books as { title: string }[]).map((b) => b.title)).toEqual([
      '巻 2',
      '巻 1',
    ]);
    const regex = await lookup({ ids: order.map(c.id), q: '/^巻 [12]$/' });
    expect((regex.body.books as { title: string }[]).map((b) => b.title)).toEqual(['巻 2', '巻 1']);

    c.e.db.prepare('UPDATE book_sources SET missing_at = 1 WHERE book_id = ?').run(c.id('巻 2'));
    const hidden = await lookup({ ids: order.map(c.id) });
    expect((hidden.body.books as { title: string }[]).map((b) => b.title)).toEqual([
      '単発',
      '巻 1',
      '新しい本',
    ]);

    expect((await lookup({ ids: [] })).body.books).toEqual([]);
    for (const body of [{}, { ids: ['nope'] }, { ids: Array(201).fill(c.id('巻 1')) }]) {
      const r = await lookup(body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_ids');
    }
    const badQuery = await lookup({ ids: [c.id('巻 1')], q: '/usr/bin' });
    expect(badQuery.body.error.code).toBe('invalid_query');
  });
});
