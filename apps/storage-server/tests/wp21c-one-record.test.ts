/**
 * WP21c follow-up (3): one store record per recording. The subtitle in a bracket at the end of
 * a title (`(妄想)` vs the store's `(入門)`: both were cleaned away, so two different books
 * agreed), measured on the live run's 33 candidates whose titles end in a bracket on both sides;
 * the one-record rule (online-records.ts) and stage 4's records phase on stage-3 rows with a
 * stand-in internet: fingerprints decide (stage 3's, or compared here when stage 3 never
 * compared the two, with the real tools in the Linux image), the exact-title tie-break, looked
 * up again without the record, Calibre first, nothing read twice; cleanup.db v18.
 */
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { updateAudioStage } from '../src/cleanup/audio/audio-stages';
import { evaluate, exactTitle, type UnitFacts } from '../src/cleanup/audio/online-match';
import { fullTitle, searchTitle, titleBracket } from '../src/cleanup/audio/online-names';
import type { StoreRecord } from '../src/cleanup/audio/online-pages';
import {
  applyOneRecord,
  combineLooks,
  stage3Look,
  type PairLook,
  type SharingUnit,
} from '../src/cleanup/audio/online-records';
import { audibleProduct, audibleSearch } from '../src/cleanup/audio/online-requests';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { AudioStage4, STAGE4_UNITS_VERSION } from '../src/cleanup/audio/stage4-online';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { makeTempDir } from './helpers/spawn-server';

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_TOOLS = hasTool('ffmpeg') && hasTool('ffprobe') && hasTool('fpcalc');
if (!HAS_TOOLS)
  console.warn('WP21c (3) real-tool tests SKIPPED: ffmpeg/ffprobe/fpcalc not on PATH');

