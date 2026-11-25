/**
 * The Natively level (2026-11-24): the page parser on real pages, the books mirror (migration
 * 32's triggers), the fetcher (pace, on-open first, back-off, 404, errors keep the level, the
 * first pass), the routes, and level: / the Level sort in the catalog.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { planBooks } from '../src/catalog/queries';
import { listUsers } from '../src/db/users';
import { NativelyLevels, type FetchLike } from '../src/natively/levels';
import { parseNativelyLevel } from '../src/natively/parse';
import { createNativelyRouter } from '../src/natively/routes';
import { readNativelySettings, saveNativelySettings } from '../src/natively/settings';
import { calibreDate, CalibreRoot, type FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, type IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import express from 'express';

const FIXTURES = path.join(__dirname, 'fixtures', 'natively');
const page = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('parseNativelyLevel', () => {
  it('reads a settled level from a real page', () => {
    expect(parseNativelyLevel(page('level-31.html'))).toEqual({
      kind: 'level',
      level: 31,
      temporary: false,
    });
  });

  it('reads a temporary level from a real page', () => {
    expect(parseNativelyLevel(page('temporary.html'))).toEqual({
      kind: 'level',
      level: 24,
      temporary: true,
    });
  });

  it("takes the book's own level, not its series' (惡の華 (6): Level 19, series L23)", () => {
    expect(parseNativelyLevel(page('series-level-differs.html'))).toEqual({
      kind: 'level',
      level: 19,
      temporary: false,
    });
  });

  it('falls back to the title with its temporary mark', () => {
    expect(parseNativelyLevel('<title>本 | L24??</title>')).toEqual({
      kind: 'level',
      level: 24,
      temporary: true,
    });
  });

  // No ungraded book was found among 35 sampled pages (2026-11-24): a page shaped like the
  // real ones, with the item's rating null.
  it('reads a book nobody graded yet as no level', () => {
    const data = JSON.stringify([
      '$',
      'x',
      null,
      { data: { item: { isbn13: '1', rating: null } } },
    ]);
    const html = `<script>self.__next_f.push([1,${JSON.stringify(`5:${data}`)}])</script>`;
    expect(parseNativelyLevel(html)).toEqual({ kind: 'none' });
  });

  it('falls back to the meta description, and gives up on other pages', () => {
    expect(
      parseNativelyLevel(
        '<meta name="description" content="Book, Difficulty: Level 12 (Beginner, ~JLPT N5)"/>',
      ),
    ).toEqual({ kind: 'level', level: 12, temporary: false });
    expect(parseNativelyLevel('<html><body>Not found</body></html>')).toEqual({
      kind: 'unreadable',
    });
  });
});

const envs: IndexerEnv[] = [];
const services: NativelyLevels[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const BASE = Date.UTC(2026, 0, 1);
const BOOKS: FixtureBook[] = [
  { title: 'Alpha', sort: 'Alpha', authors: ['Amy'] },
  { title: 'Beta', sort: 'Beta', authors: ['Bob'] },
  { title: 'Gamma', sort: 'Gamma', authors: ['Kim'] },
  { title: 'Delta', sort: 'Delta', authors: ['Zed'] },
];

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
  const ids = new Map(
    (e.db.prepare('SELECT id, title FROM books').all() as { id: string; title: string }[]).map(
      (r) => [r.title, r.id],
    ),
  );
  const id = (title: string) => ids.get(title)!;
  const link = (title: string, value: string) =>
    e.db
      .prepare(
        "INSERT OR REPLACE INTO book_identifiers (book_id, type, value) VALUES (?, 'natively', ?)",
      )
      .run(id(title), value);
  const mirror = (title: string) =>
    e.db
      .prepare(
        'SELECT natively_level AS level, natively_temporary AS temporary FROM books WHERE id = ?',
      )
      .get(id(title)) as { level: number | null; temporary: number | null };
  return { e, id, link, mirror };
}

/** A stand-in for Natively: answers from a table of id -> level (or status), and logs requests. */
function stubNatively(answers: Record<string, number | { status: number } | 'temp' | 'none'>) {
  const asked: string[] = [];
  const fetch: FetchLike = async (url) => {
    const id = /\/book\/([^/]+)\//.exec(url)![1];
    asked.push(id);
    const a = answers[id];
    if (a === undefined) return { status: 404, text: async () => '' };
    if (typeof a === 'object') return { status: a.status, text: async () => '' };
    const rating =
      a === 'none' ? 'null' : `{"lvl":${a === 'temp' ? 25 : a},"temporary":${a === 'temp'}}`;
    const data = JSON.stringify([
      '$',
      'x',
      null,
      { data: { item: { isbn13: '1', gradingUrl: '/g', rating: JSON.parse(rating) } } },
    ]);
    const push = JSON.stringify(`5:${data}`);
    return {
      status: 200,
      text: async () => `<script>self.__next_f.push([1,${push}])</script>`,
    };
  };
  return { fetch, asked };
}

