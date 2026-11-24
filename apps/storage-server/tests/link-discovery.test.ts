/**
 * More direct links: the two rules with their guards (stage4/link-rules.ts) and the pass over the
 * stored answers (stage4/link-discovery.ts) on a real cleanup.db with a stand-in stage 4: every
 * phase, resuming after a restart, add-only proposals that never touch a user field or come back
 * after an Undo, one id for one book, the spot check's gate before On (none wrong), the write
 * through stage 4's planner by its own analysis id, and the polled queries' plans.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEANUP_SCHEMA_VERSION, openCleanupDatabase } from '../src/cleanup/cleanup-db';
import type { Stage4Analysis } from '../src/cleanup/stage4/analysis';
import {
  LinkDiscovery,
  linkAddedIds,
  linkAnalysisId,
  linkBar,
  emptyLdProgress,
} from '../src/cleanup/stage4/link-discovery';
import {
  SPOT_SLOTS,
  linkRules,
  linkSpotShares,
  recordPick,
  sameEdition,
  seriesEntries,
  seriesGroupKey,
  seriesPick,
  type LinkFacts,
} from '../src/cleanup/stage4/link-rules';
import { makeTempDir } from './helpers/spawn-server';

const LIB = 'lib1';
const SERIES = '(仮)花嫁のやんごとなき事情';
const AUTHOR = '夕鷺かのう';
const BW = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** A book as the rules read it; everything not given is empty. */
function facts(over: Partial<LinkFacts> & { uuid: string; title: string }): LinkFacts {
  const { title, ...rest } = over;
  return {
    calibreId: 1,
    decided: { t: title, au: [AUTHOR], se: null, ix: null, fmt: 'light novel' },
    calibre: { title, authors: [AUTHOR], series: null, index: null, ids: {} },
    opfTitle: title,
    own: [title],
    amazonRejected: null,
    amazon: null,
    amazonList: [],
    ranobedb: null,
    ranobedbList: [],
    bookwalker: null,
    bookwalkerList: [],
    ...rest,
  };
}

const VOL = (n: number, sub: string) => `${SERIES}${n} ～${sub}～`;

describe('More direct links: rule A (the record already found)', () => {
  const title = VOL(2, '離婚できなきゃ大戦争!?');
  const amazon = {
    id: 'B00DONBNAQ',
    title: `${title} (ビーズログ文庫)`,
    authors: ['夕鷺 かのう', '山下 ナナオ'],
    roles: ['著', 'イラスト'],
    breadcrumbs: ['本', 'ライトノベル'],
  };

  it('takes the record whose title, author and volume agree with the decided and Calibre values', () => {
    const f = facts({
      uuid: 'a',
      title,
      amazon,
      ranobedb: { id: '9581', title: title.replace(/～/g, '~'), authors: [AUTHOR] },
      bookwalker: { id: BW(2), title, keywords: `${title},ヨミ,${AUTHOR},山下ナナオ,ライトノベル` },
    });
    expect(recordPick(f, 'amazon')).toEqual({ id: 'B00DONBNAQ', title: amazon.title });
    expect(recordPick(f, 'ranobedb')?.id).toBe('9581');
    expect(recordPick(f, 'bookwalker')?.id).toBe(BW(2));
  });

  it('refuses a print page: its id is the ISBN-10', () => {
    const f = facts({ uuid: 'a', title, amazon: { ...amazon, id: '4047284297' } });
    expect(recordPick(f, 'amazon')).toBeNull();
  });

  it('refuses another volume, another author, and an illustrator standing in for the author', () => {
    const other = facts({
      uuid: 'a',
      title,
      amazon: { ...amazon, title: `${VOL(3, '離婚できずに新婚旅行')} (ビーズログ文庫)` },
    });
    expect(recordPick(other, 'amazon')).toBeNull();
    const author = facts({
      uuid: 'a',
      title,
      amazon: { ...amazon, authors: ['別人', '山下 ナナオ'] },
    });
    expect(recordPick(author, 'amazon')).toBeNull();
    const illustrator = facts({ uuid: 'a', title, amazon });
    illustrator.calibre.authors = ['山下ナナオ'];
    illustrator.decided.au = ['山下ナナオ'];
    expect(recordPick(illustrator, 'amazon')).toBeNull();
  });

  it('refuses when the decided title lost the number Calibre has (the volume guard)', () => {
    const f = facts({ uuid: 'a', title, amazon });
    f.decided.t = `${SERIES} ～離婚できなきゃ大戦争!?～`;
    expect(recordPick(f, 'amazon')).toBeNull();
  });

  it('refuses a manga page for a text book, at Amazon and at BOOK☆WALKER', () => {
    const az = facts({
      uuid: 'a',
      title,
      amazon: { ...amazon, breadcrumbs: ['本', 'コミック', 'マンガ'] },
    });
    expect(recordPick(az, 'amazon')).toBeNull();
    const bw = facts({
      uuid: 'a',
      title,
      bookwalker: { id: BW(2), title, keywords: `${title},${AUTHOR},マンガ` },
    });
    expect(recordPick(bw, 'bookwalker')).toBeNull();
    bw.decided.fmt = 'manga';
    expect(recordPick(bw, 'bookwalker')?.id).toBe(BW(2));
  });

  it("refuses an edition the book's own texts do not name, in any bracket", () => {
    const t = '神父さまの囲われ者';
    const f = facts({
      uuid: 'a',
      title: t,
      amazon: {
        ...amazon,
        id: 'B0DCK68FT5',
        title: `${t}＜特別版＞ (ジュリアンノベルス)`,
        authors: [AUTHOR],
      },
    });
    expect(recordPick(f, 'amazon')).toBeNull();
    f.own = [t, '神父さまの囲われ者 特別版 電子書籍版'];
    expect(recordPick(f, 'amazon')?.id).toBe('B0DCK68FT5');
    expect(sameEdition(['x'], 'x [改版]【電子版限定書き下ろしSS付】')).toBe(false);
    expect(sameEdition(['x'], 'x【電子特典付き】')).toBe(true); // a store bonus is the e-book itself
  });
});

