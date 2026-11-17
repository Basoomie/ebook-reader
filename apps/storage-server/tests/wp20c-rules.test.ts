/**
 * WP20c (stage 3, content duplicates): the pure parts. Fingerprints and containment, extra
 * text and the spread measure, the candidate index, edition kinds, the pair rules, the best
 * copy, sets, and the picture facts.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { candidatePairs } from '../src/cleanup/stage3-index';
import { jpegQuantization, imageFactOf } from '../src/cleanup/stage3-images';
import { editionKind } from '../src/cleanup/stage3-kinds';
import {
  bestCopy,
  differentArtwork,
  classifyPair,
  decideSets,
  DEFAULT_DUPLICATE_SETTINGS,
  matchImages,
  omnibusByText,
  type PairBook,
  type QualityFacts,
} from '../src/cleanup/stage3-rules';
import {
  containment,
  extraText,
  sketchFromBlob,
  sketchOf,
  sketchToBlob,
  sortedUnique,
  toCodePoints,
  windowHashes,
} from '../src/cleanup/stage3-sketch';

/** Deterministic "Japanese" text: kana and kanji from a pool, seeded. */
export function fakeText(seed: number, length: number): string {
  const pool =
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん' +
    'アイウエオカキクケコサシスセソタチツテトナニヌネノ日月火水木金土山川田人大小中上下左右本学生';
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += pool[s % pool.length];
  }
  return out;
}

const windowsOf = (t: string) => windowHashes(toCodePoints(t));
const setOf = (t: string) => sortedUnique(windowsOf(t));

describe('fingerprints and containment', () => {
  const book = fakeText(1, 100_000);

  it('identical texts contain each other fully; unrelated texts share nothing', () => {
    expect(containment(setOf(book), setOf(book))).toMatchObject({ aInB: 1, bInA: 1 });
    const other = containment(setOf(book), setOf(fakeText(2, 100_000)));
    expect(other.aInB).toBeLessThan(0.01);
  });

  it('a copy with an extra story is a superset; one way 1.0, the other ~ the share', () => {
    const plus = book + fakeText(3, 20_000);
    const c = containment(setOf(book), setOf(plus));
    expect(c.aInB).toBe(1);
    expect(c.bInA).toBeCloseTo(100_000 / 120_000, 2);
  });

  it('counts code points: a character outside the BMP is one character', () => {
    expect(toCodePoints('𠮟る').length).toBe(2);
    expect(windowHashes(toCodePoints('一二三四五六七')).length).toBe(0);
    expect(windowHashes(toCodePoints('一二三四五六七八')).length).toBe(1);
  });

  it('the sketch keeps about 1 in 256 windows and estimates containment both ways', () => {
    const plus = book + fakeText(3, 20_000);
    const a = sketchOf(windowsOf(book));
    const b = sketchOf(windowsOf(plus));
    expect(a.length).toBeGreaterThan(300);
    expect(a.length).toBeLessThan(500);
    const est = containment(a, b);
    expect(est.aInB).toBe(1);
    expect(Math.abs(est.bInA - 100_000 / 120_000)).toBeLessThan(0.05);
    expect(sketchFromBlob(sketchToBlob(a))).toEqual(a);
  });
});

describe('extra text and the spread measure', () => {
  const chapters = Array.from({ length: 10 }, (_, i) => fakeText(10 + i, 10_000));
  const plain = chapters.join('');
  const starts = (parts: string[]) => {
    const out: number[] = [];
    let at = 0;
    for (const p of parts) {
      out.push(at);
      at += p.length;
    }
    return out;
  };

  it('an afterword and a store SS at the end are not interleaved', () => {
    const parts = [...chapters, fakeText(99, 8_000)];
    const rich = parts.join('');
    const e = extraText(windowsOf(rich), rich.length, setOf(plain), starts(parts));
    expect(e.extraChars).toBeGreaterThanOrEqual(8_000);
    expect(e.runs).toHaveLength(1);
    expect(e.interleavedRuns).toBe(0);
    expect(e.interleavedShare).toBe(0);
  });

  it('a commentary inside every chapter is interleaved, chapter by chapter', () => {
    const parts = chapters.map(
      (c, i) => c.slice(0, 5_000) + fakeText(200 + i, 1_200) + c.slice(5_000),
    );
    const rich = parts.join('');
    const e = extraText(windowsOf(rich), rich.length, setOf(plain), starts(parts));
    expect(e.interleavedRuns).toBe(10);
    expect(e.chaptersTouched).toBe(10);
    expect(e.interleavedShare).toBeCloseTo(12_000 / rich.length, 2);
  });

  it('runs shorter than 100 characters are typesetting noise', () => {
    const rich = plain.slice(0, 50_000) + fakeText(300, 60) + plain.slice(50_000);
    const e = extraText(windowsOf(rich), rich.length, setOf(plain));
    expect(e.extraChars).toBeGreaterThan(0);
    expect(e.runs).toHaveLength(0);
  });
});

