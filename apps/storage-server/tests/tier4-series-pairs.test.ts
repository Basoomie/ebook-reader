/**
 * Tier 4, Part 3: series under a short and a full name (src/cleanup/series-pairs/pairs.ts and
 * the measuring scripts' helpers). Examples are the WP20e report's (wp20e-series-pairs.md).
 */
import { describe, expect, it } from 'vitest';
import { seriesPairsOf } from '../src/cleanup/edits/series';
import {
  CANDIDATE_RULES,
  PROPOSED_RULE_IDS,
  answerPair,
  commonName,
  libraryPairs,
  pairGroup,
  pairSignals,
  spinoffWord,
  type NamePair,
  type PairBook,
  type PairRule,
} from '../src/cleanup/series-pairs/pairs';
import { measureRules, sampleRows, shares, type PairRow } from '../scripts/lib/series-pairs-io';

const book = (
  calibreId: number,
  title: string,
  index: number | null,
  more: Partial<PairBook> = {},
): PairBook => ({
  uuid: `u${calibreId}`,
  calibreId,
  title,
  authors: ['西村京太郎'],
  index,
  kind: 'full',
  own: [title],
  amazonSeries: null,
  ranobedbSeries: null,
  links: [],
  ...more,
});

const pairOf = (short: string, long: string, s = 1, l = 1): NamePair => ({
  short,
  long,
  shortBooks: s,
  longBooks: l,
  ...pairGroup(short, long),
});

describe('pairGroup', () => {
  it.each([
    ['十津川警部', '十津川警部シリーズ', 'series_word'],
    ['「涼宮ハルヒ」', '「涼宮ハルヒ」シリーズ', 'series_word'],
    ['デューン・', 'デューン・シリーズ', 'series_word'],
    ['本好きの下剋上', '本好きの下剋上 〜司書になるためには手段を選んでいられません〜', 'subtitle'],
    ['お前は俺のモノだろ？', 'お前は俺のモノだろ?~俺様社長の独占溺愛~', 'subtitle'],
    [
      '本好きの下剋上',
      '本好きの下剋上~司書になるためには手段を選んでいられません~ 短編集',
      'spinoff',
    ],
    ['ソードアート・オンライン', 'ソードアート・オンライン プログレッシブ', 'spinoff'],
    [
      'ダンジョンに出会いを求めるのは間違っているだろうか',
      'ダンジョンに出会いを求めるのは間違っているだろうか外伝',
      'spinoff',
    ],
    ['Re:ゼロから始める異世界生活', 'Re:ゼロから始める異世界生活 Ex', 'spinoff'],
    ['デート・ア・ライブ', 'デート・ア・ライブ フラグメント', 'spinoff'],
    ['源氏物語', '源氏物語が面白いほどわかる本', 'other'],
    ['キノの旅', 'キノの旅 the Beautiful World', 'other'],
    ['顔のない刑事', '「顔のない刑事」シリーズ', 'spelled'],
    ['ホーンテッド!', 'ホーンテッド・キャンパス', 'spelled'],
  ])('%s / %s → %s', (short, long, group) => {
    expect(pairGroup(short, long).group).toBe(group);
  });

  it('keeps the added text', () => {
    expect(
      pairGroup('ソードアート・オンライン', 'ソードアート・オンライン プログレッシブ').added,
    ).toBe('プログレッシブ');
    expect(pairGroup('顔のない刑事', '「顔のない刑事」シリーズ').added).toBe('シリーズ');
  });

  it('reads Latin spin-off words only as words', () => {
    expect(spinoffWord(' IF')).toBe('IF');
    expect(spinoffWord('ライフ')).toBeNull();
    expect(spinoffWord('LIFE')).toBeNull();
    expect(spinoffWord(' Ex')).toBe('Ex');
    expect(spinoffWord('Exodus')).toBeNull();
  });
});

describe('commonName', () => {
  it.each([
    ['十津川警部', '十津川警部シリーズ', '十津川警部'],
    ['「涼宮ハルヒ」', '「涼宮ハルヒ」シリーズ', '「涼宮ハルヒ」'],
    ['デューン・', 'デューン・シリーズ', 'デューン'],
    [
      '本好きの下剋上',
      '本好きの下剋上 〜司書になるためには手段を選んでいられません〜',
      '本好きの下剋上',
    ],
    ['（マ）シリーズ', '(マ)シリーズビーンズ文庫版', '（マ）'],
    ['寄せ集めたファンタジ', '寄せ集めたファンタジー', '寄せ集めたファンタジー'],
  ])('%s / %s → %s', (short, long, name) => {
    expect(commonName(short, long).name).toBe(name);
  });

  it('says when the short name is the long one cut', () => {
    expect(commonName('寄せ集めたファンタジ', '寄せ集めたファンタジー').cut).toBe(true);
    expect(commonName('GOSICK', 'GOSICKs').cut).toBe(false);
  });
});