function service(db: IndexerEnv['db'], fetch: FetchLike, now?: () => number) {
  const s = new NativelyLevels({
    db,
    fetch,
    baseUrl: 'https://n.test',
    msPerSecond: 1,
    log: () => {},
    now,
  });
  services.push(s);
  return s;
}

async function until(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the books mirror (migration 32)', () => {
  it('follows a saved level and the ingest rewriting identifiers', async () => {
    const { e, id, link, mirror } = await env();
    link('Alpha', 'aa11');
    expect(mirror('Alpha')).toEqual({ level: null, temporary: null });
    e.db
      .prepare(
        "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES ('aa11', 29, 1, 'ok', 1)",
      )
      .run();
    expect(mirror('Alpha')).toEqual({ level: 29, temporary: 1 });
    // The ingest deletes and inserts a book's identifiers.
    e.db.prepare('DELETE FROM book_identifiers WHERE book_id = ?').run(id('Alpha'));
    expect(mirror('Alpha').level).toBeNull();
    link('Alpha', 'aa11');
    expect(mirror('Alpha')).toEqual({ level: 29, temporary: 1 });
    // Another book linked to the same Natively page shares the level.
    link('Beta', 'aa11');
    expect(mirror('Beta').level).toBe(29);
    e.db
      .prepare("UPDATE natively_levels SET level = 30, temporary = 0 WHERE natively_id = 'aa11'")
      .run();
    expect(mirror('Alpha')).toEqual({ level: 30, temporary: 0 });
    expect(mirror('Beta')).toEqual({ level: 30, temporary: 0 });
  });
});

