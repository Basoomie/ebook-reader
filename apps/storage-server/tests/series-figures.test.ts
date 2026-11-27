/**
 * Series and author figures (docs/design/series-figures.md): the Series and Authors tabs sort by
 * Rating, Most rated, Most read (and the Series tab by "Went on to vol 2"), the cards carry the
 * figures, the Series tab's rating:/ratings:/readers: test volume 1, and kept: works on every tab.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { noteCatalogWrite } from '../src/catalog/catalog-version';
import { listUsers } from '../src/db/users';
import { calibreDate, CalibreRoot, FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2025, 0, 1);
const OLD = Date.UTC(2020, 0, 1);

const s = (name: string, index: number) => ({ series: { name, index } });

const BOOKS: FixtureBook[] = [
  { title: 'A1', ...s('Alpha', 1), authors: ['Amy'] },
  { title: 'A2', ...s('Alpha', 2), authors: ['Amy'] },
  { title: 'A3', ...s('Alpha', 3), authors: ['Amy'] },
  { title: 'B1', ...s('Beta', 1), authors: ['Bob'] },
  { title: 'B2', ...s('Beta', 2), authors: ['Bob'] },
  { title: 'G1', ...s('Gamma', 1), authors: ['Cat'] },
  { title: 'G2', ...s('Gamma', 2), authors: ['Cat'] },
  { title: 'D1', ...s('Delta', 1), authors: ['Cat'] },
  { title: 'D2', ...s('Delta', 2), authors: ['Cat'] },
  { title: 'D3', ...s('Delta', 3), authors: ['Cat'] },
  { title: 'E1', ...s('Eps', 1), authors: ['Cat'] },
  { title: 'E2', ...s('Eps', 2), authors: ['Cat'] },
  { title: 'Z1', ...s('Zeta', 1), authors: ['Cat'] },
  { title: 'Z2', ...s('Zeta', 2), authors: ['Cat'] },
  { title: 'H1', ...s('Eta', 1), authors: ['Cat'] },
  { title: 'H2', ...s('Eta', 2), authors: ['Cat'] },
  { title: 'L', authors: ['Amy'] },
];

/** title → [rating x10, count, score, readers, published]. */
const FIGURES: Record<
  string,
  [number | null, number | null, number | null, number | null, number | null]
> = {
  A1: [40, 100, 4000, 1000, OLD],
  A2: [46, 20, 4300, 600, OLD],
  A3: [null, null, null, 500, OLD],
  B1: [45, 10, 4233, 100, OLD],
  B2: [null, null, null, 90, OLD],
  // Gamma: too few readers on volume 1; volume 2 is rated higher than any volume 1 here.
  G1: [30, 500, 3100, 40, OLD],
  G2: [48, 300, 4700, 30, OLD],
  // Delta: volume 2 far under volume 3 (a listing almost nobody logs).
  D1: [null, null, null, 200, OLD],
  D2: [null, null, null, 20, OLD],
  D3: [null, null, null, 150, OLD],
  // Eps: volume 2 at 300 % (a wrong link).
  E1: [null, null, null, 100, OLD],
  E2: [null, null, null, 300, OLD],
  // Zeta: 110 % shows as 100 %.
  Z1: [null, null, null, 100, OLD],
  Z2: [null, null, null, 110, OLD],
  // Eta: volume 2 came out last month.
  H1: [null, null, null, 100, OLD],
  H2: [null, null, null, 80, Date.now() - 30 * 24 * 3600 * 1000],
  L: [48, 50, 4500, 300, OLD],
};

interface Card {
  name: string | null;
  figures?: {
    rating: { avg: number; count: number; score: number } | null;
    readers: number | null;
    kept: number | null;
  };
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
  for (const [t, [x10, count, score, readers, published]] of Object.entries(FIGURES)) {
    e.db
      .prepare(
        `UPDATE books SET rating_x10 = ?, rating_count = ?, rating_score = ?, readers = ?,
                          published_at = ? WHERE id = ?`,
      )
      .run(x10, count, score, readers, published, id(t));
  }
  noteCatalogWrite(e.db);
  let rev = 1;
  const record = (kind: string, recordId: string, bookId: string | null, data: object) =>
    e.db
      .prepare(
        `INSERT OR REPLACE INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)`,
      )
      .run(user.id, kind, recordId, bookId, BASE + rev, rev++, JSON.stringify(data), BASE);
  const groups = async (query: Record<string, string | number>) => {
    const res = await request(e.app).get('/api/v1/groups').query(query).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { groups: Card[]; total: number; nextCursor: string | null };
  };
  const names = async (query: Record<string, string | number>) =>
    (await groups(query)).groups.map((g) => g.name);
  const books = async (q: string) => {
    const res = await request(e.app).get('/api/v1/books').query({ q, limit: 100 }).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.books as { id: string }[]).map((b) => title(b.id)).sort();
  };
  return { e, id, record, groups, names, books };
}

