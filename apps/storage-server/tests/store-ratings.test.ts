/**
 * Store ratings (2026-11-25, docs/design/store-ratings.md): the parsers on real pages (cut from
 * the cleanup's cache and live pages), the books mirror and the score (migration 33's triggers),
 * the first fill from cached pages, the refresher through the cleanup's fetch queue, the routes,
 * Natively's learners' rating from the level's reader, and rating:/ratings:/readers:/myrating:
 * and the three sorts in the catalog.
 */
import type Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { brotliCompressSync } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { planBooks } from '../src/catalog/queries';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { listUsers } from '../src/db/users';
import { NativelyLevels } from '../src/natively/levels';
import { parseNativelyReviews } from '../src/natively/parse';
import {
  parseAmazonRating,
  parseBookmeterCounts,
  parseBookwalkerRating,
} from '../src/ratings/parse';
import { createRatingsRouter } from '../src/ratings/routes';
import {
  OPEN_PRIORITY,
  ROUTINE_PRIORITY,
  StoreRatings,
  stage4CacheFile,
} from '../src/ratings/service';
import { readRatingSettings, saveRatingSettings } from '../src/ratings/settings';
import { readScoreParams, saveRating, savedRating, updateScoreParams } from '../src/ratings/store';
import { calibreDate, CalibreRoot, type FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, type IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';

const FIXTURES = path.join(__dirname, 'fixtures', 'store-ratings');
const page = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const natively = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'natively', name), 'utf8');

const BW_RATED = '5b1a695e-9481-4a89-8bc2-c924090c6114';
const BW_NONE = 'c9ff099a-bd34-4a00-b4e9-4c549d557fb0';
const BW_JAPAN_ONLY = '00032b54-6ea6-4f3a-856b-2d153df41f55';

describe('the store pages (real pages)', () => {
  it("reads Amazon's own figures, not another product's stars on the page", () => {
    expect(page('amazon-rated-1.html')).toMatch(/5つ星のうち4\.4/); // another product's
    expect(parseAmazonRating(page('amazon-rated-1.html'))).toEqual({
      kind: 'rating',
      avg: 4.6,
      count: 180,
      reviews: null,
    });
    expect(parseAmazonRating(page('amazon-rated-2.html'))).toEqual({
      kind: 'rating',
      avg: 5,
      count: 4,
      reviews: null,
    });
    expect(parseAmazonRating(page('amazon-none.html'))).toEqual({ kind: 'none' });
    expect(parseAmazonRating(page('amazon-not-found.html'))).toEqual({ kind: 'unreadable' });
  });

  it("reads BOOK☆WALKER's figures from the book's own Product block", () => {
    expect(parseBookwalkerRating(page('bookwalker-rated.html'), BW_RATED)).toEqual({
      kind: 'rating',
      avg: 4.8,
      count: 99,
      reviews: null,
    });
    expect(parseBookwalkerRating(page('bookwalker-none.html'), BW_NONE)).toEqual({ kind: 'none' });
    // Another book's page is not this book's figure.
    expect(parseBookwalkerRating(page('bookwalker-rated.html'), BW_NONE)).toEqual({
      kind: 'unreadable',
    });
    // A Japan-only title seen through the VPN (United States): the store's error page.
    expect(parseBookwalkerRating(page('bookwalker-japan-only.html'), BW_JAPAN_ONLY)).toEqual({
      kind: 'blocked',
    });
  });

  it("reads 読書メーター's 登録数 and 感想 count", () => {
    expect(parseBookmeterCounts(page('bookmeter-6542818.html'))).toEqual({
      kind: 'rating',
      avg: null,
      count: 18,
      reviews: 4,
    });
    expect(parseBookmeterCounts(page('bookmeter-6826860.html'))).toEqual({
      kind: 'rating',
      avg: null,
      count: 444,
      reviews: 98,
    });
    expect(parseBookmeterCounts('<html>error</html>')).toEqual({ kind: 'unreadable' });
  });

  it("reads Natively's learners' rating: the book's own, not its series' (惡の華)", () => {
    expect(parseNativelyReviews(natively('series-level-differs.html'))).toEqual({
      avg: 4.53,
      count: 15,
    });
    expect(parseNativelyReviews(natively('level-31.html'))).toEqual({ avg: null, count: 0 });
    expect(parseNativelyReviews('<html></html>')).toBeNull();
  });
});