describe('More direct links: rule B (series neighbours)', () => {
  const list: [string, string][] = [
    ['9026', VOL(1, '離婚できたら一攫千金!').replace(/～/g, '~')],
    ['9581', VOL(2, '離婚できなきゃ大戦争!?').replace(/～/g, '~')],
    ['15381', VOL(9, '離婚のはずが大波乱!?').replace(/～/g, '~')],
  ];
  const book = (uuid: string, n: number, sub: string, ids: Record<string, string> = {}) => {
    const f = facts({ uuid, title: VOL(n, sub), ranobedbList: list });
    f.calibre = { ...f.calibre, series: SERIES, index: n, ids };
    return f;
  };
  const v1 = book('v1', 1, '離婚できたら一攫千金！');
  const v9 = book('v9', 9, '離婚のはずが大波乱!?', { ranobedb: '15381' });

  it("finds a volume in the series' list that another volume's saved id proves", () => {
    const entries = seriesEntries([v1, v9], 'ranobedb');
    expect(entries.size).toBe(3);
    expect(seriesPick(linkRules(), v1, entries, () => false)).toEqual({
      id: '9026',
      title: list[0][1],
    });
  });

  it('has no list without a saved id in it, and none for another author', () => {
    const noAnchor = book('v9', 9, '離婚のはずが大波乱!?');
    expect(seriesEntries([v1, noAnchor], 'ranobedb').size).toBe(0);
    const stranger = { ...v1, calibre: { ...v1.calibre, authors: ['別人'] } };
    expect(
      seriesPick(linkRules(), stranger, seriesEntries([v1, v9], 'ranobedb'), () => false),
    ).toBeNull();
  });

  it('never takes an id Calibre already holds, nor one of two entries that both match', () => {
    const entries = seriesEntries([v1, v9], 'ranobedb');
    expect(seriesPick(linkRules(), v1, entries, (id) => id === '9026')).toBeNull();
    const twice = new Map(entries);
    twice.set('99999', { title: list[0][1], anchorAuthors: entries.get('9026')!.anchorAuthors });
    expect(seriesPick(linkRules(), v1, twice, () => false)).toBeNull();
  });

  it('ignores a list that holds fewer than half of the saved ids of the series (the manga)', () => {
    const manga: [string, string][] = [
      ['m1', VOL(1, '離婚できたら一攫千金!')],
      ['m9', VOL(9, '離婚のはずが大波乱!?')],
    ];
    const a = book('a', 9, '離婚のはずが大波乱!?', { bookwalker: 'm9' });
    a.bookwalkerList = manga;
    const b = book('b', 10, 'x', { bookwalker: 'n10' });
    const c = book('c', 11, 'y', { bookwalker: 'n11' });
    expect(seriesEntries([v1, a, b, c], 'bookwalker').size).toBe(0);
    // The same list counts once it holds half of them.
    expect(seriesEntries([v1, a, b], 'bookwalker').size).toBe(2);
  });

  it("uses only Kindle results of Amazon's list", () => {
    const a = book('a', 9, '離婚のはずが大波乱!?', { amazon_jp: 'B011AYHGJC' });
    a.amazonList = [
      ['B011AYHGJC', `${VOL(9, '離婚のはずが大波乱!?')} (ビーズログ文庫)`],
      ['4047281131', `${VOL(1, '離婚できたら一攫千金！')} (ビーズログ文庫)`],
      ['B00A33COJE', `${VOL(1, '離婚できたら一攫千金！')} (ビーズログ文庫)`],
    ];
    const entries = seriesEntries([v1, a], 'amazon');
    expect([...entries.keys()].sort()).toEqual(['B00A33COJE', 'B011AYHGJC']);
    expect(seriesPick(linkRules(), v1, entries, (id) => id === 'B011AYHGJC')?.id).toBe(
      'B00A33COJE',
    );
  });

  it('groups series by the name without spacing and marks', () => {
    expect(seriesGroupKey('Re:ゼロ から 始める')).toBe(seriesGroupKey('Re：ゼロから始める'));
    expect(seriesGroupKey(null)).toBe('');
  });
});