describe('NativelyLevels', () => {
  it('reads every linked book once in the first pass, skipping bad ids and saved ones', async () => {
    const { e, link, mirror } = await env();
    link('Alpha', 'aa11');
    link('Beta', 'bb22');
    link('Gamma', 'not/an id');
    link('Delta', 'dd44');
    e.db
      .prepare(
        "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES ('dd44', 5, 0, 'ok', 1)",
      )
      .run();
    // Store ratings (2026-11-25): an id with a level is read again until it has a learners'
    // rating row too (tests/store-ratings.test.ts); this one has both.
    e.db
      .prepare(
        "INSERT INTO store_ratings (site, site_id, state, checked_at) VALUES ('natively', 'dd44', 'none', 1)",
      )
      .run();
    const stub = stubNatively({ aa11: 31, bb22: 'temp' });
    const s = service(e.db, stub.fetch);
    s.start();
    await until(() => !s.progress().pass.running && stub.asked.length === 2);
    expect(stub.asked.sort()).toEqual(['aa11', 'bb22']);
    expect(mirror('Alpha')).toEqual({ level: 31, temporary: 0 });
    expect(mirror('Beta')).toEqual({ level: 25, temporary: 1 });
    expect(s.progress().pass).toMatchObject({ total: 2, done: 2, left: 0 });
    expect(s.progress().saved).toBe(3);
  });

  it('reads an old level again when the page opens, a fresh one never', async () => {
    const { e, link } = await env();
    link('Alpha', 'aa11');
    link('Beta', 'bb22');
    const now = Date.now();
    const ins = e.db.prepare(
      "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES (?, ?, 0, 'ok', ?)",
    );
    // The default max age, 7 days, is 7 * 86400 ms with msPerSecond 1.
    ins.run('aa11', 10, now - 8 * 86400);
    ins.run('bb22', 20, now - 1000);
    const stub = stubNatively({ aa11: 12, bb22: 22 });
    const s = service(e.db, stub.fetch);
    s.start();
    expect(await s.refresh('aa11', 2000)).toMatchObject({ level: 12, state: 'ok' });
    expect(await s.refresh('bb22', 2000)).toMatchObject({ level: 20 });
    expect(stub.asked).toEqual(['aa11']);
  });

  it('puts an on-open request ahead of the first pass', async () => {
    const { e, link } = await env();
    link('Alpha', 'aa11');
    link('Beta', 'bb22');
    link('Gamma', 'cc33');
    link('Delta', 'dd44');
    saveNativelySettings(e.db, { requestSeconds: 20 });
    const stub = stubNatively({ aa11: 1, bb22: 2, cc33: 3, dd44: 4 });
    const s = service(e.db, stub.fetch);
    s.start();
    await until(() => stub.asked.length === 1);
    const answer = s.refresh('dd44', 2000);
    expect(await answer).toMatchObject({ level: 4 });
    expect(stub.asked.slice(0, 2)).toEqual(['aa11', 'dd44']);
  });

  it('waits after a refusal (doubling), tries again, and keeps the level on errors', async () => {
    const { e, link, mirror } = await env();
    link('Alpha', 'aa11');
    e.db
      .prepare(
        "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES ('aa11', 9, 0, 'ok', 0)",
      )
      .run();
    e.db
      .prepare(
        "INSERT INTO store_ratings (site, site_id, state, checked_at) VALUES ('natively', 'aa11', 'none', 1)",
      )
      .run();
    link('Beta', 'bb22');
    let refuse = 2;
    const stub = stubNatively({ aa11: 11, bb22: 22 });
    const fetch: FetchLike = async (url, init) => {
      if (refuse > 0) {
        refuse -= 1;
        stub.asked.push('refused');
        return { status: 429, text: async () => '' };
      }
      return stub.fetch(url, init);
    };
    const s = service(e.db, fetch);
    s.start();
    // Alpha has a saved row, so the first pass reads only Beta.
    await until(() => stub.asked.includes('bb22'), 3000);
    expect(stub.asked.slice(0, 3)).toEqual(['refused', 'refused', 'bb22']);
    expect(mirror('Beta').level).toBe(22);
    expect(s.progress().waitingUntil).toBeNull();
    // An error after a level keeps it.
    const fail: FetchLike = async () => ({ status: 403, text: async () => '' });
    await s.stop();
    const s2 = service(e.db, fail);
    s2.start();
    await s2.refresh('aa11', 1000);
    expect(mirror('Alpha').level).toBe(9);
    expect(
      e.db.prepare("SELECT state, fails FROM natively_levels WHERE natively_id = 'aa11'").get(),
    ).toEqual({ state: 'error', fails: 1 });
  });

  it('reads a book linked after start when the indexer wakes it', async () => {
    const { e, link, mirror } = await env();
    const stub = stubNatively({ aa11: 27 });
    const s = service(e.db, stub.fetch);
    s.start();
    expect(s.progress().pass.running).toBe(false);
    link('Alpha', 'aa11');
    s.wake();
    await until(() => mirror('Alpha').level === 27);
    expect(stub.asked).toEqual(['aa11']);
  });

  it('clears the level of a page that is gone, and of a book nobody graded yet', async () => {
    const { e, link, mirror } = await env();
    link('Alpha', 'aa11');
    link('Beta', 'bb22');
    const ins = e.db.prepare(
      "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES (?, 7, 0, 'ok', 1)",
    );
    ins.run('aa11');
    ins.run('bb22');
    const s = service(e.db, stubNatively({ bb22: 'none' }).fetch);
    s.start();
    expect(await s.refresh('aa11', 2000)).toMatchObject({ level: null, state: 'gone' });
    expect(await s.refresh('bb22', 2000)).toMatchObject({ level: null, state: 'none' });
    expect(mirror('Alpha').level).toBeNull();
    expect(mirror('Beta').level).toBeNull();
  });
});