// ------------------------------------------------------------------ library env

const envs: IndexerEnv[] = [];
const cleanups: { db: Database.Database; dir: string }[] = [];
const services: StoreRatings[] = [];
afterEach(async () => {
  while (services.length) services.pop()!.stop();
  while (cleanups.length) {
    const c = cleanups.pop()!;
    c.db.close();
    fs.rmSync(c.dir, { recursive: true, force: true });
  }
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
  const link = (title: string, type: string, value: string) =>
    e.db
      .prepare('INSERT OR REPLACE INTO book_identifiers (book_id, type, value) VALUES (?, ?, ?)')
      .run(id(title), type, value);
  const mirror = (title: string) =>
    e.db
      .prepare(
        'SELECT rating_x10 AS x10, rating_count AS count, rating_score AS score, readers FROM books WHERE id = ?',
      )
      .get(id(title)) as {
      x10: number | null;
      count: number | null;
      score: number | null;
      readers: number | null;
    };
  return { e, id, link, mirror };
}

const rated = (avg: number, count: number) =>
  ({ kind: 'rating', avg, count, reviews: null }) as const;

describe('the books mirror and the score (migration 33)', () => {
  it('pools Amazon and BOOK☆WALKER by their counts and pulls few ratings toward the middle', async () => {
    const { e, link, mirror } = await env();
    link('Alpha', 'amazon_jp', 'B000000001');
    link('Alpha', 'bookwalker', BW_RATED);
    link('Beta', 'amazon_jp', 'B000000002');
    link('Gamma', 'bookmeter', '123');
    expect(mirror('Alpha')).toEqual({ x10: null, count: null, score: null, readers: null });
    saveRating(e.db, 'amazon_jp', 'B000000001', rated(4, 100), 1);
    saveRating(e.db, 'bookwalker', BW_RATED, rated(5, 100), 1);
    saveRating(e.db, 'amazon_jp', 'B000000002', rated(5, 2), 1);
    saveRating(
      e.db,
      'bookmeter',
      '123',
      { kind: 'rating', avg: null, count: 1200, reviews: 40 },
      1,
    );
    // (20 × 4.1 + 900) / 220 = 4.4636; (20 × 4.1 + 10) / 22 = 4.1818.
    expect(mirror('Alpha')).toEqual({ x10: 45, count: 200, score: 4464, readers: null });
    expect(mirror('Beta')).toEqual({ x10: 50, count: 2, score: 4182, readers: null });
    expect(mirror('Gamma')).toEqual({ x10: null, count: null, score: null, readers: 1200 });

    // A new score parameter works every book out again.
    expect(updateScoreParams(e.db, 0, 4.1)).toBe(true);
    expect(mirror('Beta').score).toBe(5000);
    updateScoreParams(e.db, 20, 4.1);

    // An error keeps the figures; "no ratings" and a removed page clear them.
    saveRating(e.db, 'amazon_jp', 'B000000002', { kind: 'error', error: 'x' }, 2);
    expect(mirror('Beta').x10).toBe(50);
    expect(savedRating(e.db, 'amazon_jp', 'B000000002')).toMatchObject({
      state: 'error',
      fails: 1,
    });
    saveRating(e.db, 'amazon_jp', 'B000000002', { kind: 'none' }, 3);
    expect(mirror('Beta')).toEqual({ x10: null, count: null, score: null, readers: null });
    saveRating(e.db, 'bookwalker', BW_RATED, { kind: 'gone' }, 3);
    expect(mirror('Alpha')).toMatchObject({ x10: 40, count: 100 });

    // The ingest rewriting a book's identifiers keeps the mirror right.
    e.db
      .prepare("DELETE FROM book_identifiers WHERE type = 'amazon_jp' AND value = 'B000000001'")
      .run();
    expect(mirror('Alpha')).toEqual({ x10: null, count: null, score: null, readers: null });
    link('Delta', 'amazon_jp', 'B000000001');
    expect(mirror('Delta')).toMatchObject({ x10: 40, count: 100 });
  });

  it('works the middle out as the median of rated books', async () => {
    const { e, link } = await env();
    link('Alpha', 'amazon_jp', 'B000000001');
    link('Beta', 'amazon_jp', 'B000000002');
    link('Gamma', 'amazon_jp', 'B000000003');
    saveRating(e.db, 'amazon_jp', 'B000000001', rated(3.5, 10), 1);
    saveRating(e.db, 'amazon_jp', 'B000000002', rated(4.4, 10), 1);
    saveRating(e.db, 'amazon_jp', 'B000000003', rated(4.8, 10), 1);
    updateScoreParams(e.db, 20);
    expect(readScoreParams(e.db)).toEqual({ m: 4.4, c: 20 });
  });
});

describe('the catalog: searches and sorts', () => {
  it('filters and sorts by the figures, books without one never matching', async () => {
    const { e, id, link } = await env();
    link('Alpha', 'amazon_jp', 'B000000001');
    link('Beta', 'amazon_jp', 'B000000002');
    link('Gamma', 'bookmeter', '123');
    saveRating(e.db, 'amazon_jp', 'B000000001', rated(4.6, 300), 1);
    saveRating(e.db, 'amazon_jp', 'B000000002', rated(5, 3), 1);
    saveRating(e.db, 'bookmeter', '123', { kind: 'rating', avg: null, count: 1500, reviews: 9 }, 1);
    e.db.prepare('UPDATE books SET rating = 8 WHERE id = ?').run(id('Delta'));

    const auth = { Authorization: `Bearer ${e.token()}` };
    const list = async (q: Record<string, string>) =>
      (await request(e.app).get('/api/v1/books').query(q).set(auth)).body.books as {
        title: string;
        storeRating: unknown;
        readers: number | null;
        rating: number | null;
      }[];
    const titles = async (q: Record<string, string>) => (await list(q)).map((b) => b.title);
    expect((await titles({ q: 'rating:>=4.5' })).sort()).toEqual(['Alpha', 'Beta']);
    expect(await titles({ q: 'rating:4' })).toEqual(['Alpha']);
    expect(await titles({ q: '-rating:5' })).toEqual(['Alpha']);
    expect(await titles({ q: 'ratings:>=100' })).toEqual(['Alpha']);
    expect(await titles({ q: 'readers:>=1k' })).toEqual(['Gamma']);
    expect(await titles({ q: 'myrating:4' })).toEqual(['Delta']);
    // Few ratings sort below many: (20 × 4.1 + 15) / 23 = 4.22 < 4.59.
    expect((await titles({ sort: 'rating', dir: 'desc' })).slice(0, 2)).toEqual(['Alpha', 'Beta']);
    expect((await titles({ sort: 'rating', dir: 'asc' })).slice(0, 2)).toEqual(['Beta', 'Alpha']);
    expect((await titles({ sort: 'ratings', dir: 'desc' })).slice(0, 2)).toEqual(['Alpha', 'Beta']);
    expect((await titles({ sort: 'readers', dir: 'desc' }))[0]).toBe('Gamma');
    const alpha = (await list({ q: 'ratings:>=100' }))[0];
    // (20 × 4.1 + 4.6 × 300) / 320 = 4.569.
    expect(alpha.storeRating).toEqual({ avg: 4.6, count: 300, score: 4569 });
    expect((await list({ q: 'myrating:4' }))[0].rating).toBe(8);

    const user = listUsers(e.db)[0];
    for (const key of ['rating', 'ratings', 'readers'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const plan = planBooks(e.db, user, { sort: { key, dir }, limit: 2 });
        const detail = (
          e.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as { detail: string }[]
        ).map((r) => r.detail);
        expect(detail[0]).toBe(`SCAN b USING INDEX books_sort_${key}_${dir}`);
      }
    }
  });
});

// ------------------------------------------------------------------ first fill and refresher

function cacheWith(files: { site: 'amazon_jp' | 'bookwalker'; id: string; html: string }[]) {
  const dir = makeTempDir('ratings-cache-');
  for (const f of files) {
    const file = path.join(dir, 'cleanup', stage4CacheFile(f.site, f.id));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, brotliCompressSync(Buffer.from(f.html)));
    fs.utimesSync(file, new Date(BASE), new Date(BASE));
  }
  return dir;
}