describe('More direct links: pure parts', () => {
  it('adds ids only: never over one the book has, never one another book holds', () => {
    const r = linkAddedIds(
      { amazon_jp: 'B0OLD00000', isbn: '9780000000000' },
      [
        { site: 'amazon', id: 'B0NEW00000' },
        { site: 'ranobedb', id: '9026' },
        { site: 'bookwalker', id: BW(1) },
      ],
      (key, id) => key === 'bookwalker' && id === BW(1),
      () => 'nat',
    );
    expect(r.added).toEqual({ ranobedb: '9026' });
    expect(r.ids).toEqual({ amazon_jp: 'B0OLD00000', isbn: '9780000000000', ranobedb: '9026' });
  });

  it("adds Natively's id for a new Amazon id only", () => {
    const natively = (asin: string) => (asin === 'B0NEW00000' ? 'e8f395a12e' : null);
    expect(
      linkAddedIds({}, [{ site: 'amazon', id: 'B0NEW00000' }], () => false, natively).added,
    ).toEqual({
      amazon_jp: 'B0NEW00000',
      natively: 'e8f395a12e',
    });
    expect(
      linkAddedIds(
        { natively: 'mine' },
        [{ site: 'amazon', id: 'B0NEW00000' }],
        () => false,
        natively,
      ).added,
    ).toEqual({ amazon_jp: 'B0NEW00000' });
  });

  it('draws the spot check across the slots: in proportion, BOOK☆WALKER double, one from each', () => {
    const adds = {
      'amazon:record': 3000,
      'amazon:series': 1500,
      'ranobedb:record': 3000,
      'ranobedb:series': 600,
      'bookwalker:record': 1900,
      'bookwalker:series': 600,
    };
    const s = linkSpotShares(adds, 50);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(50);
    for (const slot of SPOT_SLOTS) expect(s[slot]).toBeGreaterThan(0);
    // BOOK☆WALKER's 2,500 of 10,600 links count double: 14.5 + 4.6 of the 50, both rounded up.
    expect(s['bookwalker:record'] + s['bookwalker:series']).toBe(20);
    // Never more than a slot has; everything when there is less than the size.
    expect(linkSpotShares({ 'amazon:record': 2, 'ranobedb:series': 1 }, 50)).toMatchObject({
      'amazon:record': 2,
      'ranobedb:series': 1,
      'bookwalker:record': 0,
    });
    expect(
      linkSpotShares({ 'amazon:record': 1000, 'ranobedb:series': 1 }, 50)['ranobedb:series'],
    ).toBe(1);
  });

  it('times a phase from what is open at its own pace, none before enough is measured', () => {
    const p = emptyLdProgress(1, LIB);
    p.books = 10_000;
    p.phaseStartedAt = 0;
    p.record.looked = 100;
    const w = { written: 0, toWrite: 0, pace: null };
    expect(linkBar(p, 10_000, w)).toMatchObject({ done: 100, total: 10_000, leftMs: null });
    p.record.looked = 2_000;
    expect(linkBar(p, 10_000, w).leftMs).toBe(40_000);
    p.phase = 'write';
    p.write.rebuilt = true;
    expect(linkBar(p, 0, { written: 100, toWrite: 300, pace: null }).leftMs).toBeNull();
    expect(
      linkBar(p, 0, { written: 100, toWrite: 300, pace: { ms: 60_000, items: 100 } }),
    ).toMatchObject({ done: 100, total: 400, leftMs: 180_000 });
  });
});