describe('candidate index', () => {
  const a = fakeText(1, 60_000);
  const notice = fakeText(7, 3_000); // the same legal notice in many books
  const books = [
    { id: 1, text: a + notice },
    { id: 2, text: a + fakeText(4, 6_000) + notice },
    { id: 3, text: fakeText(5, 60_000) + notice },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: 10 + i,
      text: fakeText(50 + i, 30_000) + notice,
    })),
  ];
  const sketched = books.map((b) => ({ calibreId: b.id, sketch: sketchOf(windowsOf(b.text)) }));

  it('finds the copies and drops samples shared by too many books', () => {
    const { pairs, stats } = candidatePairs(sketched, { commonBooks: 5 });
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 2]]);
    expect(pairs[0].estAInB).toBeGreaterThan(0.9);
    expect(stats.commonSamples).toBeGreaterThan(0);
  });

  it('without the common-sample cut the notice links everything weakly (below the floor)', () => {
    const { pairs } = candidatePairs(sketched, { commonBooks: 100, minEstimate: 0.2 });
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 2]]);
  });
});

describe('edition kinds (titles from the dup_test pairs)', () => {
  it.each([
    ['『灰原くんの強くて青春ニューゲーム５』BOOK☆WALKER限定書き下ろしショートストーリー', 'bonus'],
    [
      '【購入特典】『スレ主がダンジョンアタックする話』BOOK☆WALKER限定書き下ろしショートストーリー',
      'bonus',
    ],
    ['『キモオタモブ傭兵は、身の程を弁える 2』購入特典 BOOK☆WALKER限定ショートストーリー', 'bonus'],
    ['クロゥレン家の次男坊【電子書籍限定書き下ろしSS付き】', 'special'],
    ['生徒の保護者が元カノだった【BOOK☆WALKER限定オリジナルSS付き】', 'special'],
    ['デビダン！ 目指せダンジョンニート物語 【電子限定SS付】 (BKブックス)', 'special'],
    ['やがて恋するヴィヴィ・レイン １【「このラノ」ランクインフェア試し読み増量版】', 'sample'],
    ['竜と魔法の空戦記 ～はぐれ魔導技師と穴あき紫電改～【無料Prelude版】', 'sample'],
    ['ファミ通文庫 トライアルセット ファンタジー編 vol.1', 'sample'],
    ['【合本版1-5巻】夜伽の国の月光姫', 'omnibus'],
    ['猫かぶり姫と天上の音楽 合本版【初回限定SS付】【イラスト付】【合本版】', 'omnibus'],
    ['少女回春5～8総集編', 'omnibus'],
    // Found in the Preview (2026-11-17): sets of volumes.
    [
      '【対訳】ピーターラビットシリーズ １～５巻セット かわいいイラストと、英語と日本語で楽しめる、ピーターラビットと仲間たちのお話！',
      'omnibus',
    ],
    ['【対訳】ピーターラビットシリーズ 5巻セット かわいいイラストと', 'omnibus'],
    ['【対訳】ピーターラビット ⑤ モペットちゃんのおはなし -THE STORY OF MISS MOPPET-', 'full'],
    ['この素晴らしい世界に祝福を！ 11 大魔法使いの妹【電子特別版】', 'special'],
    ['デート・ア・ライブ 十香デッドエンド BOOK☆WALKER special edition', 'special'],
    ['サイレント・ウィッチ VII 特装版【掌編小説集付き】 沈黙の魔女の隠しごと', 'special'],
    [
      'りゅうおうのおしごと！２１ ～白雪姫と竜王の結婚～【完結記念メモリアルブック付き特装版】',
      'special',
    ],
    ['冒険者アル２ あいつの魔法はおかしい', 'full'],
  ])('%s → %s', (title, kind) => {
    expect(editionKind([title]).kind).toBe(kind);
  });

  it('any of the titles decides (stage 2 removed the marker from Calibre’s title)', () => {
    expect(
      editionKind([
        '灰原くんの強くて青春ニューゲーム5',
        '『灰原くん』BOOK☆WALKER限定書き下ろしショートストーリー',
      ]).kind,
    ).toBe('bonus');
    expect(editionKind([null, '', undefined]).kind).toBe('full');
  });
});

