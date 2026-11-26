/**
 * Bookmeter sync (2026-11-25, docs/design/bookmeter-sync.md): the list and profile pages, the
 * checks through the cleanup's fetch queue (a round's pages applied at once, a refused page
 * never read as an empty list, a quick check never removing what it can't see), matching (saved
 * id, the rules, the user's own choice, the account's libraries), the records the devices read,
 * the wanted-book arrival told once, bookmeter: in the catalog, the routes and the record kinds.
 */
import type Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { brotliCompressSync } from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { listUsers } from '../src/db/users';
import { SyncStore } from '../src/sync/store';
import { parseListPage, parseProfile, userIdFrom } from '../src/bookmeter/parse';
import { BOOKMETER_ENTRY_KIND, BookmeterSync } from '../src/bookmeter/service';
import { targetBook } from '../src/bookmeter/match';
import { createBookmeterRouter } from '../src/bookmeter/routes';
import { calibreDate, CalibreRoot, type FixtureBook } from './helpers/calibre-fixture';
import { enableLibrary, type IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';

// ------------------------------------------------------------------ pages in Bookmeter's markup

interface Item {
  id: string;
  title: string;
  authors: string[];
  date?: string;
}

/** One list entry exactly as Bookmeter's list pages write it (2026-11-25). */
function li(it: Item): string {
  const authors = it.authors
    .map((a) => `<li><a href="/search?author=${encodeURIComponent(a)}">${a}</a></li>`)
    .join('');
  const cut = it.title.length > 22 ? `${it.title.slice(0, 22)}…` : it.title;
  return (
    `<li class="group__book"><div class="book__thumbnail"><div class="thumbnail__cover"><a href="/books/${it.id}">` +
    `<img alt="${it.title}" class="cover__image" src="https://m.media-amazon.com/images/I/${it.id}._SL500_.jpg" /></a>` +
    `<div class="cover__icon"></div></div><div class="thumbnail__action"><div class="js-modal-button modal-button">` +
    `<span class="action__icon"><nil></nil></span><span class="action__text">本を登録する</span></div></div></div>` +
    `<div class="book__detail"><div class="detail__date">${it.date ?? ''}</div><div class="detail__title">` +
    `<a href="/books/${it.id}">${cut}</a></div><ul class="detail__authors">${authors}</ul>` +
    `<div class="detail__page">256</div><dl class="detail__options"><dt class="options__title">登録</dt>` +
    `<dd class="options__item">807</dd></dl></div></li>`
  );
}

function listPage(name: string, total: number, items: Item[]): string {
  return (
    `<html><head><title>someone - 読書メーター</title></head><body><section class="bm-block-side userdata">` +
    `<div class="userdata-side"><div class="userdata-side__name">someone</div></div></section>` +
    `<header class="content-with-header__header"><h1 class="header__title"><div class="title__content">${name}` +
    `<div class="content__count">${total}</div></div></h1></header><div class="content-with-header__content">` +
    `<ul class="book-list__group">${items.map(li).join('')}</ul></div></body></html>`
  );
}

function profilePage(userId: string, counts: [number, number, number, number]): string {
  const nav = (['read', 'reading', 'stacked', 'wish'] as const)
    .map(
      (l, i) =>
        `<li><a href="/users/${userId}/books/${l}"><span class="sprite-icon"></span><span class="userdata-nav__text">x</span>` +
        `<span class="userdata-nav__count">${counts[i]}<span class="count__unit">冊</span></span></a></li>`,
    )
    .join('');
  return (
    `<html><head><title>someone - 読書メーター</title></head><body><div class="userdata-side">` +
    `<div class="userdata-side__name">someone &amp; co</div></div><ul class="userdata-nav">${nav}</ul></body></html>`
  );
}

describe('the pages', () => {
  it('reads a list page: listing, whole title, authors, date, cover and the list size', () => {
    const p = parseListPage(
      listPage('読んだ本', 129, [
        {
          id: '5476279',
          title: '(仮)花嫁のやんごとなき事情 -離婚できなきゃ大戦争!?- (ビーズログ文庫)',
          authors: ['夕鷺かのう'],
          date: '2026/11/07',
        },
        { id: '12', title: 'B', authors: ['X', 'Y'], date: '日付不明' },
      ]),
    )!;
    expect(p.total).toBe(129);
    expect(p.entries).toHaveLength(2);
    expect(p.entries[0]).toMatchObject({
      id: '5476279',
      title: '(仮)花嫁のやんごとなき事情 -離婚できなきゃ大戦争!?- (ビーズログ文庫)',
      authors: ['夕鷺かのう'],
      date: '2026-11-07',
      cover: 'https://m.media-amazon.com/images/I/5476279._SL500_.jpg',
    });
    expect(p.entries[1]).toMatchObject({ authors: ['X', 'Y'], date: null });
    // Not a Bookmeter list (an error page): refused, never an empty list.
    expect(parseListPage('<html>Service Unavailable</html>')).toBeNull();
  });

  it('reads the profile and the user id from what the user typed', () => {
    expect(parseProfile(profilePage('42', [129, 1, 6, 114]), '42')).toEqual({
      name: 'someone & co',
      counts: { read: 129, reading: 1, stacked: 6, wish: 114 },
    });
    expect(userIdFrom('1292614')).toBe('1292614');
    expect(userIdFrom('https://bookmeter.com/users/1292614/books/wish?page=2')).toBe('1292614');
    expect(userIdFrom('https://bookmeter.com/users/1292614')).toBe('1292614');
    expect(userIdFrom('https://example.com/users/1')).toBeNull();
  });
});

describe('the copy a status goes on', () => {
  it('reads first: read or opened, then the saved id, then the oldest', () => {
    const books = [
      { id: 'a', createdAt: 1, savedId: null },
      { id: 'b', createdAt: 2, savedId: '9' },
      { id: 'c', createdAt: 3, savedId: null },
    ];
    expect(targetBook(books, '9', new Map())).toBe('b');
    expect(targetBook(books, '8', new Map())).toBe('a');
    expect(targetBook(books, '9', new Map([['c', { state: false, position: true }]]))).toBe('c');
    expect(
      targetBook(
        books,
        '9',
        new Map([
          ['c', { state: false, position: true }],
          ['a', { state: true, position: false }],
        ]),
      ),
    ).toBe('a');
    expect(targetBook([], '9', new Map())).toBeNull();
  });
});

// ------------------------------------------------------------------ the service

const envs: IndexerEnv[] = [];
const cleanups: { db: Database.Database; dir: string }[] = [];
const services: BookmeterSync[] = [];
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
  { title: '魔法律学校の麗人執事3 シーサイド・アドベンチャー', sort: 'a', authors: ['新川 帆立'] },
  { title: 'コンビニ人間', sort: 'b', authors: ['村田 沙耶香'] },
  { title: 'コンビニ人間', sort: 'c', authors: ['村田 沙耶香'] },
  { title: '妹さえいればいい。', sort: 'd', authors: ['平坂 読'] },
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
  const rows = e.db.prepare('SELECT id, title FROM books ORDER BY title_sort').all() as {
    id: string;
    title: string;
  }[];
  return { e, root, lib, rows };
}

