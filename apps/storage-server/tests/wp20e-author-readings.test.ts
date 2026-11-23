/**
 * Stage 4 rules 9 (the live Preview of 2026-11-22): NDL's notes never go into author_sort, a
 * value the cleanup wrote with them is corrected, and a name whose namesakes NDL reads
 * differently is a best guess. The rows are NDL's own answers (the fetch cache of the live run).
 */
import { describe, expect, it } from 'vitest';
import { ndlNameReading, ndlReading, type NdlRow } from '../src/cleanup/stage4/store-links';
import { proposeStage4, type AuthorReading } from '../src/cleanup/stage4/proposals';
import { plainVolume, type SeriesChoice } from '../src/cleanup/stage4/series-order';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import type { Stage4Decision } from '../src/cleanup/stage4/stage4-rules';
import type { Stage2Book } from '../src/cleanup/stage2-snapshot';

const row = (name: string, label: string, yomi: string, auth = 'a'): NdlRow => ({
  name,
  label,
  yomi,
  auth,
});

describe("NDL's notes are not part of the reading", () => {
  it('takes the label parts that spell the name', () => {
    expect(
      ndlNameReading(
        row('青木邦子', '青木, 邦子, 陶芸家', 'アオキ, クニコ, トウゲイカ'),
        '青木邦子',
      ),
    ).toBe('アオキ, クニコ');
    expect(ndlNameReading(row('ナツ', 'ナツ, pub. 2016', 'ナツ, pub. 2016'), 'ナツ')).toBe('ナツ');
    expect(
      ndlNameReading(
        row('山本一郎', '山本, 一郎, 1886- 薬剤師', 'ヤマモト, イチロウ, 1886- ヤクザイシ'),
        '山本一郎',
      ),
    ).toBe('ヤマモト, イチロウ');
    expect(
      ndlNameReading(
        row('夏目漱石', '夏目, 漱石, 1867-1916', 'ナツメ, ソウセキ, 1867-1916'),
        '夏目漱石',
      ),
    ).toBe('ナツメ, ソウセキ');
    // Numbers that are the name's own stay.
    expect(ndlNameReading(row('竜騎士07', '竜騎士07', 'リュウキシ 07'), '竜騎士07')).toBe(
      'リュウキシ 07',
    );
    expect(ndlNameReading(row('西尾維新', '西尾, 維新', 'ニシオ, イシン'), '西尾維新')).toBe(
      'ニシオ, イシン',
    );
    // A label that doesn't spell the name: the parts with a year and those after the second go.
    expect(
      ndlNameReading(row('森モト', '森, もと, pub. 2013', 'モリ, モト, pub. 2013'), '森モト'),
    ).toBe('モリ, モト');
  });

  it('drops notes in brackets and keeps NDL spacing', () => {
    expect(ndlNameReading(row('堤', '堤 (家)', 'ツツミ (ケ)'), '堤')).toBe('ツツミ');
    expect(
      ndlNameReading(row('片桐', '片桐 (家) (長岡市)', 'カタギリ (ケ) (ナガオカシ)'), '片桐'),
    ).toBe('カタギリ');
    expect(
      ndlNameReading(
        row(
          '国際情勢研究会',
          '国際情勢研究会 (pub. 2015)',
          'コクサイ ジョウセイ ケンキュウカイ (pub. 2015)',
        ),
        '国際情勢研究会',
      ),
    ).toBe('コクサイ ジョウセイ ケンキュウカイ');
    expect(ndlNameReading(row('星名ヒカリ', '星名, ヒカリ', 'ホシナ,ヒカリ'), '星名ヒカリ')).toBe(
      'ホシナ,ヒカリ',
    );
  });

  it('marks namesakes read differently, and takes the main entry or the reading kept before', () => {
    const 渡部 = [
      row('渡部正和', '渡部, 正和, pub. 2013', 'ワタナベ, マサカズ, pub. 2013', 'x1'),
      row('渡部正和', '渡部, 正和, 1941-', 'ワタナベ, マサカズ, 1941-', 'x2'),
      row('渡部正和', '渡部, 正和, 言語学', 'ワタベ, マサカズ, ゲンゴガク', 'x3'),
      row('渡部正和', '渡部, 正和', 'ワタベ, マサカズ', 'x4'),
    ];
    const first = ndlReading(渡部, '渡部正和')!;
    expect(first).toMatchObject({ reading: 'ワタベ, マサカズ', ambiguous: true, authority: 'x4' });
    // The forms stored before (with the notes) lead to the reading without them.
    expect(first.forms).toContainEqual(['ワタナベ, マサカズ, pub. 2013', 'ワタナベ, マサカズ']);
    expect(ndlReading(渡部, '渡部正和', 'ワタナベ, マサカズ')).toMatchObject({
      reading: 'ワタナベ, マサカズ',
      ambiguous: true,
    });
    // Namesakes with one reading: not ambiguous.
    const 青木 = [
      row('青木邦子', '青木, 邦子, 陶芸家', 'アオキ, クニコ, トウゲイカ'),
      row('青木邦子', '青木, 邦子', 'アオキ, クニコ'),
    ];
    expect(ndlReading(青木, '青木邦子')).toMatchObject({
      reading: 'アオキ, クニコ',
      ambiguous: false,
    });
  });
});