function fetchQueue() {
  const dir = makeTempDir('ratings-queue-');
  const db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
  cleanups.push({ db, dir });
  const s = getSettings(db).fetch;
  const sites = Object.fromEntries(
    Object.keys(s.sites).map((k) => [k, { ...s.sites[k], intervalSeconds: 0.25 }]),
  );
  updateSettings(db, { fetch: { ...s, sites } });
  const q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
  return { q, db, dir };
}

function ratingsService(
  db: Database.Database,
  cacheDir: string | null,
  q: FetchQueue | null,
  now = () => Date.now(),
) {
  const s = new StoreRatings({
    db,
    cacheDir,
    queue: () => q,
    now,
    log: () => {},
    tickMs: 3_600_000,
    paceMinAnswers: 2,
  });
  services.push(s);
  return s;
}

const answer = (html: string, status = 200) => ({
  status,
  ms: 10,
  error: null,
  body: brotliCompressSync(Buffer.from(html)),
  encoding: 'br' as const,
});

describe('the first fill (cached store pages)', () => {
  it("reads every id's cached page once, dated by the file, without a request", async () => {
    const { e, link, mirror } = await env();
    link('Alpha', 'amazon_jp', 'B07DXV5BP2');
    link('Beta', 'bookwalker', BW_RATED);
    link('Gamma', 'amazon_jp', '4047273686');
    link('Delta', 'amazon_jp', 'B07L85H8DW');
    link('Delta', 'bookwalker', BW_NONE); // no cached page
    const cache = cacheWith([
      { site: 'amazon_jp', id: 'B07DXV5BP2', html: page('amazon-rated-1.html') },
      { site: 'bookwalker', id: BW_RATED, html: page('bookwalker-rated.html') },
      { site: 'amazon_jp', id: '4047273686', html: page('amazon-none.html') },
      { site: 'amazon_jp', id: 'B07L85H8DW', html: page('amazon-not-found.html') },
    ]);
    const s = ratingsService(e.db, cache, null);
    await s.firstFill();
    expect(savedRating(e.db, 'amazon_jp', 'B07DXV5BP2')).toMatchObject({
      avg: 4.6,
      count: 180,
      state: 'ok',
      checkedAt: BASE,
    });
    expect(savedRating(e.db, 'amazon_jp', '4047273686')).toMatchObject({ state: 'none' });
    expect(savedRating(e.db, 'amazon_jp', 'B07L85H8DW')).toMatchObject({ state: 'gone' });
    expect(savedRating(e.db, 'bookwalker', BW_NONE)).toBeNull(); // left to the refresher
    expect(mirror('Beta')).toMatchObject({ x10: 48, count: 99 });
    expect(s.progress().fill).toMatchObject({ running: false, total: 5, done: 5, found: 4 });
    fs.rmSync(cache, { recursive: true, force: true });
  });
});