const queued = new Map<FetchQueue, () => number>();

function fetchQueue() {
  const dir = makeTempDir('bookmeter-queue-');
  const db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
  cleanups.push({ db, dir });
  const s = getSettings(db).fetch;
  const sites = Object.fromEntries(
    Object.keys(s.sites).map((k) => [k, { ...s.sites[k], intervalSeconds: 0.25 }]),
  );
  updateSettings(db, { fetch: { ...s, sites } });
  const q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
  queued.set(
    q,
    () =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM fetch_requests WHERE state IN ('queued', 'leased')")
          .get() as { n: number }
      ).n,
  );
  return { q, db };
}

const answer = (html: string, status = 200) => ({
  status,
  ms: 10,
  error: null,
  body: brotliCompressSync(Buffer.from(html)),
  encoding: 'br' as const,
});

function service(db: Database.Database, q: FetchQueue) {
  const notifications = { notify: vi.fn(), addDigestLine: vi.fn(), poke: vi.fn() };
  const s = new BookmeterSync({
    db,
    queue: () => q,
    notifications,
    log: () => {},
    tickMs: 3_600_000,
  });
  s.attachSync(new SyncStore(db));
  services.push(s);
  return { s, notifications };
}

/** Answers every claimed request from `pages` (url → html, or a status number). */
async function serve(q: FetchQueue, pages: Record<string, string | number>): Promise<string[]> {
  const asked: string[] = [];
  for (let round = 0; round < 400; round++) {
    const { requests } = q.claim();
    if (requests.length === 0) {
      if ((queued.get(q)?.() ?? 0) === 0) break;
      await new Promise((r) => setTimeout(r, 60));
      continue;
    }
    for (const r of requests) {
      asked.push(r.url);
      const p = pages[r.url];
      if (p === undefined) throw new Error(`no page for ${r.url}`);
      q.report(r.id, r.leaseToken, typeof p === 'number' ? answer('', p) : answer(p));
    }
  }
  return asked;
}

