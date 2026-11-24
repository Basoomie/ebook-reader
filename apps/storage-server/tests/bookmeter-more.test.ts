/**
 * More Bookmeter coverage, step 2: the whole-title parser, acceptBookmeter's two tiers, and the
 * pass over the stored answers (stage4/bookmeter-more.ts) on a real cleanup.db and fetch queue
 * with a stand-in stage 4 (its decisions) and a stand-in AI runner: every phase, resuming after a
 * restart, Q1 then Q2, add-only proposals that never touch a user field, the spot check's gate
 * before On, the write through stage 4's planner, and the queries' plans.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { brotliCompressSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEANUP_SCHEMA_VERSION, openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import type { BookmeterFacts, Stage4Analysis } from '../src/cleanup/stage4/analysis';
import {
  BookmeterMore,
  addedIds,
  bookmeterAnalysisId,
  bookmeterBar,
  emptyBmProgress,
  spotShares,
} from '../src/cleanup/stage4/bookmeter-more';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import {
  acceptBookmeter,
  bookmeterSearchUrl,
  parseBookmeterSearch,
  WHOLE_TITLE_REASON,
  type BookmeterHit,
} from '../src/cleanup/stage4/store-links';
import { makeTempDir } from './helpers/spawn-server';

const LIB = 'lib1';
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

/** A Bookmeter search answer: the list cuts each title, the cover keeps the whole one. */
function searchPage(items: { id: string; whole: string; authors: string[] }[]): string {
  const cut = (t: string) => ([...t].length > 22 ? [...t].slice(0, 22).join('') + '…' : t);
  return (
    '<ul class="books">' +
    items
      .map(
        (b) =>
          `<li class="group__book"><div class="book__thumbnail"><div class="thumbnail__cover"><a href="/books/${b.id}"><img alt="${b.whole.replace(/&/g, '&amp;')}" class="cover__image" src="x" /></a></div></div>` +
          `<div class="detail__title"><a href="/books/${b.id}">${cut(b.whole)}</a></div>` +
          `<ul class="detail__authors">${b.authors.map((a) => `<li><a href="/a">${a}</a></li>`).join('')}</ul>` +
          `<div class="detail__page">200</div></li>`,
      )
      .join('') +
    '</ul>'
  );
}

const storesJson = (isbn: string) =>
  JSON.stringify({
    resources: [
      { alphabet_name: 'kinokuniya', url: `https://www.kinokuniya.co.jp/f/dsg-08-${isbn}` },
      { alphabet_name: 'honto', url: 'https://honto.jp/ebook/pd_12345.html' },
    ],
  });

const answer = (s: string, status = 200) => ({
  status,
  ms: 10,
  error: null,
  body: brotliCompressSync(Buffer.from(s)),
  encoding: 'br' as const,
});

interface Book {
  uuid: string;
  id: number;
  title: string;
  authors: string[];
  ids?: Record<string, string>;
  kind?: string;
  fmt?: string;
  series?: string | null;
  hits: BookmeterHit[] | undefined;
  /** The book's own store titles (the candidates' question). */
  storeTitles?: string[];
  /** The search's query (stage 4's: the file's title); the decided title when not given. */
  query?: string;
  accepted?: { id: string; reason: string } | null;
  search: number | null;
  labeled?: boolean;
}

/** Stage 4 as the pass reads it: each book's decided values and stored answer. */
function standIn(books: Map<string, Book>): Stage4Analysis {
  const facts = (uuid: string): BookmeterFacts | null => {
    const b = books.get(uuid);
    if (!b) return null;
    return {
      book: {
        calibreId: b.id,
        uuid: b.uuid,
        title: b.title,
        authors: b.authors,
        identifiers: b.ids ?? {},
      } as never,
      input: {
        title: b.title,
        authors: b.authors,
        own: [b.title],
        chosen: {
          series: b.series ?? null,
          ix: null,
          fmt: b.fmt ?? 'light novel',
          calTitle: b.title,
          opfTitle: b.title,
        },
      },
      kind: b.kind ?? 'full',
      queryTitle: b.query ?? b.title,
      bookmeter: { hits: b.hits, accepted: b.accepted ?? null },
      searchRequest: b.search,
      storeTitles: b.storeTitles ?? [],
      asin: null,
    };
  };
  return {
    loadSnapshot: () => undefined,
    bookmeterFacts: (_lib: string, uuid: string) => facts(uuid),
    snapshotBook: (_lib: string, uuid: string) => facts(uuid)?.book ?? null,
    nativelyId: (_asin: string | null, isbn: string | null) =>
      isbn === '9784000000001' ? 'nat1' : null,
  } as unknown as Stage4Analysis;
}

