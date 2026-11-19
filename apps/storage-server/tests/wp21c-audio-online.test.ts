/**
 * WP21c: the audiobook cleanup's stage 4, online sources. The requests (the reference sample's
 * exact URLs), the parsers on real store answers, the names, the four checks and the review
 * reasons (the sample's runtime-only traps), the gate, the shared fetch queue (Audible never
 * paced or backed off with Amazon, and the other way round), cleanup.db v12 and its indexes,
 * the stage on built stage-3 rows with a stand-in internet (units, order, restart, settings,
 * switched-off sites, routes), and the sample-audio comparison with the real tools (ffmpeg and
 * fpcalc; it runs in the Linux image like WP21b's).
 */
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { gunzipSync } from 'zlib';
import { describe, expect, it, vi } from 'vitest';
import { allowedUrl } from '../../cleanup-fetch/src/hosts';
import {
  getAudioStage,
  setAudioStageMode,
  updateAudioStage,
} from '../src/cleanup/audio/audio-stages';
import { scoreOnlineGate, type LabeledBook } from '../src/cleanup/audio/online-gate';
import {
  dramaNumber,
  evaluate,
  storeTitle,
  titlesAgree,
  volumeMarks,
  type UnitFacts,
} from '../src/cleanup/audio/online-match';
import {
  authorFromName,
  meaningless,
  peopleFromTags,
  searchTitle,
  titleVariants,
} from '../src/cleanup/audio/online-names';
import {
  clockSeconds,
  parseAbjpProduct,
  parseAbjpSearch,
  parseAudibleProduct,
  parseAudibleSample,
  parseAudibleSearch,
  parseKikubonProduct,
  parseKikubonSearch,
  type StoreRecord,
} from '../src/cleanup/audio/online-pages';
import {
  abjpSampleAudio,
  abjpSearch,
  audibleProduct,
  audibleSampleAudio,
  audibleSampleInfo,
  audibleSearch,
  kikubonProduct,
  kikubonSearch,
} from '../src/cleanup/audio/online-requests';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { AudioStage4, stage4Counts } from '../src/cleanup/audio/stage4-online';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

const FIX = path.join(__dirname, 'fixtures', 'wp21c');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8')) as {
  name: string;
  url: string;
  status: number;
}[];
const page = (name: string) => gunzipSync(fs.readFileSync(path.join(FIX, `${name}.gz`)));
const urlOf = (name: string) => manifest.find((m) => m.name === name)!.url;

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_TOOLS = hasTool('ffmpeg') && hasTool('ffprobe') && hasTool('fpcalc');
if (!HAS_TOOLS) console.warn('WP21c real-tool tests SKIPPED: ffmpeg/ffprobe/fpcalc not on PATH');

