/**
 * Series-order follow-up (plan approved 2026-11-22): the fixed picker (pick.ts), the volume
 * numbers a title prints, and the order of each series (series-order.ts), from cases found on
 * the live library.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { calibreAsFound } from '../src/cleanup/stage4/as-found';
import { pickByVolume, titleKey } from '../src/cleanup/stage4/pick';
import {
  addSeriesChecks,
  emptyChecks,
  isSideTitle,
  omnibusLast,
  orderSeries,
  subSeriesNumber,
  arcOf,
  copyBooks,
  printedNumber,
  RDB_PLACE_SURE,
  SIDE_COUNTED,
  type SeriesBook,
} from '../src/cleanup/stage4/series-order';
import { firstColophonDate, storeListPlaces } from '../src/cleanup/stage4/analysis';

const HANAYOME = '(仮)花嫁のやんごとなき事情';
const label = (t: string) => `${t} (ビーズログ文庫)`;

describe('the picker takes the volume whose title is the book', () => {
  const cands: [string, string][] = [
    ['B00E18N9LE', label('(仮)花嫁のやんごとなき事情3 ～離婚できずに新婚旅行～')],
    ['B00A33COJE', label('(仮)花嫁のやんごとなき事情1 ～離婚できたら一攫千金！～')],
    ['B01K9G7WH8', label('(仮)花嫁のやんごとなき事情12 ～結婚できたら大団円！～')],
    ['B011AYHPY8', "(仮)花嫁のやんごとなき事情 ～離婚できたら一攫千金!～ 1 (B's-LOG COMICS)"],
  ];
  it('(仮)花嫁 vol 3: its own result, not volume 1', () => {
    expect(pickByVolume('(仮)花嫁のやんごとなき事情~離婚できずに新婚旅行!?~', cands)?.[0]).toBe(
      'B00E18N9LE',
    );
  });
  it('volume 1 still takes volume 1', () => {
    expect(pickByVolume('(仮)花嫁のやんごとなき事情~離婚できたら一攫千金!~', cands)?.[0]).toBe(
      'B00A33COJE',
    );
  });
  it('a title that is only the series name never takes a later volume by its number', () => {
    const c: [string, string][] = [
      ['A', 'ある日から使えるようになった転移魔法が万能で生きるのが楽しくなりました 1 (BUNCOMI)'],
      [
        'B',
        'ある日から使えるようになった転移魔法が万能で生きるのが楽しくなりました２ (富士見ファンタジア文庫)',
      ],
    ];
    expect(
      pickByVolume(
        'ある日から使えるようになった転移魔法が万能で生きるのが楽しくなりました',
        c,
      )?.[0],
    ).toBe('A');
  });
  it('a subtitle two volumes share does not tell them apart: volume 1', () => {
    const c: [string, string][] = [
      ['V2', '時魔術士の強くてニューゲーム２\u3000～過去に戻って世界最強からやり直す～'],
      ['V1', '時魔術士の強くてニューゲーム\u3000～過去に戻って世界最強からやり直す～'],
    ];
    expect(
      pickByVolume('時魔術士の強くてニューゲーム ～過去に戻って世界最強からやり直す～', c)?.[0],
    ).toBe('V1');
  });
  it('a year is part of the title, not a volume', () => {
    expect(titleKey('Ａｎｏｔｈｅｒ 2001（下） (角川文庫)')).not.toBe(titleKey('Another(下)'));
  });
  it('a query with its own number picks as before', () => {
    const c: [string, string][] = [
      ['X', '六畳間の侵略者！？17'],
      ['Y', '六畳間の侵略者！？1'],
    ];
    expect(pickByVolume('六畳間の侵略者!?17', c)?.[0]).toBe('X');
  });
});

describe('the volume number a title prints', () => {
  it.each([
    ['対魔導学園35試験小隊\u300013.暁の約束', '対魔導学園35試験小隊', 13],
    ['侍女なのに…聖剣を抜いてしまった！【５】', '侍女なのに...聖剣を抜いてしまった!', 5],
    ['In Another World With My Smartphone: Volume 19', 'In Another World With My Smartphone', 19],
    [
      '拝啓、天国の姉さん…保護者とかそろそろ無理です+ 第02巻',
      '拝啓、天国の姉さん…保護者とかそろそろ無理です+',
      2,
    ],
    ['明治開化 安吾捕物 その十二 愚妖', '明治開化 安吾捕物', 12],
    ['幻視界 第四界 宇宙の扉', '幻視界', 4],
    ['記憶屋ＩＩＩ (角川ホラー文庫)', '記憶屋', 3],
    ['“不思議”取り扱います 付喪堂骨董店3', '付喪堂骨董店', 3],
    [
      '転生したら才能があった件 ～異世界行っても努力する～ ： 7',
      '転生したら才能があった件 ~異世界行っても努力する~',
      7,
    ],
  ])('%s → %d', (title, name, n) => {
    expect(printedNumber(title, name)).toBe(n);
  });
  it.each([
    ['魔法少女育成計画16人の日常', '魔法少女育成計画'],
    [
      'クズレス・オブリージュ 18禁ゲー世界のクズ悪役に転生してしまった俺は',
      'クズレス・オブリージュ',
    ],
    ['ドラゴンマガジン\u3000２０２３年３月号', 'ドラゴンマガジン'],
    ['(仮)花嫁のやんごとなき事情～離婚できずに新婚旅行!?～', HANAYOME],
  ])('%s prints no volume', (title, name) => {
    expect(printedNumber(title, name)).toBeNull();
  });
  it('side books and omnibus editions', () => {
    expect(
      isSideTitle(
        '痛いのは嫌なので防御力に極振りしたいと思います。\u3000外伝１',
        '痛いのは嫌なので防御力に極振りしたいと思います。',
      ),
    ).toBe(true);
    expect(isSideTitle('はたらく魔王さま!SP2', 'はたらく魔王さま!')).toBe(true);
    expect(isSideTitle('Another(下)', 'Another')).toBe(false);
    expect(omnibusLast('侍女なのに…聖剣を抜いてしまった！【合本版 ４－７】')).toBe(7);
    expect(omnibusLast('【全３巻合本版】異世界だと思ったら崩壊した未来だった')).toBe(3);
  });
  it('the first date a colophon prints', () => {
    expect(
      firstColophonDate('2013年4月11日 電子版 制作\n（2013年2月27日発行 初刷）を元にして'),
    ).toBe(20130227);
    expect(firstColophonDate('なし')).toBeNull();
  });
});

let id = 0;
function book(p: Partial<SeriesBook> & { title: string }): SeriesBook {
  id++;
  return {
    uuid: `u${id}`,
    calibreId: id,
    name: HANAYOME,
    index: null,
    indexFrom: 'models',
    nameFrom: 'store',
    kind: 'full',
    own: [p.title],
    titleFrom: 'file',
    authors: ['夕鷺かのう'],
    records: [],
    storeSeries: [HANAYOME],
    pool: [],
    date: null,
    ...p,
  };
}

describe('the order of a series', () => {
  it('(仮)花嫁: volumes 3 and 8 from the store results with their subtitles, titles numbered', () => {
    const pool = [
      label('(仮)花嫁のやんごとなき事情3 ～離婚できずに新婚旅行～'),
      label('(仮)花嫁のやんごとなき事情8 ～離婚祭りは盛大に!?～'),
      label('(仮)花嫁のやんごとなき事情7.5 ～すべての道は離婚に通ず?～'),
    ].map((title) => ({ title, from: 'amazon' as const }));
    const books = [
      book({
        title: '(仮)花嫁のやんごとなき事情1 ～離婚できたら一攫千金！～',
        index: 1,
        indexFrom: 'store',
      }),
      book({
        title: '(仮)花嫁のやんごとなき事情～離婚できずに新婚旅行!?～',
        index: 2,
        indexFrom: 'guess',
        pool,
      }),
      book({ title: '(仮)花嫁のやんごとなき事情～すべての道は離婚に通ず？～', index: 7.5, pool }),
      book({ title: '(仮)花嫁のやんごとなき事情～離婚祭りは盛大に!?～', index: null, pool }),
      book({
        title: '(仮)花嫁のやんごとなき事情9～離婚のはずが大波乱!?～',
        index: 9,
        indexFrom: 'store',
      }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    expect(c.get(books[1].uuid)).toMatchObject({ index: 3, guess: false });
    expect(c.get(books[1].uuid)?.title).toBe(
      '(仮)花嫁のやんごとなき事情3 ～離婚できずに新婚旅行～',
    );
    expect(c.get(books[2].uuid)?.index).toBe(7.5);
    expect(c.get(books[3].uuid)).toMatchObject({ index: 8, guess: false });
    expect(c.get(books[0].uuid)?.index).toBe(1);
  });

  it('a series nothing numbers: by first publication date, as best guesses', () => {
    const name = '姫様お忍び事件帖';
    const books = [
      book({ name, title: '姫様お忍び事件帖 おまかせなされ', date: 20101201, storeSeries: [] }),
      book({ name, title: '姫様お忍び事件帖 それみたことか', date: 20100901, storeSeries: [] }),
      book({ name, title: '姫様お忍び事件帖 いいかげんにおし', date: 20110601, storeSeries: [] }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    expect(books.map((b) => c.get(b.uuid)?.index)).toEqual([2, 1, 3]);
    expect(c.get(books[0].uuid)?.guess).toBe(true);
    expect(c.get(books[0].uuid)?.reason).toMatch(/first publication/);
  });

  it('上 and 下 of one work are 1 and 2, whatever the dates', () => {
    const name = '相剋のスナイパー';
    const books = [
      book({ name, title: '相剋のスナイパー 下 (竹書房文庫)', date: 20200101 }),
      book({ name, title: '相剋のスナイパー 上 (竹書房文庫)', date: 20200201 }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    expect(c.get(books[0].uuid)?.index).toBe(2);
    expect(c.get(books[1].uuid)?.index).toBe(1);
  });

  it('a series with volumes in parts counts every book in reading order (the user, 2026-11-22)', () => {
    const name = 'GENESISシリーズ 境界線上のホライゾン';
    const t = (s: string) => `GENESISシリーズ 境界線上のホライゾン${s}`;
    const books = [
      book({ name, title: t('I＜下＞'), index: 1, indexFrom: 'models' }),
      book({ name, title: t('I＜上＞'), index: 1, indexFrom: 'store' }),
      book({ name, title: t('II＜上＞'), index: 2, indexFrom: 'models' }),
      book({ name, title: t('II＜下＞'), index: 2, indexFrom: 'models' }),
      book({ name, title: t('III＜下＞'), index: 3, indexFrom: 'models' }),
      book({ name, title: t('III＜中＞'), index: 3, indexFrom: 'models' }),
      book({ name, title: t('III＜上＞'), index: 3, indexFrom: 'models' }),
      book({ name, title: t('IV'), index: 4, indexFrom: 'models' }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x.index]));
    expect(books.map((b) => c.get(b.uuid))).toEqual([2, 1, 3, 4, 7, 6, 5, 8]);
  });

  it('a missing part keeps its place; another edition beside volume 1 is not a split volume', () => {
    const name = 'ゲート';
    const g = (s: string, i: number) =>
      book({ name, title: `ゲート〈${s}`, index: i, indexFrom: 'models' });
    const books = [
      g('1〉接触編〈上〉', 1),
      g('1〉接触編〈下〉', 1),
      g('3〉動乱編〈下〉', 3),
      g('4〉総撃編〈上〉', 4),
    ];
    // A store result shows volume 3's other part.
    books[2].pool = [{ title: 'ゲート〈3〉動乱編〈上〉', from: 'amazon' }];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x.index]));
    // 1上 1, 1下 2, (2) 3, 3上 4 (not in the library), 3下 5, 4上 6.
    expect(books.map((b) => c.get(b.uuid))).toEqual([1, 2, 5, 6]);
    const slime = '転生したらスライムだった件';
    const s = [
      book({ name: slime, title: `${slime} 1`, index: 1, indexFrom: 'store' }),
      book({
        name: slime,
        title: `${slime} 1 最強のスライム誕生！？（上）`,
        index: 1,
        indexFrom: 'models',
      }),
      book({
        name: slime,
        title: `${slime} 1 最強のスライム誕生！？（下）`,
        index: 1,
        indexFrom: 'models',
      }),
      book({ name: slime, title: `${slime} 2`, index: 2, indexFrom: 'store' }),
    ];
    const cs = new Map(orderSeries(s).map((x) => [x.uuid, x]));
    expect(cs.get(s[3].uuid)?.index).toBe(2);
  });

  it('one work in parts: 1, 2, 3 for the whole series; its place kept as a book of a series', () => {
    const t = '徳川幕閣盛衰記';
    const whole = [
      book({ name: t, title: `${t}（上）―野望の下馬将軍`, index: 1, indexFrom: 'guess' }),
      book({ name: t, title: `${t}（中）―吉宗の陰謀`, index: 2, indexFrom: 'guess' }),
      book({ name: t, title: `${t}（下）―黒船擾乱`, index: 2, indexFrom: 'guess' }),
    ];
    const c = new Map(orderSeries(whole).map((x) => [x.uuid, x.index]));
    expect(whole.map((b) => c.get(b.uuid))).toEqual([1, 2, 3]);
    const s = '女子高生探偵シャーロット・ホームズ';
    const part = [
      book({ name: s, title: `${s}の帰還 〈消えた八月〉事件 上`, index: 2, indexFrom: 'guess' }),
      book({ name: s, title: `${s}の帰還 〈消えた八月〉事件 下`, index: 2, indexFrom: 'guess' }),
    ];
    const cp = new Map(orderSeries(part).map((x) => [x.uuid, x.index]));
    expect(part.map((b) => cp.get(b.uuid))).toEqual([2, 3]);
  });

  it('a side book goes to N.5 after the volume before it, never on a main number', () => {
    const name = '痛いのは嫌なので防御力に極振りしたいと思います。';
    const books = [
      book({ name, title: `${name} 2`, index: 2, indexFrom: 'store', date: 20180101 }),
      book({ name, title: `${name} 3`, index: 3, indexFrom: 'store', date: 20190101 }),
      book({ name, title: `${name}\u3000外伝１`, index: 1, date: 20180601 }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    expect(c.get(books[2].uuid)?.index).toBe(2.5);
  });

  it("a guess on another book's number moves to a free one by date, marked", () => {
    const name = '左遷先は女性都市!';
    const books = [
      book({ name, title: '左遷先は女性都市! 1', index: 1, indexFrom: 'store', date: 20210601 }),
      book({ name, title: '左遷先は女性都市! 2', index: 2, indexFrom: 'store', date: 20220301 }),
      book({ name, title: '左遷先は女性都市!TB', index: 2, indexFrom: 'guess', date: 20231201 }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    expect(c.get(books[2].uuid)).toMatchObject({ index: 3, guess: true });
    expect(c.get(books[2].uuid)?.reason).toMatch(/belongs to another book/);
  });

  it('two books that both print one number go to review, unchanged', () => {
    const name = 'ノーゲーム・ノーライフ';
    const books = [
      book({
        name,
        title: `${name} 10 ゲーマー兄妹は過去を払わされるようです`,
        index: 10,
        indexFrom: 'store',
      }),
      book({
        name,
        title: `${name} 10 別の巻`,
        index: 10,
        indexFrom: 'store',
        own: [`${name}10 別の巻`],
      }),
    ];
    const r = orderSeries(books);
    expect(r.every((x) => x.index === 10)).toBe(true);
    expect(r.some((x) => x.review)).toBe(true);
  });

  it('a store bonus is its volume + 0.1; an omnibus its last volume + 0.9', () => {
    const name = 'りゅうおうのおしごと! 盤外編';
    const books = [
      book({ name, title: 'りゅうおうのおしごと！ 盤外編1', index: 1, indexFrom: 'store' }),
      book({
        name,
        kind: 'bonus',
        title: '『りゅうおうのおしごと！\u3000盤外編１』書き下ろしショートストーリー',
        index: 1,
        indexFrom: 'guess',
      }),
      book({
        name,
        kind: 'omnibus',
        title: 'りゅうおうのおしごと！ 盤外編【合本版 1－3】',
        index: null,
      }),
    ];
    const c = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    expect(c.get(books[1].uuid)?.index).toBe(1.1);
    expect(c.get(books[2].uuid)?.index).toBe(3.9);
  });

  it("a book's title taken as the series name goes to review", () => {
    const name = '講談名作文庫25 国定忠治';
    const books = [
      book({
        name,
        title: '講談名作文庫10 一休和尚漫遊記',
        index: 10,
        nameFrom: 'guess',
        storeSeries: [],
      }),
      book({
        name,
        title: '講談名作文庫25 国定忠治',
        index: 25,
        nameFrom: 'guess',
        storeSeries: [],
      }),
    ];
    expect(
      orderSeries(books).every((x) => x.review === "The series name is one book's title"),
    ).toBe(true);
  });

  it('a one-book series is never renumbered by date; Calibre and user values stay', () => {
    const name = '半沢直樹シリーズ';
    const one = [
      book({ name, title: '銀翼のイカロス', index: 4, indexFrom: 'models', date: 20130501 }),
    ];
    expect(orderSeries(one)[0].index).toBe(4);
    const user = [
      book({ name: 'X', title: 'X 1', index: 1, indexFrom: 'user' }),
      book({ name: 'X', title: 'X 2', index: 2, indexFrom: 'calibre' }),
    ];
    expect(orderSeries(user)).toEqual([]);
  });

  it('the checks count shared numbers and missing ones, and whether they are marked', () => {
    const name = 'Z';
    const books = [
      book({ name, title: 'Z 1', index: 1, indexFrom: 'calibre' }),
      book({ name, title: 'Z 別', index: 1, indexFrom: 'calibre', own: ['Z 別'] }),
      book({ name, title: 'Z 3', index: null, indexFrom: 'calibre' }),
    ];
    const total = emptyChecks();
    addSeriesChecks(total, books, []);
    expect(total).toMatchObject({
      collisions: 1,
      collisionsUnmarked: 1,
      missing: 1,
      missingUnmarked: 1,
    });
  });
});

describe("Calibre's title and authors as stage 4 found them (stop 2)", () => {
  const w = (field: string, old: unknown, now: unknown) => ({
    field,
    old_json: JSON.stringify(old),
    new_json: JSON.stringify(now),
  });
  it('a value stage 4 wrote and Calibre still holds reads as the value before the write', () => {
    expect(
      calibreAsFound({ title: '事情3', authors: ['A', 'B'] }, [
        w('title', '事情', '事情3'),
        w('authors', ['A'], ['A', 'B']),
      ]),
    ).toEqual({ title: '事情', authors: ['A'] });
  });
  it("a value changed in Calibre since the write is Calibre's own", () => {
    expect(
      calibreAsFound({ title: 'Your title', authors: ['C'] }, [
        w('title', '事情', '事情3'),
        w('authors', ['A'], ['A', 'B']),
      ]),
    ).toEqual({ title: 'Your title', authors: ['C'] });
  });
  it('written twice: the value before the first write', () => {
    expect(
      calibreAsFound({ title: 'v3', authors: [] }, [
        w('title', 'v1', 'v2'),
        w('title', 'v2', 'v3'),
      ]),
    ).toEqual({ title: 'v1', authors: [] });
  });
  it("Calibre's spelling of an existing author (case only) is still as written", () => {
    expect(
      calibreAsFound({ title: 't', authors: ['株式会社NewSpiral'] }, [
        w('authors', ['Unknown'], ['株式会社newspiral']),
      ]),
    ).toEqual({ title: 't', authors: ['Unknown'] });
  });
  it('no write: Calibre as it is', () => {
    expect(calibreAsFound({ title: 't', authors: ['A'] }, [])).toEqual({
      title: 't',
      authors: ['A'],
    });
  });
});

describe('the changed-series measurement fixes (stop 2)', () => {
  const lists = (amazon: number | null, ranobedb: number | null = null) => ({
    amazon,
    amazonTotal: amazon === null ? null : 12,
    ranobedb,
    ranobedbType: ranobedb === null ? null : 'main',
    amazonList: amazon === null ? null : '12|S',
    ranobedbList: ranobedb === null ? null : 'R',
  });
  it('a sub-series word with its own number', () => {
    expect(
      subSeriesNumber('乱れる愛 闇の花３ ～祠☆闘士シリーズ～ (夢中文庫)', '祠☆闘士シリーズ'),
    ).toEqual({ g: '闇の花', n: 3 });
    expect(subSeriesNumber('安里咲２', '亜由美シリーズ')).toEqual({ g: '安里咲', n: 2 });
    expect(subSeriesNumber('砂漠幻想 イブン・サーディ＆景生', 'プリンスシリーズ')).toBeNull();
  });
  it('Amazon and RanobeDB list places, only for the entry that is the book', () => {
    const rdb = {
      book: { id: 7 },
      series: {
        id: 'R',
        books: [
          { id: 7, sort_order: 5, type: 'main', title_orig: '神様とゲーム ハレ/クモリ/アメ/ニジ' },
        ],
      },
    };
    expect(
      storeListPlaces('全12冊中6番目の本 祠☆闘士シリーズ', rdb as never, [
        '神様とゲーム　ハレ／クモリ／アメ／ニジ',
      ]),
    ).toMatchObject({ amazon: 6, amazonTotal: 12, ranobedb: 5 });
    expect(storeListPlaces('', rdb as never, ['るるいえあかでみっく']).ranobedb).toBeNull();
  });
  it('a level is the volume, a number glued to a letter is not', () => {
    expect(
      printedNumber(
        'ネトゲの嫁は女の子じゃないと思った? Lv.24 DLC(1)',
        'ネトゲの嫁は女の子じゃないと思った?',
      ),
    ).toBe(24);
    expect(
      printedNumber(
        'Learning to Read Japanese: Level N4: Japanese Ghost Stories ろくろ首',
        'Learning to Read Japanese',
      ),
    ).toBeNull();
  });
  it('nothing confirmed: guesses follow the store list, a sub-series in its printed order', () => {
    const S = '祠☆闘士シリーズ';
    const t = (w: string, n: string) => `${w}${n} ～${S}～`;
    const bs = [
      book({ name: S, title: t('闇の花', '1'), index: 1, lists: lists(1) }),
      book({ name: S, title: t('闇の花', '2'), index: 2, lists: lists(2) }),
      book({ name: S, title: t('紅孔雀', '1'), index: 3, lists: lists(6) }),
      book({ name: S, title: t('雅狼', '2'), index: 4, lists: lists(null) }),
      book({ name: S, title: t('雅狼', '1'), index: 5, lists: lists(3) }),
    ];
    const got = new Map(orderSeries(bs).map((c) => [c.uuid, c.index]));
    expect(bs.map((b) => got.get(b.uuid))).toEqual([1, 2, 5, 4, 3]);
  });
  it('a guessed book against the list of confirmed volumes moves between them', () => {
    const N = '神様ゲーム';
    const v = (n: number, l: number) =>
      book({
        name: N,
        title: `神様ゲーム${n}`,
        index: n,
        indexFrom: 'store',
        lists: lists(null, l),
      });
    const side = book({ name: N, title: '神様とゲーム ハレ', index: 6, lists: lists(null, 5) });
    const bs = [v(1, 1), v(2, 2), v(3, 3), v(4, 4), v(5, 6), side];
    const c = orderSeries(bs).find((x) => x.uuid === side.uuid)!;
    expect(c.index).toBe(4.5);
    expect(c.guess).toBe(true);
  });
  it('a series name Calibre holds already is listed, not held for review', () => {
    const N = '自薦短編シリーズ';
    const bs = [1, 2].map((i) =>
      book({
        name: N,
        title: `短編${i === 1 ? 'あ' : 'い'}`,
        index: null,
        nameFrom: 'models',
        storeSeries: [],
        calibreName: N,
        date: 20200101 + i,
      }),
    );
    const cs = orderSeries(bs);
    expect(cs.every((c) => !c.review && c.guess)).toBe(true);
    expect(new Set(cs.map((c) => c.index)).size).toBe(2);
  });
});

describe('arcs that number again, counted straight through (the user, 2026-11-22)', () => {
  it('reads the arc and its volume', () => {
    const Y = 'ようこそ実力至上主義の教室へ';
    expect(arcOf(`${Y} ２年生編４．５ (MF文庫J)`, Y)).toEqual({ arc: '2年生編', n: 4.5 });
    expect(arcOf(`${Y} 10 (MF文庫J)`, Y)).toEqual({ arc: '', n: 10 });
    expect(
      arcOf('トリニティ・ブラッド Reborn on the Mars ＶＩ 茨の宝冠', 'トリニティ・ブラッド'),
    ).toEqual({ arc: 'rebornonthemars', n: 6 });
    expect(arcOf('liar ～season2～ 1', 'liar')).toEqual({ arc: 'season2', n: 1 });
    expect(arcOf('作品 新装版 3', '作品')).toEqual({ arc: '', n: 3 });
  });
  it('a later arc follows the one before; copies and side runs are no arc', () => {
    const N = 'デュラララ!!';
    const v = (t: string, i: number) =>
      book({ name: N, title: `${N}${t}`, index: i, indexFrom: 'store' });
    const main = [v('', 1), v('×2', 2), v('×3', 3)];
    const sh = [v('SH', 1), v('SH×2', 2), v('SH×3', 3)];
    const got = new Map(orderSeries([...main, ...sh]).map((c) => [c.uuid, c]));
    expect(sh.map((b) => got.get(b.uuid)?.index)).toEqual([4, 5, 6]);
    // Nothing makes the arcs' order sure (no list, an arc name without a number): a best guess.
    expect(got.get(sh[1].uuid)?.guess).toBe(true);
    // A second edition with the volumes' own subtitles is copies, not an arc.
    const M = '中の下!';
    const e = (t: string, i: number) =>
      book({ name: M, title: `${M}${t}`, index: i, indexFrom: 'store' });
    const ed = [
      e('1 ランク1.中の下と言われて', 1),
      e('2 ランク2.中の中を目指して', 2),
      e(' ランク1.中の下と言われて', 1),
      e(' ランク2.中の中を目指して', 2),
    ];
    const r = new Map(orderSeries(ed).map((c) => [c.uuid, c.index]));
    expect(ed.map((b) => r.get(b.uuid) ?? b.index)).toEqual([1, 2, 1, 2]);
  });
  // The user, 2026-11-22: "write when order is sure".
  it("the order is sure from the arcs' own numbers: written, not a guess", () => {
    const Y = 'ようこそ実力至上主義の教室へ';
    const v = (t: string, i: number, date: number) =>
      book({ name: Y, title: `${Y} ${t}`, index: i, indexFrom: 'store', date });
    const one = [v('1', 1, 20150101), v('2', 2, 20150601), v('3', 3, 20160101)];
    const two = [v('２年生編１', 1, 20200101), v('２年生編２', 2, 20200601)];
    const got = new Map(orderSeries([...one, ...two]).map((c) => [c.uuid, c]));
    expect(two.map((b) => got.get(b.uuid)?.index)).toEqual([4, 5]);
    expect(two.every((b) => got.get(b.uuid)?.guess === false)).toBe(true);
    // A main volume outside the arcs (no arc, no number of its own): the order isn't sure.
    const other = book({ name: Y, title: `${Y} 教育編`, index: 4, indexFrom: 'store' });
    const g2 = new Map(orderSeries([...one, ...two, other]).map((c) => [c.uuid, c]));
    expect(two.every((b) => g2.get(b.uuid)?.guess !== false)).toBe(true);
    // One with no number takes none from them: still sure.
    const art = book({ name: Y, title: `${Y} 終・1年生編BOX Art Works`, index: null });
    const g3 = new Map(orderSeries([...one, ...two, art]).map((c) => [c.uuid, c]));
    expect(two.map((b) => g3.get(b.uuid)?.index)).toEqual([4, 5]);
    expect(two.every((b) => g3.get(b.uuid)?.guess === false)).toBe(true);
  });
  it('the order is sure from the series list holding every book: written', () => {
    const N = 'デュラララ!!';
    const v = (t: string, i: number, place: number) =>
      book({
        name: N,
        title: `${N}${t}`,
        index: i,
        indexFrom: 'store',
        lists: {
          amazon: null,
          amazonTotal: null,
          ranobedb: place,
          ranobedbType: 'main',
          amazonList: null,
          ranobedbList: 'R1',
        },
      });
    const main = [v('', 1, 1), v('×2', 2, 2), v('×3', 3, 3)];
    const sh = [v('SH', 1, 4), v('SH×2', 2, 5), v('SH×3', 3, 6)];
    const got = new Map(orderSeries([...main, ...sh]).map((c) => [c.uuid, c]));
    expect(sh.map((b) => got.get(b.uuid)?.index)).toEqual([4, 5, 6]);
    expect(sh.every((b) => got.get(b.uuid)?.guess === false)).toBe(true);
  });
  it('the order from first-publication dates only: a best guess', () => {
    const N = '作品';
    const v = (t: string, i: number, date: number) =>
      book({ name: N, title: `${N}${t}`, index: i, indexFrom: 'store', date });
    const a = [v('1', 1, 20100101), v('2', 2, 20110101)];
    const b = [v('新章1', 1, 20120101), v('新章2', 2, 20130101)];
    const got = new Map(orderSeries([...a, ...b]).map((c) => [c.uuid, c]));
    expect(b.map((x) => got.get(x.uuid)?.index)).toEqual([3, 4]);
    expect(b.every((x) => got.get(x.uuid)?.guess === true)).toBe(true);
  });
});

describe('the second changed-series batch (build half)', () => {
  const rdb = (n: number, list: string) => ({
    amazon: null,
    amazonTotal: null,
    ranobedb: n,
    ranobedbType: 'main',
    amazonList: null,
    ranobedbList: list,
  });
  const amz = (n: number, list: string) => ({
    amazon: n,
    amazonTotal: 10,
    ranobedb: null,
    ranobedbType: null,
    amazonList: list,
    ranobedbList: null,
  });
  it('reads numbers inside the name, after a name with 【…】, after disc/Step, Roman to XXXIX', () => {
    const H = 'ハズレ枠の【状態異常スキル】で最強になった俺がすべてを蹂躙するまで';
    expect(printedNumber(`${H} 11.5`, H)).toBe(11.5);
    expect(printedNumber(`${H} 12`, H)).toBe(12);
    const O = 'Only Sense Online ―オンリーセンス・オンライン―';
    expect(printedNumber('Only Sense Online 22\u3000―オンリーセンス・オンライン―', O)).toBe(22);
    expect(printedNumber('GENEZ―8\u3000ジーンズ', 'GENEZ ジーンズ')).toBe(8);
    const K = 'キノの旅 the Beautiful World';
    expect(printedNumber('キノの旅V the Beautiful World', K)).toBe(5);
    expect(printedNumber('キノの旅XXIII\u3000the Beautiful World', K)).toBe(23);
    expect(
      printedNumber('ギャルゲヱの世界よ、ようこそ！ disc6', 'ギャルゲヱの世界よ、ようこそ!'),
    ).toBe(6);
    expect(printedNumber('陰キャになりたい陽乃森さん Step2', '陰キャになりたい陽乃森さん')).toBe(2);
    // Not an arc's season.
    expect(printedNumber('liar ～season3～ 1', 'liar')).toBe(1);
    // 別巻 and SSP are side books.
    expect(isSideTitle('吸血鬼ハンター別巻', '吸血鬼ハンター')).toBe(true);
    expect(
      isSideTitle('住めば都のコスモス荘SSP お久しぶりにドッコイ', '住めば都のコスモス荘'),
    ).toBe(true);
  });

  it("an omnibus range only from the book's own titles, not the colophon's other books", () => {
    const N = 'ASEAN連合艦隊';
    const bs = [
      book({
        name: N,
        title: 'ASEAN連合艦隊 南シナ海傭兵艦出撃！',
        own: ['ＡＳＥＡＮ連合艦隊 南シナ海傭兵艦出撃！ (歴史群像新書)', '新東亜大戦 全4巻'],
        index: 1,
        indexFrom: 'store',
      }),
      book({ name: N, title: 'ASEAN連合艦隊2', index: 2, indexFrom: 'store' }),
    ];
    expect(orderSeries(bs).find((c) => c.uuid === bs[0].uuid)?.index ?? 1).toBe(1);
  });

  it('copies share a number: a guessed copy, two side copies, a publisher code', () => {
    const N = '「ベルーフ」シリーズ';
    const bs = [
      book({ name: N, title: 'さよなら妖精', index: 1, indexFrom: 'store' }),
      book({ name: N, title: '王とサーカス', index: 2, indexFrom: 'store' }),
      book({ name: N, title: '真実の１０メートル手前', index: 3, indexFrom: 'store' }),
      book({ name: N, title: '王とサーカス', index: 4, indexFrom: 'guess' }),
    ];
    const got = new Map(orderSeries(bs).map((c) => [c.uuid, c.index]));
    expect(got.get(bs[3].uuid)).toBe(2);
    const D = 'デート・ア・ライブ';
    const ds = [
      book({ name: D, title: `${D}1`, index: 1, indexFrom: 'store' }),
      book({ name: D, title: `${D}2`, index: 2, indexFrom: 'store' }),
      book({
        name: D,
        title: `${D}\u3000アンコール4〈電子特別版〉 (富士見ファンタジア文庫)`,
        index: 2.6,
        kind: 'special edition',
      }),
      book({
        name: D,
        title: `${D}\u3000アンコール4〈電子特別版〉`,
        index: 2.7,
        kind: 'special edition',
      }),
    ];
    const dg = new Map(orderSeries(ds).map((c) => [c.uuid, c.index]));
    expect(dg.get(ds[2].uuid) ?? 2.6).toBe(dg.get(ds[3].uuid) ?? 2.7);
    const a = book({ title: 'er-理系男子の童貞を奪ったらたいへんなことになりました' });
    const c = book({ title: '理系男子の童貞を奪ったらたいへんなことになりました' });
    expect(copyBooks(a, c)).toBe(true);
    // A title that is only the series name proves nothing; a 【subtitle】 is a book of its own.
    const M = '続・魔法科高校の劣等生 メイジアン・カンパニー';
    expect(copyBooks(book({ title: `${M}3`, own: [M] }), book({ title: `${M}4`, own: [M] }))).toBe(
      false,
    );
    expect(
      copyBooks(
        book({ title: '日本編【法隆寺・完全版】' }),
        book({ title: '日本編【紀伊山地の霊場と参詣道・完全版】' }),
      ),
    ).toBe(false);
    expect(
      copyBooks(book({ title: '話の題。' }), book({ title: '話の題。【水泳部顧問編】' })),
    ).toBe(false);
    expect(
      copyBooks(book({ title: '作品の題3【電子特別版】' }), book({ title: '作品の題3' })),
    ).toBe(true);
  });

  it('a printed number on a store-numbered book yields to a list that agrees elsewhere', () => {
    const N = '王妃のプライド';
    const L = '10|王妃のプライド';
    const bs = [1, 2, 3, 4, 5, 6].map((i) =>
      book({ name: N, title: `${N}【${i}】`, index: i, indexFrom: 'store', lists: amz(i, L) }),
    );
    const late = [7, 8, 9, 10].map((i) =>
      book({ name: N, title: `${N}2【${i}】`, index: 2, indexFrom: 'models', lists: amz(i, L) }),
    );
    const got = new Map(orderSeries([...bs, ...late]).map((c) => [c.uuid, c.index]));
    expect(late.map((b) => got.get(b.uuid))).toEqual([7, 8, 9, 10]);
    // A store's number on another book, the list in agreement with the printed one: a person's call.
    const G = 'ノーゲーム・ノーライフ';
    const gl = '14|ノーゲーム・ノーライフ';
    const gs = [8, 9].map((i) =>
      book({
        name: G,
        title: `${G} ${i}\u3000副題${i}`,
        index: i,
        indexFrom: 'store',
        lists: amz(i, gl),
      }),
    );
    const side = book({
      name: G,
      title: `${G}\u3000プラクティカルウォーゲーム`,
      index: 10,
      indexFrom: 'store',
      lists: amz(10, gl),
    });
    const ten = book({
      name: G,
      title: `${G} 10\u3000副題10`,
      index: 10,
      indexFrom: 'models',
      lists: amz(11, gl),
    });
    const cs = new Map(orderSeries([...gs, side, ten]).map((c) => [c.uuid, c]));
    expect(cs.get(ten.uuid)?.index ?? 10).toBe(10);
    expect(cs.get(ten.uuid)?.review).toBeTruthy();
  });

  it("one RanobeDB subtitle at two places tells neither; the book's own entry places it", () => {
    const N = 'クロム・クローズド・クロニクル';
    const t = (i: number) => `Chrome Closed Chronicle${i === 1 ? '' : ` ${i}`}\u3000─${N}─`;
    const pool = [1, 2, 3].map((i) => ({ title: t(i), from: 'ranobedb' as const, order: i }));
    const bs = [1, 2, 3].map((i) =>
      book({ name: N, title: t(i), index: 1, indexFrom: 'models', lists: rdb(i, N), pool }),
    );
    const got = new Map(orderSeries(bs).map((c) => [c.uuid, c.index]));
    expect(bs.map((b) => got.get(b.uuid) ?? b.index)).toEqual([1, 2, 3]);
  });

  it("a side book counted in RanobeDB's list (only volume 1 on it)", () => {
    const N = 'とある魔術の禁書目録';
    const mains = Array.from({ length: 16 }, (_, i) =>
      book({
        name: N,
        title: `${N}${i + 1}`,
        index: i + 1,
        indexFrom: i ? 'models' : 'store',
        lists: i ? undefined : rdb(1, N),
      }),
    );
    const ss = book({ name: N, title: `${N}SS`, index: 16.6, lists: rdb(14, N) });
    const ss2 = book({ name: N, title: `${N}SS2`, index: 16.5, lists: rdb(18, N) });
    const got = new Map(orderSeries([...mains, ss, ss2]).map((c) => [c.uuid, c]));
    expect(got.get(ss.uuid)?.index).toBe(13.5);
    expect(got.get(ss2.uuid)?.index).toBe(16.5);
    expect(got.get(ss.uuid)?.guess).toBe(true);
  });
});

describe('the live run of 2026-11-22', () => {
  it('sub-series each numbered from 1 by the models follow the list as 1, 2, 3…', () => {
    // 惑星ハシエラシリーズ's 32 books as the live run decided them (trimmed): six sub-series, each
    // numbered from 1, Amazon's list 1-32 (薄明の来訪者4 has no place of its own).
    const bs = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'series-order-hashiera.json'), 'utf8'),
    ) as SeriesBook[];
    const got = new Map(orderSeries(bs).map((c) => [c.uuid, c.index]));
    const inList = [...bs].sort((a, c) => (a.lists?.amazon ?? 7.5) - (c.lists?.amazon ?? 7.5));
    expect(inList.map((b) => got.get(b.uuid) ?? b.index)).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 1),
    );
  });
});

describe('the held series reviews measured (2026-11-25, rules 11)', () => {
  // Real facts of these series from a copy of the live cleanup.db (pools cut to RanobeDB's list).
  const fx = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'series-held-reviews.json'), 'utf8'),
  ) as Record<string, SeriesBook[]>;
  const choose = (series: string) => {
    const books = fx[series];
    const c = new Map(orderSeries(books).map((x) => [x.calibreId ?? 0, x]));
    const byId = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    return (id: number) => {
      const b = books.find((x) => x.calibreId === id)!;
      return byId.get(b.uuid)?.index ?? (c.size ? b.index : b.index);
    };
  };
  it('「Ep.14」 and 「level.15」 are the volume numbers, not RanobeDB places that count side books', () => {
    expect(
      printedNumber(
        '86―エイティシックス―Ep.14 ―ペイント・イット・ブラック―',
        '86―エイティシックス―',
      ),
    ).toBe(14);
    expect(
      printedNumber('灰と幻想のグリムガル level.15 強くて儚きニューゲーム', '灰と幻想のグリムガル'),
    ).toBe(15);
    const g = choose('灰と幻想のグリムガル');
    expect(g(66668)).toBe(15); // level.15 (was 17)
    expect(g(66670)).toBe(14.5); // level.14+ stays
    expect(g(66671)).toBe(14.6); // level.14++ after it
    expect(choose('86―エイティシックス―')(32975)).toBe(14); // Ep.14 (was 16)
  });
  it('「14+」 prints no number of its own and 「Vol.1+2」 is an omnibus', () => {
    expect(
      printedNumber(
        '灰と幻想のグリムガル level.14＋ 相変わらずではいられない',
        '灰と幻想のグリムガル',
      ),
    ).toBeNull();
    expect(omnibusLast('恋愛処方箋 vol.1+2')).toBe(2);
    expect(omnibusLast('恋愛処方箋Vol.5+6+7')).toBe(7);
    expect(omnibusLast('超クソゲー１＋２')).toBe(2);
    const r = choose('恋愛処方箋');
    expect(r(27222)).toBe(2.9);
    expect(r(27211)).toBe(7.9);
  });
  it('a book its part mark or list place backs is not moved by date beside another edition', () => {
    expect(choose('罪と罰')(64979)).toBe(1); // 罪と罰（上） beside 罪と罰 1 (was 4)
    expect(choose('西遊記')(58968)).toBe(1); // 西遊記（上） (was 0.6)
    expect(choose('悪霊')(63991)).toBe(1); // 悪霊（上） (was 0.5)
    expect(choose('鳴門秘帖')(46248)).toBe(2); // 鳴門秘帖（下） of the 上下 edition (was 8)
  });
  it('a list place backs a number only where the list places are the series numbers', () => {
    // RanobeDB lists ∞ 7th and volume 7 8th: ∞ is not backed at 7 and goes between 6 and 7.
    expect(choose('世界の危機はめくるめく!')(21583)).not.toBe(7);
  });
  it('a side book nothing places keeps the number it has', () => {
    expect(choose('demi')(46093)).toBe(3); // was 0.5
    expect(choose('アルカリレットウセイ')(21291)).toBe(1); // was 0.5
    expect(choose('冴えない彼女の育てかた')(9134)).toBe(6.5); // FD (was 13.6)
  });
});

describe('another edition in parts is not the series split (rehearsal of rules 11)', () => {
  const fx = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'series-held-reviews.json'), 'utf8'),
  ) as Record<string, SeriesBook[]>;
  it('転スラ 1 （上）（中）（下） of the children’s edition does not renumber the 25-book series', () => {
    const books = fx['転生したらスライムだった件'];
    const byUuid = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    const n = (id: number) => {
      const b = books.find((x) => x.calibreId === id)!;
      const c = byUuid.get(b.uuid);
      return c ? c.index : b.index;
    };
    expect(n(3317)).toBe(2); // 転スラ 2 (was 4)
    expect(n(3309)).toBe(11); // 転スラ 11 (was 31)
    expect(n(13660)).toBe(22); // 転スラ 22 (was 51)
    expect(n(9600)).toBe(8.5); // 8.5 公式設定資料集 (was 22.5)
  });
});

describe("RanobeDB's places and side books counted among its volumes (rules 11, the census of 214)", () => {
  const fx = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'series-held-reviews.json'), 'utf8'),
  ) as Record<string, SeriesBook[]>;
  const choose = (series: string) => {
    const books = fx[series];
    const byUuid = new Map(orderSeries(books).map((x) => [x.uuid, x]));
    return (id: number) => {
      const b = books.find((x) => x.calibreId === id)!;
      const c = byUuid.get(b.uuid);
      return { index: c ? c.index : b.index, from: c?.from ?? null, review: !!c?.review };
    };
  };
  it('a place beside two volumes of the same list on theirs is sure', () => {
    const c = choose('〈小市民〉シリーズ');
    expect(c(11361)).toMatchObject({ index: 4, from: RDB_PLACE_SURE }); // 秋期限定 下 (was 3)
    expect(c(11362).index).toBe(3); // 秋期限定 上
    expect(c(10782).index).toBe(6); // 冬期限定
    // Volumes the models numbered on their list places count: 化物語（中） 1 → 2.
    const m = choose('〈物語〉シリーズ');
    expect(m(6342)).toMatchObject({ index: 2, from: RDB_PLACE_SURE });
    expect(m(6345).index).toBe(1); // 化物語（上）
    expect(m(6344).index).toBe(3); // 化物語（下）
  });
  it('a list of the book alone, or one volume on its place, is not sure', () => {
    // ダイブ!: RanobeDB lists only the book itself at 1; the store list has it 2nd.
    const c = choose('ダイブ');
    expect(c(62153).from).not.toBe(RDB_PLACE_SURE);
  });
  it('a side book after the count of the main volumes before it on the list', () => {
    const t = choose('とらドラ!');
    expect(t(4985)).toMatchObject({ index: 9.5 }); // スピンオフ2 (2009-01, after 9; was 2)
    expect(t(4985).from).toContain(SIDE_COUNTED);
    expect(t(53276).index).toBe(10.5); // スピンオフ3 (2010-04, after 10; was 3)
    expect(t(4986).index).toBe(4.5); // スピンオフ！ stays
    expect(t(4998).index).toBe(5); // とらドラ5！ stays on its printed number
    expect(choose('覇剣の皇姫アルティーナ')(21282).index).toBe(7.5); // 小綺譚 stays (was 6.5)
    const b = choose('青春ブタ野郎');
    expect(b(70080).index).toBe(15.6); // ドクターピッグ＋ (was 13.6)
    expect(b(70353).index).toBe(15.5); // ビーチクイーン＋ stays (was 13.5)
  });
  it('a book whose own title numbers it is no side book', () => {
    expect(choose('ハード・デイズ・ナイツ')(27413).index).toBe(6); // ハード・デイズ・ナイツ6 アンコール… (was 7.5)
    expect(choose('キネマ探偵カレイドミステリー')(49609).index).toBe(2); // ～再演奇縁のアンコール～ (was 1.5)
  });
});