describe('the Series tab', () => {
  it('sorts by Went on to vol 2, the series without one last by name, "No series" at the end', async () => {
    const c = await env();
    expect(await c.names({ by: 'series', sort: 'kept', dir: 'desc' })).toEqual([
      'Zeta', // 110 % shows as 100 %
      'Beta', // 90 %
      'Alpha', // 60 %
      'Delta',
      'Eps',
      'Eta',
      'Gamma',
      null,
    ]);
    expect(await c.names({ by: 'series', sort: 'kept', dir: 'asc' })).toEqual([
      'Alpha',
      'Beta',
      'Zeta',
      'Delta',
      'Eps',
      'Eta',
      'Gamma',
      null,
    ]);
  });

  it("sorts by volume 1's Rating, Most rated and Most read", async () => {
    const c = await env();
    // Scores of volume 1: Beta 4233, Alpha 4000, Gamma 3100 (Gamma's volume 2 rates higher).
    expect((await c.names({ by: 'series', sort: 'rating', dir: 'desc' })).slice(0, 3)).toEqual([
      'Beta',
      'Alpha',
      'Gamma',
    ]);
    expect((await c.names({ by: 'series', sort: 'ratings', dir: 'desc' })).slice(0, 3)).toEqual([
      'Gamma',
      'Alpha',
      'Beta',
    ]);
    expect((await c.names({ by: 'series', sort: 'readers', dir: 'desc' })).slice(0, 4)).toEqual([
      'Alpha',
      'Delta',
      'Beta', // 100, ties go by name
      'Eps',
    ]);
  });

  it('pages a figure sort with its cursor: the pages add up to the whole list', async () => {
    const c = await env();
    const whole = await c.names({ by: 'series', sort: 'kept', dir: 'desc' });
    const seen: (string | null)[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof c.groups>> = await c.groups({
        by: 'series',
        sort: 'kept',
        dir: 'desc',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.groups.map((g) => g.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(whole);
  });

  it("carries the series' figures on its card", async () => {
    const c = await env();
    const cards = (await c.groups({ by: 'series' })).groups;
    const alpha = cards.find((g) => g.name === 'Alpha')!;
    expect(alpha.figures).toEqual({
      rating: { avg: 4, count: 100, score: 4000 },
      readers: 1000,
      kept: 60,
    });
    expect(cards.find((g) => g.name === 'Delta')!.figures).toEqual({
      rating: null,
      readers: 200,
      kept: null,
    });
    expect(cards.find((g) => g.name === null)!.figures).toBeUndefined();
  });

  it('tests volume 1 with rating:, ratings: and readers:, not any volume', async () => {
    const c = await env();
    // Gamma's volume 2 has 4.8 stars, but its volume 1 has 3.0.
    expect(await c.names({ by: 'series', q: 'rating:>=4', sort: 'name' })).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(await c.names({ by: 'series', q: 'ratings:>=200' })).toEqual(['Gamma']);
    expect(await c.names({ by: 'series', q: 'readers:>=150 -readers:>=1000' })).toEqual(['Delta']);
    expect(await c.names({ by: 'series', q: 'kept:>=90', sort: 'name' })).toEqual(['Beta', 'Zeta']);
    // A series without the figure never matches, negated or not.
    expect(await c.names({ by: 'series', q: '-kept:>=90' })).toEqual(['Alpha']);
  });
});

describe('kept: on the Books tab', () => {
  it("gives every book its series' figure", async () => {
    const c = await env();
    expect(await c.books('kept:>=90')).toEqual(['B1', 'B2', 'Z1', 'Z2']);
    expect(await c.books('-kept:>=90')).toEqual(['A1', 'A2', 'A3']);
    expect(await c.books('kept:50-70 rating:>=4.5')).toEqual(['A2']);
  });

  it('follows your thresholds (synced global settings)', async () => {
    const c = await env();
    expect(await c.books('kept:>=0')).toHaveLength(7);
    c.record('setting', 'global:seriesKeptMinReaders', null, { value: '500' });
    // Only Alpha's volume 1 has 500 readers or more.
    expect(await c.books('kept:>=0')).toEqual(['A1', 'A2', 'A3']);
    c.record('setting', 'global:seriesKeptMinMonths', null, { value: '0' });
    c.record('setting', 'global:seriesKeptMinReaders', null, { value: '50' });
    expect(await c.names({ by: 'series', q: 'kept:>=0' })).toContain('Eta');
  });
});

describe('the Authors tab', () => {
  it('sorts by the works: each series once (its volume 1), each book without a series', async () => {
    const c = await env();
    const cards = (await c.groups({ by: 'author', sort: 'rating', dir: 'desc' })).groups;
    // Amy: Alpha's volume 1 (4.0 × 100) and L (4.8 × 50) = 4.27 over 150 ratings, pulled toward
    // the median 4.1 by 20: 4247. Bob: Beta (4.5 × 10): 4233. Cat: Gamma (3.0 × 500): 3042.
    expect(cards.map((g) => [g.name, g.figures?.rating])).toEqual([
      ['Amy', { avg: 4.3, count: 150, score: 4247 }],
      ['Bob', { avg: 4.5, count: 10, score: 4233 }],
      ['Cat', { avg: 3, count: 500, score: 3042 }],
    ]);
    // Most read: Amy 1,000 (Alpha's volume 1) + 300 (L); Cat 40 + 200 + 100 + 100 + 100.
    expect(cards.map((g) => [g.name, g.figures?.readers])).toEqual([
      ['Amy', 1300],
      ['Bob', 100],
      ['Cat', 540],
    ]);
    expect(await c.names({ by: 'author', sort: 'readers', dir: 'desc' })).toEqual([
      'Amy',
      'Cat',
      'Bob',
    ]);
  });

  it("counts a collection's books only", async () => {
    const c = await env();
    const list = randomUUID();
    c.record('collection-item', `${list}:${c.id('L')}`, c.id('L'), { key: 'L' });
    const cards = (await c.groups({ by: 'author', collection: list, sort: 'rating' })).groups;
    expect(cards.map((g) => [g.name, g.figures?.rating?.count, g.figures?.readers])).toEqual([
      ['Amy', 50, 300],
    ]);
  });
});

describe('the Tags tab', () => {
  it('takes a figure sort and lists by name (tags have no figures)', async () => {
    const c = await env();
    const res = await c.groups({ by: 'tag', sort: 'rating' });
    expect(res.groups.every((g) => g.figures === undefined)).toBe(true);
  });
});
