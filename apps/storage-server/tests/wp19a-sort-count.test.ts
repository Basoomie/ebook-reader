/**
 * WP19a: library sorts (books and groups), list counts and the manual-collection list.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { planBooks } from '../src/catalog/queries';
import { BOOK_SORT_KEYS, type BookSort, SORT_DIRS } from '../src/catalog/sort';
import { SQL_COUNT_SOURCE_KEY } from '../src/counts/count-records';
import { listUsers } from '../src/db/users';
import { calibreDate, CalibreRoot, FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);

/** Books are added one minute apart in list order (the last one is the newest). */
async function catalogEnv(books: FixtureBook[]) {
  const root = new CalibreRoot();
  const lib = root.library('a');
  for (const [i, b] of books.entries()) {
    await lib.addBook({ timestamp: calibreDate(new Date(BASE + i * 60_000)), ...b });
  }
  const e = makeIndexerEnv(root.dir);
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
  const record = (kind: string, recordId: string, bookId: string | null, data: object) =>
    e.db
      .prepare(
        `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)`,
      )
      .run(user.id, kind, recordId, bookId, BASE + rev, rev++, JSON.stringify(data), BASE);
  const setCount = (title: string, characters: number) => {
    e.db
      .prepare(
        `INSERT OR REPLACE INTO char_counts (book_id, status, source_key, spec, characters, counted_at)
         SELECT b.id, 'ok', ${SQL_COUNT_SOURCE_KEY}, ?, ?, 0
           FROM books b JOIN book_sources s ON s.book_id = b.id WHERE b.id = ?`,
      )
      .run(e.counts.spec, characters, id(title));
    e.db.prepare('UPDATE books SET char_count = ? WHERE id = ?').run(characters, id(title));
  };
  const get = (path: string, query: Record<string, string | number> = {}) =>
    request(e.app).get(`/api/v1${path}`).query(query).set(auth);
  /** Every title of a list, following the cursor page by page. */
  const allTitles = async (query: Record<string, string | number>, limit = 2) => {
    const out: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await get('/books', { ...query, limit, ...(cursor ? { cursor } : {}) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      out.push(...(res.body.books as { title: string }[]).map((b) => b.title));
      cursor = res.body.nextCursor;
      if (!cursor) return out;
    }
    throw new Error('too many pages');
  };
  const count = async (query: Record<string, string | number> = {}) => {
    const res = await get('/books/count', query);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.count as number;
  };
  return { e, libId, user, id, record, setCount, get, allTitles, count };
}

// Added in this order (A oldest, E newest).
const BOOKS: FixtureBook[] = [
  { title: 'Cherry', sort: 'Cherry', authors: ['Zed'], pubdate: '2001-05-01 00:00:00+00:00' },
  { title: 'apple', sort: 'apple', authors: ['Amy'], pubdate: '1999-01-01 00:00:00+00:00' },
  { title: 'Banana', sort: 'Banana', authors: ['Mia'] },
  { title: 'Date', sort: 'Date', authors: ['Bob'], pubdate: '2010-01-01 00:00:00+00:00' },
  { title: 'Elder', sort: 'Elder', authors: ['Kim'], pubdate: '1960-06-01 00:00:00+00:00' },
];

async function sortedEnv() {
  const c = await catalogEnv(BOOKS);
  c.setCount('Cherry', 300);
  c.setCount('apple', 100);
  c.setCount('Date', 200);
  c.setCount('Elder', 200);
  // An upload-like book without an author sort.
  c.e.db.prepare('UPDATE books SET author_sort = NULL WHERE id = ?').run(c.id('Banana'));
  return c;
}

describe('book sorts (GET /books?sort=&dir=)', () => {
  it('sorts by each key in both directions, across pages, books without a value last', async () => {
    const c = await sortedEnv();
    const t = (sort: string, dir: string) => c.allTitles({ sort, dir });
    expect(await t('added', 'desc')).toEqual(['Elder', 'Date', 'Banana', 'apple', 'Cherry']);
    expect(await t('added', 'asc')).toEqual(['Cherry', 'apple', 'Banana', 'Date', 'Elder']);
    // Calibre's title sort, binary order (upper case before lower case).
    expect(await t('title', 'asc')).toEqual(['Banana', 'Cherry', 'Date', 'Elder', 'apple']);
    expect(await t('title', 'desc')).toEqual(['apple', 'Elder', 'Date', 'Cherry', 'Banana']);
    expect(await t('author', 'asc')).toEqual(['apple', 'Date', 'Elder', 'Cherry', 'Banana']);
    expect(await t('author', 'desc')).toEqual(['Cherry', 'Elder', 'Date', 'apple', 'Banana']);
    // Equal counts (Date, Elder) break by id, in the sort's direction.
    const pair = c.id('Date') < c.id('Elder') ? ['Date', 'Elder'] : ['Elder', 'Date'];
    expect(await t('chars', 'asc')).toEqual(['apple', ...pair, 'Cherry', 'Banana']);
    expect(await t('chars', 'desc')).toEqual(['Cherry', ...[...pair].reverse(), 'apple', 'Banana']);
    expect(await t('published', 'asc')).toEqual(['Elder', 'apple', 'Cherry', 'Date', 'Banana']);
    expect(await t('published', 'desc')).toEqual(['Date', 'Cherry', 'apple', 'Elder', 'Banana']);
  });

  it('defaults the direction per key and keeps the old cursor for newest first', async () => {
    const c = await sortedEnv();
    expect(await c.allTitles({ sort: 'title' })).toEqual(
      await c.allTitles({ sort: 'title', dir: 'asc' }),
    );
    expect(await c.allTitles({ sort: 'chars' })).toEqual(
      await c.allTitles({ sort: 'chars', dir: 'desc' }),
    );
    const first = await c.get('/books', { limit: 2 });
    const explicit = await c.get('/books', { limit: 2, sort: 'added', dir: 'desc' });
    expect(explicit.body.nextCursor).toBe(first.body.nextCursor);
    const [addedAt, id] = JSON.parse(Buffer.from(first.body.nextCursor, 'base64url').toString());
    expect(typeof addedAt).toBe('number');
    expect(typeof id).toBe('string');
  });

  it('rejects unknown sorts and a cursor from another sort', async () => {
    const c = await sortedEnv();
    const unknown = await c.get('/books', { sort: 'rating' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('invalid_sort');
    expect((await c.get('/books', { sort: 'title', dir: 'up' })).body.error.code).toBe(
      'invalid_sort',
    );
    const page = await c.get('/books', { sort: 'title', limit: 2 });
    const other = await c.get('/books', { sort: 'author', cursor: page.body.nextCursor });
    expect(other.body.error.code).toBe('invalid_cursor');
    const dateCursor = (await c.get('/books', { limit: 2 })).body.nextCursor;
    expect((await c.get('/books', { sort: 'title', cursor: dateCursor })).status).toBe(400);
  });

  it('keeps series order inside a series unless a sort is given', async () => {
    const c = await catalogEnv([
      { title: 'S 2', series: { name: 'S', index: 2 } },
      { title: 'S 1', series: { name: 'S', index: 1 } },
      { title: 'S 3', series: { name: 'S', index: 3 } },
    ]);
    const group = { by: 'series', group: 'S' };
    expect(await c.allTitles(group)).toEqual(['S 1', 'S 2', 'S 3']);
    expect(await c.allTitles({ ...group, sort: 'added', dir: 'desc' })).toEqual([
      'S 3',
      'S 1',
      'S 2',
    ]);
    expect(await c.allTitles({ ...group, sort: 'title', dir: 'desc' })).toEqual([
      'S 3',
      'S 2',
      'S 1',
    ]);
  });

  it('walks a sort index for every sort and direction (no sort of all books)', async () => {
    const c = await sortedEnv();
    const expected: Record<string, Record<string, string>> = {
      added: { asc: 'books_added', desc: 'books_added' },
      title: { asc: 'books_sort_title', desc: 'books_sort_title' },
      author: { asc: 'books_sort_author_asc', desc: 'books_sort_author_desc' },
      chars: { asc: 'books_sort_chars_asc', desc: 'books_sort_chars_desc' },
      published: { asc: 'books_sort_published_asc', desc: 'books_sort_published_desc' },
    };
    for (const key of BOOK_SORT_KEYS) {
      for (const dir of SORT_DIRS) {
        const sort: BookSort = { key, dir };
        const first = planBooks(c.e.db, c.user, { sort, limit: 2, query: 'a chars:<1000' });
        const page = first.finish(c.e.db.prepare(first.sql).all(...first.params));
        for (const plan of [
          first,
          planBooks(c.e.db, c.user, { sort, limit: 2, cursor: page.nextCursor ?? undefined }),
        ]) {
          const detail = (
            c.e.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as {
              detail: string;
            }[]
          ).map((r) => r.detail);
          expect(detail[0], `${key} ${dir}`).toBe(`SCAN b USING INDEX ${expected[key][dir]}`);
          expect(detail.join('\n'), `${key} ${dir}`).not.toContain('TEMP B-TREE FOR ORDER BY');
        }
      }
    }
  });
});

describe('list counts (GET /books/count)', () => {
  it('counts the same books as the list, with every filter', async () => {
    const c = await sortedEnv();
    expect(await c.count()).toBe(5);
    expect(await c.count({ q: 'chars:>150' })).toBe(3);
    // A bare pattern matches the title, an author or the series: Cherry, Banana, Amy, Bob.
    expect(await c.count({ q: '/^[A-C]/' })).toBe(4);
    expect(await c.count({ scope: 'author:Amy,Zed' })).toBe(2);
    expect(await c.count({ by: 'author', group: 'Mia' })).toBe(1);
    expect(await c.count({ by: 'series', none: 1 })).toBe(5);
    expect(await c.count({ library: c.libId })).toBe(5);
    expect(await c.count({ library: 'no-such-library' })).toBe(0);
  });

  it('answers status and favorite counts fresh after a sync write, from cache otherwise', async () => {
    const c = await sortedEnv();
    expect(await c.count({ q: 'status:reading' })).toBe(0);
    c.record('book-status', c.id('Date'), c.id('Date'), { status: 'reading', auto: false });
    expect(await c.count({ q: 'status:reading' })).toBe(1);
    // A cached answer stays valid while nothing changes (the catalog and records are the same).
    c.e.db.prepare('UPDATE books SET title = title').run();
    expect(await c.count({ q: 'status:reading' })).toBe(1);
  });

  it('rejects a bad search with invalid_query', async () => {
    const c = await sortedEnv();
    const res = await c.get('/books/count', { q: '/usr/bin' });
    expect(res.status).toBe(400);
  });
});

describe('manual collection lists (GET /books?collection=)', () => {
  it('lists, sorts and counts the live items of one of your collections', async () => {
    const c = await sortedEnv();
    const list = randomUUID();
    const add = (title: string) =>
      c.record('collection-item', `${list}:${c.id(title)}`, c.id(title), { key: 'a' });
    add('Cherry');
    add('Date');
    add('apple');
    c.e.db
      .prepare(
        "UPDATE sync_records SET deleted_at = 1 WHERE kind = 'collection-item' AND book_id = ?",
      )
      .run(c.id('apple'));
    expect(await c.allTitles({ collection: list, sort: 'title', dir: 'asc' })).toEqual([
      'Cherry',
      'Date',
    ]);
    expect(await c.count({ collection: list })).toBe(2);
    expect(await c.count({ collection: randomUUID() })).toBe(0);
    expect((await c.get('/books', { collection: 'not-an-id' })).status).toBe(400);
  });
});

describe('group sorts and totals (GET /groups?sort=&dir=)', () => {
  it('sorts by newest, name and book count, "No series" last, with totals across pages', async () => {
    const c = await catalogEnv([
      { title: 'B1', series: { name: 'Beta', index: 1 } },
      { title: 'A1', series: { name: 'Alpha', index: 1 } },
      { title: 'A2', series: { name: 'Alpha', index: 2 } },
      { title: 'Loose' },
      { title: 'C1', series: { name: 'Gamma', index: 1 } },
      { title: 'C2', series: { name: 'Gamma', index: 2 } },
      { title: 'C3', series: { name: 'Gamma', index: 3 } },
    ]);
    const names = async (query: Record<string, string | number>) => {
      const out: (string | null)[] = [];
      let cursor: string | null = null;
      let total = -1;
      for (let i = 0; i < 20; i++) {
        const res = await c.get('/groups', {
          by: 'series',
          limit: 1,
          ...query,
          ...(cursor ? { cursor } : {}),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        total = res.body.total;
        out.push(...(res.body.groups as { name: string | null }[]).map((g) => g.name));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(total).toBe(out.length);
      return out;
    };
    expect(await names({})).toEqual(['Gamma', 'Alpha', 'Beta', null]);
    expect(await names({ sort: 'newest', dir: 'asc' })).toEqual(['Beta', 'Alpha', 'Gamma', null]);
    expect(await names({ sort: 'name' })).toEqual(['Alpha', 'Beta', 'Gamma', null]);
    expect(await names({ sort: 'name', dir: 'desc' })).toEqual(['Gamma', 'Beta', 'Alpha', null]);
    expect(await names({ sort: 'count' })).toEqual(['Gamma', 'Alpha', 'Beta', null]);
    expect(await names({ sort: 'count', dir: 'asc' })).toEqual(['Beta', 'Alpha', 'Gamma', null]);
    expect((await c.get('/groups', { by: 'series', sort: 'size' })).status).toBe(400);
  });

  it('still accepts a group cursor made before WP19a', async () => {
    const c = await catalogEnv([
      { title: 'B1', series: { name: 'Beta', index: 1 } },
      { title: 'A1', series: { name: 'Alpha', index: 1 } },
    ]);
    const res = await c.get('/groups', { by: 'series', limit: 1 });
    const [newest, , name] = JSON.parse(Buffer.from(res.body.nextCursor, 'base64url').toString());
    const old = Buffer.from(JSON.stringify([newest, name])).toString('base64url');
    const next = await c.get('/groups', { by: 'series', limit: 1, cursor: old });
    expect(next.status).toBe(200);
    expect(next.body.groups[0].name).toBe('Beta');
  });
});