describe('libraryPairs', () => {
  it('finds the same pairs as the series editor, without its cap', () => {
    const series = [
      { name: '十津川警部', books: 8 },
      { name: '十津川警部シリーズ', books: 1 },
      { name: 'Re:ゼロから始める異世界生活', books: 51 },
      { name: 'Re:ゼロから始める異世界生活 短編集', books: 11 },
      { name: 'Re:ゼロから始める異世界生活 Ex', books: 6 },
      { name: '「顔のない刑事」シリーズ', books: 13 },
      { name: '顔のない刑事', books: 6 },
      { name: '刑', books: 1 },
      { name: 'ホーンテッド・キャンパス', books: 24 },
      { name: 'ホーンテッド!', books: 4 },
      // A 2-letter short name is not a pair (the report's list; the editor suggests it).
      { name: '物語', books: 4 },
      { name: '〈物語〉シリーズ', books: 31 },
    ];
    const pairs = libraryPairs(series);
    const names = pairs.map((p) => `${p.short} / ${p.long}`).sort();
    expect(names).toEqual(
      [
        'Re:ゼロから始める異世界生活 / Re:ゼロから始める異世界生活 Ex',
        'Re:ゼロから始める異世界生活 / Re:ゼロから始める異世界生活 短編集',
        'ホーンテッド! / ホーンテッド・キャンパス',
        '十津川警部 / 十津川警部シリーズ',
        '顔のない刑事 / 「顔のない刑事」シリーズ',
      ].sort(),
    );
    // Every pair the editor suggests for a name is found (3 letters and more).
    for (const s of series)
      for (const other of seriesPairsOf(s.name, series, new Set()).filter(
        (o) => o.name !== '物語' && s.name !== '物語',
      ))
        expect(
          pairs.some(
            (p) =>
              (p.short === s.name && p.long === other.name) ||
              (p.long === s.name && p.short === other.name),
          ),
        ).toBe(true);
  });

  it('pairs names that share a key with each other name of the other key', () => {
    const pairs = libraryPairs([
      { name: 'Re:ゼロ', books: 3 },
      { name: 'Re：ゼロ', books: 1 },
      { name: 'Re:ゼロ Ex', books: 2 },
    ]);
    expect(pairs).toHaveLength(2);
    // Two spellings of one key are not a pair here (one spelling per series handles them).
    expect(pairs.every((p) => p.long === 'Re:ゼロ Ex')).toBe(true);
  });

  it('runs at the library size in well under a second', () => {
    const series: { name: string; books: number }[] = [];
    for (let i = 0; i < 9000; i++) {
      const base = `シリーズ名${String.fromCodePoint(0x4e00 + (i % 2000))}${i}`;
      series.push({ name: i % 10 === 0 ? `${base}外伝` : base, books: 1 + (i % 5) });
    }
    for (let i = 0; i < 9000; i += 10)
      series.push({ name: `シリーズ名${String.fromCodePoint(0x4e00 + (i % 2000))}${i}`, books: 2 });
    const t = performance.now();
    const pairs = libraryPairs(series);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(pairs.length).toBeGreaterThan(800);
  });
});