const U = 'https://bookmeter.com/users/777';

function pagesFor(read: Item[], wish: Item[], extra: Record<string, string | number> = {}) {
  const pages: Record<string, string | number> = {
    [U]: profilePage('777', [read.length, 0, 0, wish.length]),
    [`${U}/books/reading`]: listPage('読んでる本', 0, []),
    [`${U}/books/stacked`]: listPage('積読本', 0, []),
    [`${U}/books/wish`]: listPage('読みたい本', wish.length, wish.slice(0, 20)),
    [`${U}/books/read`]: listPage('読んだ本', read.length, read.slice(0, 20)),
  };
  for (let p = 2; p <= Math.ceil(read.length / 20); p++)
    pages[`${U}/books/read?page=${p}`] = listPage(
      '読んだ本',
      read.length,
      read.slice((p - 1) * 20, p * 20),
    );
  return { ...pages, ...extra };
}

/** Runs ticks and answers until the account's check is done. */
async function check(s: BookmeterSync, q: FetchQueue, pages: Record<string, string | number>) {
  const asked: string[] = [];
  for (let i = 0; i < 6; i++) {
    await s.tick();
    asked.push(...(await serve(q, pages)));
    await s.tick();
    if (!s.status().accounts.some((a) => a.checking)) break;
  }
  return asked;
}

const filler = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(900000 + i),
    title: `存在しない本 ${i}`,
    authors: ['誰か'],
    date: '2025/01/01',
  }));

