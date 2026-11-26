/**
 * Bookmeter links (bookmeter-listings.md): the pick of the listing readers log (store-links.ts:
 * the 登録 count, the most registered of the listings that are the book, the comic and
 * adaptation guards), and the one-time pass over the saved ids (stage4/bookmeter-listing.ts) on a
 * real cleanup.db and fetch queue with a stand-in stage 4: every phase, the proposals that replace
 * only the bookmeter id, never a user field or after an Undo, the spot check's gate before On, the
 * write by its own analysis id, and the polled queries' plans.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { brotliCompressSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEANUP_SCHEMA_VERSION, openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import type { BookmeterFacts, Stage4Analysis } from '../src/cleanup/stage4/analysis';
import { adaptationListing } from '../src/cleanup/stage4/bookmeter-rules';
import {
  BL_SEARCH_VERSION,
  BookmeterListings,
  refusedWaitMs,
  decideListing,
  emptyBlProgress,
  listingAnalysisId,
  listingBar,
  mergeAnswers,
  replaceBookmeter,
} from '../src/cleanup/stage4/bookmeter-listing';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import {
  BOOKMETER_AUTHOR_LIST_KEY,
  acceptBookmeter,
  authorWalkGoesOn,
  bookListings,
  bookmeterAuthor,
  bookmeterAuthorPage,
  parseBookmeterSearch,
  type BookmeterBook,
  type BookmeterHit,
} from '../src/cleanup/stage4/store-links';
import { makeTempDir } from './helpers/spawn-server';

const LIB = 'lib1';

/** A search answer as Bookmeter's list writes it (with each listing's 登録 count). */
function searchPage(
  items: { id: string; whole: string; authors: string[]; reg?: number | string }[],
): string {
  const cut = (t: string) => ([...t].length > 22 ? [...t].slice(0, 22).join('') + '…' : t);
  return (
    '<ul class="books">' +
    items
      .map(
        (b) =>
          `<li class="group__book"><div class="book__thumbnail"><div class="thumbnail__cover"><a href="/books/${b.id}"><img alt="${b.whole}" class="cover__image" src="x" /></a></div></div>` +
          `<div class="detail__title"><a href="/books/${b.id}">${cut(b.whole)}</a></div>` +
          `<ul class="detail__authors">${b.authors.map((a) => `<li><a href="/a">${a}</a></li>`).join('')}</ul>` +
          `<div class="detail__page">200</div>` +
          (b.reg !== undefined
            ? `<dl class="detail__options"><dt class="options__title">登録</dt><dd class="options__item">${b.reg}</dd></dl>`
            : '') +
          `</li>`,
      )
      .join('') +
    '</ul>'
  );
}

const answer = (s: string, status = 200) => ({
  status,
  ms: 10,
  error: null,
  body: brotliCompressSync(Buffer.from(s)),
  encoding: 'br' as const,
});

const LN: BookmeterBook = {
  title: '庶民サンプル 2',
  authors: ['七月隆文'],
  own: ['庶民サンプル 2'],
  chosen: { series: '庶民サンプル', ix: 2, fmt: 'light novel', calTitle: '庶民サンプル 2' },
};

const hit = (id: string, title: string, authors: string[], reg?: number | null): BookmeterHit => ({
  id,
  title,
  listTitle: title,
  authors,
  pages: 200,
  ...(reg !== undefined ? { registrations: reg } : {}),
});