const S = { ...DEFAULT_DUPLICATE_SETTINGS };
const book = (calibreId: number, kind: PairBook['kind'] = 'full', chars = 100_000): PairBook => ({
  calibreId,
  kind,
  chars,
});
const m = (aInB: number, bInA: number) => ({ aInB, bInA, extraA: null, extraB: null });

describe('the pair rules', () => {
  it.each([
    ['same text both ways', book(1), book(2), m(0.99, 0.98), 'duplicate', 'both_ways'],
    ['exactly the both-ways limit', book(1), book(2), m(0.8, 0.8), 'duplicate', 'both_ways'],
    // 2026-11-17: a quarter or more beyond the other's text is a collection: review.
    ['one way holds the other', book(1), book(2), m(1, 0.7), 'review', 'holds_other'],
    ['superset just under the limit', book(1), book(2), m(0.949, 0.7), 'review', 'partial'],
    ['partial overlap', book(1), book(2), m(0.3, 0.2), 'review', 'partial'],
    ['at the review floor', book(1), book(2), m(0.1, 0.05), 'review', 'partial'],
    ['different books', book(1), book(2), m(0.03, 0.02), 'different', 'different'],
    [
      'store-bonus SS in the novel',
      book(1, 'bonus', 2000),
      book(2),
      m(0.12, 0.002),
      'never',
      'bonus',
    ],
    [
      'preview inside the full book',
      book(1, 'sample', 13_000),
      book(2),
      m(1, 0.1),
      'never',
      'sample',
    ],
    [
      'two copies of one bonus SS',
      book(1, 'bonus', 2000),
      book(2, 'bonus', 2000),
      m(1, 1),
      'duplicate',
      'both_ways',
    ],
    [
      'volume inside an omnibus',
      book(1, 'omnibus', 500_000),
      book(2),
      m(0.2, 1),
      'never',
      'omnibus',
    ],
    [
      'omnibus 1-5 inside omnibus 1-10',
      book(1, 'omnibus'),
      book(2, 'omnibus'),
      m(1, 0.5),
      'never',
      'omnibus',
    ],
    [
      'the same omnibus, titled so on one side',
      book(1, 'omnibus'),
      book(2),
      m(0.999, 0.999),
      'duplicate',
      'omnibus_same',
    ],
    [
      'an omnibus sharing no text: different books',
      book(1, 'omnibus'),
      book(2),
      m(0.02, 0.01),
      'different',
      'different',
    ],
    ['special edition, same text', book(1, 'special'), book(2), m(1, 1), 'duplicate', 'both_ways'],
  ] as const)('%s', (_name, a, b, measure, cls, rule) => {
    const v = classifyPair(a, b, measure, S);
    expect([v.cls, v.rule]).toEqual([cls, rule]);
  });

  it('names the copy that contains the other', () => {
    expect(classifyPair(book(1), book(2), m(1, 0.7), S).container).toBe('b');
    expect(classifyPair(book(1), book(2), m(0.7, 1), S).container).toBe('a');
  });

  const spread = (share: number, runs: number) => ({
    aInB: 0.88,
    bInA: 1,
    extraA: {
      extraChars: 1,
      runs: [],
      interleavedRuns: runs,
      interleavedChars: 1,
      interleavedShare: share,
      chaptersTouched: runs,
    },
    extraB: null,
  });

  it('extra text inside the chapters goes to review while the limits are unset', () => {
    const v = classifyPair(book(1, 'special'), book(2), spread(0.12, 20), S);
    expect([v.cls, v.rule]).toEqual(['review', 'spread_unset']);
    // Extra text only at the end: the class stands.
    expect(classifyPair(book(1), book(2), spread(0, 0), S).cls).toBe('duplicate');
  });

  it('with the limits set: keep both, borderline, or the class stands', () => {
    const set = { ...S, spreadKeepBoth: 0.05, spreadIgnore: 0.01 };
    expect(classifyPair(book(1), book(2), spread(0.12, 20), set).cls).toBe('keep_both');
    expect(classifyPair(book(1), book(2), spread(0.03, 4), set).cls).toBe('review');
    expect(classifyPair(book(1), book(2), spread(0.002, 1), set).cls).toBe('duplicate');
  });

  it('an omnibus by its text: holds two books that share nothing', () => {
    const vol1 = book(11, 'full', 100_000);
    const vol2 = book(12, 'full', 110_000);
    const preview = book(13, 'sample', 13_000);
    expect(omnibusByText([vol1, vol2], () => false)).toBe(true);
    // The same volume twice (two editions of it) is not an omnibus.
    expect(omnibusByText([vol1, vol2], () => true)).toBe(false);
    // A volume plus a preview of another novel is not either.
    expect(omnibusByText([vol1, preview], () => false)).toBe(false);
  });
});