describe('the checks, matching and records', () => {
  it('reads every page, matches by saved id and by the rules, and tells every device', async () => {
    const { e, rows } = await env();
    const { q } = fetchQueue();
    const { s } = service(e.db, q);
    const [mahou, konbini1, konbini2, imouto] = [rows[0], rows[1], rows[2], rows[3]];
    // The cleanup saved the most-registered listing; the user logged another one.
    e.db
      .prepare(
        "INSERT INTO book_identifiers (book_id, type, value) VALUES (?, 'bookmeter', '9380622')",
      )
      .run(imouto.id);
    const read: Item[] = [
      {
        id: '9380622',
        title: '妹さえいればいい。 (ガガガ文庫 ひ 4-1)',
        authors: ['平坂 読'],
        date: '2026/06/29',
      },
      {
        id: '13029012',
        title: 'コンビニ人間 (文春文庫 む 16-1)',
        authors: ['村田 沙耶香'],
        date: '2025/03/01',
      },
      ...filler(20),
      // Read twice: an older read with no date (日付不明) is listed last; the dated read stays.
      {
        id: '9380622',
        title: '妹さえいればいい。 (ガガガ文庫 ひ 4-1)',
        authors: ['平坂 読'],
        date: '日付不明',
      },
    ];
    const wish: Item[] = [
      {
        id: '22956269',
        title: '魔法律学校の麗人執事３　シーサイド・アドベンチャー',
        authors: ['新川 帆立'],
      },
      { id: '11111', title: 'まだない本', authors: ['未来の作者'] },
    ];
    s.addAccount({ userId: '777' });
    const asked = await check(s, q, pagesFor(read, wish));
    // A full check: the profile, page 1 of each list, then the rest of the read list.
    expect(asked).toContain(`${U}/books/read?page=2`);
    const st = s.status().accounts[0];
    expect(st.name).toBe('someone & co');
    expect(st.entries).toEqual({ read: 22, reading: 0, stacked: 0, wish: 2 });
    expect(st.matched).toBe(3);
    expect(st.checking).toBeNull();

    const links = e.db
      .prepare('SELECT listing_id, book_id, how FROM bookmeter_links ORDER BY listing_id, book_id')
      .all();
    expect(links).toEqual(
      [
        { listing_id: '13029012', book_id: konbini1.id, how: 'rules' },
        { listing_id: '13029012', book_id: konbini2.id, how: 'rules' },
        { listing_id: '22956269', book_id: mahou.id, how: 'rules' },
        { listing_id: '9380622', book_id: imouto.id, how: 'saved-id' },
      ].sort(
        (a, b) => a.listing_id.localeCompare(b.listing_id) || a.book_id.localeCompare(b.book_id),
      ),
    );

    const user = listUsers(e.db)[0];
    const recs = e.db
      .prepare(
        `SELECT id, data FROM sync_records WHERE user_id = ? AND kind = ? AND deleted_at IS NULL`,
      )
      .all(user.id, BOOKMETER_ENTRY_KIND) as { id: string; data: string }[];
    expect(recs).toHaveLength(24);
    const konbini = JSON.parse(recs.find((r) => r.id.endsWith(':13029012'))!.data);
    expect(konbini).toMatchObject({ list: 'read', date: '2025-03-01', how: 'rules' });
    const imo = JSON.parse(recs.find((r) => r.id.endsWith(':9380622'))!.data);
    expect(imo).toMatchObject({
      list: 'read',
      date: '2026-06-29',
      how: 'saved-id',
      target: imouto.id,
    });
    expect(konbini.books.sort()).toEqual([konbini1.id, konbini2.id].sort());
    // Two copies, neither read: the oldest.
    expect([konbini1.id, konbini2.id]).toContain(konbini.target);

    // bookmeter: in the catalog.
    const auth = { Authorization: `Bearer ${e.token()}` };
    const titles = async (qs: string) =>
      (
        (await request(e.app).get('/api/v1/books').query({ q: qs }).set(auth)).body.books as {
          title: string;
        }[]
      )
        .map((b) => b.title)
        .sort();
    expect(await titles('bookmeter:wish')).toEqual([
      '魔法律学校の麗人執事3 シーサイド・アドベンチャー',
    ]);
    expect(await titles('bookmeter:read')).toEqual([
      'コンビニ人間',
      'コンビニ人間',
      '妹さえいればいい。',
    ]);
    expect(await titles('-bookmeter:read,wish')).toEqual([]);

    // The 読みたい本 collection was made for every user.
    const acc = s.settings().accounts[0];
    const col = e.db
      .prepare("SELECT data FROM sync_records WHERE kind = 'collection' AND id = ?")
      .get(acc.collectionId) as { data: string };
    expect(JSON.parse(col.data)).toMatchObject({ type: 'smart', query: 'bookmeter:wish' });

    // Unmatched: the made-up books, read first, with no near books.
    const um = s.unmatched(acc.id);
    expect(um.unmatched.map((x) => x.listingId)).toContain('11111');
    expect(um.unmatched[0].list).toBe('read');
  });

  it('never reads a refused page as an empty list, and a quick check removes nothing it can’t see', async () => {
    const { e } = await env();
    const { q } = fetchQueue();
    const { s } = service(e.db, q);
    const read = [
      { id: '13029012', title: 'コンビニ人間', authors: ['村田 沙耶香'], date: '2025/03/01' },
      ...filler(25),
    ];
    const acc = s.addAccount({ userId: '777' });
    await check(s, q, pagesFor(read, []));
    expect(s.status().accounts[0].entries.read).toBe(26);

    // A full check whose page 2 is refused (busy, again and again) changes nothing.
    const fs2 = getSettings((q as unknown as { db: Database.Database }).db).fetch;
    void fs2;
    s.checkNow(acc.id);
    const busy = pagesFor(read.slice(0, 20), [], { [`${U}/books/read?page=2`]: 404 });
    busy[`${U}/books/read`] = listPage('読んだ本', 26, read.slice(0, 20));
    await check(s, q, busy);
    const st = s.status().accounts[0];
    expect(st.error).toMatch(/Page 2 of read/);
    expect(st.entries.read).toBe(26);

    // A quick check sees page 1 only: the books further down stay.
    e.db.prepare('UPDATE bookmeter_state SET quick_at = 0, error_at = NULL').run();
    const fresh = [
      { id: '5555', title: '新しい本', authors: ['誰か'], date: '2026/11/20' },
      ...read,
    ];
    await check(
      s,
      q,
      pagesFor(fresh.slice(0, 20), [], {
        [`${U}/books/read`]: listPage('読んだ本', 27, fresh.slice(0, 20)),
      }),
    );
    expect(s.status().accounts[0].entries.read).toBe(27);

    // A full check removes a book that left the list.
    s.checkNow(acc.id);
    const shorter = fresh.filter((x) => x.id !== '13029012');
    await check(s, q, pagesFor(shorter, []));
    expect(s.status().accounts[0].entries.read).toBe(26);
    expect(
      e.db.prepare("SELECT 1 FROM bookmeter_entries WHERE listing_id = '13029012'").get(),
    ).toBeUndefined();
    const user = listUsers(e.db)[0];
    const rec = e.db
      .prepare('SELECT deleted_at FROM sync_records WHERE user_id = ? AND kind = ? AND id = ?')
      .get(user.id, BOOKMETER_ENTRY_KIND, `${acc.id}:13029012`) as { deleted_at: number | null };
    expect(rec.deleted_at).not.toBeNull();
  });

  it("keeps the user's choice, keeps to the account's libraries, and tells a wanted book's arrival once", async () => {
    const { e, lib, rows } = await env();
    const { q } = fetchQueue();
    const { s, notifications } = service(e.db, q);
    const wish: Item[] = [
      { id: '700', title: '新刊の本 (電撃文庫)', authors: ['新しい 作者'] },
      { id: '13029012', title: 'コンビニ人間', authors: ['村田 沙耶香'] },
    ];
    const acc = s.addAccount({ userId: '777' });
    await check(s, q, pagesFor([], wish));
    expect(notifications.notify).not.toHaveBeenCalled();

    // Not in my library, then Forget my choice; Link to one copy.
    s.choose(acc.id, '13029012', null);
    expect(
      e.db.prepare("SELECT COUNT(*) AS n FROM bookmeter_links WHERE listing_id = '13029012'").get(),
    ).toEqual({ n: 0 });
    expect(s.unmatched(acc.id).notInLibrary.map((x) => x.listingId)).toEqual(['13029012']);
    s.choose(acc.id, '13029012', undefined);
    expect(
      e.db.prepare("SELECT COUNT(*) AS n FROM bookmeter_links WHERE listing_id = '13029012'").get(),
    ).toEqual({ n: 2 });
    s.choose(acc.id, '13029012', rows[2].id);
    expect(
      e.db.prepare("SELECT book_id, how FROM bookmeter_links WHERE listing_id = '13029012'").all(),
    ).toEqual([{ book_id: rows[2].id, how: 'user' }]);

    // The wanted book arrives in the library: told once (and a digest line).
    await new Promise((r) => setTimeout(r, 5));
    await lib.addBook({
      title: '新刊の本',
      sort: 'z',
      authors: ['新しい 作者'],
      timestamp: calibreDate(new Date()),
    });
    await e.indexer.tick();
    await s.tick();
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({
      event: 'bookmeter_wanted_arrived',
    });
    expect(notifications.addDigestLine).toHaveBeenCalledTimes(1);
    await s.tick();
    s.updateAccount(acc.id, { statuses: true });
    expect(notifications.notify).toHaveBeenCalledTimes(1);

    // Only the account's libraries: a library it doesn't cover matches nothing.
    e.db
      .prepare(
        "INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at) VALUES ('other', 'other', 'other', 'ja', 1, 0, 0)",
      )
      .run();
    s.updateAccount(acc.id, { libraries: ['other'] });
    expect(s.status().accounts[0].matched).toBe(0);
  });
});