describe('Bookmeter links: the pick', () => {
  it("reads each listing's 登録 count from the search list (commas too)", () => {
    const hits = parseBookmeterSearch(
      searchPage([
        { id: '1', whole: 'A', authors: ['x'], reg: '1,234' },
        { id: '2', whole: 'B', authors: ['x'] },
      ]),
    );
    expect(hits.map((h) => h.registrations)).toEqual([1234, null]);
  });

  it('takes the most registered listing that is the book, the first on a tie or without counts', () => {
    const kindle = hit('6542818', '庶民サンプル 2 (Kindle版)', ['七月 隆文'], 18);
    const paper = hit('7000001', '庶民サンプル 2 (星海社FICTIONS)', ['七月 隆文'], 444);
    const other = hit('9', '庶民サンプル 3', ['七月 隆文'], 9000);
    expect(acceptBookmeter([kindle, other, paper], LN).hit?.id).toBe('7000001');
    expect(acceptBookmeter([kindle, other, paper], LN).reason).toMatch(/most registered of 2/);
    expect(
      acceptBookmeter(
        [
          { ...kindle, registrations: 5 },
          { ...paper, registrations: 5 },
        ],
        LN,
      ).hit?.id,
    ).toBe('6542818');
    // Results stored before the counts: Bookmeter's order, as before.
    const old = (h: BookmeterHit) => ({ ...h, registrations: undefined });
    expect(acceptBookmeter([old(kindle), old(paper)], LN).hit?.id).toBe('6542818');
  });

  it('sets aside a comic edition of a text book in the first tier too (not for manga, not when the title says マンガ)', () => {
    const book: BookmeterBook = {
      title: 'ゴールデンキッズ 2',
      authors: ['作者'],
      chosen: { series: null, ix: 2, fmt: 'novel', calTitle: 'ゴールデンキッズ 2' },
    };
    const comic = hit('1', 'ゴールデンキッズ 2 (愛蔵版コミックス)', ['作者'], 300);
    const novel = hit('2', 'ゴールデンキッズ 2 (文庫)', ['作者'], 10);
    expect(acceptBookmeter([comic, novel], book).hit?.id).toBe('2');
    expect(acceptBookmeter([comic], book)).toEqual({
      hit: null,
      reason: 'only a comic edition (a comic label the book does not have)',
    });
    expect(
      acceptBookmeter([comic, novel], { ...book, chosen: { ...book.chosen!, fmt: 'manga' } }).hit
        ?.id,
    ).toBe('1');
    const eromanga: BookmeterBook = {
      title: 'エロマンガ先生 3',
      authors: ['伏見つかさ'],
      chosen: { series: 'エロマンガ先生', ix: 3, fmt: 'light novel', calTitle: 'エロマンガ先生 3' },
    };
    expect(
      acceptBookmeter([hit('5', 'エロマンガ先生 3 (電撃文庫)', ['伏見 つかさ'], 900)], eromanga).hit
        ?.id,
    ).toBe('5');
  });

  it("sets aside a manga adaptation credited (原作) to the book's author, never a novelization by the book's own author", () => {
    expect(adaptationListing(['むらさきゆきや'], ['福田 直叶,(原作)むらさき ゆきや'])).toBe(true);
    expect(adaptationListing(['むらさきゆきや'], ['むらさき ゆきや'])).toBe(false);
    expect(adaptationListing(['昼熊'], ['昼熊,(原作)暁 なつめ'])).toBe(false);
    expect(adaptationListing(['むらさきゆきや'], ['むらさき ゆきや 原作'])).toBe(false); // nobody else
    const book: BookmeterBook = {
      title: '異世界魔王と召喚少女の奴隷魔術 3',
      authors: ['むらさきゆきや'],
      chosen: {
        series: '異世界魔王と召喚少女の奴隷魔術',
        ix: 3,
        fmt: 'light novel',
        calTitle: '異世界魔王と召喚少女の奴隷魔術3',
      },
    };
    const manga = hit(
      '13876810',
      '異世界魔王と召喚少女の奴隷魔術（３）',
      ['福田 直叶,(原作)むらさき ゆきや'],
      50,
    );
    const novel = hit(
      '8000',
      '異世界魔王と召喚少女の奴隷魔術 3 (講談社ラノベ文庫)',
      ['むらさき ゆきや'],
      20,
    );
    expect(acceptBookmeter([manga, novel], book).hit?.id).toBe('8000');
    expect(acceptBookmeter([manga], book).reason).toMatch(/adaptation/);
  });

  it('decides a saved id: change to more registrations, keep on a tie, adaptation, unseen', () => {
    const kindle = hit('6542818', '庶民サンプル 2 (Kindle版)', ['七月 隆文'], 18);
    const paper = hit('7000001', '庶民サンプル 2', ['七月 隆文'], 444);
    expect(decideListing('6542818', [kindle, paper], LN)).toMatchObject({
      state: 'change',
      saved: { id: '6542818', registrations: 18 },
      pick: { id: '7000001', registrations: 444 },
      listings: 2,
    });
    expect(decideListing('7000001', [kindle, paper], LN).state).toBe('keep');
    expect(decideListing('6542818', [kindle, { ...paper, registrations: 18 }], LN).state).toBe(
      'keep',
    );
    // The saved listing is in none of the answers, or its count is not shown: nothing changes.
    expect(decideListing('555', [kindle, paper], LN).state).toBe('unseen');
    expect(decideListing('6542818', [{ ...kindle, registrations: null }, paper], LN).state).toBe(
      'unseen',
    );
    // Saved to a manga adaptation: the novel's own listing, whatever the counts.
    const book: BookmeterBook = { ...LN, authors: ['むらさきゆきや'] };
    const manga = hit('1', '庶民サンプル 2', ['福田 直叶,(原作)むらさき ゆきや'], 900);
    const novel = hit('2', '庶民サンプル 2', ['むらさき ゆきや'], 3);
    expect(decideListing('1', [manga, novel], book)).toMatchObject({
      state: 'change',
      savedGuard: 'adaptation',
      pick: { id: '2' },
    });
    expect(decideListing('1', [manga], book)).toMatchObject({ state: 'adaptation', pick: null });
  });

  it("merges the answers in order, each listing once, with the latest answer's count", () => {
    const a = hit('1', 'x', ['a'], 5);
    const b = hit('2', 'y', ['a'], null);
    const m = mergeAnswers([
      [a, b],
      [hit('2', 'y', ['a'], 70), hit('1', 'x', ['a'], 6)],
    ]);
    expect(m.map((h) => [h.id, h.registrations])).toEqual([
      ['1', 6],
      ['2', 70],
    ]);
  });

  it('replaces only the bookmeter id; every other id stays as it is', () => {
    const ids = { isbn: '9784061234567', amazon_jp: 'B0X', bookmeter: '1', rakuten: 'rk/abc' };
    expect(replaceBookmeter(ids, '2')).toEqual({ ...ids, bookmeter: '2' });
  });

  it("reads an author's listings page by page, keyed by the first author (the keyword is ignored by Bookmeter)", () => {
    expect(bookmeterAuthor(['七月 隆文', 'x'])).toBe('七月隆文');
    expect(bookmeterAuthor([])).toBeNull();
    expect(bookmeterAuthor(['Unknown'])).toBeNull();
    expect(bookmeterAuthorPage('七月隆文', 2)).toEqual({
      key: `${BOOKMETER_AUTHOR_LIST_KEY}七月隆文\n2`,
      url: expect.stringMatching(
        /author=%E4%B8%83%E6%9C%88%E9%9A%86%E6%96%87&keyword=&partial=true&sort=recommended&type=japanese&page=2$/,
      ),
      accept: 'text/html, */*; q=0.01',
    });
    const page = (n: number, last: number | null) =>
      Array.from({ length: n }, (_, i) => hit(String(i), 'x', ['a'], i === n - 1 ? last : 900));
    // Goes on while the page is full, under the limit, and its last count beats the stop.
    expect(authorWalkGoesOn(page(20, 31), 1, 30, 8)).toBe(true);
    expect(authorWalkGoesOn(page(20, 30), 1, 30, 8)).toBe(false);
    expect(authorWalkGoesOn(page(19, 900), 1, 0, 8)).toBe(false);
    expect(authorWalkGoesOn(page(20, 900), 8, 0, 8)).toBe(false);
    expect(authorWalkGoesOn(page(20, null), 1, 30, 8)).toBe(true);
  });

  it('takes another listing of the same book once its own listing is known, never as a first match', () => {
    const book: BookmeterBook = {
      title: '狼と香辛料II',
      authors: ['支倉凍砂'],
      own: ['狼と香辛料II'],
      chosen: { series: '狼と香辛料', ix: 2, fmt: 'light novel', calTitle: '狼と香辛料II' },
    };
    const kindle = hit('8229663', '狼と香辛料II (電撃文庫)', ['支倉 凍砂'], 194);
    const paper = hit('577843', '狼と香辛料 (2) (電撃文庫)', ['支倉 凍砂'], 4150);
    const vol3 = hit('577844', '狼と香辛料 (3) (電撃文庫)', ['支倉 凍砂'], 3737);
    const comic = hit('572959', '狼と香辛料(2) (電撃コミックス)', ['小梅 けいと,文倉 十'], 565);
    expect(acceptBookmeter([kindle, vol3, comic, paper], book)).toMatchObject({
      hit: { id: '577843' },
      reason: 'another listing of the same book (as-written); the most registered of 2 listings',
    });
    // The paperback alone is no first match (the checks don't take it).
    expect(acceptBookmeter([paper, vol3], book).hit).toBeNull();
    expect(bookListings([paper, vol3], book).map((l) => l.hit.id)).toEqual([]);
    // The saved listing makes the book's own listing known (the AI check's ids too).
    expect(bookListings([paper, vol3], book, undefined, '8229663').map((l) => l.hit.id)).toEqual(
      [],
    );
    expect(
      bookListings([kindle, paper, vol3], book, undefined, '8229663').map((l) => [l.hit.id, l.via]),
    ).toEqual([
      ['8229663', 1],
      ['577843', 'as-written'],
    ]);
    expect(decideListing('8229663', [kindle, paper, vol3, comic], book)).toMatchObject({
      state: 'change',
      pick: { id: '577843', registrations: 4150 },
      via: 'as-written',
    });
  });

  it('times the search from the authors left at the pace since every book was queued', () => {
    const p = emptyBlProgress(1, LIB);
    p.phaseStartedAt = 0;
    p.search = { looked: 10, asked: 10, answered: 0, enqueued: false, failed: 0, since: null };
    p.books = 10;
    expect(listingBar(p, 1000, { open: 0, written: 0, toWrite: 0, pace: null })).toMatchObject({
      done: 10,
      total: 10,
      leftMs: null,
    });
    p.search = {
      looked: 400,
      asked: 400,
      answered: 250,
      enqueued: true,
      failed: 0,
      authors: 350,
      walked: 200,
      since: { at: 1000, answered: 0 },
    };
    // 200 walks ended in 400 s since queuing: 150 open take 300 s.
    expect(listingBar(p, 401_000, { open: 150, written: 0, toWrite: 0, pace: null })).toMatchObject(
      { done: 200, total: 350, leftMs: 300_000 },
    );
  });
});

