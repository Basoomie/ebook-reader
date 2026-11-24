/**
 * Series, authors and tags in a collection (2026-11-24): GET /groups?scope=|collection=
 * lists the groups of a collection's books, and every number, series list and collage
 * counts only those books.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SQL_COUNT_SOURCE_KEY } from '../src/counts/count-records';
import { listUsers } from '../src/db/users';
import { calibreDate, CalibreRoot, FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);

// Added in this order, one minute apart (L is the newest).
const BOOKS: FixtureBook[] = [
  { title: 'A1', series: { name: 'Alpha', index: 1 }, authors: ['Amy'], tags: ['x'] },
  { title: 'A2', series: { name: 'Alpha', index: 2 }, authors: ['Amy'], tags: ['x', 'y'] },
  { title: 'A3', series: { name: 'Alpha', index: 3 }, authors: ['Bob'] },
  { title: 'B1', series: { name: 'Beta', index: 1 }, authors: ['Bob'], tags: ['y'] },
  { title: 'L', authors: ['Amy'], tags: ['x'] },
];

interface Card {
  name: string | null;
  bookCount: number;
  chars: { total: number; counted: number; pending: number; failed: number };
  bookIds?: string[];
  cover?: { bookId: string } | null;
  tiles?: { bookId: string }[];
}

async function env() {
  const root = new CalibreRoot();
  const lib = root.library('a');
  for (const [i, b] of BOOKS.entries()) {
    await lib.addBook({ timestamp: calibreDate(new Date(BASE + i * 60_000)), ...b });
  }
  const e = makeIndexerEnv(root.dir);
  envs.push(e);
  await e.indexer.start({ timer: false });
  enableLibrary(e.db, 'a');
  await e.indexer.tick();
  const user = listUsers(e.db)[0];
  const auth = { Authorization: `Bearer ${e.token()}` };
  const ids = new Map(
    (e.db.prepare('SELECT id, title FROM books').all() as { id: string; title: string }[]).map(
      (r) => [r.title, r.id],
    ),
  );
  const id = (title: string) => ids.get(title)!;
  const title = (bookId: string) => [...ids].find(([, v]) => v === bookId)?.[0];
  let rev = 1;
  const record = (kind: string, recordId: string, bookId: string | null, data: object) =>
    e.db
      .prepare(
        `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)`,
      )
      .run(user.id, kind, recordId, bookId, BASE + rev, rev++, JSON.stringify(data), BASE);
  const setCount = (t: string, characters: number) => {
    e.db
      .prepare(
        `INSERT OR REPLACE INTO char_counts (book_id, status, source_key, spec, characters, counted_at)
         SELECT b.id, 'ok', ${SQL_COUNT_SOURCE_KEY}, ?, ?, 0
           FROM books b JOIN book_sources s ON s.book_id = b.id WHERE b.id = ?`,
      )
      .run(e.counts.spec, characters, id(t));
    e.db.prepare('UPDATE books SET char_count = ? WHERE id = ?').run(characters, id(t));
  };
  const groups = async (query: Record<string, string | number>) => {
    const res = await request(e.app).get('/api/v1/groups').query(query).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { groups: Card[]; total: number; nextCursor: string | null };
  };
  /** name → book count. */
  const counts = async (query: Record<string, string | number>) =>
    Object.fromEntries((await groups(query)).groups.map((g) => [g.name ?? '(none)', g.bookCount]));
  const list = randomUUID();
  const addToList = (t: string) => record('collection-item', `${list}:${id(t)}`, id(t), { key: t });
  return { e, id, title, record, setCount, groups, counts, list, addToList };
}