/** The AI runner as the pass uses it: answers set per item, asked once. */
class FakeRunner {
  answers = new Map<string, { primary: string; secondary: string }>();
  asked = new Set<string>();
  queued = new Set<string>();
  /** The evidence each item was asked with, and by which question. */
  evidence = new Map<string, { stage: string; evidence: unknown }>();
  putItems(spec: { stage: string }, items: { key: string; evidence: unknown }[]): number {
    for (const i of items) {
      this.queued.add(i.key);
      this.asked.delete(i.key);
      this.evidence.set(i.key, { stage: spec.stage, evidence: i.evidence });
    }
    return items.length;
  }
  enqueue(): number {
    return 0;
  }
  pending(): number {
    return [...this.queued].filter((k) => !this.asked.has(k)).length;
  }
  async step(): Promise<{ pending: number; wait: null; sent: number; answered: number }> {
    const n = this.pending();
    for (const k of this.queued) this.asked.add(k);
    return { pending: 0, wait: null, sent: n, answered: n };
  }
  counts() {
    return { queued: 0, sent: 0, answered: this.asked.size * 2, blocked: 0, invalid: 0, failed: 0 };
  }
  answerOf(spec: { stage: string }, role: 'primary' | 'secondary', key: string) {
    const a = this.answers.get(key);
    if (!a || !this.asked.has(key)) return null;
    // The candidates' question answers with a result's id.
    if (spec.stage === 'bookmeter-near2')
      return { model: role, state: 'answered', answer: { match: a[role], reason: 'r' } };
    return { model: role, state: 'answered', answer: { same_book: a[role], reason: 'r' } };
  }
}