interface Book {
  uuid: string;
  id: number;
  title: string;
  authors: string[];
  ids: Record<string, string>;
  fmt?: string;
  /** Stage 4's stored search (its request id) and the hits it stored. */
  search: number | null;
  hits: BookmeterHit[];
}

describe('Bookmeter links: the pass', () => {
  let dir: string;
  let db: Database.Database;
  let q: FetchQueue;
  let books: Map<string, Book>;
  let planned: string[];
  let stamp: number;
  let clock = Date.now();
  const tick = () => (clock += 1000);

  const facts = (uuid: string): BookmeterFacts | null => {
    const b = books.get(uuid);
    if (!b) return null;
    return {
      book: {
        calibreId: b.id,
        uuid,
        title: b.title,
        authors: b.authors,
        identifiers: b.ids,
      } as never,
      input: {
        title: b.title,
        authors: b.authors,
        own: [b.title],
        chosen: {
          series: null,
          ix: null,
          fmt: b.fmt ?? 'light novel',
          calTitle: b.title,
          opfTitle: b.title,
        },
      },
      kind: 'full',
      queryTitle: b.title,
      bookmeter: { hits: b.hits, accepted: { id: b.ids.bookmeter, reason: 'x' } },
      searchRequest: b.search,
      storeTitles: [],
      asin: null,
    };
  };

  const standIn = (): Stage4Analysis =>
    ({
      loadSnapshot: () => undefined,
      snapshotStamp: () => stamp,
      bookmeterSaved: () =>
        [...books.values()]
          .filter((b) => b.ids.bookmeter)
          .map((b) => ({ uuid: b.uuid, calibreId: b.id, saved: b.ids.bookmeter }))
          .sort((a, b) => (a.uuid < b.uuid ? -1 : 1)),
      bookmeterFacts: (_lib: string, uuid: string) => facts(uuid),
      snapshotBook: (_lib: string, uuid: string) => {
        const b = books.get(uuid);
        return b
          ? { calibreId: b.id, uuid, title: b.title, authors: b.authors, identifiers: b.ids }
          : null;
      },
    }) as unknown as Stage4Analysis;

  const pass = () =>
    new BookmeterListings({
      db,
      analysis: standIn(),
      queue: q,
      batches: {
        plan: async (_lib: string, o: { analysisId?: string }) => {
          const n = db
            .prepare(
              `UPDATE proposed_changes SET state = 'applied' WHERE analysis_id = ? AND state = 'proposed'`,
            )
            .run(o.analysisId).changes;
          if (!n) return { batch: null, reason: 'Nothing left to write' };
          planned.push(String(o.analysisId));
          return { batch: { id: 'b1' }, reason: null };
        },
      } as never,
      targetLibrary: () => LIB,
      stage4Done: () => true,
      writeWait: () => null,
      referenceFile: () => null,
    });

  const store = (key: string, body: string) => {
    const r = q.enqueue({ site: 'bookmeter', key, url: `https://bookmeter.com/x?${key}` }, null);
    for (;;) {
      const c = q.claim(tick()).requests.find((x) => x.id === r.id);
      if (!c) break;
      q.report(c.id, c.leaseToken, answer(body), clock);
    }
    return r.id;
  };

  /** The fetcher: answers every queued Bookmeter request by its address. */
  const fetchAll = (by: (url: string) => string) => {
    for (let i = 0; i < 50; i++) {
      const got = q.claim(tick()).requests;
      if (!got.length) return;
      for (const c of got) q.report(c.id, c.leaseToken, answer(by(c.url)), clock);
    }
  };

  const runUntil = async (p: BookmeterListings, stop: (phase: string) => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (stop(p.state().progress.phase)) return;
      const r = await p.step();
      if (r === 'idle' || r === 'wait') return;
    }
  };

  const add = (
    b: Omit<Book, 'search' | 'hits'>,
    stored: Parameters<typeof searchPage>[0] | null,
  ) => {
    const page = stored ? searchPage(stored) : null;
    const search = page ? store(`search-jp:${b.title}`, page) : null;
    books.set(b.uuid, { ...b, search, hits: page ? parseBookmeterSearch(page) : [] });
    db.prepare(
      `INSERT INTO stage4_books (library_id, calibre_uuid, calibre_id, analysis_id, labeled, state, pending, updated_at)
       VALUES (?, ?, ?, 'a1', 0, 'proposed', 0, 0)`,
    ).run(LIB, b.uuid, b.id);
  };

  const rows = () =>
    db
      .prepare('SELECT calibre_uuid AS u, state FROM bookmeter_listing_books ORDER BY calibre_uuid')
      .all() as { u: string; state: string }[];
  const proposals = () =>
    db
      .prepare(
        'SELECT calibre_uuid AS u, old_json, new_json, state, analysis_id FROM proposed_changes ORDER BY calibre_uuid',
      )
      .all() as {
      u: string;
      old_json: string;
      new_json: string;
      state: string;
      analysis_id: string;
    }[];

  /** Each author's listings on Bookmeter, most registered first; served 20 a page. */
  const live: Record<string, Parameters<typeof searchPage>[0]> = {};
  const asked: string[] = [];
  const byUrl = (url: string) => {
    const au = decodeURIComponent(/author=([^&]*)/.exec(url)?.[1] ?? '');
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 1);
    asked.push(`${au}#${page}`);
    return searchPage((live[au] ?? []).slice((page - 1) * 20, page * 20));
  };

  beforeEach(() => {
    dir = makeTempDir('bm-listing-');
    db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
    const s = getSettings(db).fetch;
    updateSettings(db, {
      fetch: {
        ...s,
        sites: { ...s.sites, bookmeter: { enabled: true, intervalSeconds: 0.25, inFlight: 4 } },
      },
    });
    q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
    books = new Map();
    planned = [];
    stamp = 1;
    for (const k of Object.keys(live)) delete live[k];
    asked.length = 0;
    const au = ['七月 隆文'];
    // a: saved the Kindle listing; only the author's listings show the paperback (page 2).
    add(
      {
        uuid: 'a',
        id: 1,
        title: '庶民サンプル 2',
        authors: ['七月隆文'],
        ids: { bookmeter: '6542818', isbn: '978', amazon_jp: 'B0A' },
      },
      [{ id: '6542818', whole: '庶民サンプル 2 (Kindle版)', authors: au, reg: 18 }],
    );
    live['七月隆文'] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `90${i}`,
        whole: `ぼくは明日、昨日のきみとデートする ${i + 1}`,
        authors: au,
        reg: 9000 - i,
      })),
      { id: '7000001', whole: '庶民サンプル 2 (星海社FICTIONS)', authors: au, reg: 444 },
      { id: '6826860', whole: '庶民サンプル 7', authors: au, reg: 444 },
      // Under every saved count from here: never read (page 3).
      ...Array.from({ length: 18 }, (_, i) => ({
        id: `80${i}`,
        whole: `他の本 ${i}`,
        authors: au,
        reg: 3,
      })),
      { id: '6542818', whole: '庶民サンプル 2 (Kindle版)', authors: au, reg: 2 },
    ];
    // b: already the most registered listing.
    add(
      {
        uuid: 'b',
        id: 2,
        title: '庶民サンプル 7',
        authors: ['七月隆文'],
        ids: { bookmeter: '6826860' },
      },
      [
        { id: '6826860', whole: '庶民サンプル 7', authors: au, reg: 444 },
        { id: '7', whole: '庶民サンプル 7 (Kindle版)', authors: au, reg: 4 },
      ],
    );
    // c: saved to the manga adaptation; the new search finds the novel.
    add(
      {
        uuid: 'c',
        id: 3,
        title: '異世界魔王と召喚少女の奴隷魔術 3',
        authors: ['むらさきゆきや'],
        ids: { bookmeter: '13876810' },
      },
      [
        {
          id: '13876810',
          whole: '異世界魔王と召喚少女の奴隷魔術 3',
          authors: ['福田 直叶,(原作)むらさき ゆきや'],
          reg: 50,
        },
      ],
    );
    live['むらさきゆきや'] = [
      {
        id: '8000',
        whole: '異世界魔王と召喚少女の奴隷魔術 3 (講談社ラノベ文庫)',
        authors: ['むらさき ゆきや'],
        reg: 20,
      },
    ];
    // d: a manga adaptation and no novel anywhere: listed, never changed.
    add(
      {
        uuid: 'd',
        id: 4,
        title: 'ビーストテイマー 9',
        authors: ['作者'],
        ids: { bookmeter: '99' },
      },
      [{ id: '99', whole: 'ビーストテイマー 9', authors: ['漫画家,(原作)作者'], reg: 5 }],
    );
  });

  afterEach(() => db.close());

  it('is cleanup.db v35 or later with its tables, Off by default', async () => {
    expect(CLEANUP_SCHEMA_VERSION).toBeGreaterThanOrEqual(35);
    const p = pass();
    expect(p.state().mode).toBe('off');
    expect(await p.step()).toBe('idle');
  });

  /** The pass and the fetcher in turn until the spot check (or nothing moves). */
  const drive = async (p: BookmeterListings) => {
    for (let i = 0; i < 20 && p.state().progress.phase === 'search'; i++) {
      await runUntil(p, (ph) => ph === 'spot');
      fetchAll(byUrl);
    }
    await runUntil(p, (ph) => ph === 'spot');
  };

  it("reads each author's listings page by page down to the saved counts, decides each book from them, and replaces only the bookmeter id", async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, () => false);
    expect(p.state().progress.phase).toBe('search');
    // One walk per first author (a and b share 七月隆文).
    expect(p.openSearches(LIB)).toBe(3);
    expect(rows().every((r) => r.state === 'search')).toBe(true);
    await drive(p);
    expect(p.openSearches(LIB)).toBe(0);
    // 七月隆文: page 2's last listing (3) is under the lowest saved count (18): no page 3.
    expect(asked.sort()).toEqual(['七月隆文#1', '七月隆文#2', '作者#1', 'むらさきゆきや#1'].sort());
    expect(p.state().progress.search).toMatchObject({ authors: 3, walked: 3, pages: 4 });
    expect(rows()).toEqual([
      { u: 'a', state: 'change' },
      { u: 'b', state: 'keep' },
      { u: 'c', state: 'change' },
      { u: 'd', state: 'adaptation' },
    ]);
    const pr = proposals();
    expect(pr.map((x) => x.u)).toEqual(['a', 'c']);
    expect(pr.every((x) => x.analysis_id === listingAnalysisId(1))).toBe(true);
    expect(JSON.parse(pr[0].old_json)).toEqual({
      bookmeter: '6542818',
      isbn: '978',
      amazon_jp: 'B0A',
    });
    expect(JSON.parse(pr[0].new_json)).toEqual({
      bookmeter: '7000001',
      isbn: '978',
      amazon_jp: 'B0A',
    });
    expect(JSON.parse(pr[1].new_json)).toEqual({ bookmeter: '8000' });
    const list = p.listBooks(LIB, 1, 'change', 0, 20);
    expect(list.total).toBe(2);
    expect(list.items[0]).toMatchObject({
      saved: { id: '6542818', registrations: 18, url: 'https://bookmeter.com/books/6542818' },
      pick: { id: '7000001', registrations: 444 },
    });
  });

  it("reads the saved listing's count from the earlier run's own search when no other answer shows it", async () => {
    // e: matched by More Bookmeter coverage; stage 4's search never showed the saved listing, the
    // earlier run's author-field search (key by the decided title) did.
    add(
      {
        uuid: 'e',
        id: 5,
        title: '庶民サンプル 5',
        authors: ['七月隆文'],
        ids: { bookmeter: '555' },
      },
      [],
    );
    store(
      'search-jp-au:七月隆文\n庶民サンプル 5',
      searchPage([
        { id: '555', whole: '庶民サンプル 5 (Kindle版)', authors: ['七月 隆文'], reg: 6 },
      ]),
    );
    live['七月隆文'].splice(20, 0, {
      id: '7000005',
      whole: '庶民サンプル 5 (星海社FICTIONS)',
      authors: ['七月 隆文'],
      reg: 300,
    });
    const p = pass();
    p.setMode('analyse');
    await drive(p);
    expect(rows().find((r) => r.u === 'e')?.state).toBe('change');
    expect(p.listBooks(LIB, 1, 'change', 0, 20).items.find((x) => x.uuid === 'e')).toMatchObject({
      saved: { id: '555', registrations: 6 },
      pick: { id: '7000005', registrations: 300 },
    });
  });

  it('never looks at the user’s identifiers; looks at a saved id the AI check chose like the others', async () => {
    db.prepare(
      `INSERT INTO user_fields (library_id, calibre_uuid, field, since, source) VALUES (?, 'a', 'identifiers', 0, 'edit')`,
    ).run(LIB);
    db.prepare(
      `INSERT INTO bookmeter_more_books (library_id, calibre_uuid, calibre_id, state, source, hit_json, updated_at)
       VALUES (?, 'c', 3, 'ready', 'ai', '{"id":"13876810"}', 0)`,
    ).run(LIB);
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, () => false);
    expect(p.openSearches(LIB)).toBe(3);
    expect(rows().filter((r) => r.state !== 'search')).toEqual([{ u: 'a', state: 'yours' }]);
    await drive(p);
    expect(rows().find((r) => r.u === 'c')?.state).toBe('change');
  });

  it('holds a book with another open change, skips one whose saved id changed, and never proposes again after an Undo', async () => {
    const p = pass();
    p.setMode('analyse');
    await drive(p);
    db.prepare(`DELETE FROM proposed_changes`).run();
    db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source, class, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, 1, 'a', 'identifiers', '{}', '{}', 'x', 'auto', 'proposed', 'other', 0, 0)`,
    ).run(LIB);
    expect(p.proposeOne(LIB, 1, 'a')).toBe('held');
    db.prepare(`DELETE FROM proposed_changes WHERE analysis_id = 'other'`).run();
    books.get('a')!.ids = { ...books.get('a')!.ids, bookmeter: '1' };
    expect(p.proposeOne(LIB, 1, 'a')).toBe('gone');
    books.get('a')!.ids = { ...books.get('a')!.ids, bookmeter: '6542818', honto: '5' };
    expect(p.proposeOne(LIB, 1, 'a')).toBe('proposed');
    // Made from Calibre's identifiers now: the id added meanwhile stays.
    expect(JSON.parse(proposals()[0].new_json)).toMatchObject({ bookmeter: '7000001', honto: '5' });
    db.prepare(`UPDATE proposed_changes SET state = 'undone'`).run();
    expect(p.proposeOne(LIB, 1, 'a')).toBe('written');
    expect(p.proposeOne(LIB, 2, 'a')).toBe('written');
  });

  it('allows On only with every book of the spot check right, then writes by its own analysis id', async () => {
    const p = pass();
    p.setMode('analyse');
    await drive(p);
    await p.step();
    expect(() => p.setMode('on')).toThrow(/spot check/);
    const spot = p.listSpot(LIB, 1);
    expect(spot.map((s) => s.uuid).sort()).toEqual(['a', 'c']);
    for (const s of spot) p.setVerdict(s.uuid, 'right');
    p.setVerdict(spot[0].uuid, 'wrong');
    expect(() => p.setMode('on')).toThrow(/spot check/);
    p.setVerdict(spot[0].uuid, 'right');
    p.setMode('on');
    for (let i = 0; i < 50 && p.state().progress.phase !== 'done'; i++) await p.step();
    expect(planned).toEqual([listingAnalysisId(1)]);
    expect(proposals().every((x) => x.state === 'applied')).toBe(true);
    expect(() => p.setVerdict(spot[0].uuid, 'wrong')).toThrow(/closed/);
  });

  it('drops the changes of books removed from Calibre before each batch (never pausing stage 4 on them)', async () => {
    const p = pass();
    p.setMode('analyse');
    await drive(p);
    await p.step();
    for (const s of p.listSpot(LIB, 1)) p.setVerdict(s.uuid, 'right');
    // Removed before On (the rebuild finds it gone): its Preview proposal goes too.
    const c = books.get('c')!;
    books.delete('c');
    p.setMode('on');
    for (let i = 0; i < 50 && !p.state().progress.write.rebuilt; i++) await p.step();
    expect(proposals().map((x) => x.u)).toEqual(['a']);
    expect(p.state().progress.propose).toMatchObject({ proposed: 1, removed: 1, gone: 0 });
    // Removed after the rebuild, while the write waits: dropped before the batch is planned.
    books.set('c', c);
    expect(p.proposeOne(LIB, 1, 'c')).toBe('proposed');
    books.delete('a');
    for (let i = 0; i < 50 && p.state().progress.phase !== 'done'; i++) await p.step();
    expect(planned).toEqual([listingAnalysisId(1)]);
    expect(proposals().map((x) => [x.u, x.state])).toEqual([['c', 'applied']]);
    // Counted from the database as it is now, each book once ('c' is back in Calibre).
    expect(p.state().progress.propose).toMatchObject({ proposed: 1, removed: 1, gone: 0, held: 0 });
  });

  it('takes the card counts from the database once for a run rebuilt before (never twice)', async () => {
    const p = pass();
    p.setMode('analyse');
    await drive(p);
    await p.step();
    for (const s of p.listSpot(LIB, 1)) p.setVerdict(s.uuid, 'right');
    p.setMode('on');
    for (let i = 0; i < 50 && !p.state().progress.write.rebuilt; i++) await p.step();
    // As the old code left it: a book gone from Calibre counted as "saved link changed", its
    // Preview proposal still open, the counts never taken from the database.
    db.prepare(
      `UPDATE bookmeter_listing_state SET progress_json = json_set(json_remove(progress_json, '$.write.recounted'), '$.propose.gone', 1, '$.propose.proposed', 1)`,
    ).run();
    books.delete('c');
    for (let i = 0; i < 50 && p.state().progress.phase !== 'done'; i++) await p.step();
    expect(p.state().progress.propose).toMatchObject({ proposed: 1, removed: 1, gone: 0 });
  });

  it("never decides a book from a refused page: asks it again until the author's walk is read", async () => {
    const s0 = getSettings(db).fetch;
    updateSettings(db, { fetch: { ...s0, maxAttempts: 1 } });
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, () => false);
    // Bookmeter refuses every page (busy); the queue backs the site off after each refusal, so
    // the fetcher's clock moves on an hour between claims.
    const refused = new Set<number>();
    for (let i = 0; i < 50 && refused.size < 3; i++) {
      clock += 3600_000;
      for (const c of q.claim(clock).requests) {
        q.report(c.id, c.leaseToken, answer('busy', 503), clock);
        refused.add(c.id);
      }
    }
    expect(refused.size).toBe(3);
    await runUntil(p, () => false);
    expect(p.state().progress.phase).toBe('search');
    expect(rows().every((r) => r.state === 'search')).toBe(true);
    expect(p.state().progress.search).toMatchObject({ failed: 3, answered: 0 });
    expect(p.refusedOpen(LIB)).toBe(3);
    expect(p.openSearches(LIB)).toBe(3);
    // Put back in line with a wait (10 minutes the first time).
    const due = db
      .prepare(`SELECT state, next_at FROM fetch_requests WHERE key LIKE 'author-list:%'`)
      .all() as { state: string; next_at: number }[];
    expect(due.every((r) => r.state === 'queued' && r.next_at > Date.now() + 9 * 60_000)).toBe(
      true,
    );
    expect(refusedWaitMs(1)).toBe(600_000);
    expect(refusedWaitMs(3)).toBe(2_400_000);
    expect(refusedWaitMs(20)).toBe(7_200_000);
    // The wait is over and Bookmeter answers: decided as usual.
    db.prepare(`UPDATE fetch_requests SET next_at = 0 WHERE key LIKE 'author-list:%'`).run();
    clock += 3600_000;
    await drive(p);
    expect(rows()).toEqual([
      { u: 'a', state: 'change' },
      { u: 'b', state: 'keep' },
      { u: 'c', state: 'change' },
      { u: 'd', state: 'adaptation' },
    ]);
    expect(p.refusedOpen(LIB)).toBe(0);
  });

  it('ends a walk Bookmeter answers "not found" for, deciding its books from what was read', async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, () => false);
    for (let i = 0; i < 50; i++) {
      const got = q.claim(tick()).requests;
      if (!got.length) break;
      for (const c of got)
        q.report(
          c.id,
          c.leaseToken,
          c.url.includes(encodeURIComponent('七月隆文')) ? answer('', 404) : answer(byUrl(c.url)),
          clock,
        );
    }
    await drive(p);
    // a's stored search shows only its saved listing: kept; b too.
    expect(rows()).toEqual([
      { u: 'a', state: 'keep' },
      { u: 'b', state: 'keep' },
      { u: 'c', state: 'change' },
      { u: 'd', state: 'adaptation' },
    ]);
    expect(proposals().map((x) => x.u)).toEqual(['c']);
  });

  it('starts a run made under the old search rules again, by itself', async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, () => false);
    const st = p.state().progress;
    db.prepare('UPDATE bookmeter_listing_state SET progress_json = ? WHERE id = 1').run(
      JSON.stringify({ ...st, searchVersion: 2 }),
    );
    expect(await p.step()).toBe('more');
    expect(p.state().progress).toMatchObject({
      run: 2,
      searchVersion: BL_SEARCH_VERSION,
      phase: 'search',
    });
    expect(BL_SEARCH_VERSION).toBe(3);
    expect(p.state().mode).toBe('analyse');
    await runUntil(p, () => false);
    expect(p.openSearches(LIB)).toBe(3);
  });

  it('looks again from the start: a new run, its unwritten proposals gone, written ones kept', async () => {
    const p = pass();
    p.setMode('analyse');
    await drive(p);
    db.prepare(`UPDATE proposed_changes SET state = 'applied' WHERE calibre_uuid = 'a'`).run();
    p.again();
    expect(p.state().progress.run).toBe(2);
    expect(proposals().map((x) => x.u)).toEqual(['a']);
    expect(rows()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bookmeter_author_walks').get()).toEqual({ n: 0 });
  });

  it('reads its polled counts, its waiters and the walks by index', () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    expect(
      plan(
        `SELECT state, COUNT(*) AS n FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state WHERE library_id = 'x' GROUP BY state`,
      ),
    ).toMatch(/COVERING INDEX bookmeter_listing_books_state/);
    expect(
      plan(
        `SELECT w.request_id FROM bookmeter_listing_waiters w JOIN fetch_requests r ON r.id = w.request_id WHERE w.ready = 1 AND w.library_id = 'x' LIMIT 100`,
      ),
    ).toMatch(/bookmeter_listing_waiters_ready/);
    expect(
      plan(
        `SELECT COUNT(*) AS n FROM bookmeter_author_walks INDEXED BY bookmeter_author_walks_state WHERE library_id = 'x' AND state IN ('wait', 'walk')`,
      ),
    ).toMatch(/COVERING INDEX bookmeter_author_walks_state/);
    expect(
      plan(
        `SELECT b.calibre_uuid FROM bookmeter_author_walks w INDEXED BY bookmeter_author_walks_state
         JOIN bookmeter_listing_books b INDEXED BY bookmeter_listing_books_author
           ON b.library_id = w.library_id AND b.author = w.author AND b.state = 'search'
         WHERE w.library_id = 'x' AND w.state = 'done' LIMIT 50`,
      ),
    ).toMatch(/bookmeter_listing_books_author/);
  });
});