describe('groups of a manual collection (GET /groups?collection=)', () => {
  it('counts, totals and lists only the collection’s books', async () => {
    const c = await env();
    c.addToList('A1');
    c.addToList('A3');
    c.addToList('L');
    c.setCount('A1', 100);
    c.setCount('A2', 1000);
    c.setCount('A3', 50);

    const series = await c.groups({ by: 'series', collection: c.list });
    expect(series.groups.map((g) => [g.name, g.bookCount])).toEqual([
      ['Alpha', 2],
      [null, 1],
    ]);
    expect(series.total).toBe(2);
    const alpha = series.groups[0];
    expect(alpha.bookIds!.map(c.title)).toEqual(['A1', 'A3']);
    expect(c.title(alpha.cover!.bookId)).toBe('A1');
    expect(alpha.chars).toEqual({ total: 150, counted: 2, pending: 0, failed: 0 });

    expect(await c.counts({ by: 'author', collection: c.list })).toEqual({ Amy: 2, Bob: 1 });
    const tags = await c.groups({ by: 'tag', collection: c.list });
    expect(tags.groups.map((g) => [g.name, g.bookCount])).toEqual([['x', 2]]);
    expect(tags.groups[0].tiles!.map((t) => c.title(t.bookId)).sort()).toEqual(['A1', 'L']);

    // The whole library is unchanged.
    expect(await c.counts({ by: 'series' })).toEqual({ Alpha: 3, Beta: 1, '(none)': 1 });
    expect(await c.counts({ by: 'tag' })).toEqual({ x: 3, y: 2 });
  });

  it('sees a book added to the collection at once (not a cached answer)', async () => {
    const c = await env();
    c.addToList('A1');
    expect(await c.counts({ by: 'series', collection: c.list })).toEqual({ Alpha: 1 });
    expect(await c.counts({ by: 'series', collection: c.list })).toEqual({ Alpha: 1 });
    c.addToList('B1');
    expect(await c.counts({ by: 'series', collection: c.list })).toEqual({ Alpha: 1, Beta: 1 });
  });

  it('an empty or unknown collection has no groups; a bad id is refused', async () => {
    const c = await env();
    expect((await c.groups({ by: 'series', collection: randomUUID() })).total).toBe(0);
    const res = await request(c.e.app)
      .get('/api/v1/groups')
      .query({ by: 'series', collection: 'nope' })
      .set({ Authorization: `Bearer ${c.e.token()}` });
    expect(res.status).toBe(400);
  });
});

describe('groups of a smart collection (GET /groups?scope=)', () => {
  it('counts only the books its search matches', async () => {
    const c = await env();
    expect(await c.counts({ by: 'series', scope: 'author:Amy' })).toEqual({
      Alpha: 2,
      '(none)': 1,
    });
    expect(await c.counts({ by: 'tag', scope: 'author:Amy' })).toEqual({ x: 3, y: 1 });
  });

  it('the typed search picks groups inside the collection, the numbers stay the collection’s', async () => {
    const c = await env();
    // Alpha has a book with y among Amy's (A2); the card still counts both of Amy's.
    expect(await c.counts({ by: 'series', scope: 'author:Amy', q: 'tag:y' })).toEqual({
      Alpha: 2,
    });
    // In Tags, tag:y lists the tag y only (not every tag of the matching books).
    expect(await c.counts({ by: 'tag', scope: 'author:Amy', q: 'tag:y' })).toEqual({ y: 1 });
  });

  it('follows your reading status (a saved search on status)', async () => {
    const c = await env();
    c.record('book-status', c.id('B1'), c.id('B1'), { status: 'reading', auto: false });
    expect(await c.counts({ by: 'series', scope: 'status:reading' })).toEqual({ Beta: 1 });
    c.record('book-status', c.id('A2'), c.id('A2'), { status: 'reading', auto: false });
    expect(await c.counts({ by: 'series', scope: 'status:reading' })).toEqual({
      Beta: 1,
      Alpha: 1,
    });
  });

  it('runs a pattern in the collection’s search', async () => {
    const c = await env();
    expect(await c.counts({ by: 'author', scope: '/^Bo/' })).toEqual({ Bob: 2 });
  });

  it('an empty search is the whole library (whole-group numbers)', async () => {
    const c = await env();
    expect(await c.counts({ by: 'series', scope: '' })).toEqual({
      Alpha: 3,
      Beta: 1,
      '(none)': 1,
    });
  });

  it('pages and sorts the collection’s groups', async () => {
    const c = await env();
    const first = await c.groups({
      by: 'author',
      scope: 'tag:x,y',
      limit: 1,
      sort: 'name',
      dir: 'asc',
    });
    expect(first.groups.map((g) => g.name)).toEqual(['Amy']);
    expect(first.total).toBe(2);
    const next = await c.groups({
      by: 'author',
      scope: 'tag:x,y',
      limit: 1,
      sort: 'name',
      dir: 'asc',
      cursor: first.nextCursor!,
    });
    expect(next.groups.map((g) => [g.name, g.bookCount])).toEqual([['Bob', 1]]);
    expect(next.nextCursor).toBeNull();
  });
});