describe('pairSignals', () => {
  it('counts a collision when both names have a different #1', () => {
    const p = pairOf('ソードアート・オンライン', 'ソードアート・オンライン プログレッシブ', 2, 1);
    const s = pairSignals(
      p,
      [
        book(1, 'ソードアート・オンライン1 アインクラッド', 1, { authors: ['川原礫'] }),
        book(2, 'ソードアート・オンライン2 アインクラッド', 2, { authors: ['川原礫'] }),
      ],
      [book(3, 'ソードアート・オンライン プログレッシブ1', 1, { authors: ['川原 礫'] })],
    );
    expect(s.collisions).toBe(1);
    expect(s.bothHaveOne).toBe(true);
    expect(s.collisionExamples[0]).toMatch(/^1: /);
    expect(s.sharedAuthors).toEqual(['川原礫']);
    expect(s.spinoff).toBe('プログレッシブ');
  });

  it('does not count copies of one volume as a collision', () => {
    const p = pairOf('十津川警部', '十津川警部シリーズ');
    const s = pairSignals(p, [book(1, '寝台特急殺人事件', 1)], [book(2, '寝台特急殺人事件', 1)]);
    expect(s.collisions).toBe(0);
    expect(s.longWithShortAuthor).toBe(1);
  });

  it('counts only the clashes a merge adds, not the ones a name already has', () => {
    const p = pairOf('身代わり伯爵', '身代わり伯爵シリーズ', 2, 1);
    const s = pairSignals(
      p,
      [
        book(1, '身代わり伯爵の冒険', 1, { authors: ['清家未森'] }),
        book(2, '身代わり伯爵の結婚行進曲 Ⅰ', 1, { authors: ['清家未森'] }),
      ],
      [book(3, '身代わり伯爵の婚前旅行 Ⅱ', 2, { authors: ['清家未森'] })],
    );
    expect(s.collisionsWithin).toBe(1);
    expect(s.collisions).toBe(0);
    expect(s.collisionExamples).toEqual([]);
  });

  it('holds a merge that adds a clash for review', () => {
    const p = pairOf('十津川警部', '十津川警部シリーズ');
    const s = pairSignals(p, [book(1, '寝台特急殺人事件', 1)], [book(2, '終着駅殺人事件', 1)]);
    expect(s.collisions).toBe(1);
    const merge: PairRule[] = [{ id: 'm', says: () => 'merge' }];
    expect(answerPair(p, s, merge)).toEqual({ answer: 'review', rule: 'm', held: 'collision' });
  });

  it('does not count side books as a collision', () => {
    const p = pairOf('銀河英雄伝説', '銀河英雄伝説外伝');
    const s = pairSignals(
      p,
      [book(1, '銀河英雄伝説1 黎明篇', 1)],
      [book(2, '銀河英雄伝説外伝1 星を砕く者', 1, { kind: 'bonus' })],
    );
    expect(s.collisions).toBe(0);
  });

  it('reads the stores: RanobeDB ids and Amazon series text', () => {
    const p = pairOf('魔女の旅々', '魔女の旅々 学園物語');
    const same = pairSignals(
      p,
      [book(1, '魔女の旅々', 1, { ranobedbSeries: { id: '10', name: '魔女の旅々' } })],
      [book(2, '魔女の旅々 学園物語', 2, { ranobedbSeries: { id: '10', name: '魔女の旅々' } })],
    );
    expect(same.ranobedb).toBe('same');
    expect(same.storeNamesOther).toBe(true);
    const diff = pairSignals(
      p,
      [book(1, '魔女の旅々', 1, { ranobedbSeries: { id: '10', name: '魔女の旅々' } })],
      [
        book(2, '魔女の旅々 学園物語', 1, {
          ranobedbSeries: { id: '11', name: '魔女の旅々 学園物語' },
          amazonSeries: '魔女の旅々 学園物語 (GA文庫)',
        }),
      ],
    );
    expect(diff.ranobedb).toBe('different');
    expect(diff.amazon).toBe('none');
    expect(diff.storeNamesOther).toBe(false);
  });

  it('sees no shared author for unrelated books', () => {
    const p = pairOf('源氏物語', '源氏物語が面白いほどわかる本');
    const s = pairSignals(
      p,
      [book(1, '源氏物語 一', 1, { authors: ['紫式部'] })],
      [book(2, '源氏物語が面白いほどわかる本', 1, { authors: ['出口汪'] })],
    );
    expect(s.sharedAuthors).toEqual([]);
    expect(answerPair(p, s).answer).toBe('separate');
  });
});

describe('answerPair', () => {
  it('merges a シリーズ pair by one author with no collision', () => {
    const p = pairOf('十津川警部', '十津川警部シリーズ');
    const s = pairSignals(p, [book(1, '寝台特急殺人事件', 1)], [book(2, '終着駅殺人事件', 2)]);
    expect(answerPair(p, s)).toEqual({ answer: 'merge', rule: 'series-word' });
  });

  it('sends what no rule decides to review', () => {
    const p = pairOf('キノの旅', 'キノの旅 the Beautiful World');
    const s = pairSignals(
      p,
      [book(1, 'キノの旅', 1, { authors: ['時雨沢恵一'] })],
      [book(2, 'キノの旅II the Beautiful World', 2, { authors: ['時雨沢恵一'] })],
    );
    expect(answerPair(p, s)).toEqual({ answer: 'review', rule: null });
  });

  it('takes the first rule with an answer', () => {
    const rules: PairRule[] = [
      { id: 'a', says: () => null },
      { id: 'b', says: () => 'separate' },
      { id: 'c', says: () => 'merge' },
    ];
    const p = pairOf('A1', 'A1 B');
    expect(answerPair(p, pairSignals(p, [], []), rules)).toEqual({ answer: 'separate', rule: 'b' });
  });
});