describe('More Bookmeter coverage: the parser and acceptBookmeter', () => {
  it('reads the whole title from the cover and keeps the list text', () => {
    const [h] = parseBookmeterSearch(
      searchPage([
        {
          id: '5283950',
          whole: '子ひつじは迷わない 贈るひつじが6ぴき (角川スニーカー文庫)',
          authors: ['玩具堂'],
        },
      ]),
    );
    expect(h.title).toBe('子ひつじは迷わない 贈るひつじが6ぴき (角川スニーカー文庫)');
    expect(h.listTitle).toBe('子ひつじは迷わない 贈るひつじが6ぴき (角…');
  });

  it("falls back to the list's text when the cover has no alt", () => {
    const html =
      '<li class="group__book"><div class="detail__title"><a href="/books/9">短い題名</a></div></li>';
    expect(parseBookmeterSearch(html)[0]).toMatchObject({
      title: '短い題名',
      listTitle: '短い題名',
    });
  });

  const chosen = { series: null, ix: null, fmt: 'light novel', calTitle: '', opfTitle: null };

  it("decides a stored result and the same result parsed now alike (today's tier first)", () => {
    for (const [title, authors, hitTitle] of [
      ['神様のメモ帳2', ['杉井光'], '神様のメモ帳2 (電撃文庫 す 9-5)'],
      ['転生したら剣でした 13', ['棚架ユウ'], '転生したら剣でした 13 (GCノベルズ)'],
      ['転生したら剣でした 13', ['棚架ユウ'], '転生したら剣でした 12 (GCノベルズ)'],
    ] as [string, string[], string][]) {
      const old: BookmeterHit = { id: '1', title: hitTitle, authors: [authors[0]], pages: 1 };
      const now: BookmeterHit = { ...old, listTitle: hitTitle };
      const book = { title, authors, chosen: { ...chosen, calTitle: title } };
      const a = acceptBookmeter([now], book);
      const b = acceptBookmeter([old], book);
      expect([a.hit?.id ?? null, a.reason]).toEqual([b.hit?.id ?? null, b.reason]);
    }
    // A plain match is today's tier's (its reason), not the chosen rules'.
    expect(
      acceptBookmeter(
        [{ id: '2', title: '転生したら剣でした 13 (GCノベルズ)', authors: ['棚架ユウ'], pages: 1 }],
        {
          title: '転生したら剣でした 13',
          authors: ['棚架ユウ'],
          chosen: { ...chosen, calTitle: '' },
        },
      ).reason,
    ).toBe('title, author and volume agree');
  });

  it('accepts a cut title by its whole title (the second tier), with the volume check', () => {
    const hits = parseBookmeterSearch(
      searchPage([
        {
          id: '5',
          whole: '自重しない元勇者の強くて楽しいニューゲーム 5 (ダッシュエックス文庫)',
          authors: ['新木 伸'],
        },
        {
          id: '3',
          whole: '自重しない元勇者の強くて楽しいニューゲーム 3 (ダッシュエックス文庫)',
          authors: ['新木 伸'],
        },
      ]),
    );
    const book = { title: '自重しない元勇者の強くて楽しいニューゲーム 3', authors: ['新木伸'] };
    expect(acceptBookmeter(hits, book).hit).toBeNull(); // no chosen inputs: the first tier only
    const r = acceptBookmeter(hits, { ...book, chosen: { ...chosen, calTitle: book.title } });
    expect(r).toMatchObject({ hit: { id: '3' }, reason: WHOLE_TITLE_REASON });
  });

  it('keeps the volume guard (17961: the decided title lost its number)', () => {
    const hits = parseBookmeterSearch(
      searchPage([
        { id: '1', whole: '捨てられ勇者は帰宅中 (ダッシュエックス文庫)', authors: ['ななみ'] },
      ]),
    );
    const r = acceptBookmeter(hits, {
      title: '捨てられ勇者は帰宅中',
      authors: ['ななみ'],
      chosen: { ...chosen, calTitle: '捨てられ勇者は帰宅中 2' },
    });
    expect(r.hit).toBeNull();
  });

  it('takes a comic label only for a book decided as manga (the comic guard)', () => {
    const hits = parseBookmeterSearch(
      searchPage([
        { id: '1', whole: 'ドラゴンの花嫁 1 (ガンガンコミックスUP!)', authors: ['原作者'] },
      ]),
    );
    const book = { title: 'ドラゴンの花嫁 1', authors: ['原作者'] };
    expect(
      acceptBookmeter(hits, { ...book, chosen: { ...chosen, calTitle: book.title } }).hit,
    ).toBeNull();
    expect(
      acceptBookmeter(hits, { ...book, chosen: { ...chosen, fmt: 'manga', calTitle: book.title } })
        .hit?.id,
    ).toBe('1');
  });

  it('drops the series name Bookmeter appends after the title', () => {
    const hits = parseBookmeterSearch(
      searchPage([
        {
          id: '7',
          whole: '司書とハサミと短い鉛筆2<司書とハサミと短い鉛筆> (電撃文庫)',
          authors: ['ゆうきりん'],
        },
      ]),
    );
    const book = { title: '司書とハサミと短い鉛筆2', authors: ['ゆうきりん'] };
    expect(
      acceptBookmeter(hits, { ...book, chosen: { ...chosen, calTitle: book.title } }).hit?.id,
    ).toBe('7');
  });

  it("asks Q2 with Bookmeter's author field, as step 1 did", () => {
    expect(bookmeterSearchUrl('Temptation2', '作者')).toBe(
      `https://bookmeter.com/search?author=${encodeURIComponent('作者')}&keyword=Temptation2&partial=true&sort=recommended&type=japanese`,
    );
  });
});