function freshDb(): Database.Database {
  const s = initCleanupDatabase(makeTempDir('wp21c3-db'));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

const M = { runtimeMinutes: 2, titleScore: 0.8, titleMinChars: 3, titleMinShare: 0.25 };

/** Unit facts as stage 4 builds them from a file name. */
function factsOf(name: string, over: Partial<UnitFacts> = {}): UnitFacts {
  return {
    title: searchTitle(name),
    otherTitles: [],
    authors: [],
    narrators: [],
    volume: null,
    drama: null,
    seconds: 3600,
    files: 1,
    titleBracket: titleBracket(name),
    fullTitle: fullTitle(name),
    ...over,
  };
}

function rec(over: Partial<StoreRecord>): StoreRecord {
  return {
    source: 'audible',
    id: 'B0TEST0000',
    title: '本',
    subtitle: null,
    authors: [],
    narrators: [],
    seconds: 3600,
    publisher: null,
    releaseDate: null,
    series: [],
    extra: {},
    ...over,
  };
}

// The live run's 33 automatic candidates whose title ends in a bracket on both sides
// (2026-11-21 07:39 copy): file name, store title.
const LIVE_PAIRS: [string, string][] = [
  [
    '天国の犬ものがたり～ありがとう～（小学館ジュニア文庫）_ （小学館） [B0CVRNVKK2]',
    '天国の犬ものがたり～ありがとう～（小学館ジュニア文庫）',
  ],
  ['[7巻] Fate∕strange Fake(7)꞉ (KADOKAWA) [B0D6NMRJBN]', '[7巻] Fate/strange Fake(7)'],
  [
    'ぼくのひいおばあちゃんはこんなに可愛い（以下略）꞉ (小学館) [B0G3T3T5VB]',
    'ぼくのひいおばあちゃんはこんなに可愛い（以下略）',
  ],
  ['消滅　VANISHING POINT（下）_ (幻冬舎文庫) [B0FW5SMT28]', '消滅　VANISHING POINT（下）'],
  [
    '黒川さんに悪役は似合わない ２（ガガガ文庫）_ （小学館） [B0CJRBWD3P]',
    '黒川さんに悪役は似合わない ２（ガガガ文庫）',
  ],
  [
    '人類は衰退しました 3（ガガガ文庫）꞉ （小学館） [B0BKPX99KY]',
    '人類は衰退しました 3（ガガガ文庫）',
  ],
  [
    'サンタクロースを殺した。そして、キスをした。（ガガガ文庫）. （小学館） [B0CCV9LFRY]',
    'サンタクロースを殺した。そして、キスをした。（ガガガ文庫）',
  ],
  [
    '総理通訳の外国語勉強法（現代新書）꞉ (講談社現代新書) [B084S9SW4S]',
    '総理通訳の外国語勉強法（現代新書）',
  ],
  ['[01] スロウハイツの神様（上）꞉ (講談社文庫) [B0BX2SLH25]', 'スロウハイツの神様（上）'],
  ['[02] 海賊とよばれた男（下）. (講談社文庫) [B0BSXFNY29]', '海賊とよばれた男（下）'],
  [
    'モテモテな僕は 世界まで救っちゃうんだぜ(入門)',
    'モテモテな僕は 世界まで救っちゃうんだぜ(入門)',
  ],
];

describe('the subtitle at the end of a title (the cause: (妄想) and (入門) were both cleaned away)', () => {
  it('searchTitle still drops the bracket (search URLs unchanged); fullTitle keeps it, drops TMW’s publisher', () => {
    const n = 'モテモテな僕は 世界まで救っちゃうんだぜ(妄想)';
    expect(searchTitle(n)).toBe('モテモテな僕は 世界まで救っちゃうんだぜ');
    expect(audibleSearch(searchTitle(n)).url).toBe(
      audibleSearch('モテモテな僕は 世界まで救っちゃうんだぜ').url,
    );
    expect(fullTitle(n)).toBe('モテモテな僕は 世界まで救っちゃうんだぜ(妄想)');
    expect(fullTitle('消滅　VANISHING POINT（下）_ (幻冬舎文庫) [B0FW5SMT28].m4b')).toBe(
      '消滅 VANISHING POINT(下)',
    );
    expect(fullTitle('[13巻] 安達としまむら13 (KADOKAWA)')).toBe('安達としまむら13');
  });

  it('titleBracket: a subtitle; never a volume, an imprint or publisher, a reader or a reading', () => {
    expect(titleBracket('モテモテな僕は 世界まで救っちゃうんだぜ(妄想)')).toBe('妄想');
    expect(titleBracket('ぼくのひいおばあちゃんはこんなに可愛い（以下略）')).toBe('以下略');
    // A volume number after it (the live search: "(泣)2" and "(泣)3" came before "(妄想)").
    expect(titleBracket('[2巻] モテモテな僕は 世界まで救っちゃうんだぜ(泣)2')).toBe('泣');
    expect(titleBracket('[6巻] モテモテな僕は 世界まで救っちゃうんだぜ(泣)６')).toBe('泣');
    for (const n of [
      '蜜蜂と遠雷（上）',
      'Fate/strange Fake(7)',
      '源氏物語(一)',
      '人生（ガガガ文庫）',
      '総理通訳の外国語勉強法（現代新書）',
      '卍（まんじ）',
      '令和 人間椅子（朗読：誰か）',
      '安達としまむら13 (KADOKAWA)',
      '負けヒロインが多すぎる！',
    ])
      expect(titleBracket(n), n).toBeNull();
  });

  it('on the live pairs only (妄想)/(入門) disagrees; every other pair keeps its agreement', () => {
    for (const [file, store] of LIVE_PAIRS) {
      const e = evaluate(factsOf(file), rec({ title: store }), M, {
        viaNameAsin: /\[B0/.test(file),
      });
      expect(e.checks.title.ok, file).toBe(true);
    }
    const mousou = factsOf('モテモテな僕は 世界まで救っちゃうんだぜ(妄想)', { seconds: 20136 });
    const nyumon = rec({
      id: 'B00WK0IARS',
      title: 'モテモテな僕は 世界まで救っちゃうんだぜ(入門)',
      seconds: 20100,
    });
    const e = evaluate(mousou, nyumon, M);
    expect(e.checks.title).toMatchObject({
      ok: false,
      detail: 'different subtitle: (妄想) / (入門)',
    });
    expect(e.pass).toBe(false);
    // Even when the id in the name chose it.
    expect(evaluate(mousou, nyumon, M, { viaNameId: true }).checks.title.ok).toBe(false);
    // A unit built before (no titleBracket) passes as it did: the units version makes the stage
    // build them again.
    expect(evaluate({ ...mousou, titleBracket: undefined }, nyumon, M).pass).toBe(true);
    // 4 added the bracket; later versions (5: the bare tag form, WP21f-2) keep it.
    expect(STAGE4_UNITS_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('exactTitle: the file’s own title with its subtitle is the store’s title, nothing cleaned away', () => {
    const store = 'モテモテな僕は 世界まで救っちゃうんだぜ(入門)';
    expect(exactTitle(factsOf('モテモテな僕は 世界まで救っちゃうんだぜ(入門).m4b'), store)).toBe(
      true,
    );
    expect(exactTitle(factsOf('モテモテな僕は 世界まで救っちゃうんだぜ(妄想).m4b'), store)).toBe(
      false,
    );
    expect(
      exactTitle(
        factsOf('[01] 負けヒロインが多すぎる！ [B0CGJ583HH].m4b'),
        '負けヒロインが多すぎる！',
      ),
    ).toBe(true);
    // An imprint in a last bracket counts on neither side (the live run: Audible's title had it,
    // the TMW name with the ASIN didn't).
    expect(
      exactTitle(factsOf('負けヒロインが多すぎる！（ガガガ文庫）'), '負けヒロインが多すぎる！'),
    ).toBe(true);
    expect(
      exactTitle(
        factsOf('[01] 負けヒロインが多すぎる！ [B0CGJ583HH].m4b'),
        '負けヒロインが多すぎる！（ガガガ文庫）',
      ),
    ).toBe(true);
    expect(exactTitle(factsOf('罪の声 完全収録版.m4b'), '罪の声')).toBe(false);
    expect(
      exactTitle(
        factsOf('[13巻] 安達としまむら13_ (KADOKAWA) [B0GP5PY2CH].m4b'),
        '[13巻] 安達としまむら13 (KADOKAWA)',
      ),
    ).toBe(true);
  });
});

describe('the one-record rule (pure)', () => {
  const u = (id: number, exact: boolean): SharingUnit => ({ id, name: `u${id}`, exact });
  const all = (l: PairLook) => () => l;

  it('stage 3’s measures: identical and same/partly alike, different, unknown; nothing measured = compare', () => {
    expect(stage3Look({ test: 'identical', verdict: 'same', fp_verdict: null })).toBe('alike');
    expect(stage3Look({ test: 'title', verdict: 'same', fp_verdict: 'same' })).toBe('alike');
    expect(stage3Look({ test: 'title', verdict: 'unsure', fp_verdict: 'partly' })).toBe('alike');
    expect(stage3Look({ test: 'title', verdict: 'different', fp_verdict: 'different' })).toBe(
      'different',
    );
    expect(stage3Look({ test: 'title', verdict: 'unsure', fp_verdict: 'unknown' })).toBe('unknown');
    expect(stage3Look({ test: 'title', verdict: 'pending', fp_verdict: null })).toBeNull();
    expect(combineLooks([null, 'alike', 'different'])).toBe('different');
    expect(combineLooks(['alike', 'unknown'])).toBe('alike');
    expect(combineLooks([null])).toBeNull();
  });

  it('alike keeps both; different: the exact title keeps, the other is looked up again; both or neither exact: review', () => {
    expect(applyOneRecord([u(1, true), u(2, false)], all('alike'))).toEqual({
      review: new Map(),
      exclude: new Map(),
    });
    const one = applyOneRecord([u(1, true), u(2, false)], all('different'));
    expect([...one.exclude]).toEqual([[2, 'u1']]);
    expect(one.review.size).toBe(0);
    for (const [a, b] of [
      [true, true],
      [false, false],
    ]) {
      const r = applyOneRecord([u(1, a), u(2, b)], all('different'));
      expect([...r.review]).toEqual([
        [1, ['u2']],
        [2, ['u1']],
      ]);
      expect(r.exclude.size).toBe(0);
    }
    // Windows that couldn't be read: both to review, exact title or not.
    expect(applyOneRecord([u(1, true), u(2, false)], all('unknown')).review.size).toBe(2);
  });

  it('the ASIN in the name first, then the exact title; the same ASIN in both: the title decides', () => {
    const v = (id: number, exact: boolean, asinInName: boolean): SharingUnit => ({
      id,
      name: `v${id}`,
      exact,
      asinInName,
    });
    // The record's ASIN in one name: it keeps, even against the exact title (ひと, 負けヒロイン).
    expect([
      ...applyOneRecord([v(1, true, false), v(2, true, true)], all('different')).exclude,
    ]).toEqual([[1, 'v2']]);
    expect([
      ...applyOneRecord([v(1, true, false), v(2, false, true)], all('different')).exclude,
    ]).toEqual([[1, 'v2']]);
    // The same ASIN in both names (or in neither): the exact title decides, else review.
    expect([
      ...applyOneRecord([v(1, true, true), v(2, false, true)], all('different')).exclude,
    ]).toEqual([[2, 'v1']]);
    expect(applyOneRecord([v(1, true, true), v(2, true, true)], all('different')).review.size).toBe(
      2,
    );
    // Windows that couldn't be read: both to review whatever the names say.
    expect(applyOneRecord([v(1, false, false), v(2, true, true)], all('unknown')).review.size).toBe(
      2,
    );
  });

  it('three on one record: looked up again wins over review, review over keeping', () => {
    // 1 exact, 2 and 3 not; 1-2 different, 1-3 alike, 2-3 different.
    const look = (a: SharingUnit, b: SharingUnit): PairLook =>
      a.id + b.id === 4 ? 'alike' : 'different';
    const r = applyOneRecord([u(1, true), u(2, false), u(3, false)], look);
    expect([...r.exclude.keys()]).toEqual([2]);
    expect([...r.review.keys()]).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------------------
// Stage 4 on stage-3 rows with a stand-in internet.

interface CopySpec {
  key: string;
  rel: string;
  name: string;
  seconds: number;
  asins?: string[];
  tags?: Record<string, string>;
  sha?: string;
}

/** Copies (each its own unit) and the pairs stage 3 measured between them. */
function seedStage3(
  db: Database.Database,
  copies: CopySpec[],
  pairs: { a: string; b: string; test: string; verdict: string; fp: string | null }[],
): string {
  const analysisId = randomUUID();
  const now = Date.now();
  const putFile = db.prepare(
    `INSERT INTO audio_files (root, rel_path, ext, kind, size, mtime_ms, dev, ino, nlink, sha256, first_seen_at, seen_at)
     VALUES ('torrents', ?, ?, 'audio', ?, ?, 1, ?, 1, ?, ?, ?)`,
  );
  const putHealth = db.prepare(
    `INSERT INTO audio_file_health (file_id, size, mtime_ms, duration, tags_json, header_ok, checked_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  const putCopy = db.prepare(
    `INSERT INTO audio_dup_copies (analysis_id, copy_key, book_key, kind, file_ids, name, seconds, ai, asins, abs_asins)
     VALUES (?, ?, ?, 'file', ?, ?, ?, 0, ?, '[]')`,
  );
  const ids = new Map<string, number>();
  copies.forEach((c, i) => {
    const size = 1000 + i;
    const f = putFile.run(c.rel, path.extname(c.rel), size, now, 100 + i, c.sha ?? null, now, now);
    const fid = Number(f.lastInsertRowid);
    putHealth.run(fid, size, now, c.seconds, c.tags ? JSON.stringify(c.tags) : null, now);
    const r = putCopy.run(
      analysisId,
      c.key,
      `torrents:${c.rel}`,
      JSON.stringify([fid]),
      c.name,
      c.seconds,
      JSON.stringify(c.asins ?? []),
    );
    ids.set(c.key, Number(r.lastInsertRowid));
  });
  for (const pr of pairs)
    db.prepare(
      `INSERT INTO audio_dup_pairs (analysis_id, a_id, b_id, test, verdict, fp_verdict) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(analysisId, ids.get(pr.a), ids.get(pr.b), pr.test, pr.verdict, pr.fp);
  updateAudioStage(db, 3, {
    state: 'ready',
    progress: { analysisId, phase: 'done', error: null, finishedAt: now },
  });
  return analysisId;
}

function answerAll(
  db: Database.Database,
  q: FetchQueue,
  pages: Map<string, Buffer>,
  asked: string[],
) {
  const rows = db
    .prepare(
      `SELECT id, url FROM fetch_requests WHERE state = 'queued'
       AND site IN ('audible', 'audible-sample', 'kikubon', 'audiobookjp', 'audiobookjp-sample')`,
    )
    .all() as { id: number; url: string }[];
  for (const r of rows) {
    const token = randomUUID();
    db.prepare(
      `UPDATE fetch_requests SET state = 'leased', lease_token = ?, lease_until = ? WHERE id = ?`,
    ).run(token, Date.now() + 60_000, r.id);
    asked.push(r.url);
    const body = pages.get(r.url);
    q.report(r.id, token, {
      status: body ? 200 : 404,
      ms: 1,
      error: null,
      body: body ?? Buffer.from('no'),
      encoding: 'identity',
    });
  }
}

function makeStage(db: Database.Database) {
  const lock = new DiskLock(5);
  const roots = { torrents: makeTempDir('wp21c3-t'), library: makeTempDir('wp21c3-l') };
  const tools = { ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg', fpcalcPath: 'fpcalc' };
  const queue = new FetchQueue(db, makeTempDir('wp21c3-cache'), () => getSettings(db).fetch);
  const readLabels = () => ({ text: JSON.stringify({ books: [] }), error: null });
  const stage3 = new AudioStage3({ db, roots, tools, lock, readLabels });
  const stage4 = new AudioStage4({ db, roots, tools, lock, queue, stage3, readLabels });
  return { stage4, queue, lock, roots };
}

async function runToEnd(
  db: Database.Database,
  stage4: AudioStage4,
  queue: FetchQueue,
  pages: Map<string, Buffer>,
  asked: string[],
  maxRounds = 300,
) {
  for (let i = 0; i < maxRounds; i++) {
    answerAll(db, queue, pages, asked);
    if (await stage4.step(() => false)) return;
  }
  throw new Error('stage 4 did not finish');
}

const product = (
  asin: string,
  title: string,
  minutes: number,
  extra: Record<string, unknown> = {},
) =>
  Buffer.from(
    JSON.stringify({
      product: {
        asin,
        title,
        runtime_length_min: minutes,
        authors: [{ name: '谷 春慶' }],
        narrators: [{ name: '大森 ゆき' }, { name: '河野 茉莉' }],
        ...extra,
      },
    }),
  );
const search = (items: { asin: string; title: string; minutes: number }[]) =>
  Buffer.from(
    JSON.stringify({
      products: items.map((x) => ({
        asin: x.asin,
        title: x.title,
        runtime_length_min: x.minutes,
        authors: [{ name: '谷 春慶' }],
        narrators: [{ name: '大森 ゆき' }, { name: '河野 茉莉' }],
      })),
    }),
  );
const TAGS = { artist: '谷 春慶', composer: '大森 ゆき, 河野 茉莉' };

const units = (db: Database.Database) =>
  db
    .prepare(
      'SELECT name, class, store_id, review_reason, detail, excluded_json FROM audio_online_units ORDER BY id',
    )
    .all() as {
    name: string;
    class: string;
    store_id: string | null;
    review_reason: string | null;
    detail: string | null;
    excluded_json: string;
  }[];

describe('stage 4: the subtitle fix and the one-record rule on stage-3 rows', () => {
  it('モテモテ: (入門) keeps B00WK0IARS, (妄想) finds B00WK0OM5M behind the (泣) volumes (the live answer’s order)', async () => {
    const db = freshDb();
    seedStage3(
      db,
      [
        {
          key: 'c1',
          rel: 'TMW/モテモテな僕は 世界まで救っちゃうんだぜ(入門).m4b',
          name: 'モテモテな僕は 世界まで救っちゃうんだぜ(入門)',
          seconds: 20169,
          tags: TAGS,
        },
        {
          key: 'c2',
          rel: 'TMW/モテモテな僕は 世界まで救っちゃうんだぜ(妄想).m4b',
          name: 'モテモテな僕は 世界まで救っちゃうんだぜ(妄想)',
          seconds: 20136,
          tags: TAGS,
        },
      ],
      [{ a: 'c1', b: 'c2', test: 'title', verdict: 'different', fp: 'different' }],
    );
    const { stage4, queue } = makeStage(db);
    const q = 'モテモテな僕は 世界まで救っちゃうんだぜ';
    const pages = new Map<string, Buffer>([
      [
        audibleSearch(q).url,
        // Audible's live answer, in its order (the other volumes' lengths are 3-30 min off).
        search([
          { asin: 'B00WK0NRH6', title: `[1巻] ${q}(泣)`, minutes: 371 },
          { asin: 'B00WK0NZW8', title: `[5巻] ${q}(泣)5`, minutes: 342 },
          { asin: 'B00WK0IARS', title: `${q}(入門)`, minutes: 335 },
          { asin: 'B00WK0N14U', title: `[2巻] ${q}(泣)2`, minutes: 335 },
          { asin: 'B00WK0JR5W', title: `[3巻] ${q}(泣)3`, minutes: 334 },
          { asin: 'B00WK0KESG', title: `[7巻] ${q}(泣)7`, minutes: 451 },
          { asin: 'B00WK0NVBI', title: `[6巻] ${q}(泣)６`, minutes: 367 },
          { asin: 'B00WK0OM5M', title: `${q}(妄想)`, minutes: 335 },
          { asin: 'B00WK0NE38', title: `[4巻] ${q}(泣)4`, minutes: 317 },
        ]),
      ],
      [audibleProduct('B00WK0IARS').url, product('B00WK0IARS', `${q}(入門)`, 335)],
      [audibleProduct('B00WK0N14U').url, product('B00WK0N14U', `[2巻] ${q}(泣)2`, 335)],
      [audibleProduct('B00WK0JR5W').url, product('B00WK0JR5W', `[3巻] ${q}(泣)3`, 334)],
      [audibleProduct('B00WK0OM5M').url, product('B00WK0OM5M', `${q}(妄想)`, 335)],
    ]);
    stage4.restart();
    const asked: string[] = [];
    await runToEnd(db, stage4, queue, pages, asked);
    expect(units(db).map((u) => [u.class, u.store_id])).toEqual([
      ['auto', 'B00WK0IARS'],
      ['auto', 'B00WK0OM5M'],
    ]);
    // One search for both (the same URL), each product read once; the (泣) volumes never read
    // (another subtitle); nothing shares a record.
    expect(asked.filter((u) => u === audibleSearch(q).url)).toHaveLength(1);
    expect(asked.some((u) => u.includes('B00WK0N14U') || u.includes('B00WK0JR5W'))).toBe(false);
    expect(stage4.progress()!.records).toMatchObject({ shared: 0, review: 0, lookedUpAgain: 0 });
  });

  it('different by fingerprints: the ASIN in the name keeps, else the exact title; the other is looked up again without the record; unreadable windows: review', async () => {
    const db = freshDb();
    seedStage3(
      db,
      [
        {
          key: 'm1',
          rel: 'TMW/負けヒロインが多すぎる！（ガガガ文庫）.m4b',
          name: '負けヒロインが多すぎる！（ガガガ文庫）',
          seconds: 25200,
        },
        {
          key: 'm2',
          rel: 'Discord/[01] 負けヒロインが多すぎる！ [B0CGJ583HH].m4b',
          name: '[01] 負けヒロインが多すぎる！ [B0CGJ583HH]',
          seconds: 25190,
        },
        {
          key: 's1',
          rel: 'Discord/罪の声 [B0TSUMINO0].m4b',
          name: '罪の声 [B0TSUMINO0]',
          seconds: 30000,
        },
        { key: 's2', rel: 'TMW/罪の声 完全収録版.m4b', name: '罪の声 完全収録版', seconds: 30010 },
        // Neither name has the ASIN: the exact title decides.
        { key: 'e1', rel: 'TMW/一瞬の風になれ.m4b', name: '一瞬の風になれ', seconds: 30000 },
        {
          key: 'e2',
          rel: 'Discord/一瞬の風になれ 完全版.m4b',
          name: '一瞬の風になれ 完全版',
          seconds: 30000,
        },
        {
          key: 'h1',
          rel: 'Discord/ひと [B0GXYRJ43N].m4b',
          name: 'ひと [B0GXYRJ43N]',
          seconds: 31920,
        },
        { key: 'h2', rel: 'TMW/ひと.m4b', name: 'ひと', seconds: 32040 },
        // Alike by stage 3's fingerprints: both keep the record.
        { key: 'a1', rel: 'TMW/地面師たち.m4b', name: '地面師たち', seconds: 34980 },
        {
          key: 'a2',
          rel: 'Discord/[01] 地面師たち [B0DQ69693N].m4b',
          name: '[01] 地面師たち [B0DQ69693N]',
          seconds: 34985,
        },
        // Windows stage 3 couldn't read: both to review.
        { key: 'k1', rel: 'TMW/ララピポ.m4b', name: 'ララピポ', seconds: 30720 },
        {
          key: 'k2',
          rel: 'Discord/ララピポ [B0LALAPIPO].m4b',
          name: 'ララピポ [B0LALAPIPO]',
          seconds: 30720,
        },
      ],
      [
        { a: 'm1', b: 'm2', test: 'title', verdict: 'different', fp: 'different' },
        { a: 's1', b: 's2', test: 'title', verdict: 'different', fp: 'different' },
        { a: 'e1', b: 'e2', test: 'title', verdict: 'different', fp: 'different' },
        { a: 'h1', b: 'h2', test: 'title', verdict: 'different', fp: 'different' },
        { a: 'a1', b: 'a2', test: 'title', verdict: 'same', fp: 'same' },
        { a: 'k1', b: 'k2', test: 'title', verdict: 'unsure', fp: 'unknown' },
      ],
    );
    const { stage4, queue } = makeStage(db);
    const plain = (asin: string, title: string, minutes: number) =>
      Buffer.from(JSON.stringify({ product: { asin, title, runtime_length_min: minutes } }));
    const hits = (asin: string, title: string, minutes: number) =>
      Buffer.from(JSON.stringify({ products: [{ asin, title, runtime_length_min: minutes }] }));
    const pages = new Map<string, Buffer>([
      [
        audibleProduct('B0CGJ583HH').url,
        plain('B0CGJ583HH', '負けヒロインが多すぎる！（ガガガ文庫）', 420),
      ],
      [
        audibleSearch('負けヒロインが多すぎる！').url,
        hits('B0CGJ583HH', '負けヒロインが多すぎる！（ガガガ文庫）', 420),
      ],
      [audibleProduct('B0TSUMINO0').url, plain('B0TSUMINO0', '罪の声', 500)],
      [audibleSearch('罪の声 完全収録版').url, hits('B0TSUMINO0', '罪の声', 500)],
      [audibleSearch('一瞬の風になれ').url, hits('B0ISSHUN00', '一瞬の風になれ', 500)],
      [audibleSearch('一瞬の風になれ 完全版').url, hits('B0ISSHUN00', '一瞬の風になれ', 500)],
      [audibleProduct('B0ISSHUN00').url, plain('B0ISSHUN00', '一瞬の風になれ', 500)],
      [audibleProduct('B0GXYRJ43N').url, plain('B0GXYRJ43N', 'ひと', 533)],
      [audibleSearch('ひと').url, hits('B0GXYRJ43N', 'ひと', 533)],
      [audibleProduct('B0DQ69693N').url, plain('B0DQ69693N', '地面師たち', 583)],
      [audibleSearch('地面師たち').url, hits('B0DQ69693N', '地面師たち', 583)],
      [audibleProduct('B0LALAPIPO').url, plain('B0LALAPIPO', 'ララピポ', 512)],
      [audibleSearch('ララピポ').url, hits('B0LALAPIPO', 'ララピポ', 512)],
    ]);
    stage4.restart();
    const asked: string[] = [];
    await runToEnd(db, stage4, queue, pages, asked);
    const u = units(db);
    const by = (n: string) => u.find((x) => x.name === n)!;
    // The record's ASIN in one name keeps it (罪の声, 負けヒロイン and ひと, the last two against
    // an exact title on the other side); the other is looked up again without it: not found.
    for (const [keep, lose, rec] of [
      ['罪の声 [B0TSUMINO0]', '罪の声 完全収録版', 'B0TSUMINO0'],
      [
        '[01] 負けヒロインが多すぎる！ [B0CGJ583HH]',
        '負けヒロインが多すぎる！（ガガガ文庫）',
        'B0CGJ583HH',
      ],
      ['ひと [B0GXYRJ43N]', 'ひと', 'B0GXYRJ43N'],
      // Neither name has the ASIN: the exact title keeps.
      ['一瞬の風になれ', '一瞬の風になれ 完全版', 'B0ISSHUN00'],
    ]) {
      expect(by(keep), keep).toMatchObject({ class: 'auto', store_id: rec });
      const lost = by(lose);
      expect(lost, lose).toMatchObject({ class: 'unknown', excluded_json: `["audible:${rec}"]` });
      expect(lost.detail).toMatch(new RegExp(`without audible:${rec}`));
    }
    // 地面師たち: alike, both keep. ララピポ: unknown windows, both to review.
    expect(by('地面師たち')).toMatchObject({ class: 'auto', store_id: 'B0DQ69693N' });
    expect(by('[01] 地面師たち [B0DQ69693N]')).toMatchObject({
      class: 'auto',
      store_id: 'B0DQ69693N',
    });
    expect(by('ララピポ')).toMatchObject({ class: 'review', review_reason: 'shared' });
    const p = stage4.progress()!;
    expect(p.phase).toBe('done');
    expect(p.records).toMatchObject({
      shared: 6,
      different: 4,
      review: 2,
      lookedUpAgain: 4,
      compared: 0,
    });
    expect(p.counts).toMatchObject({ 'review:shared': 2 });
    // The excluded record was never asked again for the unit that lost it: one product request.
    expect(asked.filter((x) => x === audibleProduct('B0TSUMINO0').url)).toHaveLength(1);
    // Deciding again (a settings change) starts the rule from scratch and comes out the same.
    updateSettings(db, { audiobooks: { ...getSettings(db).audiobooks, onlineRuntimeMinutes: 3 } });
    stage4.redecide();
    expect(units(db).every((x) => x.excluded_json === '[]')).toBe(true);
    await runToEnd(db, stage4, queue, pages, asked);
    expect(units(db).map((x) => [x.name, x.class])).toEqual(u.map((x) => [x.name, x.class]));
  });

  it('never compared by stage 3, unreadable files: compared here, the windows unknown: both to review', async () => {
    const db = freshDb();
    seedStage3(
      db,
      [
        { key: 't1', rel: 'TMW/旅ドロップ.m4b', name: '旅ドロップ', seconds: 8700 },
        {
          key: 't2',
          rel: 'Discord/旅ドロップ [dwango 18147483].m4b',
          name: '旅ドロップ [dwango 18147483]',
          seconds: 8700,
        },
      ],
      [],
    );
    const { stage4, queue, lock } = makeStage(db);
    const hits = Buffer.from(
      JSON.stringify({
        products: [{ asin: 'B0TABIDROP', title: '旅ドロップ', runtime_length_min: 145 }],
      }),
    );
    const pages = new Map<string, Buffer>([
      [audibleSearch('旅ドロップ').url, hits],
      [
        audibleProduct('B0TABIDROP').url,
        Buffer.from(
          JSON.stringify({
            product: { asin: 'B0TABIDROP', title: '旅ドロップ', runtime_length_min: 145 },
          }),
        ),
      ],
    ]);
    // While a Calibre job holds the disk the phase waits, and the waiting is not work time.
    lock.tryAcquire('Calibre stage 4 (applying a batch)', 'calibre');
    stage4.restart();
    for (let i = 0; i < 40 && stage4.progress()!.phase !== 'records'; i++) {
      answerAll(db, queue, pages, []);
      await stage4.step(() => false);
    }
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) await stage4.step(() => false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
    expect(stage4.progress()!.phase).toBe('records');
    expect(stage4.progress()!.phaseTimes.records?.ms ?? 0).toBeLessThan(500);
    lock.release('Calibre stage 4 (applying a batch)');
    await runToEnd(db, stage4, queue, pages, []);
    expect(units(db).map((u) => [u.class, u.review_reason])).toEqual([
      ['review', 'shared'],
      ['review', 'shared'],
    ]);
    expect(db.prepare('SELECT verdict FROM audio_online_pair_checks').all()).toEqual([
      { verdict: 'unknown' },
    ]);
    expect(stage4.progress()!.records).toMatchObject({ compared: 1 });
  });
});

// ---------------------------------------------------------------------------------------
function samples(seconds: number, seed: number, rate = 22050): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n);
  let s = seed >>> 0 || 1;
  const r = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const seg = Math.round(rate / 4);
  let f1 = 0;
  let f2 = 0;
  let amp = 0;
  for (let i = 0; i < n; i++) {
    if (i % seg === 0) {
      f1 = 150 + r() * 1500;
      f2 = 300 + r() * 2500;
      amp = 0.2 + r() * 0.5;
    }
    const t = i / rate;
    const k = i % seg;
    const env = Math.min(1, k / 200, (seg - k) / 200);
    const v =
      amp * env * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t));
    out[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

function wav(parts: Int16Array[], rate = 22050): Buffer {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const b = Buffer.alloc(44 + total * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + total * 2, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(total * 2, 40);
  let o = 44;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) b.writeInt16LE(p[i], o);
  return b;
}

describe.skipIf(!HAS_TOOLS)('never compared by stage 3: compared here with the real tools', () => {
  it('the same recording in mp3 and m4b keeps the record; another recording sends both to review; Calibre first; nothing read twice', async () => {
    const work = makeTempDir('wp21c3-audio');
    const ff = (args: string[]) =>
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });
    const book = samples(300, 7);
    const other = samples(300, 8);
    const db = freshDb();
    const { stage4, queue, lock, roots } = makeStage(db);
    const src = (name: string, s: Int16Array) => {
      const p = path.join(work, `${name}.wav`);
      fs.writeFileSync(p, wav([s]));
      return p;
    };
    const put = (rel: string, wavPath: string, codec: string[]) => {
      fs.mkdirSync(path.join(roots.torrents, path.dirname(rel)), { recursive: true });
      ff(['-i', wavPath, ...codec, path.join(roots.torrents, rel)]);
    };
    const aac = ['-c:a', 'aac', '-b:a', '64k'];
    const mp3 = ['-c:a', 'libmp3lame', '-b:a', '64k'];
    put('TMW/かがみの孤城.m4b', src('k', book), aac);
    put('_extracted/かがみの孤城.zip/かがみの孤城.mp3', src('k', book), mp3);
    put('TMW/君の膵臓をたべたい.m4b', src('o1', book), aac);
    put('Discord/君の膵臓をたべたい.mp3', src('o2', other), mp3);
    seedStage3(
      db,
      [
        { key: 'k1', rel: 'TMW/かがみの孤城.m4b', name: 'かがみの孤城', seconds: 300 },
        {
          key: 'k2',
          rel: '_extracted/かがみの孤城.zip/かがみの孤城.mp3',
          name: 'かがみの孤城',
          seconds: 300,
        },
        { key: 'o1', rel: 'TMW/君の膵臓をたべたい.m4b', name: '君の膵臓をたべたい', seconds: 300 },
        {
          key: 'o2',
          rel: 'Discord/君の膵臓をたべたい.mp3',
          name: '君の膵臓をたべたい',
          seconds: 300,
        },
      ],
      [],
    );
    const hit = (asin: string, title: string) =>
      Buffer.from(JSON.stringify({ products: [{ asin, title, runtime_length_min: 5 }] }));
    const prod = (asin: string, title: string) =>
      Buffer.from(JSON.stringify({ product: { asin, title, runtime_length_min: 5 } }));
    const pages = new Map<string, Buffer>([
      [audibleSearch('かがみの孤城').url, hit('B0KAGAMI00', 'かがみの孤城')],
      [audibleProduct('B0KAGAMI00').url, prod('B0KAGAMI00', 'かがみの孤城')],
      [audibleSearch('君の膵臓をたべたい').url, hit('B0KIMINO00', '君の膵臓をたべたい')],
      [audibleProduct('B0KIMINO00').url, prod('B0KIMINO00', '君の膵臓をたべたい')],
    ]);
    // While a Calibre job holds the disk nothing is read.
    lock.tryAcquire('Calibre stage 3 (content duplicates)', 'calibre');
    stage4.restart();
    const asked: string[] = [];
    for (let i = 0; i < 30 && stage4.progress()!.phase !== 'records'; i++) {
      answerAll(db, queue, pages, asked);
      await stage4.step(() => false);
    }
    for (let i = 0; i < 3; i++) await stage4.step(() => false);
    expect(stage4.progress()!.phase).toBe('records');
    expect(stage4.waitingForDisk()).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audio_fingerprints').get()).toEqual({ n: 0 });
    lock.release('Calibre stage 3 (content duplicates)');
    await runToEnd(db, stage4, queue, pages, asked);
    const u = units(db);
    expect(u.map((x) => [x.name, x.class, x.store_id])).toEqual([
      ['かがみの孤城', 'auto', 'B0KAGAMI00'],
      ['かがみの孤城', 'auto', 'B0KAGAMI00'],
      ['君の膵臓をたべたい', 'review', 'B0KIMINO00'],
      ['君の膵臓をたべたい', 'review', 'B0KIMINO00'],
    ]);
    const checks = db
      .prepare('SELECT a_name, verdict FROM audio_online_pair_checks ORDER BY a_name')
      .all() as { a_name: string; verdict: string }[];
    expect(checks.map((c) => c.verdict).sort()).toEqual(['different', 'same']);
    const fps = (db.prepare('SELECT COUNT(*) AS n FROM audio_fingerprints').get() as { n: number })
      .n;
    expect(fps).toBeGreaterThan(0);
    // Decided again: the comparisons come from the table; nothing is read twice.
    const before = db
      .prepare('SELECT win_key, made_at FROM audio_fingerprints ORDER BY win_key')
      .all();
    stage4.redecide();
    await runToEnd(db, stage4, queue, pages, asked);
    expect(
      db.prepare('SELECT win_key, made_at FROM audio_fingerprints ORDER BY win_key').all(),
    ).toEqual(before);
    expect(units(db).map((x) => x.class)).toEqual(['auto', 'auto', 'review', 'review']);
  }, 240_000);
});

describe('cleanup.db v18', () => {
  it('adds the pair checks and the exclusions; the records phase’s queries use indexes', () => {
    const db = freshDb();
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(18);
    const cols = (
      db.prepare('PRAGMA table_info(audio_online_units)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('excluded_json');
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    for (const q of [
      `SELECT id, name FROM audio_online_units WHERE analysis_id = 'a' AND class = 'auto' AND (source, store_id) IN (SELECT source, store_id FROM audio_online_units WHERE analysis_id = 'a' AND class = 'auto' AND source IS NOT NULL GROUP BY source, store_id HAVING COUNT(*) > 1) ORDER BY source, store_id, id`,
      `SELECT id FROM audio_dup_copies WHERE analysis_id = 'a' AND copy_key = 'k'`,
      `SELECT test, verdict, fp_verdict FROM audio_dup_pairs WHERE analysis_id = 'a' AND a_id = 1 AND b_id = 2`,
      `SELECT verdict FROM audio_online_pair_checks WHERE pair_key = 'k'`,
    ])
      expect(plan(q), q).not.toMatch(
        /SCAN (audio_online_units|audio_dup_copies|audio_dup_pairs|audio_online_pair_checks)\b(?! USING)/,
      );
  });
});