describe('the refresher (the cleanup fetch queue)', () => {
  it('asks only with the setting on, behind the cleanup, saves the answer and deletes its file', async () => {
    const { e, link, id } = await env();
    link('Alpha', 'amazon_jp', 'B07DXV5BP2');
    link('Beta', 'bookmeter', '6826860');
    const { q, db: cdb } = fetchQueue();
    const s = ratingsService(e.db, null, q);
    s.start();

    await s.tick();
    expect(cdb.prepare('SELECT COUNT(*) AS n FROM fetch_requests').get()).toEqual({ n: 0 });

    saveRatingSettings(e.db, { refresh: true, newBookWaitHours: 0 });
    await s.tick();
    const reqs = cdb.prepare('SELECT * FROM fetch_requests').all() as {
      id: number;
      site: string;
      key: string;
      priority: number;
    }[];
    // 読書メーター with the other stores (its own switch is gone since its link fix).
    expect(reqs.map((r) => [r.site, r.key, r.priority])).toEqual([
      ['amazon-dp', 'ratings:B07DXV5BP2', ROUTINE_PRIORITY],
      ['bookmeter', 'ratings:6826860', ROUTINE_PRIORITY],
    ]);

    const pages: Record<string, string> = {
      'amazon-dp': 'amazon-rated-1.html',
      bookmeter: 'bookmeter-6826860.html',
    };
    let c = { id: 0 };
    for (let got = 0; got < 2; ) {
      for (const r of q.claim().requests) {
        q.report(r.id, r.leaseToken, answer(page(pages[r.site])));
        if (r.site === 'amazon-dp') c = r;
        got += 1;
      }
      if (got < 2) await new Promise((res) => setTimeout(res, 300));
    }
    const cacheFile = (
      cdb.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?').get(c.id) as {
        cache_file: string;
      }
    ).cache_file;
    await s.tick();
    expect(savedRating(e.db, 'amazon_jp', 'B07DXV5BP2')).toMatchObject({ avg: 4.6, count: 180 });
    expect(savedRating(e.db, 'bookmeter', '6826860')).toMatchObject({ count: 444, reviews: 98 });
    expect(
      cdb.prepare('SELECT state, cache_file FROM fetch_requests WHERE id = ?').get(c.id),
    ).toEqual({
      state: 'done',
      cache_file: null,
    });
    expect(cacheFile).toBeTruthy();
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM store_rating_requests').get()).toEqual({ n: 0 });

    // Fresh figures are not asked again; old ones are (the same request put back in line).
    await s.tick();
    expect(q.requestState(c.id)).toBe('done');
    e.db.prepare('UPDATE store_ratings SET checked_at = ?').run(Date.now() - 400 * 86_400_000);
    await s.tick();
    expect(q.requestState(c.id)).toBe('queued');

    // A book page asks old figures ahead of the routine.
    const r = s.forBook(id('Beta'), true);
    expect(r.refreshing).toBe(true);
    const bm = cdb
      .prepare("SELECT priority FROM fetch_requests WHERE site = 'bookmeter'")
      .get() as { priority: number };
    expect(bm.priority).toBe(OPEN_PRIORITY);
  });

  it('records a removed page and a failed fetch', async () => {
    const { e, link } = await env();
    link('Alpha', 'amazon_jp', 'B000000009');
    link('Beta', 'bookwalker', BW_RATED);
    const { q } = fetchQueue();
    saveRatingSettings(e.db, { refresh: true, newBookWaitHours: 0 });
    const s = ratingsService(e.db, null, q);
    s.start();
    await s.tick();
    for (const c of q.claim().requests) {
      q.report(
        c.id,
        c.leaseToken,
        c.site === 'amazon-dp' ? answer('', 404) : answer('<html>?</html>'),
      );
    }
    await s.tick();
    expect(savedRating(e.db, 'amazon_jp', 'B000000009')).toMatchObject({ state: 'gone' });
    expect(savedRating(e.db, 'bookwalker', BW_RATED)).toMatchObject({ state: 'error', fails: 1 });
  });

  it('asks a Japan-only page again only at the old-book pace', async () => {
    const { e, link } = await env();
    link('Alpha', 'bookwalker', BW_JAPAN_ONLY);
    const { q } = fetchQueue();
    saveRatingSettings(e.db, { refresh: true, newBookWaitHours: 0 });
    const s = ratingsService(e.db, null, q);
    s.start();
    await s.tick();
    for (const c of q.claim().requests) {
      q.report(c.id, c.leaseToken, answer(page('bookwalker-japan-only.html')));
    }
    await s.tick();
    expect(savedRating(e.db, 'bookwalker', BW_JAPAN_ONLY)).toMatchObject({
      state: 'error',
      fails: 3,
      avg: null,
    });
    const day = 86_400_000;
    e.db.prepare('UPDATE store_ratings SET checked_at = ?').run(Date.now() - 2 * day);
    await s.refreshDue();
    expect(s.dueIds('bookwalker', 10)).toEqual([]);
    e.db.prepare('UPDATE store_ratings SET checked_at = ?').run(Date.now() - 91 * day);
    await s.refreshDue();
    expect(s.dueIds('bookwalker', 10)).toEqual([BW_JAPAN_ONLY]);
  });

  it('reads saved searches again only for an id not looked for before', async () => {
    const { e, link } = await env();
    link('Beta', 'bookmeter', '6826860');
    // No search lists Gamma's id: it stays without a figure, and every fill looks for it.
    link('Gamma', 'bookmeter', '999');
    const { q } = fetchQueue();
    q.enqueue(
      {
        site: 'bookmeter',
        key: 'search-jp-au:x y',
        url: 'https://bookmeter.com/search?author=x&keyword=y&partial=true&sort=recommended&type=japanese',
        priority: 0,
      },
      null,
      Date.now(),
    );
    for (let got = 0; got < 1; ) {
      for (const r of q.claim().requests) {
        q.report(
          r.id,
          r.leaseToken,
          answer(
            '<ul><li class="group__book"><div class="detail__title"><a href="/books/6826860">本</a></div>' +
              '<dl><dt class="options__title">登録</dt><dd class="options__item">1,234</dd></dl></li></ul>',
          ),
        );
        got += 1;
      }
      if (got < 1) await new Promise((res) => setTimeout(res, 300));
    }
    let reads = 0;
    const read = q.readAnswerAsync.bind(q);
    q.readAnswerAsync = (id: number) => {
      reads += 1;
      return read(id);
    };
    const s = ratingsService(e.db, null, q);
    await s.firstFill();
    expect(savedRating(e.db, 'bookmeter', '6826860')).toMatchObject({ count: 1234 });
    expect(reads).toBe(1);
    // The same ids, no new search: nothing is read again.
    await s.firstFill();
    expect(reads).toBe(1);
    // A new id: the saved searches are read again for it.
    link('Delta', 'bookmeter', '1000');
    await s.firstFill();
    expect(reads).toBe(2);
    expect(savedRating(e.db, 'bookmeter', '999')).toBeNull();
  });

  it("takes 読書メーター's 登録数 from a saved search, then asks the book page for its reviews", async () => {
    const { e, link } = await env();
    link('Beta', 'bookmeter', '6826860');
    const { q, db: cdb } = fetchQueue();
    // A Bookmeter search the cleanup saved, listing this book with its 登録 count.
    const search = q.enqueue(
      {
        site: 'bookmeter',
        key: 'search-jp-au:x y',
        url: 'https://bookmeter.com/search?author=x&keyword=y&partial=true&sort=recommended&type=japanese',
        priority: 0,
      },
      null,
      Date.now(),
    );
    for (let got = 0; got < 1; ) {
      for (const r of q.claim().requests) {
        q.report(
          r.id,
          r.leaseToken,
          answer(
            '<ul><li class="group__book"><div class="detail__title"><a href="/books/6826860">本</a></div>' +
              '<dl><dt class="options__title">登録</dt><dd class="options__item">1,234</dd></dl></li></ul>',
          ),
        );
        got += 1;
      }
      if (got < 1) await new Promise((res) => setTimeout(res, 300));
    }
    const finished = (
      cdb.prepare('SELECT finished_at FROM fetch_requests WHERE id = ?').get(search.id) as {
        finished_at: number;
      }
    ).finished_at;
    saveRatingSettings(e.db, { refresh: true });
    const s = ratingsService(e.db, null, q);
    await s.firstFill();
    expect(savedRating(e.db, 'bookmeter', '6826860')).toMatchObject({
      state: 'ok',
      count: 1234,
      reviews: null,
      checkedAt: finished,
    });
    // Fresh from the search: no book page is asked (its 感想 count is not shown).
    await s.refreshDue();
    expect(s.dueIds('bookmeter', 10)).toEqual([]);
  });

  it("holds a new book's 読書メーター id for its search, like stage 4's pages", async () => {
    const { e, link } = await env();
    link('Beta', 'bookmeter', '6826860');
    const { q } = fetchQueue();
    saveRatingSettings(e.db, { refresh: true });
    let now = Date.now();
    const s = ratingsService(e.db, null, q, () => now);
    await s.refreshDue();
    expect(s.dueIds('bookmeter', 10)).toEqual([]);
    now += 49 * 3_600_000;
    await s.refreshDue();
    expect(s.dueIds('bookmeter', 10)).toEqual(['6826860']);
  });

  it("leaves a new book's first rating to stage 4's page (no second request)", async () => {
    const { e, link } = await env();
    link('Alpha', 'amazon_jp', 'B07DXV5BP2');
    link('Beta', 'amazon_jp', 'B009NNZQVS');
    const { q } = fetchQueue();
    saveRatingSettings(e.db, { refresh: true });
    let now = Date.now();
    const s = ratingsService(e.db, null, q, () => now);
    // Books new to the reader wait (48 h by default) for the new arrivals' stage 4.
    await s.refreshDue();
    expect(s.dueIds('amazon_jp', 10)).toEqual([]);
    // Stage 4's own request for Beta's page is still open: Beta waits on, Alpha is asked.
    q.enqueue(
      {
        site: 'amazon-dp',
        key: 'B009NNZQVS',
        url: 'https://www.amazon.co.jp/dp/B009NNZQVS',
        priority: 0,
      },
      null,
      now,
    );
    now += 49 * 3_600_000;
    await s.refreshDue();
    expect(s.dueIds('amazon_jp', 10)).toEqual(['B07DXV5BP2']);
  });

  it('measures the time left from the answers of the last hour', async () => {
    const { e, link } = await env();
    let now = Date.now();
    for (const [i, b] of BOOKS.entries()) link(b.title, 'amazon_jp', `B00000020${i}`);
    const { q } = fetchQueue();
    saveRatingSettings(e.db, { refresh: true, queuedPerSite: 2, newBookWaitHours: 0 });
    const s = ratingsService(e.db, null, q, () => now);
    s.start();
    expect(s.progress().refresh.secondsLeft).toBeNull();
    await s.tick();
    // The queue hands out one request per site at its pace (0.25 s here).
    for (let got = 0; got < 2; ) {
      for (const c of q.claim().requests) {
        q.report(c.id, c.leaseToken, answer(page('amazon-rated-1.html')));
        got += 1;
      }
      if (got < 2) await new Promise((r) => setTimeout(r, 300));
    }
    now += 20 * 60_000;
    await s.tick();
    const p = s.progress().refresh;
    // 2 answers in 20 minutes; the 2 still due take about 20 minutes more.
    expect(p.read).toBe(2);
    // The other 2 were asked as the first answers came back (the queue topped up).
    expect(p.waiting).toBe(2);
    expect(p.due).toEqual({ amazon_jp: 0, bookwalker: 0, bookmeter: 0 });
    expect(p.secondsLeft).toBe(1200);

    // A quick later check of stage 4's saved pages runs without a bar.
    await s.firstFill(true);
    expect(s.progress().fill.running).toBe(false);
  });
});

