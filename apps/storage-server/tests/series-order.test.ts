/**
 * Series-order follow-up (plan approved 2026-11-22): the fixed picker (pick.ts), the volume
 * numbers a title prints, and the order of each series (series-order.ts), from cases found on
 * the live library.
 */
import { describe, expect, it } from 'vitest';
import { pickByVolume, titleKey } from '../src/cleanup/stage4/pick';
import {
  addSeriesChecks,
  emptyChecks,
  isSideTitle,
  omnibusLast,
  orderSeries,
  printedNumber,
  type SeriesBook,
} from '../src/cleanup/stage4/series-order';
import { firstColophonDate } from '../src/cleanup/stage4/analysis';

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
      book({ name, title: `${name} 10`, index: 10, indexFrom: 'store', own: [`${name}10 別の巻`] }),
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