const q = (over: Partial<QualityFacts> = {}): QualityFacts => ({
  calibreId: 1,
  chars: 100_000,
  images: [],
  ruby: 10,
  tocEntries: 12,
  vertical: true,
  coverSide: 1600,
  customTags: 0,
  addedAt: 1000,
  ...over,
});
const img = (phash: string, side: number, quant: number | null) => ({ phash, side, quant });
const OPTS = { imageMatchDistance: 10, coverLargerPercent: 10 };

describe('the best copy', () => {
  const p1 = '0f0f0f0f0f0f0f0f';
  const p2 = 'ffff0000ffff0000';

  it('better pictures and the same text: auto', () => {
    const a = q({ calibreId: 1, images: [img(p1, 1600, 8), img(p2, 1600, 8)] });
    const b = q({ calibreId: 2, images: [img(p1, 1186, 60), img(p2, 1186, 60)] });
    expect(bestCopy(a, b, OPTS)).toMatchObject({ keep: 'a', by: 'measures' });
  });

  it('different artwork (another edition): a trade-off with its own reason, never auto', () => {
    // Four illustrations each, none alike (e.g. a 新装版 with new art).
    const artA = ['0000ffff0000ffff', '00ff00ff00ff00ff', '0f0f0f0f0f0f0f0f', '3333333333333333'];
    const artB = ['ffff0000ffff0000', 'ff00ff00ff00ff00', 'f0f0f0f0f0f0f0f0', 'cccccccccccccccc'];
    const a = q({ calibreId: 1, images: artA.map((h) => img(h, 1600, 8)) });
    const b = q({ calibreId: 2, images: artB.map((h) => img(h, 1000, 60)) });
    const best = bestCopy(a, b, OPTS);
    expect(best).toMatchObject({ keep: null, by: 'tradeoff' });
    expect(best.reason).toMatch(/different artwork/);
    expect(best.measures.find((m) => m.name === 'artwork')?.detail).toBe(
      'different artwork: 0 of 4 / 4 full-size illustrations match',
    );
    // The same art, only sharper in one copy: no artwork measure, the sharper copy stays.
    const same = q({ calibreId: 3, images: artA.map((h) => img(h, 1000, 60)) });
    const sharper = bestCopy(a, same, OPTS);
    expect(sharper.keep).toBe('a');
    expect(sharper.measures.some((m) => m.name === 'artwork')).toBe(false);
    // Two different illustrations only (an extra page, a store's own art): not another edition.
    const two = q({
      calibreId: 4,
      images: [...artA.slice(0, 2), ...artB.slice(0, 2)].map((h) => img(h, 1600, 8)),
    });
    expect(differentArtwork(two.images, a.images, 10).different).toBe(false);
  });

  it('larger pictures but stronger compression: a trade-off', () => {
    const a = q({ calibreId: 1, images: [img(p1, 1600, 60)] });
    const b = q({ calibreId: 2, images: [img(p1, 1186, 8)] });
    expect(bestCopy(a, b, OPTS)).toMatchObject({ keep: null, by: 'tradeoff' });
  });

  it('the superset with worse pictures: a trade-off', () => {
    const a = q({ calibreId: 1, chars: 110_000, images: [img(p1, 1000, 60)] });
    const b = q({ calibreId: 2, images: [img(p1, 1600, 8)] });
    expect(bestCopy(a, b, { ...OPTS, superset: 'a' }).keep).toBeNull();
    expect(
      bestCopy(a, q({ calibreId: 2, images: [img(p1, 1000, 60)] }), { ...OPTS, superset: 'a' })
        .keep,
    ).toBe('a');
  });

  it('ruby, contents and cover count; writing direction is always a trade-off', () => {
    expect(bestCopy(q({ calibreId: 1 }), q({ calibreId: 2, ruby: 0 }), OPTS).keep).toBe('a');
    expect(bestCopy(q({ calibreId: 1, tocEntries: 0 }), q({ calibreId: 2 }), OPTS).keep).toBe('b');
    expect(bestCopy(q({ calibreId: 1, coverSide: 800 }), q({ calibreId: 2 }), OPTS).keep).toBe('b');
    expect(bestCopy(q({ calibreId: 1, coverSide: 1500 }), q({ calibreId: 2 }), OPTS).by).toBe(
      'tie',
    );
    expect(bestCopy(q({ calibreId: 1, vertical: false }), q({ calibreId: 2 }), OPTS).by).toBe(
      'tradeoff',
    );
  });

  it('all tied: more of your tags, then the older record', () => {
    expect(
      bestCopy(q({ calibreId: 1, addedAt: 5 }), q({ calibreId: 2, addedAt: 3 }), OPTS),
    ).toMatchObject({ keep: 'b', by: 'tie' });
    expect(
      bestCopy(
        q({ calibreId: 1, addedAt: 5, customTags: 1 }),
        q({ calibreId: 2, addedAt: 3 }),
        OPTS,
      ).keep,
    ).toBe('a');
  });

  it('more pictures with the matched ones as good: the richer copy', () => {
    const a = q({ calibreId: 1, images: [img(p1, 1600, 8), img(p2, 1600, 8)] });
    const b = q({ calibreId: 2, images: [img(p1, 1600, 8)] });
    expect(bestCopy(a, b, OPTS).keep).toBe('a');
  });

  it('matches each picture once, closest first', () => {
    const pairs = matchImages(
      [img(p1, 1, null)],
      [img('0f0f0f0f0f0f0f0e', 1, null), img(p1, 1, null)],
      10,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].distance).toBe(0);
  });
});