describe('More direct links: the pass', () => {
  let dir: string;
  let db: Database.Database;
  let books: Map<string, LinkFacts>;
  let planned: string[];
  let stamp: number;

  /** Stage 4 as the pass reads it. */
  const standIn = (): Stage4Analysis =>
    ({
      loadSnapshot: () => undefined,
      snapshotStamp: () => stamp,
      linkFacts: (_lib: string, uuid: string) => books.get(uuid) ?? null,
      snapshotIds: (uuid: string) => books.get(uuid)?.calibre.ids ?? null,
      snapshotBook: (_lib: string, uuid: string) => {
        const f = books.get(uuid);
        return f ? { calibreId: f.calibreId, uuid, identifiers: f.calibre.ids } : null;
      },
      linkSeries: () => {
        const out = new Map<string, string[]>();
        for (const f of books.values()) {
          const k = seriesGroupKey(f.calibre.series);
          if (k) out.set(k, [...(out.get(k) ?? []), f.uuid]);
        }
        for (const [k, g] of out) if (g.length < 2) out.delete(k);
        return out;
      },
      heldIds: (_lib: string, key: string) => {
        const out = new Map<string, string>();
        for (const f of books.values()) if (f.calibre.ids[key]) out.set(f.calibre.ids[key], f.uuid);
        return out;
      },
      nativelyId: (asin: string | null) => (asin === 'B00A33COJE' ? 'e8f395a12e' : null),
    }) as unknown as Stage4Analysis;

  const pass = () =>
    new LinkDiscovery({
      db,
      analysis: standIn(),
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

  const add = (f: LinkFacts, labeled = false) => {
    books.set(f.uuid, f);
    db.prepare(
      `INSERT INTO stage4_books (library_id, calibre_uuid, calibre_id, analysis_id, labeled, state, pending, updated_at)
       VALUES (?, ?, ?, 'a1', ?, 'proposed', 0, 0)`,
    ).run(LIB, f.uuid, f.calibreId, labeled ? 1 : 0);
  };

  const runUntil = async (p: LinkDiscovery, stop: (phase: string) => boolean) => {
    for (let i = 0; i < 2000; i++) {
      if (stop(p.state().progress.phase)) return;
      const r = await p.step();
      if (r === 'idle' || r === 'wait') return;
    }
  };

  const picks = () =>
    db
      .prepare(
        'SELECT calibre_uuid AS u, site, store_id AS id, how, state, saved_id AS saved FROM link_discovery_picks ORDER BY calibre_uuid, site',
      )
      .all() as {
      u: string;
      site: string;
      id: string;
      how: string;
      state: string;
      saved: string | null;
    }[];

  const proposals = () =>
    db
      .prepare(
        `SELECT calibre_uuid AS u, new_json, evidence_json, state, analysis_id FROM proposed_changes ORDER BY calibre_uuid`,
      )
      .all() as {
      u: string;
      new_json: string;
      evidence_json: string;
      state: string;
      analysis_id: string;
    }[];

  const rdbList: [string, string][] = [
    ['9026', VOL(1, '離婚できたら一攫千金!')],
    ['9581', VOL(2, '離婚できなきゃ大戦争!?')],
    ['15381', VOL(9, '離婚のはずが大波乱!?')],
  ];
  const inSeries = (f: LinkFacts, n: number, ids: Record<string, string> = {}): LinkFacts => ({
    ...f,
    calibre: { ...f.calibre, series: SERIES, index: n, ids },
    ranobedbList: rdbList,
  });

  beforeEach(() => {
    dir = makeTempDir('links-');
    db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
    books = new Map();
    planned = [];
    stamp = 1;
    // v1: stage 4 found its Amazon page and decided the title without its number (the user's
    // example): rule A refuses it, the series' list finds its RanobeDB page.
    const t1 = VOL(1, '離婚できたら一攫千金！');
    const v1 = inSeries(
      facts({
        uuid: 'v1',
        title: t1,
        calibreId: 1,
        amazon: {
          id: 'B00A33COJE',
          title: `${t1} (ビーズログ文庫)`,
          authors: ['夕鷺 かのう'],
          roles: ['著'],
          breadcrumbs: ['ライトノベル'],
        },
      }),
      1,
    );
    add(v1, true);
    // v2: both rules find the same RanobeDB page.
    const t2 = VOL(2, '離婚できなきゃ大戦争!?');
    add(
      inSeries(
        facts({
          uuid: 'v2',
          title: t2,
          calibreId: 2,
          ranobedb: { id: '9581', title: t2, authors: [AUTHOR] },
        }),
        2,
      ),
    );
    // v9: has its ids (the anchor).
    add(
      inSeries(facts({ uuid: 'v9', title: VOL(9, '離婚のはずが大波乱!?'), calibreId: 9 }), 9, {
        ranobedb: '15381',
      }),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('is cleanup.db v33 or later with its tables, Off by default', () => {
    expect(CLEANUP_SCHEMA_VERSION).toBeGreaterThanOrEqual(33);
    const p = pass();
    expect(p.state().mode).toBe('off');
    return expect(p.step()).resolves.toBe('idle');
  });

  it('runs every phase, resumes after a restart, and proposes add-only links', async () => {
    let p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'series');
    expect(p.state().progress.record).toMatchObject({ looked: 3, yours: 0, noFacts: 0 });
    expect(picks().map((x) => `${x.u}:${x.site}:${x.how}`)).toEqual([
      'v1:amazon:record',
      'v2:ranobedb:record',
    ]);
    // A restart: a new pass object goes on from the stored state.
    p = pass();
    await runUntil(p, (ph) => ph === 'spot');
    await p.step(); // draws the spot check
    const st = p.state().progress;
    expect(st.series).toMatchObject({ done: 1, agree: 1, differ: 0, saved: 0 });
    expect(st.series.picked.ranobedb).toBe(1);
    expect(picks().map((x) => `${x.u}:${x.site}:${x.how}:${x.id}:${x.state}`)).toEqual([
      'v1:amazon:record:B00A33COJE:ok',
      'v1:ranobedb:series:9026:ok',
      'v2:ranobedb:record:9581:ok',
    ]);
    const props = proposals();
    expect(props.map((x) => [x.u, x.state, x.analysis_id])).toEqual([
      ['v1', 'proposed', linkAnalysisId(1)],
      ['v2', 'proposed', linkAnalysisId(1)],
    ]);
    expect(JSON.parse(props[0].new_json)).toEqual({
      amazon_jp: 'B00A33COJE',
      ranobedb: '9026',
      natively: 'e8f395a12e',
    });
    expect(JSON.parse(props[0].evidence_json).links.ranobedb).toEqual({
      how: 'series',
      title: rdbList[0][1],
    });
    expect(st.propose).toMatchObject({ total: 2, done: 2, proposed: 2, natively: 1 });
    expect(p.spotCounts()).toEqual({ size: 3, right: 0, wrong: 0, open: 3 });
    expect(await p.step()).toBe('idle'); // Preview ends at the spot check
  });

  it('keeps neither id where the two rules disagree, and gives a claimed id to neither book', async () => {
    // v2's record now names another RanobeDB page than the series' list does.
    books.get('v2')!.ranobedb = {
      id: '777',
      title: VOL(2, '離婚できなきゃ大戦争!?'),
      authors: [AUTHOR],
    };
    // Two books outside the series claim one BOOK☆WALKER page.
    for (const u of ['x1', 'x2'])
      add(
        facts({
          uuid: u,
          title: '同じ題名の本',
          calibreId: 20,
          bookwalker: {
            id: BW(7),
            title: '同じ題名の本',
            keywords: `同じ題名の本,${AUTHOR},ライトノベル`,
          },
        }),
      );
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    const by = Object.fromEntries(picks().map((x) => [`${x.u}:${x.site}`, x.state]));
    expect(by).toMatchObject({
      'v2:ranobedb': 'differs',
      'x1:bookwalker': 'clash',
      'x2:bookwalker': 'clash',
    });
    expect(p.state().progress.series.differ).toBe(1);
    expect(p.state().progress.settle.clash).toBe(2);
    expect(proposals().map((x) => x.u)).toEqual(['v1']);
  });

  it("lists a saved id the series' list disagrees with, and changes nothing there", async () => {
    // v2 has volume 1's id saved (as found live for a spin-off series).
    books.get('v2')!.calibre.ids = { ranobedb: '9026' };
    books.get('v2')!.ranobedb = null;
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    expect(picks().filter((x) => x.u === 'v2')).toEqual([
      { u: 'v2', site: 'ranobedb', id: '9581', how: 'series', state: 'saved', saved: '9026' },
    ]);
    // v1's own page is held by v2, so the series' list gives v1 nothing at RanobeDB either.
    expect(proposals().find((x) => x.u === 'v2')).toBeUndefined();
    expect(JSON.parse(proposals().find((x) => x.u === 'v1')!.new_json).ranobedb).toBeUndefined();
    const saved = p.listLinks(LIB, 1, { state: 'saved' }, 0, 20);
    expect(saved.total).toBe(1);
    expect(saved.items[0].saved?.url).toBe('https://ranobedb.org/book/9026');
    expect(saved.items[0].store.url).toBe('https://ranobedb.org/book/9581');
  });

  it('never looks at a book whose identifiers are yours', async () => {
    db.prepare(
      `INSERT INTO user_fields (library_id, calibre_uuid, field, value_json, source, since) VALUES (?, 'v1', 'identifiers', '{}', 'edit', 0)`,
    ).run(LIB);
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    expect(p.state().progress.record.yours).toBe(1);
    expect(picks().some((x) => x.u === 'v1')).toBe(false);
  });

  it('holds a book with another open change, and never proposes again after an Undo', async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    db.prepare(`DELETE FROM proposed_changes`).run();
    expect(p.proposeOne(LIB, 1, 'v1')).toBe('proposed');
    db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source, class, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, 1, 'v1', 'identifiers', '{}', '{}', 'x', 'auto', 'proposed', 'other', 0, 0)`,
    ).run(LIB);
    expect(p.proposeOne(LIB, 1, 'v1')).toBe('held');
    db.prepare(`DELETE FROM proposed_changes WHERE analysis_id = 'other'`).run();
    expect(p.proposeOne(LIB, 1, 'v1')).toBe('proposed');
    // Calibre got the Amazon id meanwhile (from another book's id): only what is still new.
    books.get('v1')!.calibre.ids = { amazon_jp: 'B0SOMETHING' };
    expect(p.proposeOne(LIB, 1, 'v1')).toBe('proposed');
    expect(JSON.parse(proposals()[0].new_json)).toEqual({
      amazon_jp: 'B0SOMETHING',
      ranobedb: '9026',
    });
    db.prepare(`UPDATE proposed_changes SET state = 'undone'`).run();
    expect(p.proposeOne(LIB, 1, 'v1')).toBe('written');
    // Also in a later run.
    expect(p.proposeOne(LIB, 2, 'v1')).toBe('written');
  });

  it('allows On only with every link of the spot check right, then writes by its own analysis id', async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    await p.step();
    expect(() => p.setMode('on')).toThrow(/spot check/);
    const spot = p.listSpot(LIB, 1);
    expect(spot).toHaveLength(3);
    expect(spot[0].store.url).toMatch(/^https:\/\//);
    for (const s of spot) p.setVerdict(s.uuid, s.site, 'right');
    p.setVerdict(spot[0].uuid, spot[0].site, 'wrong');
    expect(p.spotPassed()).toBe(false); // one wrong is too many
    expect(() => p.setMode('on')).toThrow(/spot check/);
    p.setVerdict(spot[0].uuid, spot[0].site, 'right');
    p.setMode('on');
    for (let i = 0; i < 50 && p.state().progress.phase !== 'done'; i++) await p.step();
    expect(planned).toEqual([linkAnalysisId(1)]);
    expect(p.state().progress.phase).toBe('done');
    expect(proposals().every((x) => x.state === 'applied')).toBe(true);
    expect(() => p.setVerdict(spot[0].uuid, spot[0].site, 'wrong')).toThrow(/closed/);
  });

  it('goes back to Preview when a link is marked wrong while On waits', async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    await p.step();
    const spot = p.listSpot(LIB, 1);
    for (const s of spot) p.setVerdict(s.uuid, s.site, 'right');
    p.setMode('on');
    p.setVerdict(spot[1].uuid, spot[1].site, 'wrong');
    expect(p.state().mode).toBe('analyse');
    expect(await p.step()).toBe('idle');
    expect(planned).toEqual([]);
  });

  it('looks again from the start: a new run, its unwritten proposals gone, written ones kept', async () => {
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'spot');
    db.prepare(`UPDATE proposed_changes SET state = 'applied' WHERE calibre_uuid = 'v2'`).run();
    p.again();
    expect(p.state().progress).toMatchObject({ run: 2, phase: 'record' });
    expect(picks()).toEqual([]);
    expect(proposals().map((x) => [x.u, x.state])).toEqual([['v2', 'applied']]);
    // Calibre has v2's id now: the new run finds nothing more for it.
    books.get('v2')!.calibre.ids = { ranobedb: '9581' };
    stamp = 2;
    await runUntil(p, (ph) => ph === 'spot');
    expect(proposals().map((x) => [x.u, x.state, x.analysis_id])).toEqual([
      ['v1', 'proposed', linkAnalysisId(2)],
      ['v2', 'applied', linkAnalysisId(1)],
    ]);
  });

  it('ends without a spot check when nothing is found', async () => {
    for (const f of books.values()) {
      f.amazon = null;
      f.ranobedb = null;
      f.ranobedbList = [];
    }
    const p = pass();
    p.setMode('analyse');
    await runUntil(p, (ph) => ph === 'done');
    expect(p.state().progress.phase).toBe('done');
    expect(p.spotCounts().size).toBe(0);
  });

  it('reads its polled counts and its settling by index', () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    expect(
      plan(
        `SELECT state, site, how, COUNT(*) AS n FROM link_discovery_picks INDEXED BY link_discovery_picks_counts WHERE library_id = 'x' GROUP BY state, site, how`,
      ),
    ).toMatch(/COVERING INDEX link_discovery_picks_counts/);
    expect(
      plan(
        `SELECT site, store_id FROM link_discovery_picks INDEXED BY link_discovery_picks_id WHERE library_id = 'x' AND state = 'ok' GROUP BY site, store_id HAVING COUNT(*) > 1`,
      ),
    ).toMatch(/INDEX link_discovery_picks_id/);
    expect(
      plan(
        `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = 'x' AND state = 'applied' AND field = 'identifiers' AND analysis_id = 'y'`,
      ),
    ).toMatch(/COVERING INDEX proposed_changes_counts/);
    expect(
      plan(
        `SELECT id, state, analysis_id FROM proposed_changes INDEXED BY proposed_changes_book WHERE library_id = 'x' AND calibre_uuid = 'u' AND field = 'identifiers'`,
      ),
    ).toMatch(/INDEX proposed_changes_book/);
  });
});