const book = (authorSort: string | null, authors = ['青木邦子']): Stage2Book =>
  ({
    calibreId: 1,
    uuid: 'u1',
    title: '平清盛 一',
    titleSort: null,
    authors,
    authorSort,
    tags: [],
    hasCover: false,
    path: 'a/b (1)',
    filePath: 'a/b (1)/b.epub',
    lastModified: null,
    identifiers: {},
    publisher: null,
    languages: [],
    illustrators: [],
  }) as Stage2Book;
const record = {
  calibre: { cal_title: '平清盛 一' },
  file: { opf_title: '平清盛 一' },
  amazon: {},
  ranobedb: {},
  bookwalker: {},
} as unknown as RefRecord;
const decision = (
  authors: string[],
  se: string | null = null,
  ix: number | null = null,
): Stage4Decision =>
  ({
    values: { t: '平清盛 一', au: authors, il: [], se, ix, fmt: 'novel', kind: 'full' },
    auto: { t: true, au: true, il: true, se: true, ix: true, fmt: true, kind: true },
    numberGuess: null,
    amazonRejected: null,
    kindMarker: null,
    trace: {
      amazonIdentified: false,
      amazonByAsin: false,
      ranobedbIdentified: false,
      amazon: {},
      cleaned: { file: '', amazon: null, ranobedb: null, bookwalker: null },
      colophonIllustrators: [],
      imprints: [],
    },
  }) as unknown as Stage4Decision;
const sortOf = (
  b: Stage2Book,
  readings: Record<string, AuthorReading>,
  applied: Map<string, unknown> = new Map(),
) =>
  proposeStage4({
    book: b,
    extras: { comments: null, series: null, seriesIndex: null } as never,
    record,
    decision: decision(b.authors),
    bookmeter: null,
    natively: null,
    readings: new Map(Object.entries(readings)),
    cover: null,
    applied: applied as never,
    sameDistance: 5,
    smallCoverPx: 800,
    ai: null,
  }).find((p) => p.field === 'author_sort');

describe('author_sort with the readings read again', () => {
  it('corrects a written value that only loses the notes, even for an ambiguous name', () => {
    const written = 'アオキ, クニコ, トウゲイカ';
    const p = sortOf(
      book(written),
      { 青木邦子: { reading: 'アオキ, クニコ', source: 'ndl', noted: written } },
      new Map([['author_sort', written]]),
    );
    expect(p).toMatchObject({ class: 'auto', new: 'アオキ, クニコ' });
    const q = sortOf(
      book('ワタナベ, マサカズ, pub. 2013', ['渡部正和']),
      {
        渡部正和: {
          reading: 'ワタナベ, マサカズ',
          source: 'ndl',
          ambiguous: true,
          noted: 'ワタナベ, マサカズ, pub. 2013',
        },
      },
      new Map([['author_sort', 'ワタナベ, マサカズ, pub. 2013']]),
    );
    expect(q).toMatchObject({ class: 'auto', new: 'ワタナベ, マサカズ' });
  });

  it('a reading namesakes give differently is a best guess (to review)', () => {
    const p = sortOf(book(null, ['渡部正和']), {
      渡部正和: { reading: 'ワタベ, マサカズ', source: 'ndl', ambiguous: true },
    });
    expect(p).toMatchObject({ class: 'review', evidence: { unconfirmed: true } });
  });

  it('a sure reading for an empty field stays automatic', () => {
    const p = sortOf(book(null), { 青木邦子: { reading: 'アオキ, クニコ', source: 'ndl' } });
    expect(p).toMatchObject({ class: 'auto', new: 'アオキ, クニコ' });
  });
});

const seriesOf = (
  calibre: { series: string | null; seriesIndex: number | null },
  decided: { se: string; ix: number | null },
  so: Partial<SeriesChoice> & { index: number | null; from: string },
  applied: Map<string, unknown> = new Map(),
  title?: string,
  appliedGuess?: Set<string>,
) =>
  proposeStage4({
    appliedGuess,
    book: title ? { ...book(null), title } : book(null),
    extras: { comments: null, ...calibre } as never,
    record,
    decision: decision(['青木邦子'], decided.se, decided.ix),
    bookmeter: null,
    natively: null,
    readings: new Map(),
    cover: null,
    applied: applied as never,
    sameDistance: 5,
    smallCoverPx: 800,
    ai: null,
    seriesOrder: { uuid: 'u1', guess: false, reason: null, ...so },
  }).find((p) => p.field === 'series');