describe('sets of copies', () => {
  it('the copy that wins against every other one stays', () => {
    const d = decideSets([
      { a: 1, b: 2, keep: 2 },
      { a: 2, b: 3, keep: 2 },
      { a: 1, b: 3, keep: 3 },
    ]);
    expect(d).toEqual([
      {
        members: [1, 2, 3],
        keeper: 2,
        removed: [1, 3],
        removals: [
          { id: 1, keep: 2 },
          { id: 3, keep: 2 },
        ],
      },
    ]);
  });

  it('no copy at least as good as all others, none beaten by all: nothing removed', () => {
    expect(
      decideSets([
        { a: 1, b: 2, keep: 2 },
        { a: 2, b: 3, keep: 3 },
      ]),
    ).toEqual([{ members: [1, 2, 3], keeper: null, removed: [], removals: [] }]);
    expect(decideSets([{ a: 1, b: 2, keep: null }])[0]).toMatchObject({
      keeper: null,
      removals: [],
    });
  });

  it('no single winner: the copy every other copy beats goes, the others stay (2026-11-17)', () => {
    // 1 and 2 both stay (each better somewhere); 3 loses to both: it goes, in favour of the copy
    // that beats more of the others (tie: the lower id).
    expect(
      decideSets([
        { a: 1, b: 2, keep: null },
        { a: 1, b: 3, keep: 1 },
        { a: 2, b: 3, keep: 2 },
      ]),
    ).toEqual([{ members: [1, 2, 3], keeper: null, removed: [3], removals: [{ id: 3, keep: 1 }] }]);
    // A chain: 4 loses to all, then 3 loses to all copies left; 1 and 2 stay.
    const chain = decideSets([
      { a: 1, b: 2, keep: null },
      { a: 1, b: 3, keep: 1 },
      { a: 2, b: 3, keep: 2 },
      { a: 1, b: 4, keep: 1 },
      { a: 2, b: 4, keep: 2 },
      { a: 3, b: 4, keep: 3 },
    ])[0];
    expect(chain.keeper).toBeNull();
    expect(chain.removals).toEqual([
      { id: 4, keep: 1 },
      { id: 3, keep: 1 },
    ]);
    // Beaten by all but one copy it has no measured pair with: it stays.
    expect(
      decideSets([
        { a: 1, b: 2, keep: null },
        { a: 1, b: 3, keep: 1 },
        { a: 2, b: 4, keep: 2 },
      ])[0].removals,
    ).toEqual([]);
    // Every removal points at a copy that stays and beats it.
    for (const r of chain.removals) expect([1, 2]).toContain(r.keep);
  });
});