describe('More Bookmeter coverage: pure parts', () => {
  it('splits the spot check in proportion, one at least from each source', () => {
    expect(spotShares({ rules: 22749, ai: 5000, second: 300 })).toEqual({
      rules: 40,
      ai: 9,
      second: 1,
    });
    expect(spotShares({ rules: 10 })).toEqual({ rules: 10, ai: 0, second: 0 });
    expect(spotShares({})).toEqual({ rules: 0, ai: 0, second: 0 });
  });

  it('adds ids only, never over one Calibre has; BOOK☆WALKER only when none', () => {
    const r = addedIds(
      { isbn: '9780000000000', bookwalker: 'old' },
      '123',
      { isbn: '9784000000001', honto: '5', bookwalker: 'new' },
      (isbn) => (isbn ? 'nat' : null),
    );
    expect(r.added).toEqual({ bookmeter: '123', honto: '5', natively: 'nat' });
    expect(r.ids).toMatchObject({ isbn: '9780000000000', bookwalker: 'old', bookmeter: '123' });
  });

  it('times only the questions outside batches; none while only a batch at a provider is left', () => {
    const p = emptyBmProgress(1, LIB);
    p.phase = 'ai';
    p.ai.rate = { at: T0, done: 0 };
    const ai = { queued: 0, sent: 500, answered: 13256, blocked: 0, invalid: 0, failed: 0 };
    const base = { openSearches: 0, openQ1: 0, openStores: 0, intervalSeconds: 5 };
    // Found live: the 500 left were one batch at OpenAI; the old bar said "about 1 min left".
    expect(bookmeterBar(p, T0 + 16 * 60_000, { ...base, ai })?.leftMs).toBeGreaterThan(0);
    expect(bookmeterBar(p, T0 + 16 * 60_000, { ...base, ai, aiInBatches: 500 })?.leftMs).toBeNull();
    // 1,000 asked one call each besides the batch: timed at the measured rate.
    const more = { ...ai, queued: 1000 };
    expect(bookmeterBar(p, T0 + 16 * 60_000, { ...base, ai: more, aiInBatches: 500 })?.leftMs).toBe(
      ((16 * 60_000) / 13256) * 1000,
    );
  });

  it("counts the store lists' time at Bookmeter's pace until 30 answers are measured", () => {
    const p = emptyBmProgress(1, LIB);
    p.phase = 'stores';
    p.stores = { asked: 100, answered: 10, failed: 0, enqueued: true, rate: { at: T0, done: 0 } };
    const x = {
      ai: { queued: 0, sent: 0, answered: 0, blocked: 0, invalid: 0, failed: 0 },
      openSearches: 0,
      openQ1: 0,
      openStores: 90,
      intervalSeconds: 5,
    };
    expect(bookmeterBar(p, T0 + 60_000, x)).toMatchObject({ leftMs: 450_000, measured: false });
    p.stores.answered = 40;
    expect(bookmeterBar(p, T0 + 400_000, { ...x, openStores: 60 })).toMatchObject({
      leftMs: 600_000,
      measured: true,
    });
  });
});