describe('the routes', () => {
  it("answers a book's figures, hides 読書メーター until it is on, and saves settings", async () => {
    const { e, id, link } = await env();
    link('Alpha', 'amazon_jp', 'B000000001');
    link('Alpha', 'bookwalker', BW_RATED);
    link('Alpha', 'bookmeter', '123');
    saveRating(e.db, 'amazon_jp', 'B000000001', rated(4, 30), 5);
    saveRating(e.db, 'bookwalker', BW_RATED, rated(5, 10), 6);
    saveRating(e.db, 'bookmeter', '123', { kind: 'rating', avg: null, count: 700, reviews: 20 }, 7);
    const s = ratingsService(e.db, null, null);
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createRatingsRouter(s));

    const a = (await request(app).get(`/api/v1/ratings/book/${id('Alpha')}`)).body;
    expect(a.pooled).toEqual({ avg: 4.3, count: 40 });
    // 読書メーター is shown with the other stores (its own switch is gone since its link fix).
    expect(Object.keys(a.sites).sort()).toEqual(['amazon_jp', 'bookmeter', 'bookwalker']);
    expect(a.sites.bookmeter).toMatchObject({ count: 700, reviews: 20 });
    expect(a.readers).toBe(700);
    // With the score's pull, for the offline Library's author figures (series-figures).
    expect((await request(app).get('/api/v1/ratings/features')).body).toEqual({
      bookmeter: true,
      score: { m: 4.1, c: 20 },
    });
    // An older page that still sends the retired switch saves fine; the switch is dropped.
    expect(
      (await request(app).put('/api/v1/ratings/settings').send({ bookmeter: false })).status,
    ).toBe(200);
    expect(readRatingSettings(e.db)).not.toHaveProperty('bookmeter');

    expect((await request(app).put('/api/v1/ratings/settings').send({ newDays: 0 })).status).toBe(
      400,
    );
    expect((await request(app).put('/api/v1/ratings/settings').send({ nope: 1 })).status).toBe(400);
    await request(app).put('/api/v1/ratings/settings').send({ scoreRatings: 5 });
    expect(readScoreParams(e.db).c).toBe(5);
    expect(readRatingSettings(e.db)).toMatchObject({
      scoreRatings: 5,
      refresh: false,
    });
    expect((await request(app).get(`/api/v1/ratings/book/nope`)).status).toBe(404);
    expect((await request(app).get('/api/v1/ratings/progress')).body).toMatchObject({
      refresh: { on: false, available: false },
      score: { c: 5 },
    });
  });
});

describe("Natively's learners' rating (the level's reader)", () => {
  it("saves the page's rating with the level, and reads ids that have a level but no rating once", async () => {
    const { e, link } = await env();
    link('Alpha', 'natively', 'aa11');
    e.db
      .prepare(
        "INSERT INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES ('aa11', 19, 0, 'ok', 1)",
      )
      .run();
    const asked: string[] = [];
    const levels = new NativelyLevels({
      db: e.db,
      fetch: async (url) => {
        asked.push(url);
        return { status: 200, text: async () => natively('series-level-differs.html') };
      },
      baseUrl: 'https://n.test',
      msPerSecond: 1,
      log: () => {},
    });
    levels.start();
    try {
      const start = Date.now();
      while (!savedRating(e.db, 'natively', 'aa11') && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      await levels.stop();
    }
    expect(asked).toEqual(['https://n.test/book/aa11/']);
    expect(savedRating(e.db, 'natively', 'aa11')).toMatchObject({
      avg: 4.53,
      count: 15,
      state: 'ok',
    });
  });
});