function freshDb(): Database.Database {
  const s = initCleanupDatabase(makeTempDir('wp21c-db'));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

const M = { runtimeMinutes: 2, titleScore: 0.8 };

function unit(over: Partial<UnitFacts>): UnitFacts {
  return {
    title: '本',
    otherTitles: [],
    authors: [],
    narrators: [],
    volume: null,
    drama: null,
    seconds: 3600,
    files: 1,
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

// ---------------------------------------------------------------------------------------
describe('requests are the reference sample’s', () => {
  it('builds the sample’s exact URLs (product, search, kikubon, audiobook.jp)', () => {
    expect(audibleProduct('B09VNK3Q9H').url).toBe(urlOf('audible-product-cd3'));
    expect(audibleSearch('源氏物語 第五帖 若紫').url).toBe(urlOf('audible-search-wakamurasaki'));
    expect(kikubonSearch('藪の中 分割版007').url).toBe(urlOf('kikubon-search-yabu'));
    expect(kikubonProduct('964').url).toBe(urlOf('kikubon-product-964'));
    expect(abjpSearch('脳のパフォーマンスを最大まで引き出す 神・時間術').url).toBe(
      urlOf('abjp-search-jikanjutsu'),
    );
    expect(abjpSearch('グイン・サーガ(12) 紅の密使').url).toBe(urlOf('abjp-search-none'));
    // The search asks for product_desc (without it the titles come back empty).
    expect(audibleSearch('x').url).toContain('product_desc');
    expect(audibleSearch('x', true).url).toMatch(/&keywords=x$/);
    expect(audibleSampleInfo('B079YB26J1').url).toBe(
      'https://api.audible.co.jp/1.0/catalog/products/B079YB26J1?response_groups=sample',
    );
  });

  it('sample audio only from the stores’ own sample places; the fetcher allows nothing else', () => {
    const a = 'https://samples.audible.com/bk/panr/001596/bk_panr_001596_sample.mp3';
    const b =
      'https://storage.googleapis.com/otobank-abjp-core-prod.appspot.com/audios/sample/270620.mp3?gen=1';
    expect(audibleSampleAudio(a)?.site).toBe('audible-sample');
    expect(abjpSampleAudio(b)?.site).toBe('audiobookjp-sample');
    expect(audibleSampleAudio('https://evil.example/x.mp3')).toBeNull();
    expect(abjpSampleAudio('https://storage.googleapis.com/someone-else/x.mp3')).toBeNull();
    for (const u of [a, b, urlOf('audible-product-cd3'), urlOf('kikubon-search-yabu')]) {
      expect(allowedUrl(u), u).not.toBeNull();
    }
    expect(allowedUrl('https://storage.googleapis.com/someone-else/x.mp3')).toBeNull();
    expect(
      allowedUrl('https://storage.googleapis.com/otobank-abjp-core-prod.appspot.com/../../x'),
    ).toBeNull();
    expect(allowedUrl('http://audiobook.jp/search?q=x')).toBeNull();
    expect(allowedUrl('https://www.audible.co.jp/pd/B079YB26J1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
describe('store answers (real pages from the reference sample)', () => {
  it('Audible: a product with its series position, an ASIN Audible doesn’t sell, a search', () => {
    const p = parseAudibleProduct(page('audible-product-cd3'))!;
    expect(p.title).toContain('本好きの下剋上');
    expect(p.seconds).toBe(60 * 60);
    expect(p.narrators).toContain('井口 裕香');
    expect(p.series[0]).toMatchObject({ name: '[CD] 本好きの下剋上', sequence: '3', sort: '3' });
    expect(p.extra.product_images).toBeTruthy(); // every field kept for WP21d
    expect(parseAudibleProduct(page('audible-product-none'))).toBeNull();
    const hits = parseAudibleSearch(page('audible-search-wakamurasaki'));
    expect(hits.map((h) => h.id)).toContain('B00YTC9VBO');
    const w = hits.find((h) => h.id === 'B00YTC9VBO')!;
    expect(w.record?.narrators).toEqual(['岡崎 弥保']);
    expect(w.seconds).toBe(111 * 60);
    expect(
      parseAudibleSample(
        '{"product":{"asin":"B079YB26J1","sample_url":"https://samples.audible.com/bk/x_sample.mp3"}}',
      ),
    ).toBe('https://samples.audible.com/bk/x_sample.mp3');
  });

  it('kikubon: its result list and a product page with runtime, narrators and publisher', () => {
    const hits = parseKikubonSearch(page('kikubon-search-yabu'));
    expect(hits.map((h) => h.id)).toEqual(['743', '355', '22']);
    expect(hits[0]).toMatchObject({
      authors: ['芥川龍之介'],
      narrators: ['古川登志夫', '柿沼紫乃'],
    });
    const p = parseKikubonProduct(page('kikubon-product-964'), '964')!;
    expect(p).toMatchObject({
      title: 'グイン・サーガ(12) 紅の密使',
      authors: ['栗本薫'],
      narrators: ['下山吉光', '浅井晴美'],
      seconds: 7 * 3600 + 32 * 60 + 38,
      publisher: '早川書房',
    });
    expect((p.extra.chapters as unknown[]).length).toBe(4);
  });

  it('audiobook.jp: results without the new-arrivals lane, none when nothing matched, a product with its sample', () => {
    const hits = parseAbjpSearch(page('abjp-search-jikanjutsu'));
    expect(hits[0]).toMatchObject({ id: '237845', narrators: ['清水圭吾'], seconds: 21000 });
    expect(hits.every((h) => h.id !== '277236')).toBe(true);
    expect(parseAbjpSearch(page('abjp-search-none'))).toEqual([]);
    const p = parseAbjpProduct(page('abjp-product-265254'), '265254')!;
    expect(p).toMatchObject({
      title: 'さるのこしかけ',
      authors: ['さくらももこ'],
      narrators: ['TARAKO'],
      seconds: 3 * 3600 + 49 * 60 + 29,
      publisher: '集英社',
    });
    expect(p.extra.sampleUrl).toMatch(
      /^https:\/\/storage\.googleapis\.com\/otobank-abjp-core-prod\.appspot\.com\/audios\/sample\/265254\.mp3/,
    );
    expect(clockSeconds('7時間32分38秒')).toBe(27158);
    expect(clockSeconds('13分08秒')).toBe(788);
  });
});

// ---------------------------------------------------------------------------------------
describe('names', () => {
  it('search titles as refsample.py made them, and the variants tried before giving up', () => {
    expect(searchTitle('[小川糸] 食堂かたつむり.m4b')).toBe('食堂かたつむり');
    expect(searchTitle('[12] グイン・サーガ(12) 紅の密使 [kikubon 964].m4b')).toBe(
      'グイン・サーガ(12) 紅の密使',
    );
    expect(searchTitle('[4巻] 錆喰いビスコ4 業花の帝冠、花束の剣.m4b')).toBe(
      '錆喰いビスコ4 業花の帝冠、花束の剣',
    );
    expect(searchTitle('Bonus - 藪の中 分割版007')).toBe('藪の中 分割版007');
    expect(titleVariants('薬屋のひとりごと４')).toEqual([
      '薬屋のひとりごと４',
      '薬屋のひとりごと4',
      '薬屋のひとりごと 4',
      '薬屋のひとりごと',
    ]);
    for (const q of [
      'Unknown',
      'AI',
      '12',
      'moved',
      'Discord',
      'MAM',
      'TMW Japanese Audiobooks Collection (Part 3)',
    ])
      expect(meaningless(q), q).toBe(true);
  });

  it('authors from "[著者] " names, never volume or CD tags; narrators from the composer tag', () => {
    expect(authorFromName('[田中 芳樹] タイタニア')).toBe('田中 芳樹');
    expect(authorFromName('[4巻] 本')).toBeNull();
    expect(authorFromName('[第1弾] 本')).toBeNull();
    expect(authorFromName('[下巻] 本')).toBeNull();
    expect(authorFromName('[CD]本')).toBeNull();
    expect(peopleFromTags({ artist: '宮部 みゆき', composer: '井上 悟' })).toEqual({
      authors: ['宮部 みゆき'],
      narrators: ['井上 悟'],
    });
    // Without a composer the artist may be the narrator: neither is used.
    expect(peopleFromTags({ artist: '住谷哲栄' })).toEqual({ authors: [], narrators: [] });
  });
});

// ---------------------------------------------------------------------------------------
describe('accepting a match (all four checks; the sample’s runtime-only traps)', () => {
  it('a record agreeing on title, author, volume and length is a match', () => {
    const e = evaluate(
      unit({
        title: 'ペテロの葬列 上： 杉村三郎シリーズ３',
        volume: '3',
        authors: ['宮部 みゆき'],
        seconds: 48030,
      }),
      rec({
        title: 'ペテロの葬列 上',
        authors: ['宮部 みゆき'],
        seconds: 800 * 60,
        series: [
          { name: '杉村三郎シリーズ', sequence: '杉村三郎シリーズ３ 上', sort: '3', id: null },
        ],
      }),
      M,
    );
    expect(e.failed).toEqual([]);
  });

  it('kikubon 兇人邸の殺人 for 魔眼の匣の殺人 (0.5 min apart, same author): the title differs', () => {
    const e = evaluate(
      unit({ title: '魔眼の匣の殺人', authors: ['今村 昌弘'], seconds: 774.9 * 60 }),
      rec({
        source: 'kikubon',
        title: '兇人邸の殺人　＜剣崎比留子シリーズ＞',
        authors: ['今村昌弘'],
        seconds: 774.4 * 60,
      }),
      M,
    );
    expect(e.failed).toContain('title');
  });

  it('Audible 小鳥とリムジン for 食堂かたつむり: the title differs', () => {
    expect(
      evaluate(
        unit({ title: '食堂かたつむり', seconds: 538 * 60 }),
        rec({ title: '小鳥とリムジン', seconds: 538 * 60 }),
        M,
      ).failed,
    ).toContain('title');
  });

  it('とある飛空士への恋歌3 for 恋歌: the store prints a volume the file lacks', () => {
    const e = evaluate(
      unit({ title: '恋歌', seconds: 641 * 60 }),
      rec({ title: 'とある飛空士への恋歌3', seconds: 641 * 60 }),
      M,
    );
    expect(e.checks.title.ok).toBe(true);
    expect(e.failed).toEqual(['volume']);
  });

  it('another translation (源氏物語 若紫) and other editions (金五十両): the narrator differs', () => {
    const e = evaluate(
      unit({ title: '金五十両', narrators: ['楠木 華子'], seconds: 45.8 * 60 }),
      rec({ title: '金五十両', narrators: ['斉藤 範子'], seconds: 45 * 60 }),
      M,
    );
    expect(e.failed).toEqual(['narrator']);
  });

  it('a later edition (魔弾の射手 完全版, +16 min) is not a match: the length differs', () => {
    const e = evaluate(
      unit({ title: '魔弾の射手―天久鷹央の事件カルテ―', seconds: 587.1 * 60 }),
      rec({ title: '魔弾の射手―天久鷹央の事件カルテ― 完全版', seconds: 603 * 60 }),
      M,
    );
    expect(e.failed).toEqual(['runtime']);
  });

  it('drama CDs: the number decides, never the length (CD1 68 min vs CD2 69 min)', () => {
    const u = unit({ title: '白豚貴族ドラマCD', drama: { number: '1' }, seconds: 69.1 * 60 });
    const cd2 = rec({ title: '[CD2]白豚貴族 ドラマCD2', seconds: 69 * 60 });
    expect(evaluate(u, cd2, M).failed).toContain('volume');
    // Without a number in the file name only the ASIN in the name may decide.
    const noNumber = unit({ title: '白豚貴族ドラマCD', drama: { number: null }, seconds: 68 * 60 });
    const cd1 = rec({ title: '白豚貴族ドラマCD', seconds: 68 * 60 });
    expect(evaluate(noNumber, cd1, M).failed).toContain('volume');
    expect(evaluate(noNumber, cd1, M, { viaNameAsin: true }).failed).toEqual([]);
    expect(dramaNumber('[CD7]本好きの下剋上～ドラマCD7')).toBe('7');
  });

  it('half and third lengths only for several files (藪の中: 7 files, the whole book’s length)', () => {
    const r = rec({ title: '藪の中', seconds: 30 * 60 });
    expect(evaluate(unit({ title: '藪の中', seconds: 29.9 * 60, files: 7 }), r, M).failed).toEqual(
      [],
    );
    const doubled = evaluate(unit({ title: '藪の中', seconds: 60 * 60, files: 2 }), r, M);
    expect(doubled.fraction).toBe(2);
    expect(doubled.failed).toEqual(['runtime']);
    // A single file never matches at half its length (the 源氏物語 trap).
    expect(
      evaluate(unit({ title: '藪の中', seconds: 60 * 60, files: 1 }), r, M).fraction,
    ).toBeNull();
  });

  it('names: a one-character pen name; other scripts can’t be compared', () => {
    expect(evaluate(unit({ authors: ['岬'] }), rec({ authors: ['岬'] }), M).checks.author.ok).toBe(
      true,
    );
    expect(
      evaluate(unit({ authors: ['岬'] }), rec({ authors: ['岬下'] }), M).checks.author.ok,
    ).toBe(false);
    const c = evaluate(
      unit({ authors: ['Arthur Conan Doyle'] }),
      rec({ authors: ['アーサー・コナン・ドイル'] }),
      M,
    ).checks.author;
    expect(c).toMatchObject({ ok: true, unknown: true });
  });

  it('titles: brackets cleaned on both sides; volumes by their printed marks', () => {
    expect(titlesAgree(['鏡 ＜田中芳樹短篇小説＞'], '鏡　＜田中芳樹短篇小説＞', 0.8).ok).toBe(true);
    expect(titlesAgree(['卍（まんじ）'], '卍（まんじ）', 0.8).ok).toBe(true);
    expect(storeTitle('[17巻] 盾の勇者の成り上がり 17')).toBe('盾の勇者の成り上がり 17');
    expect([...volumeMarks('ペテロの葬列 上： 杉村三郎シリーズ３')].sort()).toEqual(['3', '上']);
  });
});

// ---------------------------------------------------------------------------------------
describe('the gate on the labeled books', () => {
  const books: LabeledBook[] = [
    { id: 'A', kind: 'book', src: 'audible:B0A', torrent: 'a.m4b' },
    { id: 'B', kind: 'book', src: 'audiobook.jp:1', torrent: 'b.m4b' },
    { id: 'C', kind: 'book', src: null, torrent: 'c.m4b' },
    { id: 'D', kind: 'ai', src: null, torrent: 'AI/d.mp3' },
  ];
  const u = (cls: 'auto' | 'review' | 'unknown' | 'none_expected', record: string | null) => ({
    unitKey: 'u',
    kind: cls === 'none_expected' ? ('none_expected' as const) : ('lookup' as const),
    class: cls,
    record,
    reason: null,
  });
  it('passes when no automatic match differs from its label; review and unknown are never misses', () => {
    const g = scoreOnlineGate(books, (t) =>
      t === 'a.m4b'
        ? u('auto', 'audible:B0A')
        : t === 'b.m4b'
          ? u('review', 'audiobookjp:1')
          : t === 'c.m4b'
            ? u('unknown', null)
            : u('none_expected', null),
    );
    expect(g.passed).toBe(true);
    expect(g.bySource.audible).toEqual({ auto_agrees: 1 });
    expect(g.bySource['audiobook.jp']).toEqual({ review: 1 });
  });
  it('another record, or any record where the label has none, is a miss', () => {
    const g = scoreOnlineGate(books, (t) =>
      t === 'a.m4b'
        ? u('auto', 'audible:B0X')
        : t === 'c.m4b'
          ? u('auto', 'kikubon:5')
          : u('unknown', null),
    );
    expect(g.passed).toBe(false);
    // D (an AI book) came out unknown: not an automatic match, so not a miss.
    expect(g.misses.map((m) => m.id)).toEqual(['A', 'C']);
  });
});

// ---------------------------------------------------------------------------------------
describe('the shared fetch queue', () => {
  function queueWith(db: Database.Database) {
    return new FetchQueue(db, makeTempDir('wp21c-cache'), () => getSettings(db).fetch);
  }
  const answer = (
    q: FetchQueue,
    id: number,
    token: string,
    status: number,
    body = 'x',
    at?: number,
  ) =>
    q.report(
      id,
      token,
      { status, ms: 1, error: null, body: Buffer.from(body), encoding: 'identity' },
      at,
    );

  it('Amazon refusing (back-off, pause, slow-down) never holds Audible up, and the other way round', () => {
    const db = freshDb();
    const q = queueWith(db);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 30; i++) {
      q.enqueue(
        { site: 'amazon-dp', key: `a${i}`, url: `https://www.amazon.co.jp/dp/${i}` },
        null,
        t0,
      );
      q.enqueue(
        { site: 'audible', key: `b${i}`, url: `https://api.audible.co.jp/x/${i}` },
        null,
        t0,
      );
    }
    // Amazon refuses 8 times in a row: it backs off and pauses.
    let now = t0;
    for (let i = 0; i < 8; i++) {
      db.prepare(
        `UPDATE fetch_sites SET backoff_until = NULL, paused_reason = NULL WHERE site = 'amazon'`,
      ).run();
      // One claim gives each due site its request: Amazon refuses, Audible answers.
      for (const c of q.claim(now).requests) {
        answer(q, c.id, c.leaseToken, c.site === 'amazon-dp' ? 503 : 200, '{}');
      }
      now += 8000;
    }
    db.prepare(`UPDATE fetch_sites SET backoff_until = ? WHERE site = 'amazon'`).run(now + 900_000);
    expect(q.blocked('amazon-dp', now)).not.toBeNull();
    // Audible keeps its own 3 s pace meanwhile.
    expect(q.blocked('audible', now)).toBeNull();
    expect(
      (
        db.prepare(`SELECT paused_reason FROM fetch_sites WHERE site = 'amazon'`).get() as {
          paused_reason: string | null;
        }
      ).paused_reason,
    ).toMatch(/refusals in a row/);
    const claimed = q.claim(now).requests;
    expect(claimed.map((r) => r.site)).toContain('audible');
    expect(claimed.map((r) => r.site)).not.toContain('amazon-dp');
    expect(q.blocked('audible', now + 1000)?.reason).toBe('pace');
    for (const c of claimed) answer(q, c.id, c.leaseToken, 200, '{}');
    // Audible busy (503): only Audible waits; Amazon (released) goes on.
    q.resume('amazon-dp', now);
    const next = q.claim(now + 3000).requests;
    const a = next.find((r) => r.site === 'audible')!;
    for (const c of next) if (c !== a) answer(q, c.id, c.leaseToken, 200, '{}');
    expect(answer(q, a.id, a.leaseToken, 503, 'x', now + 3000)).toMatchObject({ outcome: 'busy' });
    expect(q.blocked('audible', now + 4000)?.reason).toMatch(/busy/);
    expect(q.blocked('amazon-dp', now + 20_000)).toBeNull();
    // Audible's answers never enter Amazon's slow-down window.
    expect(
      (
        db.prepare(`SELECT slow_factor FROM fetch_sites WHERE site = 'audible'`).get() as {
          slow_factor: number;
        }
      ).slow_factor,
    ).toBe(1);
  });

  it('an answer wakes the audio waiters; a switched-off site gives its queued requests up', () => {
    const db = freshDb();
    const q = queueWith(db);
    const r1 = q.enqueue({ site: 'audible', key: 'k1', url: 'https://api.audible.co.jp/1' }, null);
    db.prepare(
      `INSERT INTO audio_fetch_waiters (request_id, unit_key, step) VALUES (?, 'u1', 's')`,
    ).run(r1.id);
    const c = q.claim().requests.find((x) => x.site === 'audible')!;
    answer(q, c.id, c.leaseToken, 200, '{}');
    const r2 = q.enqueue({ site: 'kikubon', key: 'k2', url: 'https://kikubon.jp/2' }, null);
    db.prepare(
      `INSERT INTO audio_fetch_waiters (request_id, unit_key, step) VALUES (?, 'u2', 's')`,
    ).run(r2.id);
    expect(db.prepare(`SELECT ready FROM audio_fetch_waiters WHERE unit_key = 'u1'`).get()).toEqual(
      { ready: 1 },
    );
    expect(q.giveUpQueued('kikubon')).toEqual([r2.id]);
    expect(db.prepare(`SELECT ready FROM audio_fetch_waiters WHERE unit_key = 'u2'`).get()).toEqual(
      { ready: 1 },
    );
    // Calibre's own waiters are untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM fetch_waiters').get()).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------------------
// Stage-3 rows built directly: copies, their files and what stage 2 found in them.

interface CopySpec {
  key: string;
  rel: string;
  name: string;
  seconds: number;
  asins?: string[];
  absAsins?: string[];
  ai?: boolean;
  tags?: Record<string, string>;
  /** Copies with the same group are proven the same recording. */
  group?: string;
  sha?: string;
}

function seedStage3(db: Database.Database, copies: CopySpec[]): string {
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
     VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`,
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
      c.ai ? 1 : 0,
      JSON.stringify(c.asins ?? []),
      JSON.stringify(c.absAsins ?? []),
    );
    ids.set(c.key, Number(r.lastInsertRowid));
  });
  const groups = new Map<string, CopySpec[]>();
  for (const c of copies) if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  for (const [g, cs] of groups) {
    const r = db
      .prepare(
        `INSERT INTO audio_dup_groups (analysis_id, group_key, kind, first_test, tests_json, members, best_copy_id, rule, outcome)
         VALUES (?, ?, 'group', 'identical', '[]', ?, ?, 'identical', 'auto')`,
      )
      .run(analysisId, g, cs.length, ids.get(cs[0].key));
    cs.forEach((c, i) =>
      db
        .prepare(
          `INSERT INTO audio_dup_members (group_id, copy_id, rank, role) VALUES (?, ?, ?, ?)`,
        )
        .run(Number(r.lastInsertRowid), ids.get(c.key), i, i === 0 ? 'keep' : 'drop'),
    );
  }
  updateAudioStage(db, 3, {
    state: 'ready',
    progress: { analysisId, phase: 'done', error: null, finishedAt: now },
  });
  return analysisId;
}

/** Answers every queued audiobook request from `pages` (404 when missing); returns the URLs asked. */
function answerAll(
  db: Database.Database,
  q: FetchQueue,
  pages: Map<string, Buffer>,
  asked: string[],
): number {
  // A switched-off site is never claimed by the fetcher.
  const on = getSettings(db).fetch.sites;
  const rows = (
    db
      .prepare(
        `SELECT id, url, site FROM fetch_requests WHERE state = 'queued'
       AND site IN ('audible', 'audible-sample', 'kikubon', 'audiobookjp', 'audiobookjp-sample')`,
      )
      .all() as { id: number; url: string; site: string }[]
  ).filter((r) => on[r.site]?.enabled);
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
  return rows.length;
}

function audibleJson(asin: string, over: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ product: { asin, ...over } }));
}

function makeStage(db: Database.Database, labels: LabeledBook[] = [], shared?: FetchQueue) {
  const lock = new DiskLock(5);
  const roots = { torrents: makeTempDir('wp21c-t'), library: makeTempDir('wp21c-l') };
  const tools = { ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg', fpcalcPath: 'fpcalc' };
  const queue =
    shared ?? new FetchQueue(db, makeTempDir('wp21c-cache'), () => getSettings(db).fetch);
  const readLabels = () => ({ text: JSON.stringify({ books: labels }), error: null });
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
  maxRounds = 200,
) {
  for (let i = 0; i < maxRounds; i++) {
    answerAll(db, queue, pages, asked);
    if (await stage4.step(() => false)) return;
    if (process.env.WP21C_DEBUG) {
      const p = stage4.progress();
      console.log(
        i,
        p?.phase,
        JSON.stringify(db.prepare('SELECT state, error, class FROM audio_online_units').all()),
        JSON.stringify(
          db.prepare('SELECT win_key, items, error FROM audio_fingerprints').all(),
        ).slice(0, 600),
      );
    }
  }
  throw new Error('stage 4 did not finish');
}

describe('stage 4 on stage-3 rows with a stand-in internet', () => {
  it('one lookup per recording; the decided order; AI and radio clips never asked; gate; counts', async () => {
    const db = freshDb();
    seedStage3(db, [
      // Two proven copies of one recording, the ASIN in the names: one lookup.
      {
        key: 'c1',
        rel: 'TMW Japanese Audiobooks Collection (Part 1)/[03] 本A 3 [B0AAAAAAA3].m4b',
        name: '[03] 本A 3 [B0AAAAAAA3]',
        seconds: 300 * 60,
        asins: ['B0AAAAAAA3'],
        group: 'g1',
        tags: { artist: '作者 一', composer: '読み 手' },
      },
      {
        key: 'c2',
        rel: 'Discord/moved/本A 3 [B0AAAAAAA3]/本A 3 [B0AAAAAAA3].m4b',
        name: '本A 3 [B0AAAAAAA3]',
        seconds: 300 * 60 + 15,
        asins: ['B0AAAAAAA3'],
        group: 'g1',
      },
      // No ASIN: found by the title search.
      {
        key: 'c3',
        rel: 'TMW Japanese Audiobooks Collection (Part 3)/本B.m4b',
        name: '本B',
        seconds: 100 * 60,
      },
      // Not on Audible: kikubon by its id.
      {
        key: 'c4',
        rel: 'TMW Japanese Audiobooks Collection (Part 9)/[栗本 薫] グイン・サーガ/[12] グイン・サーガ(12) 紅の密使 [kikubon 964].m4b',
        name: '[12] グイン・サーガ(12) 紅の密使 [kikubon 964]',
        seconds: 27158,
      },
      // Nowhere.
      { key: 'c5', rel: 'MAM/本C/本C.m4b', name: '本C', seconds: 50 * 60 },
      { key: 'c6', rel: 'AI/本D/本D1.mp3', name: '本D1', seconds: 500 * 60, ai: true },
      {
        key: 'c7',
        rel: 'Discord/moved/山田じぇみ子の ざこざこお兄さん取締ラジオ/vol1/おまけ.m4a',
        name: 'おまけ',
        seconds: 1700,
      },
    ]);
    const pages = new Map<string, Buffer>([
      [
        audibleProduct('B0AAAAAAA3').url,
        audibleJson('B0AAAAAAA3', {
          title: '本A 3',
          authors: [{ name: '作者 一' }],
          narrators: [{ name: '読み 手' }],
          runtime_length_min: 300,
          relationships: [
            {
              relationship_type: 'series',
              relationship_to_product: 'parent',
              title: '本A',
              sequence: '3',
              sort: '3',
            },
          ],
        }),
      ],
      [
        audibleSearch('本B').url,
        Buffer.from(
          JSON.stringify({
            products: [
              { asin: 'B0BBBBBBB1', title: '本B', runtime_length_min: 100 },
              { asin: 'B0BBBBBBB2', title: '本B 2', runtime_length_min: 300 },
            ],
          }),
        ),
      ],
      [
        audibleProduct('B0BBBBBBB1').url,
        audibleJson('B0BBBBBBB1', { title: '本B', runtime_length_min: 100 }),
      ],
      [kikubonProduct('964').url, page('kikubon-product-964')],
    ]);
    const labels: LabeledBook[] = [
      {
        id: 'L1',
        kind: 'book',
        src: 'audible:B0AAAAAAA3',
        torrent: 'TMW Japanese Audiobooks Collection (Part 1)/[03] 本A 3 [B0AAAAAAA3].m4b',
      },
      {
        id: 'L2',
        kind: 'book',
        src: 'kikubon:964',
        torrent:
          'TMW Japanese Audiobooks Collection (Part 9)/[栗本 薫] グイン・サーガ/[12] グイン・サーガ(12) 紅の密使 [kikubon 964].m4b',
      },
      { id: 'L3', kind: 'ai', src: null, torrent: 'AI/本D' },
    ];
    const { stage4, queue } = makeStage(db, labels);
    stage4.restart();
    const asked: string[] = [];
    await runToEnd(db, stage4, queue, pages, asked);
    const p = stage4.progress()!;
    expect(p.error).toBeNull();
    expect(p).toMatchObject({ units: 6, lookupUnits: 4, noRecordUnits: 2, labeledUnits: 3 });
    const units = db
      .prepare(
        `SELECT name, class, source, store_id, review_reason FROM audio_online_units ORDER BY id`,
      )
      .all() as { name: string; class: string; source: string | null; store_id: string | null }[];
    const by = (n: string) => units.find((u) => u.name === n)!;
    expect(by('[03] 本A 3 [B0AAAAAAA3]')).toMatchObject({
      class: 'auto',
      source: 'audible',
      store_id: 'B0AAAAAAA3',
    });
    expect(by('本B')).toMatchObject({ class: 'auto', source: 'audible', store_id: 'B0BBBBBBB1' });
    expect(by('[12] グイン・サーガ(12) 紅の密使 [kikubon 964]')).toMatchObject({
      class: 'auto',
      source: 'kikubon',
      store_id: '964',
    });
    expect(by('本C')).toMatchObject({ class: 'unknown' });
    expect(by('本D1')).toMatchObject({ class: 'none_expected' });
    expect(by('おまけ')).toMatchObject({ class: 'none_expected' });
    // The ASIN unit asked only its product (nothing after an automatic match), once for both copies.
    expect(asked.filter((u) => u.includes('B0AAAAAAA3'))).toEqual([
      audibleProduct('B0AAAAAAA3').url,
    ]);
    expect(asked.some((u) => /search.*%E6%9C%ACA/.test(u))).toBe(false);
    // Nothing was asked for the AI book or the radio clip.
    expect(asked.some((u) => /%E6%9C%ACD|%E3%81%8A%E3%81%BE%E3%81%91/.test(u))).toBe(false);
    // Each request once.
    expect(new Set(asked).size).toBe(asked.length);
    // The record keeps every field (WP21d needs no new fetching).
    const r = db
      .prepare(
        `SELECT record FROM audio_online_records WHERE source = 'kikubon' AND store_id = '964'`,
      )
      .get() as {
      record: Buffer;
    };
    expect(JSON.parse(gunzipSync(r.record).toString()).extra.fields['カバーイラスト']).toBe(
      '加藤直之',
    );
    expect(p.gate).toMatchObject({ passed: true, checked: 3 });
    expect(stage4Counts(db, p.analysisId)).toMatchObject({ auto: 3, unknown: 1, none_expected: 2 });
  });

  it('a restart asks nothing twice; a settings change decides again from the stored answers', async () => {
    const db = freshDb();
    seedStage3(db, [{ key: 'c1', rel: 'MAM/本E/本E.m4b', name: '本E', seconds: 103 * 60 }]);
    const pages = new Map<string, Buffer>([
      [
        audibleSearch('本E').url,
        Buffer.from(
          JSON.stringify({
            products: [{ asin: 'B0EEEEEEE1', title: '本E', runtime_length_min: 100 }],
          }),
        ),
      ],
      [
        audibleProduct('B0EEEEEEE1').url,
        audibleJson('B0EEEEEEE1', { title: '本E', runtime_length_min: 100 }),
      ],
    ]);
    const s = makeStage(db);
    s.stage4.restart();
    const asked: string[] = [];
    await s.stage4.step(() => false); // units
    answerAll(db, s.queue, pages, asked);
    // The server restarts: a new stage object on the same database and fetch cache.
    const s2 = makeStage(db, [], s.queue).stage4;
    await runToEnd(db, s2, s.queue, pages, asked);
    expect(new Set(asked).size).toBe(asked.length);
    // 3 min off with a 2 min tolerance: review (the length differs); no search hit at 3 min is read.
    let u = db.prepare('SELECT class, review_reason FROM audio_online_units').get();
    expect(u).toMatchObject({ class: 'unknown' });
    const before = asked.length;
    updateSettings(db, { audiobooks: { ...getSettings(db).audiobooks, onlineRuntimeMinutes: 4 } });
    s2.redecide();
    await runToEnd(db, s2, s.queue, pages, asked);
    u = db.prepare('SELECT class, source, store_id FROM audio_online_units').get();
    expect(u).toMatchObject({ class: 'auto', store_id: 'B0EEEEEEE1' });
    // Only the product page the wider line made worth reading was asked; the search came from the cache.
    expect(asked.slice(before)).toEqual([audibleProduct('B0EEEEEEE1').url]);
  });

  it('a finished analysis scores its gate again when the labels change (nothing asked again)', async () => {
    const db = freshDb();
    const rel = 'TMW Japanese Audiobooks Collection (Part 1)/本G [B0GGGGGGG1].m4b';
    seedStage3(db, [
      { key: 'c1', rel, name: '本G [B0GGGGGGG1]', seconds: 60 * 60, asins: ['B0GGGGGGG1'] },
    ]);
    const pages = new Map<string, Buffer>([
      [
        audibleProduct('B0GGGGGGG1').url,
        audibleJson('B0GGGGGGG1', { title: '本G', runtime_length_min: 60 }),
      ],
    ]);
    const labels: LabeledBook[] = [{ id: 'G1', kind: 'book', src: null, torrent: rel }];
    const { stage4, queue } = makeStage(db, labels);
    stage4.restart();
    const asked: string[] = [];
    await runToEnd(db, stage4, queue, pages, asked);
    // Labeled "no record" but matched: a miss.
    expect(stage4.progress()!.gate).toMatchObject({ passed: false, misses: [{ id: 'G1' }] });
    expect(stage4.refreshGate()).toBe(false); // the same labels: nothing to do
    labels[0].src = 'audible:B0GGGGGGG1';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000); // the labels are read again after a minute
      expect(stage4.refreshGate()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(stage4.progress()!.gate).toMatchObject({ passed: true, checked: 1, misses: [] });
    expect(asked).toEqual([audibleProduct('B0GGGGGGG1').url]);
  });

  it('a switched-off site answers nothing: its requests are given up and the lookups go on', async () => {
    const db = freshDb();
    seedStage3(db, [{ key: 'c1', rel: 'MAM/本F/本F.m4b', name: '本F', seconds: 60 * 60 }]);
    const fetch = getSettings(db).fetch;
    updateSettings(db, {
      fetch: {
        ...fetch,
        sites: { ...fetch.sites, kikubon: { enabled: false, intervalSeconds: 5 } },
      },
    });
    const { stage4, queue } = makeStage(db);
    stage4.restart();
    const asked: string[] = [];
    await runToEnd(db, stage4, queue, new Map(), asked);
    expect(asked.some((u) => u.includes('kikubon'))).toBe(false);
    expect(db.prepare(`SELECT state FROM fetch_requests WHERE site = 'kikubon'`).get()).toEqual({
      state: 'failed',
    });
    expect(db.prepare('SELECT class FROM audio_online_units').get()).toEqual({ class: 'unknown' });
  });

  it('editions told apart only by the narrator wait for sample audio (the disk part); without samples: review', async () => {
    const db = freshDb();
    seedStage3(db, [
      {
        key: 'c1',
        rel: 'TMW Japanese Audiobooks Collection (Part 3)/金五十両.m4b',
        name: '金五十両',
        seconds: 45.8 * 60,
        tags: { artist: '山本周五郎', composer: '楠木 華子' },
      },
    ]);
    const pages = new Map<string, Buffer>([
      [
        audibleSearch('金五十両').url,
        Buffer.from(
          JSON.stringify({
            products: [
              {
                asin: 'B079YB26J1',
                title: '金五十両',
                runtime_length_min: 45,
                narrators: [{ name: '斉藤 範子' }],
              },
              {
                asin: 'B0H5JGYLDP',
                title: '金五十両',
                runtime_length_min: 44,
                narrators: [{ name: '伊藤 治明' }],
              },
            ],
          }),
        ),
      ],
      [audibleProduct('B079YB26J1').url, page('audible-product-kin-saito')],
    ]);
    const { stage4, queue } = makeStage(db);
    stage4.restart();
    const asked: string[] = [];
    await runToEnd(db, stage4, queue, pages, asked);
    const u = db.prepare('SELECT class, review_reason, detail FROM audio_online_units').get() as {
      class: string;
      review_reason: string;
      detail: string;
    };
    // The opening can't be read here (no file) and no sample answered: review, never a guess.
    expect(u.class).toBe('review');
    expect(u.review_reason).toBe('narrator');
    expect(asked).toContain(audibleSampleInfo('B079YB26J1').url);
  });

  it('routes: status with the sites, lists, On refused, Ask again; the Calibre card keeps its own sites', async () => {
    const { env, setup } = await makeCleanupEnv({ audio: {} });
    try {
      await setup();
      const token = env.userToken();
      const auth = { Authorization: `Bearer ${token}` };
      const st = await request(env.app).get('/api/v1/cleanup/audio/status').set(auth);
      expect(st.status).toBe(200);
      expect(st.body.stages.map((s: { stage: number }) => s.stage)).toContain(4);
      expect(st.body.stage4.sites.map((s: { site: string }) => s.site)).toEqual([
        'audible',
        'audible-sample',
        'kikubon',
        'audiobookjp',
        'audiobookjp-sample',
      ]);
      const on = await request(env.app)
        .put('/api/v1/cleanup/audio/stages/4')
        .set(auth)
        .send({ mode: 'on' });
      expect(on.status).toBe(400);
      const pv = await request(env.app)
        .put('/api/v1/cleanup/audio/stages/4')
        .set(auth)
        .send({ mode: 'analyse' });
      expect(pv.status).toBe(200);
      expect(getAudioStage(env.cleanupDb, 4).mode).toBe('analyse');
      const list = await request(env.app).get('/api/v1/cleanup/audio/online?list=review').set(auth);
      expect(list.status).toBe(200);
      expect(list.body).toEqual({ total: 0, items: [] });
      const bad = await request(env.app).get('/api/v1/cleanup/audio/online?list=nope').set(auth);
      expect([200, 400]).toContain(bad.status);
      const retry = await request(env.app)
        .post('/api/v1/cleanup/audio/online/sites/audible/retry')
        .set(auth)
        .send({});
      // No fetch queue in this environment: refused with a reason, never a crash.
      expect([200, 400]).toContain(retry.status);
      const nosite = await request(env.app)
        .post('/api/v1/cleanup/audio/online/sites/amazon-dp/retry')
        .set(auth)
        .send({});
      expect(nosite.status).toBe(400);
      const calibre = env.service.stage4Status(null) as { sites: { site: string }[] };
      expect(calibre.sites.map((s) => s.site)).not.toContain('audible');
      setAudioStageMode(env.cleanupDb, 4, 'off');
    } finally {
      await env.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
describe('cleanup.db v12', () => {
  it('adds stage 4 and its tables; every polled query uses an index', () => {
    const db = freshDb();
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(12);
    expect(getAudioStage(db, 4).mode).toBe('off');
    const plan = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    const polled = [
      `SELECT id, unit_key, labeled, inputs_json FROM audio_online_units WHERE analysis_id = 'a' AND state IN ('planned', 'ready') ORDER BY labeled DESC, id LIMIT 100`,
      `SELECT id FROM audio_online_units WHERE analysis_id = 'a' AND state = 'audio' ORDER BY labeled DESC, id LIMIT 4`,
      `UPDATE audio_online_units SET state = 'ready' WHERE analysis_id = 'a' AND state = 'waiting' AND unit_key IN (SELECT unit_key FROM audio_fetch_waiters WHERE ready = 1)`,
      `SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = 'a' AND state NOT IN ('decided', 'error')`,
      `SELECT site, state, COUNT(*) AS n FROM fetch_requests WHERE site IN ('audible', 'kikubon') GROUP BY site, state`,
      `SELECT COUNT(*) AS n FROM fetch_attempts WHERE site = 'audible' AND at >= 0`,
      `SELECT a.at, r.created_at FROM fetch_attempts a JOIN fetch_requests r ON r.id = a.request_id WHERE a.site = 'audible' ORDER BY a.at DESC LIMIT 501`,
      `SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = 'a' AND class = 'review'`,
      `SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = 'a' AND class = 'review' AND review_reason = 'title'`,
      `SELECT * FROM audio_online_candidates WHERE unit_id = 1`,
      `DELETE FROM audio_fetch_waiters WHERE unit_key = 'u' AND ready = 1`,
      `SELECT record FROM audio_online_records WHERE source = 'audible' AND store_id = 'x'`,
    ];
    for (const q of polled) {
      const p = plan(q);
      expect(p, q).not.toMatch(
        /SCAN (audio_online_units|audio_fetch_waiters|fetch_requests|fetch_attempts|audio_online_candidates|audio_online_records)\b(?! USING)/,
      );
    }
  });

  it('settings: stage 4’s limits are user settings and validated', () => {
    const db = freshDb();
    const s = getSettings(db);
    expect(s.audiobooks).toMatchObject({
      onlineRuntimeMinutes: 2,
      onlineTitleScore: 0.8,
      onlineOpeningSeconds: 240,
    });
    expect(s.fetch.sites.audible).toEqual({ enabled: true, intervalSeconds: 3 });
    expect(s.fetch.sites.kikubon.intervalSeconds).toBe(5);
    expect(s.fetch.sites.audiobookjp.intervalSeconds).toBe(5);
    expect(() =>
      updateSettings(db, { audiobooks: { ...s.audiobooks, noStoreRecordFolders: ['../x'] } }),
    ).toThrow();
    expect(() =>
      updateSettings(db, { audiobooks: { ...s.audiobooks, onlineTitleScore: 2 } }),
    ).toThrow();
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

describe.skipIf(!HAS_TOOLS)('sample audio with ffmpeg and fpcalc', () => {
  it('the store whose sample is the recording’s opening is the match; none matching = unknown; the disk is given to Calibre', async () => {
    const work = makeTempDir('wp21c-audio');
    const ff = (args: string[]) =>
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });
    // The recording (6.5 min), another edition (other audio) and its stores' 60 s samples.
    const book = samples(390, 11);
    const other = samples(390, 22);
    const w = (name: string, s: Int16Array) => {
      const p = path.join(work, `${name}.wav`);
      fs.writeFileSync(p, wav([s]));
      return p;
    };
    const db = freshDb();
    const { stage4, queue, lock, roots } = makeStage(db);
    const rel = 'TMW Japanese Audiobooks Collection (Part 3)/金五十両.m4b';
    fs.mkdirSync(path.join(roots.torrents, path.dirname(rel)), { recursive: true });
    ff(['-i', w('book', book), '-c:a', 'aac', '-b:a', '64k', path.join(roots.torrents, rel)]);
    const mp3 = (name: string, s: Int16Array, from: number) => {
      const out = path.join(work, `${name}.mp3`);
      ff([
        '-ss',
        String(from),
        '-t',
        '60',
        '-i',
        w(name, s),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        out,
      ]);
      return fs.readFileSync(out);
    };
    seedStage3(db, [
      {
        key: 'c1',
        rel,
        name: '金五十両',
        seconds: 390,
        tags: { artist: '山本周五郎', composer: '楠木 華子' },
      },
    ]);
    const sample = (asin: string) => `https://samples.audible.com/bk/x/${asin}_sample.mp3`;
    const pages = new Map<string, Buffer>([
      [
        audibleSearch('金五十両').url,
        Buffer.from(
          JSON.stringify({
            products: [
              {
                asin: 'B0KKKKKKK1',
                title: '金五十両',
                runtime_length_min: 6,
                narrators: [{ name: '斉藤 範子' }],
              },
              {
                asin: 'B0KKKKKKK2',
                title: '金五十両',
                runtime_length_min: 7,
                narrators: [{ name: '伊藤 治明' }],
              },
            ],
          }),
        ),
      ],
      [
        audibleSampleInfo('B0KKKKKKK1').url,
        audibleJson('B0KKKKKKK1', { sample_url: sample('B0KKKKKKK1') }),
      ],
      [
        audibleSampleInfo('B0KKKKKKK2').url,
        audibleJson('B0KKKKKKK2', { sample_url: sample('B0KKKKKKK2') }),
      ],
      // Edition 1's sample is this recording's start; edition 2's is other audio.
      [sample('B0KKKKKKK1'), mp3('s1', book, 0)],
      [sample('B0KKKKKKK2'), mp3('s2', other, 0)],
    ]);
    updateSettings(db, { audiobooks: { ...getSettings(db).audiobooks, onlineRuntimeMinutes: 1 } });
    // While a Calibre job waits for the disk, the opening isn't read.
    lock.tryAcquire('Calibre stage 3 (content duplicates)', 'calibre');
    stage4.restart();
    const asked: string[] = [];
    for (let i = 0; i < 8; i++) {
      answerAll(db, queue, pages, asked);
      await stage4.step(() => false);
    }
    expect(db.prepare('SELECT state FROM audio_online_units').get()).toEqual({ state: 'audio' });
    expect(stage4.progress()!.openingsRead).toBe(0);
    lock.release('Calibre stage 3 (content duplicates)');
    await runToEnd(db, stage4, queue, pages, asked);
    const u = db
      .prepare('SELECT class, source, store_id, detail FROM audio_online_units')
      .get() as {
      class: string;
      store_id: string;
      detail: string;
    };
    expect(u).toMatchObject({ class: 'auto', store_id: 'B0KKKKKKK1' });
    expect(u.detail).toMatch(/sample audio/);
    const scores = db
      .prepare('SELECT store_id, sample_score FROM audio_online_candidates ORDER BY store_id')
      .all() as { store_id: string; sample_score: number }[];
    expect(scores[0].sample_score).toBeGreaterThan(0.9);
    expect(scores[1].sample_score).toBeLessThan(0.7);
    // Neither sample is the recording: no store edition is it (unknown, editions compared).
    pages.set(sample('B0KKKKKKK1'), mp3('s3', other, 120));
    db.prepare(`DELETE FROM audio_fingerprints WHERE win_key LIKE 'sample:%'`).run();
    stage4.redecide();
    // The cached sample answer stays (never fetched twice), so stand in a new address.
    pages.set(
      audibleSampleInfo('B0KKKKKKK1').url,
      audibleJson('B0KKKKKKK1', { sample_url: sample('B0KKKKKKK1') + '?v=2' }),
    );
    pages.set(sample('B0KKKKKKK1') + '?v=2', mp3('s4', other, 120));
    db.prepare(`DELETE FROM fetch_requests WHERE url = ?`).run(audibleSampleInfo('B0KKKKKKK1').url);
    await runToEnd(db, stage4, queue, pages, asked);
    expect(db.prepare('SELECT class, review_reason FROM audio_online_units').get()).toEqual({
      class: 'unknown',
      review_reason: 'editions compared',
    });
  }, 240_000);
});