describe('More Bookmeter coverage: the pass', () => {
  let dir: string;
  let db: Database.Database;
  let q: FetchQueue;
  let books: Map<string, Book>;
  let runner: FakeRunner;
  let planned: string[];
  let add: (b: Omit<Book, 'search'> & { page?: string }) => void;
  /** Dクラッカーズ・ショートII as found live: two results fail only the title check. */
  const pageM = searchPage([
    {
      id: '81',
      whole: 'Dクラッカーズ・ショート 2 (富士見ミステリー文庫 7-8)',
      authors: ['あざの 耕平'],
    },
    {
      id: '82',
      whole:
        'Dクラッカーズ・ショートII　過日―roots―（富士見ファンタジア文庫） Dクラッカーズショート',
      authors: ['あざの 耕平,村崎 久都'],
    },
  ]);
  const addM = (uuid: string, id: number) =>
    add({
      uuid,
      id,
      title: 'Dクラッカーズ・ショートII 過日─roots─',
      authors: ['あざの耕平'],
      hits: parseBookmeterSearch(pageM).map((h) => ({
        ...h,
        title: h.listTitle!,
        listTitle: undefined,
      })),
      page: pageM,
      storeTitles: ['Dクラッカーズ・ショートII　過日―roots―（富士見ファンタジア文庫）'],
    });
  let clock = Date.now();
  /** The fetcher's clock: a second per claim, so Bookmeter's pace never holds a test. */
  const tick = () => (clock += 1000);

  const store = (key: string, body: string) => {
    const r = q.enqueue({ site: 'bookmeter', key, url: `https://bookmeter.com/x?${key}` }, null);
    for (;;) {
      const c = q.claim(tick()).requests.find((x) => x.id === r.id);
      if (!c) break;
      q.report(c.id, c.leaseToken, answer(body), clock);
    }
    return r.id;
  };

  const pass = () =>
    new BookmeterMore({
      db,
      analysis: standIn(books),
      queue: q,
      runner: runner as never,
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

  /** Answers every queued Bookmeter request (the fetcher), by its address. */
  const fetchAll = (by: (url: string) => string) => {
    for (let i = 0; i < 50; i++) {
      const got = q.claim(tick()).requests;
      if (!got.length) return;
      for (const c of got) q.report(c.id, c.leaseToken, answer(by(c.url)), clock);
    }
  };

  const runUntil = async (p: BookmeterMore, stop: (phase: string) => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (stop(p.state().progress.phase)) return;
      const r = await p.step();
      if (r === 'idle' || r === 'wait') return;
    }
  };

  beforeEach(() => {
    dir = makeTempDir('bm-more-');
    db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
    const s = getSettings(db).fetch;
    updateSettings(db, {
      fetch: {
        ...s,
        sites: { ...s.sites, bookmeter: { enabled: true, intervalSeconds: 0.25, inFlight: 4 } },
      },
    });
    q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
    runner = new FakeRunner();
    planned = [];
    books = new Map();
    add = (b) => {
      const search = b.page !== undefined ? store(`search-jp:${b.query ?? b.title}`, b.page) : null;
      books.set(b.uuid, { ...b, search });
      db.prepare(
        `INSERT INTO stage4_books (library_id, calibre_uuid, calibre_id, analysis_id, labeled, state, pending, updated_at)
         VALUES (?, ?, ?, 'a1', ?, 'proposed', 0, 0)`,
      ).run(LIB, b.uuid, b.id, b.labeled ? 1 : 0);
    };
    const pageA = searchPage([
      {
        id: '5',
        whole: '自重しない元勇者の強くて楽しいニューゲーム 5 (ダッシュエックス文庫)',
        authors: ['新木 伸'],
      },
      {
        id: '3',
        whole: '自重しない元勇者の強くて楽しいニューゲーム 3 (ダッシュエックス文庫)',
        authors: ['新木 伸'],
      },
    ]);
    // a: a cut title the whole title matches (the rules).
    add({
      uuid: 'a',
      id: 1,
      title: '自重しない元勇者の強くて楽しいニューゲーム 3',
      authors: ['新木伸'],
      ids: { isbn: '9780000000000' },
      hits: parseBookmeterSearch(pageA).map((h) => ({
        ...h,
        title: h.listTitle!,
        listTitle: undefined,
      })),
      page: pageA,
      labeled: true,
    });
    // b, c: the closest result fails one check (the author): the AI check.
    for (const [uuid, id] of [
      ['b', 2],
      ['c', 3],
    ] as const) {
      const page = searchPage([
        { id: `9${id}`, whole: `ドラゴンブラッド ${id} (MF文庫J)`, authors: ['別人'] },
      ]);
      add({
        uuid,
        id,
        title: `ドラゴンブラッド ${id}`,
        authors: ['伊上円'],
        hits: parseBookmeterSearch(page),
        page,
      });
    }
    runner.answers.set(`${LIB}:b`, { primary: 'yes', secondary: 'yes' });
    runner.answers.set(`${LIB}:c`, { primary: 'yes', secondary: 'no' });
    // d: no results: Q1 (no subtitle) finds nothing, Q2 (with the author) finds it.
    add({
      uuid: 'd',
      id: 4,
      title: 'Temptation2',
      query: 'Temptation2 ～甘い罠～',
      authors: ['作者 名'],
      hits: [],
      page: searchPage([]),
    });
    // e: a bonus story with no results: left out of the second search.
    add({
      uuid: 'e',
      id: 5,
      title: '特典SS',
      authors: ['x'],
      kind: 'bonus',
      hits: [],
      page: searchPage([]),
    });
    // f: matched before (kept); g: store links the user edited; h: a Bookmeter id already.
    add({
      uuid: 'f',
      id: 6,
      title: 'f',
      authors: ['x'],
      hits: [],
      accepted: { id: '1', reason: 'r' },
      page: searchPage([]),
    });
    add({
      uuid: 'g',
      id: 7,
      title: 'ドラゴンブラッド 7',
      authors: ['伊上円'],
      hits: [],
      page: searchPage([]),
    });
    add({
      uuid: 'h',
      id: 8,
      title: 'h',
      authors: ['x'],
      ids: { bookmeter: '1' },
      hits: [],
      page: searchPage([]),
    });
    db.prepare(
      `INSERT INTO user_fields (library_id, calibre_uuid, field, value_json, source, since) VALUES (?, 'g', 'identifiers', '{}', 'edit', 0)`,
    ).run(LIB);
    db.prepare(`UPDATE bookmeter_more_state SET mode = 'analyse' WHERE id = 1`).run();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is cleanup.db v30 with its tables, Off by default', () => {
    expect(CLEANUP_SCHEMA_VERSION).toBeGreaterThanOrEqual(30);
    const fresh = openCleanupDatabase(path.join(dir, 'fresh.db'));
    expect(new BookmeterMore({ db: fresh } as never).state().mode).toBe('off');
    fresh.close();
  });

  it('runs every phase, resumes after a restart, and proposes add-only store links', async () => {
    let p = pass();
    await runUntil(p, (ph) => ph !== 'match');
    const s1 = p.state().progress;
    expect(s1.counts).toMatchObject({
      before: 1,
      yours: 1,
      hasId: 1,
      leftOut: 1,
      rules: 1,
      near: 2,
      second: 1,
    });

    // A restart between phases: a new instance goes on from cleanup.db.
    p = pass();
    await runUntil(p, (ph) => ph === 'second');
    expect(p.state().progress.ai).toMatchObject({ accepted: 1, notAccepted: 1 });

    await runUntil(p, () => false); // asks Q1 and waits for it
    const first = q.claim(tick()).requests;
    expect(first.map((r) => decodeURIComponent(r.url))).toEqual([
      expect.stringContaining('author=&keyword=Temptation2'),
    ]);
    q.report(first[0].id, first[0].leaseToken, answer(searchPage([])), clock);
    p = pass(); // and again while a search is out
    await runUntil(p, () => false);
    fetchAll((url) =>
      url.includes('author=%E4%BD%9C%E8%80%85%E5%90%8D')
        ? searchPage([{ id: '44', whole: 'Temptation2 (蜜夢文庫)', authors: ['作者 名'] }])
        : searchPage([]),
    );
    await runUntil(p, (ph) => ph === 'stores');
    expect(p.state().progress.second).toMatchObject({ asked: 2, found: 1 });

    await runUntil(p, () => false); // the store lists go out
    fetchAll((url) => storesJson(url.includes('/3/') ? '9784000000001' : '9784000000002'));
    await runUntil(p, (ph) => ph === 'spot');

    const props = db
      .prepare(
        `SELECT calibre_uuid, old_json, new_json, source, analysis_id FROM proposed_changes WHERE field = 'identifiers' ORDER BY calibre_uuid`,
      )
      .all() as {
      calibre_uuid: string;
      old_json: string;
      new_json: string;
      source: string;
      analysis_id: string;
    }[];
    expect(props.map((r) => r.calibre_uuid)).toEqual(['a', 'b', 'd']);
    expect(props.every((r) => r.analysis_id === bookmeterAnalysisId(1))).toBe(true);
    const a = props[0];
    expect(JSON.parse(a.old_json)).toEqual({ isbn: '9780000000000' });
    // Calibre's ISBN stays; Natively by the store list's ISBN, as stage 4 does.
    expect(JSON.parse(a.new_json)).toEqual({
      isbn: '9780000000000',
      bookmeter: '3',
      honto: '12345',
      natively: 'nat1',
    });
    expect(JSON.parse(props[1].new_json)).toMatchObject({ bookmeter: '92', isbn: '9784000000002' });
  });

  it('asks every candidate when several results fail one check; both models must choose the same one', async () => {
    addM('m', 9);
    addM('n', 10);
    runner.answers.set(`${LIB}:m`, { primary: '82', secondary: '82' });
    runner.answers.set(`${LIB}:n`, { primary: '82', secondary: '81' });
    const p = pass();
    await runUntil(p, (ph) => ph === 'second');
    const ev = runner.evidence.get(`${LIB}:m`) as {
      stage: string;
      evidence: { book: { storeTitles: string[] }; results: { id: string; failedCheck: string }[] };
    };
    expect(ev.stage).toBe('bookmeter-near2');
    expect(ev.evidence.results.map((r) => [r.id, r.failedCheck])).toEqual([
      ['81', 'title'],
      ['82', 'title'],
    ]);
    expect(ev.evidence.book.storeTitles[0]).toContain('富士見ファンタジア文庫');
    const row = (u: string) =>
      db
        .prepare(
          `SELECT state, source, failed_check, hit_json FROM bookmeter_more_books WHERE calibre_uuid = ?`,
        )
        .get(u) as { state: string; source: string | null; failed_check: string; hit_json: string };
    expect(row('m')).toMatchObject({ state: 'matched', source: 'ai', failed_check: 'several' });
    expect(JSON.parse(row('m').hit_json).id).toBe('82');
    // The models disagree: no match.
    expect(row('n')).toMatchObject({ state: 'none', source: null });
    // Single-result near misses keep step 1's question.
    expect(runner.evidence.get(`${LIB}:b`)?.stage).toBe('bookmeter-near');
  });

  it('asks a finished Preview again once: several candidates, their proposals and the spot check set aside', async () => {
    addM('m', 9);
    runner.answers.set(`${LIB}:m`, { primary: '82', secondary: '82' });
    const p = pass();
    // As the live Preview left it: m accepted by step 1's question (the closest, the print edition).
    db.prepare(
      `INSERT INTO bookmeter_more_books (library_id, calibre_uuid, calibre_id, labeled, state, source, hit_json, failed_check, stores_json, updated_at)
       VALUES (?, 'm', 9, 0, 'ready', 'ai', ?, 'title', '{"isbn":"9784829162156"}', 0)`,
    ).run(
      LIB,
      JSON.stringify({
        id: '81',
        title: 'Dクラッカーズ・ショート 2',
        authors: ['あざの 耕平'],
        pages: 410,
      }),
    );
    expect(p.proposeOne(LIB, 1, 'm')).toBe('proposed');
    db.prepare(
      `INSERT INTO bookmeter_more_spot (library_id, calibre_uuid, position, source) VALUES (?, 'm', 0, 'ai')`,
    ).run(LIB);
    // Saved as the live Preview was, before the version existed (no nearVersion field).
    const st: Partial<ReturnType<typeof emptyBmProgress>> & ReturnType<typeof emptyBmProgress> = {
      ...emptyBmProgress(1, LIB),
      phase: 'spot' as const,
    };
    delete st.nearVersion;
    st.spot = { drawnAt: Date.now(), size: 1, notified: false };
    st.second.enqueued = true;
    st.stores.enqueued = true;
    db.prepare(
      'UPDATE bookmeter_more_state SET progress_json = ?, library_id = ? WHERE id = 1',
    ).run(JSON.stringify(st), LIB);
    await runUntil(p, () => false); // re-ask, AI, second, stores (waits for the new store list)
    expect(p.state().progress.nearVersion).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bookmeter_more_spot').get()).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes WHERE calibre_uuid = 'm' AND state = 'proposed'`,
        )
        .get(),
    ).toEqual({ n: 0 });
    fetchAll(() => storesJson('9784000000082'));
    await runUntil(p, (ph) => ph === 'spot');
    await p.step(); // draws again
    const prop = db
      .prepare(
        `SELECT new_json FROM proposed_changes WHERE calibre_uuid = 'm' AND state = 'proposed'`,
      )
      .get() as { new_json: string };
    expect(JSON.parse(prop.new_json)).toMatchObject({ bookmeter: '82', isbn: '9784000000082' });
    expect(db.prepare('SELECT calibre_uuid FROM bookmeter_more_spot').all()).toEqual([
      { calibre_uuid: 'm' },
    ]);
  });

  it('rebuilds a row stage 4 deleted, holds a book with another open change, never re-proposes an undone one', async () => {
    const p = pass();
    // Straight to proposals: a ready book.
    db.prepare(
      `INSERT INTO bookmeter_more_books (library_id, calibre_uuid, calibre_id, labeled, state, source, hit_json, stores_json, updated_at)
       VALUES (?, 'b', 2, 0, 'ready', 'ai', ?, '{}', 0)`,
    ).run(LIB, JSON.stringify({ id: '92', title: 't', authors: [], pages: null }));
    expect(p.proposeOne(LIB, 1, 'b')).toBe('proposed');
    db.prepare(`DELETE FROM proposed_changes`).run();
    expect(p.proposeOne(LIB, 1, 'b')).toBe('proposed');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM proposed_changes`).get()).toEqual({ n: 1 });
    db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source, class, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, 2, 'b', 'identifiers', '{}', '{}', 'x', 'auto', 'proposed', 'other', 0, 0)`,
    ).run(LIB);
    expect(p.proposeOne(LIB, 1, 'b')).toBe('held');
    db.prepare(`DELETE FROM proposed_changes WHERE analysis_id = 'other'`).run();
    expect(p.proposeOne(LIB, 1, 'b')).toBe('proposed');
    db.prepare(`UPDATE proposed_changes SET state = 'undone'`).run();
    expect(p.proposeOne(LIB, 1, 'b')).toBe('written');
    // A field that became the user's is never proposed (and the v29 trigger sets aside a row).
    db.prepare(`DELETE FROM proposed_changes`).run();
    db.prepare(
      `INSERT INTO user_fields (library_id, calibre_uuid, field, value_json, source, since) VALUES (?, 'b', 'identifiers', '{}', 'edit', 0)`,
    ).run(LIB);
    expect(p.proposeOne(LIB, 1, 'b')).toBe('yours');
  });

  it('allows On only after the spot check passed, then writes through stage 4 by its own analysis id', async () => {
    const p = pass();
    for (let i = 0; i < 6; i++)
      db.prepare(
        `INSERT INTO bookmeter_more_books (library_id, calibre_uuid, calibre_id, labeled, state, source, hit_json, stores_json, updated_at)
         VALUES (?, ?, 2, 0, 'ready', ?, ?, '{}', 0)`,
      ).run(
        LIB,
        'b' + i,
        i < 4 ? 'rules' : 'ai',
        JSON.stringify({ id: String(i), title: 't', authors: [], pages: null }),
      );
    for (let i = 0; i < 6; i++) books.set('b' + i, { ...books.get('b')!, uuid: 'b' + i, ids: {} });
    const st = p.state().progress;
    st.libraryId = LIB;
    st.phase = 'propose';
    db.prepare(
      'UPDATE bookmeter_more_state SET progress_json = ?, library_id = ? WHERE id = 1',
    ).run(JSON.stringify(st), LIB);
    await runUntil(p, (ph) => ph === 'spot');
    await p.step(); // draws
    expect(p.spotCounts()).toEqual({ size: 6, right: 0, wrong: 0, open: 6 });
    expect(() => p.setMode('on')).toThrow(/spot check/);
    const spot = db
      .prepare('SELECT calibre_uuid, source FROM bookmeter_more_spot ORDER BY position')
      .all() as { calibre_uuid: string; source: string }[];
    expect(spot.filter((s) => s.source === 'ai')).toHaveLength(2);
    p.setVerdict(spot[0].calibre_uuid, 'wrong');
    p.setVerdict(spot[1].calibre_uuid, 'wrong');
    for (const s of spot.slice(2)) p.setVerdict(s.calibre_uuid, 'right');
    expect(p.spotPassed()).toBe(false); // two wrong
    p.setVerdict(spot[1].calibre_uuid, 'right');
    expect(p.spotPassed()).toBe(true);
    p.setMode('on');
    await runUntil(p, (ph) => ph === 'done');
    for (let i = 0; i < 20 && p.state().progress.phase !== 'done'; i++) await p.step();
    expect(planned).toEqual([bookmeterAnalysisId(1)]);
    expect(p.state().progress.phase).toBe('done');
    expect(() => p.setVerdict(spot[0].calibre_uuid, 'right')).not.toThrow();
  });

  it("marks the pass's waiters ready when the queue gets the answer or gives up", () => {
    const r = q.enqueue(
      { site: 'bookmeter', key: 'stores:1', url: 'https://bookmeter.com/s' },
      null,
    );
    db.prepare(
      `INSERT INTO bookmeter_more_waiters (request_id, library_id, calibre_uuid, step, ready) VALUES (?, ?, 'u', 'stores', 0)`,
    ).run(r.id, LIB);
    const [c] = q.claim(tick()).requests;
    q.report(c.id, c.leaseToken, answer('{}'), clock);
    expect(db.prepare('SELECT ready FROM bookmeter_more_waiters').get()).toEqual({ ready: 1 });
  });

  it('reads its polled counts by index (no scan of a table that grows with the pass)', () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    expect(
      plan(
        `SELECT state, source, COUNT(*) AS n FROM bookmeter_more_books INDEXED BY bookmeter_more_books_state WHERE library_id = 'x' GROUP BY state, source`,
      ),
    ).toMatch(/COVERING INDEX bookmeter_more_books_state/);
    expect(
      plan(
        `SELECT COUNT(*) AS n FROM bookmeter_more_waiters WHERE ready = 0 AND step IN ('stores')`,
      ),
    ).toMatch(/INDEX bookmeter_more_waiters_step/);
    expect(
      plan(
        `SELECT w.request_id FROM bookmeter_more_waiters w WHERE w.ready = 1 AND w.step = 'stores' LIMIT 200`,
      ),
    ).not.toMatch(/^SCAN w$/);
    expect(
      plan(
        `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = 'x' AND state = 'applied' AND field = 'identifiers' AND analysis_id = 'y'`,
      ),
    ).toMatch(/COVERING INDEX proposed_changes_counts/);
  });
});