describe('the proposed rules', () => {
  const proposed = PROPOSED_RULE_IDS.map((id) => CANDIDATE_RULES.find((r) => r.id === id)!);

  it('names only rules that exist', () => {
    expect(proposed.every(Boolean)).toBe(true);
  });

  it('keeps an omnibus of the series in it, and separates a spin-off', () => {
    const omni = pairOf('懲役警察 B side diary', '懲役警察 B Side Diary(合本版)');
    const so = pairSignals(
      omni,
      [
        book(1, '懲役警察 B side diary 幻の追跡者', 1, {
          authors: ['さかいみつる'],
          amazonSeries: '懲役警察 B Side Diary（合本版）',
        }),
      ],
      [
        book(2, '懲役警察 B Side Diary（合本版）1巻', 1.9, {
          kind: 'omnibus',
          authors: ['さかいみつる'],
          amazonSeries: '懲役警察 B Side Diary（合本版）',
        }),
      ],
    );
    expect(answerPair(omni, so, proposed).answer).toBe('merge');
    const spin = pairOf('スパイ教室', 'スパイ教室 短編集');
    const ss = pairSignals(
      spin,
      [book(1, 'スパイ教室01', 1, { authors: ['竹町'] })],
      [book(2, 'スパイ教室 短編集01', 1, { authors: ['竹町'] })],
    );
    expect(answerPair(spin, ss, proposed)).toEqual({
      answer: 'separate',
      rule: 'spinoff-not-omnibus',
    });
  });

  it('never separates for a clash: one series with a misnumbered book goes to review', () => {
    const p = pairOf('ネロ・ウルフ', 'ネロ・ウルフ中編シリーズ');
    const s = pairSignals(
      p,
      [book(1, '赤い箱', 2, { authors: ['レックス・スタウト'], amazonSeries: 'ネロ・ウルフ' })],
      [book(2, '死の招待', 2, { authors: ['レックス・スタウト'], amazonSeries: 'ネロ・ウルフ' })],
    );
    expect(s.collisions).toBe(1);
    expect(answerPair(p, s, proposed)).toEqual({
      answer: 'review',
      rule: 'store-same',
      held: 'collision',
    });
  });
});

describe('the measuring helpers', () => {
  const row = (short: string, long: string, truth: 'same' | 'different' | null) => {
    const p = pairOf(short, long);
    const signals = pairSignals(p, [book(1, short, 1)], [book(2, long, 2)]);
    const r: PairRow = {
      ...p,
      common: commonName(short, long),
      decided: null,
      signals,
      ...answerPair(p, signals),
      shortSide: [book(1, short, 1)],
      longSide: [book(2, long, 2)],
    };
    return { ...sampleRows([r])[0], truth, evidence: null };
  };

  it('counts wrong answers per rule and for the list', () => {
    const sample = [
      row('十津川警部', '十津川警部シリーズ', 'same'),
      row('亜由美', '亜由美シリーズ', 'different'),
      row('キノの旅', 'キノの旅 the Beautiful World', 'same'),
      row('天使と悪魔', '天使と悪魔の捧げ物', null),
    ];
    const m = measureRules(sample, [
      { id: 'series-word', says: (p) => (p.group === 'series_word' ? 'merge' : null) },
    ]);
    expect(m.checked).toBe(3);
    expect(m.alone[0]).toMatchObject({ merge: 2, mergeWrong: 1 });
    expect(m.list).toMatchObject({ merge: 2, mergeWrong: 1, review: 1 });
    expect(m.list.wrong[0]).toMatch(/亜由美/);
  });

  it('keeps at most 8 books per side in the sample', () => {
    const p = pairOf('解註謡曲全集', '解註謡曲全集全六巻');
    const many = Array.from({ length: 20 }, (_, i) =>
      book(i + 1, `解註謡曲全集 ${20 - i}`, 20 - i),
    );
    const signals = pairSignals(p, many, []);
    const [s] = sampleRows([
      {
        ...p,
        common: commonName(p.short, p.long),
        decided: null,
        signals,
        ...answerPair(p, signals),
        shortSide: many,
        longSide: [],
      },
    ]);
    expect(s.shortSide.map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('shares the sample by group with a minimum', () => {
    const s = shares(
      { series_word: 60, subtitle: 33, spinoff: 44, other: 279, spelled: 28 },
      80,
      10,
    );
    expect(s).toEqual({ series_word: 14, subtitle: 12, spinoff: 13, other: 30, spelled: 11 });
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(80);
    expect(
      shares({ series_word: 3, subtitle: 0, spinoff: 1, other: 100, spelled: 0 }, 80, 10),
    ).toEqual({
      series_word: 3,
      subtitle: 0,
      spinoff: 1,
      other: 76,
      spelled: 0,
    });
    expect(
      shares({ series_word: 3, subtitle: 2, spinoff: 1, other: 4, spelled: 0 }, 80, 10),
    ).toEqual({
      series_word: 3,
      subtitle: 2,
      spinoff: 1,
      other: 4,
      spelled: 0,
    });
  });
});