describe('picture facts', () => {
  const picture = async (width: number, quality: number, seed = 1) => {
    const raw = Buffer.alloc(width * Math.round(width * 1.4) * 3);
    let s = seed;
    for (let y = 0; y < Math.round(width * 1.4); y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const v = Math.round(
          127 + 100 * Math.sin(((x * seed) / width) * 6) * Math.cos((y / width) * 4),
        );
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        raw[i] = raw[i + 1] = raw[i + 2] = Math.max(0, Math.min(255, v + (s % 7)));
      }
    }
    return sharp(raw, { raw: { width, height: Math.round(width * 1.4), channels: 3 } })
      .jpeg({ quality })
      .toBuffer();
  };

  it('reads the quantization: less compressed = lower', async () => {
    const good = jpegQuantization(await picture(400, 95));
    const bad = jpegQuantization(await picture(400, 40));
    expect(good).not.toBeNull();
    expect(good!).toBeLessThan(bad!);
    expect(jpegQuantization(Buffer.from('not a jpeg'))).toBeNull();
  });

  it('the same picture re-encoded smaller matches; another picture does not', async () => {
    const a = (await imageFactOf(await picture(800, 92)))!;
    const b = (await imageFactOf(await picture(500, 50)))!;
    const c = (await imageFactOf(await picture(800, 92, 5)))!;
    expect(a.side).toBe(Math.round(800 * 1.4));
    expect(matchImages([a], [b], 10)).toHaveLength(1);
    expect(matchImages([a], [c], 10)).toHaveLength(0);
  });
});

const REF = process.env.CLEANUP_REFERENCE_DIR;

describe.skipIf(!REF)('edition kinds on the 800 labeled books', () => {
  it('recognizes every labeled sample, bonus and omnibus (they guard removals)', () => {
    const gold = JSON.parse(fs.readFileSync(path.join(REF!, 'gold800.json'), 'utf8')) as Record<
      string,
      { kind: string; t: string }
    >;
    const confusion = new Map<string, number>();
    const missed: string[] = [];
    for (const [id, label] of Object.entries(gold)) {
      const rec = JSON.parse(fs.readFileSync(path.join(REF!, 'records', `${id}.json`), 'utf8')) as {
        calibre: { cal_title: string };
        file: { opf_title: string | null };
      };
      const got = editionKind([rec.file.opf_title, rec.calibre.cal_title]).kind;
      const want = label.kind === 'special edition' ? 'special' : label.kind;
      confusion.set(`${want}→${got}`, (confusion.get(`${want}→${got}`) ?? 0) + 1);
      if (['sample', 'bonus', 'omnibus'].includes(want) && got !== want)
        missed.push(`${id} ${want}→${got} ${label.t}`);
    }
    console.log(
      [...confusion]
        .sort()
        .map(([k, n]) => `${k}: ${n}`)
        .join('\n'),
    );
    expect(missed).toEqual([]);
  });
});