describe('the routes and the record kinds', () => {
  it('adds, checks and removes an account; refuses a bad user; devices cannot write entries', async () => {
    const { e } = await env();
    const { q } = fetchQueue();
    const { s } = service(e.db, q);
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.auth = { user: listUsers(e.db)[0] };
      next();
    });
    app.use(createBookmeterRouter(s));
    app.use(
      (
        err: { status?: number; code?: string; message: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        void _next;
        res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
      },
    );
    expect((await request(app).post('/bookmeter/accounts').send({ user: 'nobody' })).status).toBe(
      400,
    );
    const added = await request(app)
      .post('/bookmeter/accounts')
      .send({ user: 'https://bookmeter.com/users/777' });
    expect(added.status).toBe(201);
    expect(added.body.accounts[0].checking).toMatchObject({ kind: 'full' });
    expect((await request(app).post('/bookmeter/accounts').send({ user: '777' })).status).toBe(400);
    const id = added.body.account.id as string;
    await check(s, q, pagesFor([], []));
    expect((await request(app).get('/bookmeter/finished-here')).body).toEqual({ books: [] });
    expect(
      (await request(app).put('/bookmeter/settings').send({ askAbove: 5 })).body.settings.askAbove,
    ).toBe(5);
    expect((await request(app).put('/bookmeter/settings').send({ askAbove: -1 })).status).toBe(400);
    expect(
      (await request(app).post(`/bookmeter/accounts/${id}/reviewed`)).body.account.reviewedAt,
    ).not.toBeNull();
    expect((await request(app).delete(`/bookmeter/accounts/${id}`)).body.accounts).toEqual([]);

    // A device can't write a bookmeter-entry; it can write bookmeter-applied (checked).
    const user = listUsers(e.db)[0];
    const store = new SyncStore(e.db);
    const device = 'dev-1';
    e.db
      .prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, 0)')
      .run(device, user.id);
    const bookId = (e.db.prepare('SELECT id FROM books LIMIT 1').get() as { id: string }).id;
    const now = Date.now();
    expect(
      store.writeAs(
        user.id,
        device,
        {
          kind: 'bookmeter-entry',
          id: `${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}:1`,
          updatedAt: now,
          data: {},
        },
        now,
      ).status,
    ).toBe('rejected');
    const applied = (data: Record<string, unknown>) =>
      store.writeAs(
        user.id,
        device,
        { kind: 'bookmeter-applied', id: bookId, updatedAt: Date.now(), data },
        Date.now(),
      ).status;
    const ok = {
      account: '11111111-1111-1111-1111-111111111111',
      listing: '123',
      list: 'read',
      date: '2026-10-17',
      outcome: 'applied',
      at: now,
    };
    expect(applied(ok)).toBe('applied');
    expect(applied({ ...ok, list: 'wish' })).toBe('rejected');
    expect(applied({ ...ok, extra: 1 })).toBe('rejected');
  });
});
