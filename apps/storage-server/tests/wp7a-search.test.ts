/**
 * WP7a: the library search language on the server, browse groups (series, authors,
 * tags), collage tiles, the regex worker, and the tag-blur kind.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogVersion, noteCatalogWrite } from '../src/catalog/catalog-version';
import { planBooks } from '../src/catalog/queries';
import { SMALL_SET } from '../src/catalog/search-sql';
import { SearchRunner, RegexTimeoutError } from '../src/catalog/search-runner';
import { SQL_COUNT_SOURCE_KEY } from '../src/counts/count-records';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import { calibreDate, CalibreRoot, FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTestApp } from './helpers/test-app';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);

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
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const user = listUsers(e.db)[0];
  const auth = { Authorization: `Bearer ${e.token()}` };
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
  let rev = 1;
  const record = (
    kind: string,
    recordId: string,
    bookId: string | null,
    data: object,
    userId = user.id,
  ) =>
    e.db
      .prepare(
        `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)`,
      )
      .run(userId, kind, recordId, bookId, BASE + rev, rev++, JSON.stringify(data), BASE);
  const status = (title: string, value: string, userId?: string) =>
    record('book-status', id(title), id(title), { status: value, auto: false }, userId);
  const favorite = (title: string, value: boolean) =>
    record('book-favorite', id(title), id(title), { favorite: value });
  const opened = (title: string) =>
    record('position', `${id(title)}:dev`, id(title), {
      charPos: 1,
      progress: 0.1,
      readThroughId: null,
    });
  const setCount = (title: string, characters: number | null) => {
    e.db
      .prepare(
        `INSERT OR REPLACE INTO char_counts (book_id, status, source_key, spec, characters, counted_at)
         SELECT b.id, ?, ${SQL_COUNT_SOURCE_KEY}, ?, ?, 0
           FROM books b JOIN book_sources s ON s.book_id = b.id WHERE b.id = ?`,
      )
      .run(characters === null ? 'error' : 'ok', e.counts.spec, characters, id(title));
    e.db.prepare('UPDATE books SET char_count = ? WHERE id = ?').run(characters, id(title));
  };
  const get = (path: string, query: Record<string, string | number> = {}) =>
    request(e.app).get(`/api/v1${path}`).query(query).set(auth);
  const titles = async (query: Record<string, string | number>) => {
    const res = await get('/books', query);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.books as { title: string }[]).map((b) => b.title);
  };
  return { e, libId, user, auth, id, record, status, favorite, opened, setCount, get, titles };
}

const SAMPLE: FixtureBook[] = [
  {
    title: '薬屋のひとりごと 1',
    authors: ['日向夏'],
    series: { name: '薬屋のひとりごと', index: 1 },
    tags: ['ライトノベル', 'ミステリー'],
  },
  {
    title: '薬屋のひとりごと 2',
    authors: ['日向夏'],
    series: { name: '薬屋のひとりごと', index: 2 },
    tags: ['ライトノベル'],
  },
  {
    title: '薬屋のひとりごと 外伝',
    authors: ['日向夏'],
    series: { name: '薬屋のひとりごと', index: 1.5 },
  },
  { title: '共著の本', authors: ['著者二', '著者一'], tags: ['アンソロジー'] },
  {
    title: 'Re:ゼロから始める異世界生活 1',
    authors: ['長月達平'],
    series: { name: 'Re:ゼロ', index: 1 },
    tags: ['ライトノベル', 'SF'],
  },
  { title: 'The Long Way', authors: ['Doe, Jane'], tags: ['SF Fantasy'] },
  { title: '100% Pure', authors: ['Ann Author'] },
];

describe('search language (GET /api/v1/books?q=)', () => {
  it('keeps the WP6 plain-text meaning: title, author or series, newest first', async () => {
    const c = await catalogEnv(SAMPLE);
    expect(await c.titles({ q: '薬屋' })).toEqual([
      '薬屋のひとりごと 外伝',
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 1',
    ]);
    expect(await c.titles({ q: '日向' })).toHaveLength(3);
    expect(await c.titles({ q: 'Re:ゼロ' })).toEqual(['Re:ゼロから始める異世界生活 1']);
    expect(await c.titles({ q: '100%' })).toEqual(['100% Pure']);
    expect(await c.titles({ q: 'the LONG' })).toEqual(['The Long Way']);
  });

  it('filters by author, series and tag, with = for exact and commas for any', async () => {
    const c = await catalogEnv(SAMPLE);
    expect(await c.titles({ q: 'author:著者一' })).toEqual(['共著の本']);
    expect(await c.titles({ q: 'author:"Doe, Jane"' })).toEqual(['The Long Way']);
    expect(await c.titles({ q: 'series:=Re:ゼロ' })).toEqual(['Re:ゼロから始める異世界生活 1']);
    expect(await c.titles({ q: 'series:=Re' })).toEqual([]);
    expect(await c.titles({ q: 'tag:SF' })).toEqual([
      'The Long Way',
      'Re:ゼロから始める異世界生活 1',
    ]);
    expect(await c.titles({ q: 'tag:=sf' })).toEqual(['Re:ゼロから始める異世界生活 1']);
    expect(await c.titles({ q: 'tag:ミステリー,アンソロジー' })).toEqual([
      '共著の本',
      '薬屋のひとりごと 1',
    ]);
    expect(await c.titles({ q: 'tag:ライトノベル tag:ミステリー' })).toEqual([
      '薬屋のひとりごと 1',
    ]);
    expect(await c.titles({ q: 'tag：アンソロジー' })).toEqual(['共著の本']);
  });

  it('negates terms, including books without the field', async () => {
    const c = await catalogEnv(SAMPLE);
    expect(await c.titles({ q: '-series:薬屋 -tag:ライトノベル' })).toEqual([
      '100% Pure',
      'The Long Way',
      '共著の本',
    ]);
    expect(await c.titles({ q: '薬屋 -外伝' })).toEqual([
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 1',
    ]);
  });

  it('matches /regex/ on titles, authors and series, and as field values', async () => {
    const c = await catalogEnv(SAMPLE);
    expect(await c.titles({ q: '/ごと [0-9]$/' })).toEqual([
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 1',
    ]);
    expect(await c.titles({ q: '/^the/' })).toEqual([]);
    expect(await c.titles({ q: '/^the/i' })).toEqual(['The Long Way']);
    expect(await c.titles({ q: 'author:/^著者/' })).toEqual(['共著の本']);
    expect(await c.titles({ q: 'series:/外伝$/,/^Re/' })).toEqual([
      'Re:ゼロから始める異世界生活 1',
    ]);
    expect(await c.titles({ q: '-/薬屋|著/' })).toHaveLength(3);
  });

  it('filters by character count and never includes books without a count', async () => {
    const c = await catalogEnv(SAMPLE);
    c.setCount('薬屋のひとりごと 1', 120_000);
    c.setCount('薬屋のひとりごと 2', 160_000);
    c.setCount('共著の本', 50_000);
    c.setCount('The Long Way', null); // failed
    expect(await c.titles({ q: 'chars:<150k' })).toEqual(['共著の本', '薬屋のひとりごと 1']);
    expect(await c.titles({ q: 'chars:50000-120000' })).toEqual(['共著の本', '薬屋のひとりごと 1']);
    expect(await c.titles({ q: 'chars:>=160,000' })).toEqual(['薬屋のひとりごと 2']);
    expect(await c.titles({ q: '-chars:<100k' })).toEqual([
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 1',
    ]);
  });

  it("filters by the user's own status and favorites; no record = unread", async () => {
    const c = await catalogEnv(SAMPLE);
    c.status('薬屋のひとりごと 1', 'completed');
    c.status('薬屋のひとりごと 2', 'reading');
    c.status('共著の本', 'unread');
    c.favorite('The Long Way', true);
    c.favorite('100% Pure', false);
    expect(await c.titles({ q: 'status:reading' })).toEqual(['薬屋のひとりごと 2']);
    expect(await c.titles({ q: 'status:reading,completed' })).toEqual([
      '薬屋のひとりごと 2',
      '薬屋のひとりごと 1',
    ]);
    expect(await c.titles({ q: 'status:unread' })).toHaveLength(5);
    expect(await c.titles({ q: 'status:unread,reading,completed,dropped' })).toHaveLength(7);
    expect(await c.titles({ q: '-status:completed 薬屋' })).toEqual([
      '薬屋のひとりごと 外伝',
      '薬屋のひとりごと 2',
    ]);
    expect(await c.titles({ q: 'favorite:yes' })).toEqual(['The Long Way']);
    expect(await c.titles({ q: 'favorite:no' })).toHaveLength(6);
  });

  it("never sees another user's book state", async () => {
    const c = await catalogEnv(SAMPLE);
    const other = randomUUID();
    c.e.db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, 0)').run(other, 'other');
    c.status('共著の本', 'dropped', other);
    expect(await c.titles({ q: 'status:dropped' })).toEqual([]);
    const otherAuth = { Authorization: `Bearer ${createToken(c.e.db, other, 'o').token}` };
    const res = await request(c.e.app)
      .get('/api/v1/books')
      .query({ q: 'status:dropped' })
      .set(otherAuth);
    expect(res.body.books.map((b: { title: string }) => b.title)).toEqual(['共著の本']);
  });

  it('pages through filtered results with the keyset cursor', async () => {
    const books = Array.from({ length: 7 }, (_, i) => ({
      title: `本 ${i}`,
      tags: [i % 2 ? 'odd' : 'even'],
    }));
    const c = await catalogEnv(books);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await c.get('/books', {
        q: 'tag:=even',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...res.body.books.map((b: { title: string }) => b.title));
      cursor = res.body.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['本 6', '本 4', '本 2', '本 0']);
  });

  it('answers invalid_query with the span and keeps unknown fields as text', async () => {
    const c = await catalogEnv(SAMPLE);
    const res = await c.get('/books', { q: 'ok status:foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'invalid_query', start: 3, end: 13 });
    expect(res.body.error.message).toMatch(/isn't a status/);
    expect((await c.get('/books', { q: '/(/' })).body.error.code).toBe('invalid_query');
    expect((await c.get('/books', { q: 'x'.repeat(501) })).body.error.code).toBe('invalid_query');
    expect(await c.titles({ q: 'title:x' })).toEqual([]);
  });

  it('keeps the books_added walk for text and count filters (60k-book speed)', async () => {
    // Filters that name a set (author:, tag:, status:) may let SQLite start from that set
    // instead; the benchmark (scripts/bench-index.ts) measures both shapes.
    const c = await catalogEnv(SAMPLE);
    const plan = planBooks(c.e.db, c.user, {
      query: '薬屋 /x/ chars:<100k -series:x -status:reading',
      cursor: Buffer.from(JSON.stringify([1, 'x'])).toString('base64url'),
    });
    const detail = (
      c.e.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as { detail: string }[]
    ).map((r) => r.detail);
    expect(detail[0]).toBe('SCAN b USING INDEX books_added');
    expect(detail.join('\n')).not.toContain('TEMP B-TREE FOR ORDER BY');
  });
});

describe('group books (GET /api/v1/books?by=&group=)', () => {
  it('lists a series in series order and pages it', async () => {
    const c = await catalogEnv(SAMPLE);
    expect(await c.titles({ by: 'series', group: '薬屋のひとりごと' })).toEqual([
      '薬屋のひとりごと 1',
      '薬屋のひとりごと 外伝',
      '薬屋のひとりごと 2',
    ]);
    const first = await c.get('/books', { by: 'series', group: '薬屋のひとりごと', limit: 2 });
    const second = await c.get('/books', {
      by: 'series',
      group: '薬屋のひとりごと',
      limit: 2,
      cursor: first.body.nextCursor,
    });
    expect(second.body.books.map((b: { title: string }) => b.title)).toEqual([
      '薬屋のひとりごと 2',
    ]);
    const plan = planBooks(c.e.db, c.user, { group: { by: 'series', name: 'x' } });
    const detail = (
      c.e.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
    expect(detail[0]).toMatch(/^SEARCH b USING INDEX books_series \(series_id=\?\)/);
  });

  it('lists "No series", an author and a tag newest first, with the search applied', async () => {
    const c = await catalogEnv(SAMPLE);
    expect(await c.titles({ by: 'series', none: 1 })).toEqual([
      '100% Pure',
      'The Long Way',
      '共著の本',
    ]);
    expect(await c.titles({ by: 'author', group: '著者一' })).toEqual(['共著の本']);
    expect(await c.titles({ by: 'tag', group: 'ライトノベル', q: '-薬屋' })).toEqual([
      'Re:ゼロから始める異世界生活 1',
    ]);
    expect(await c.titles({ by: 'author', group: 'nobody' })).toEqual([]);
    expect((await c.get('/books', { by: 'genre', group: 'x' })).body.error.code).toBe(
      'invalid_group',
    );
    expect((await c.get('/books', { by: 'tag' })).body.error.code).toBe('invalid_group');
  });
});

interface Card {
  name: string | null;
  bookCount: number;
  chars: { total: number; counted: number; pending: number; failed: number };
  cover?: { bookId: string; thumbnail: string | null; tags: string[] } | null;
  bookIds?: string[];
  tiles?: { bookId: string; thumbnail: string | null; tags: string[] }[];
}

async function groups(
  c: Awaited<ReturnType<typeof catalogEnv>>,
  query: Record<string, string | number>,
) {
  const res = await c.get('/groups', query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { groups: Card[]; nextCursor: string | null };
}

describe('browse groups (GET /api/v1/groups)', () => {
  it('lists series newest first with "No series" last, totals and pending counts', async () => {
    const c = await catalogEnv(SAMPLE);
    c.setCount('薬屋のひとりごと 1', 100_000);
    c.setCount('薬屋のひとりごと 2', 50_000);
    c.setCount('共著の本', null);
    const { groups: cards } = await groups(c, { by: 'series' });
    expect(cards.map((g) => g.name)).toEqual(['Re:ゼロ', '薬屋のひとりごと', null]);
    const kusuriya = cards[1];
    expect(kusuriya.bookCount).toBe(3);
    expect(kusuriya.chars).toEqual({ total: 150_000, counted: 2, pending: 1, failed: 0 });
    expect(kusuriya.bookIds).toEqual([
      c.id('薬屋のひとりごと 1'),
      c.id('薬屋のひとりごと 外伝'),
      c.id('薬屋のひとりごと 2'),
    ]);
    expect(kusuriya.cover?.bookId).toBe(c.id('薬屋のひとりごと 1'));
    expect(kusuriya.cover?.tags).toEqual(['ミステリー', 'ライトノベル']);
    const none = cards[2];
    expect(none.bookCount).toBe(3);
    expect(none.chars).toEqual({ total: 0, counted: 0, pending: 2, failed: 1 });
    expect(none.tiles?.map((t) => t.bookId)).toEqual([
      c.id('100% Pure'),
      c.id('The Long Way'),
      c.id('共著の本'),
    ]);
  });

  it('lists groups with a matching book, with whole-group numbers', async () => {
    const c = await catalogEnv(SAMPLE);
    c.status('薬屋のひとりごと 2', 'reading');
    const reading = await groups(c, { by: 'series', q: 'status:reading' });
    expect(reading.groups.map((g) => [g.name, g.bookCount])).toEqual([['薬屋のひとりごと', 3]]);
    const noSeries = await groups(c, { by: 'series', q: 'pure' });
    expect(noSeries.groups.map((g) => g.name)).toEqual([null]);
    // Terms on the grouping field also filter the group names.
    const authors = await groups(c, { by: 'author', q: 'author:著者一' });
    expect(authors.groups.map((g) => g.name)).toEqual(['著者一']);
    const tags = await groups(c, { by: 'tag', q: '-tag:ライトノベル' });
    // ミステリー's only book also has ライトノベル.
    expect(tags.groups.map((g) => g.name).sort()).toEqual(['SF Fantasy', 'アンソロジー'].sort());
    const regex = await groups(c, { by: 'tag', q: 'tag:/^S/' });
    expect(regex.groups.map((g) => g.name).sort()).toEqual(['SF', 'SF Fantasy']);
  });

  it('pages groups with a cursor, "No series" on the last page', async () => {
    const books = Array.from({ length: 5 }, (_, i) => ({
      title: `巻 ${i}`,
      series: { name: `S${i}`, index: 1 },
    }));
    const c = await catalogEnv([...books, { title: 'loose' }]);
    const names: (string | null)[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await groups(c, { by: 'series', limit: 2, ...(cursor ? { cursor } : {}) });
      names.push(...page.groups.map((g) => g.name));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(names).toEqual(['S4', 'S3', 'S2', 'S1', 'S0', null]);
  });

  it('picks collage tiles: opened books, one first volume per series, then the newest', async () => {
    const tag = ['T'];
    const c = await catalogEnv([
      { title: 'A1', series: { name: 'A', index: 1 }, tags: tag },
      { title: 'A2', series: { name: 'A', index: 2 }, tags: tag },
      { title: 'B2', series: { name: 'B', index: 2 }, tags: tag },
      { title: 'B1', series: { name: 'B', index: 1 } }, // not tagged: B's first tagged volume is B2
      { title: 'loose 1', tags: tag },
      { title: 'C1', series: { name: 'C', index: 1 }, tags: tag },
      { title: 'loose 2', tags: tag },
      { title: 'A3', series: { name: 'A', index: 3 }, tags: tag },
    ]);
    c.opened('A2');
    const { groups: cards } = await groups(c, { by: 'tag' });
    const t = cards.find((g) => g.name === 'T')!;
    // A2 opened; then the first volume of each series newest first: C1, (A already
    // shown), B2 (B1 doesn't have the tag); then the newest book, A3.
    expect(t.tiles?.map((x) => x.bookId)).toEqual([c.id('A2'), c.id('C1'), c.id('B2'), c.id('A3')]);
    expect(t.bookCount).toBe(7);
  });

  it('refreshes cached group numbers when counts or the catalog change, not on sync writes', async () => {
    const c = await catalogEnv(SAMPLE);
    const series = async () =>
      (await groups(c, { by: 'series' })).groups.find((g) => g.name === '薬屋のひとりごと')!;
    expect((await series()).chars.pending).toBe(3);
    // A count written by the server (the counter's write path) is seen at once.
    noteCatalogWrite(c.e.db);
    c.setCount('薬屋のひとりごと 1', 1000);
    noteCatalogWrite(c.e.db);
    expect((await series()).chars).toMatchObject({ total: 1000, counted: 1, pending: 2 });
    // A write from another connection (the CLI) is seen too.
    const other = new Database(c.e.db.name);
    other.prepare('DELETE FROM char_counts').run();
    other.close();
    expect((await series()).chars).toMatchObject({ counted: 0, pending: 3 });
    // Sync writes (reading on another device) keep the cache.
    const version = catalogVersion(c.e.db);
    c.opened('共著の本');
    expect(catalogVersion(c.e.db)).toBe(version);
  });

  it('refreshes collages when you open a book', async () => {
    const c = await catalogEnv(SAMPLE);
    const none = async () =>
      (await groups(c, { by: 'series' })).groups.find((g) => g.name === null)!;
    expect((await none()).tiles?.[0].bookId).toBe(c.id('100% Pure'));
    c.opened('共著の本');
    expect((await none()).tiles?.[0].bookId).toBe(c.id('共著の本'));
  });

  it('picks a plan by the size of an author or tag filter', async () => {
    const c = await catalogEnv(SAMPLE);
    const plan = (query: string) => planBooks(c.e.db, c.user, { query }).sql;
    expect(plan('author:日向')).toContain('b.id IN (SELECT ba.book_id');
    expect(plan('author:日向')).not.toContain('+b.id IN (SELECT ba.book_id');
    expect(plan('author:/日向/')).toContain('+b.id IN (SELECT ba.book_id');
    expect(SMALL_SET).toBeGreaterThan(100);
  });

  it('rejects an unknown grouping', async () => {
    const c = await catalogEnv(SAMPLE);
    expect((await c.get('/groups', { by: 'genre' })).body.error.code).toBe('invalid_group');
  });
});

describe('regex worker', () => {
  it('stops a pattern that runs too long while the server keeps answering', async () => {
    const titleBomb = `${'a'.repeat(40)}!`;
    const c = await catalogEnv([{ title: titleBomb }, { title: 'other' }], 1);
    const started = Date.now();
    const slow = c.get('/books', { q: '/^(a+)+$/' });
    // A plain request is answered while the pattern runs in the worker.
    const fast = await c.get('/books', { q: 'other' });
    expect(fast.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(900);
    const res = await slow;
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('regex_timeout');
    // The next pattern search gets a new worker.
    expect(await c.titles({ q: '/^oth/' })).toEqual(['other']);
  });

  it('runs in-process without a database file and reports timeouts as RegexTimeoutError', async () => {
    const db = new Database(':memory:');
    const runner = new SearchRunner({ db, file: null, timeoutSeconds: 1 });
    expect(await runner.all("SELECT ttu_regexp('^a', '', 'abc') AS m", [])).toEqual([{ m: 1 }]);
    await runner.close();
    db.close();
    expect(new RegexTimeoutError('x')).toBeInstanceOf(Error);
  });
});

describe('tag-blur kind', () => {
  it('stores, rejects and deletes per-tag blur rules', async () => {
    const t = makeTestApp();
    const auth = { Authorization: `Bearer ${t.newUserToken('d')}` };
    const reg = await request(t.app)
      .post('/api/v1/devices/register')
      .set(auth)
      .send({ deviceId: randomUUID() });
    expect(reg.status).toBe(200);
    const push = async (changes: unknown[]) =>
      (await request(t.app).post('/api/v1/sync').set(auth).send({ changes })).body.results as {
        status: string;
        reason?: string;
      }[];
    const now = Date.now();
    const results = await push([
      { kind: 'tag-blur', id: 'BL', updatedAt: now, data: { blur: true } },
      { kind: 'tag-blur', id: ' padded', updatedAt: now, data: { blur: true } },
      { kind: 'tag-blur', id: 'x', updatedAt: now, data: { blur: false } },
    ]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'rejected', 'rejected']);
    const del = await push([
      { kind: 'tag-blur', id: 'BL', updatedAt: now + 1, deletedAt: now + 1 },
    ]);
    expect(del[0].status).toBe('applied');
  });
});