describe("the series step's number over a number Calibre has (rules 9)", () => {
  it('one source only (a number read from the title, unlike the decided one): to review', () => {
    const p = seriesOf(
      { series: '文豪ストレイドッグス', seriesIndex: 4 },
      { se: '文豪ストレイドッグス', ix: 4 },
      { index: 55, from: 'its own title' },
    );
    expect(p).toMatchObject({ class: 'review', new: { index: 55 } });
    expect(p?.reason).toContain('book');
  });
  it("agreeing with the book's decided number: automatic", () => {
    const p = seriesOf(
      { series: 'S', seriesIndex: 3 },
      { se: 'S', ix: 5 },
      { index: 5, from: 'its store record' },
    );
    expect(p).toMatchObject({ class: 'auto', new: { index: 5 } });
  });
  it("the user's conventions over the agreed number stay automatic", () => {
    const p = seriesOf(
      { series: 'リビルドワールド', seriesIndex: 4 },
      { se: 'リビルドワールド', ix: 4 },
      { index: 7, from: 'the reading order (the series has volumes in parts)' },
    );
    expect(p).toMatchObject({ class: 'auto', new: { index: 7 } });
  });
  it('a number the cleanup wrote is not changed by the models asked again', () => {
    const name = '本好きの下剋上 〜司書になるためには手段を選んでいられません〜';
    const p = seriesOf(
      { series: name, seriesIndex: 30 },
      { se: name, ix: 9 },
      { index: 9, from: 'its own title' },
      new Map([['series', { name, index: 30 }]]),
    );
    expect(p).toMatchObject({
      class: 'review',
      reason: 'Would replace a number the cleanup wrote',
    });
  });
});

describe('a volume number printed plainly after the series name', () => {
  it('reads the plain form only', () => {
    expect(plainVolume('闇の皇太子19 光と闇のロマンス', '闇の皇太子')).toBe(19);
    expect(plainVolume('丹下左膳 03 日光の巻', '丹下左膳')).toBe(3);
    expect(plainVolume('キノの旅XXIII the Beautiful World', 'キノの旅')).toBe(23);
    expect(plainVolume('文豪ストレイドッグス 55Minutes', '文豪ストレイドッグス')).toBeNull();
    expect(
      plainVolume('借金お嬢クリス 42兆円耳を揃えて返してやりますわ', '借金お嬢クリス'),
    ).toBeNull();
    expect(
      plainVolume('東京ダンジョンマスター ～社畜勇者(28)は休めない～', '東京ダンジョンマスター'),
    ).toBeNull();
    expect(plainVolume('ひめゆり1,2,3', 'ひめゆり')).toBeNull();
    expect(plainVolume('その者。のちに… 9 新婚旅行編（2）', 'その者。のちに…')).toBeNull();
    expect(plainVolume('安達としまむら99.9', '安達としまむら')).toBeNull();
    expect(plainVolume('恋愛処方箋 Vol.1+2', '恋愛処方箋')).toBeNull();
    expect(plainVolume('壊れたカーソル（セイレーンⅡ―ⅱ）', 'セイレーン')).toBeNull();
    expect(plainVolume('三国志 02 桃園の巻', '三国志')).toBe(2);
  });
  it('lets such a title change the number Calibre has', () => {
    const p = seriesOf(
      { series: '闇の皇太子', seriesIndex: 18.5 },
      { se: '闇の皇太子', ix: 18.5 },
      { index: 19, from: 'its own title' },
      new Map(),
      '闇の皇太子19 光と闇のロマンス',
    );
    expect(p?.class).toBe('auto');
  });
});

describe('a value the cleanup wrote as a best guess (2026-11-23, (仮)花嫁)', () => {
  const name = '(仮)花嫁のやんごとなき事情';
  it('a number written as a guess is replaced by a confirmed one', () => {
    const p = seriesOf(
      { series: name, seriesIndex: 2 },
      { se: name, ix: 3 },
      { index: 3, from: "its store record's title" },
      new Map([['series', { name, index: 2 }]]),
      undefined,
      new Set(['series']),
    );
    expect(p).toMatchObject({ class: 'auto', new: { index: 3 } });
  });
  it('a number written as confirmed stays (review)', () => {
    const p = seriesOf(
      { series: name, seriesIndex: 2 },
      { se: name, ix: 3 },
      { index: 3, from: "its store record's title" },
      new Map([['series', { name, index: 2 }]]),
    );
    expect(p).toMatchObject({
      class: 'review',
      reason: 'Would replace a number the cleanup wrote',
    });
  });
  it('one source only is still review, guess written or not', () => {
    const p = seriesOf(
      { series: name, seriesIndex: 2 },
      { se: name, ix: 2 },
      { index: 9, from: 'its own title' },
      new Map([['series', { name, index: 2 }]]),
      undefined,
      new Set(['series']),
    );
    expect(p?.class).toBe('review');
  });
});