describe('the routes and the catalog', () => {
  it("answers a book's level, and level: and the Level sort use the mirror", async () => {
    const { e, id, link } = await env();
    link('Alpha', 'aa11');
    link('Beta', 'bb22');
    link('Gamma', 'cc33');
    const ins = e.db.prepare(
      "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES (?, ?, ?, 'ok', ?)",
    );
    ins.run('aa11', 31, 0, Date.now());
    ins.run('bb22', 18, 1, Date.now());
    ins.run('cc33', 25, 0, Date.now());
    const s = service(e.db, stubNatively({}).fetch);
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createNativelyRouter(s));
    const res = await request(app).get(`/api/v1/natively/level/${id('Beta')}`);
    expect(res.body).toMatchObject({ nativelyId: 'bb22', level: 18, temporary: true, state: 'ok' });
    const none = await request(app).get(`/api/v1/natively/level/${id('Delta')}`);
    expect(none.body).toMatchObject({ nativelyId: null, level: null });
    const put = await request(app).put('/api/v1/natively/settings').send({ maxAgeDays: 3 });
    expect(put.body.settings.maxAgeDays).toBe(3);
    expect(readNativelySettings(e.db).maxAgeDays).toBe(3);
    const bad = await request(app).put('/api/v1/natively/settings').send({ requestSeconds: 0 });
    expect(bad.status).toBe(400);

    const auth = { Authorization: `Bearer ${e.token()}` };
    const titles = async (q: Record<string, string>) =>
      (
        (await request(e.app).get('/api/v1/books').query(q).set(auth)).body.books as {
          title: string;
          nativelyLevel: unknown;
        }[]
      ).map((b) => b.title);
    expect(await titles({ q: 'level:20-30' })).toEqual(['Gamma']);
    expect(await titles({ q: '-level:20-30' }).then((t) => t.sort())).toEqual(['Alpha', 'Beta']);
    expect(await titles({ q: 'level:<20' })).toEqual(['Beta']);
    expect(await titles({ sort: 'level', dir: 'asc' })).toEqual([
      'Beta',
      'Gamma',
      'Alpha',
      'Delta',
    ]);
    expect(await titles({ sort: 'level', dir: 'desc' })).toEqual([
      'Alpha',
      'Gamma',
      'Beta',
      'Delta',
    ]);
    const list = (await request(e.app).get('/api/v1/books').query({ q: 'level:18' }).set(auth)).body
      .books;
    expect(list[0].nativelyLevel).toEqual({ level: 18, temporary: true });
    const detail = (
      await request(e.app)
        .get(`/api/v1/books/${id('Alpha')}`)
        .set(auth)
    ).body;
    expect(detail.nativelyLevel).toEqual({ level: 31, temporary: false });

    // Both directions walk the sort's own index.
    const user = listUsers(e.db)[0];
    for (const [dir, index] of [
      ['asc', 'books_sort_level_asc'],
      ['desc', 'books_sort_level_desc'],
    ] as const) {
      const plan = planBooks(e.db, user, { sort: { key: 'level', dir }, limit: 2 });
      const detailPlan = (
        e.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as { detail: string }[]
      ).map((r) => r.detail);
      expect(detailPlan[0]).toBe(`SCAN b USING INDEX ${index}`);
    }
  });
});
