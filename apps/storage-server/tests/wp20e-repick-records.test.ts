/**
 * The fixed picker's second pass (REPICK_VERSION 2) and the record judge, from the live run of
 * 2026-11-22: the first pass replaced records that were the book (BookWalker's series list stored
 * cut at 40, Amazon's bare-titled result of another format), and stop 3 was held.
 */
import { describe, expect, it } from 'vitest';
import { pickByVolume, titleKey, titleMatch } from '../src/cleanup/stage4/pick';
import { recordFit, replaces, type BookFacts } from '../src/cleanup/stage4/record-judge';
import { onlySpacing } from '../src/cleanup/stage4/proposals';

const c = (titles: string[]) => titles.map((t, i) => [`k${i}`, t] as [string, string]);
const pick = (
  q: string,
  titles: string[],
  volumes: boolean | ((x: [string, string]) => boolean) = true,
) => pickByVolume(q, c(titles), true, volumes)?.[1] ?? null;

describe('the picker never takes another volume or a guide book for a numbered title', () => {
  it('a missing volume picks nothing (not Re：zeropedia, not volume 29)', () => {
    expect(
      pick('Re:ゼロから始める異世界生活6', [
        'Re：ゼロから始める異世界生活 46',
        'Re：ゼロから始める異世界生活　Re：zeropedia',
        'Re：ゼロから始める異世界生活 9',
      ]),
    ).toBeNull();
    expect(
      pick('異世界はスマートフォンとともに。2', ['異世界はスマートフォンとともに。29']),
    ).toBeNull();
    expect(
      pick('Re:ゼロから始める異世界生活6', [
        'Re：ゼロから始める異世界生活 7',
        'Re：ゼロから始める異世界生活 6',
      ]),
    ).toBe('Re：ゼロから始める異世界生活 6');
  });
  it('every number of the title before some of them', () => {
    expect(
      pick('11月3日~11月7日生まれ あなたを守る天使からのメッセージ', [
        '１１月１３日～１１月１７日生まれ　あなたを守る天使からのメッセージ',
        '１１月３日～１１月７日生まれ　あなたを守る天使からのメッセージ',
      ]),
    ).toBe('１１月３日～１１月７日生まれ　あなたを守る天使からのメッセージ');
  });
  it("BookWalker's search: series results have no number; its book pages are volumes", () => {
    const isBook = (x: [string, string]) => x[0].includes('/de');
    const r = pickByVolume(
      '転生したらスライムだった件 1',
      [
        ['https://bookwalker.jp/dexx/', '転生したらスライムだった件（１９）'],
        ['https://bookwalker.jp/series/17155/list/', '転生したらスライムだった件（GCノベルズ）'],
      ],
      true,
      isBook,
    );
    expect(r?.[0]).toBe('https://bookwalker.jp/series/17155/list/');
  });
  it("a title without a number: the store's series name after it is the same title", () => {
    expect(
      pick('青春ブタ野郎はゆめみる少女の夢を見ない', [
        '青春ブタ野郎はゆめみる少女の夢を見ない １ (電撃コミックスNEXT)',
        '青春ブタ野郎はゆめみる少女の夢を見ない 青春ブタ野郎シリーズ (電撃文庫)',
        '青春ブタ野郎はゆめみる少女の夢を見ない',
      ]),
    ).toBe('青春ブタ野郎はゆめみる少女の夢を見ない 青春ブタ野郎シリーズ (電撃文庫)');
    expect(
      pick('ハリー・ポッターと謎のプリンス', [
        'ハリー・ポッターと謎のプリンス ハリー・ポッタ (Harry Potter)',
        'ハリー・ポッターと謎のプリンス',
      ]),
    ).toBe('ハリー・ポッターと謎のプリンス ハリー・ポッタ (Harry Potter)');
    const q = titleKey('夜行堂奇譚');
    expect(titleMatch(q, '夜行堂奇譚　参　下')).toBe(false);
    expect(
      titleMatch(titleKey('ONE PIECE novel HEROINES'), 'ONE PIECE novel HEROINES ［Colorful］'),
    ).toBe(false);
  });
});

describe('the record judge: a record that is the book is never replaced by one that fits less', () => {
  const book = (title: string, text = ''): BookFacts => ({ title, text, textBook: true });
  it('the volume number must be there; all of them best', () => {
    const b = book('Ｒｅ：ゼロから始める異世界生活６');
    expect(recordFit(b, { title: 'Re：ゼロから始める異世界生活　Re：zeropedia' })).toBeNull();
    expect(recordFit(b, { title: 'Re：ゼロから始める異世界生活 6' })).not.toBeNull();
    expect(
      replaces(
        b,
        { title: 'Re：ゼロから始める異世界生活 6' },
        { title: 'Re：ゼロから始める異世界生活 29' },
      ),
    ).toBe(false);
    expect(
      recordFit(book('お菓子職人の成り上がり～天才パティシエの領地経営～④'), {
        title: 'お菓子職人の成り上がり～天才パティシエの領地経営～（４９）',
      }),
    ).toBeNull();
  });
  it('a numbered record for a file without a number: only with its own subtitle', () => {
    expect(
      recordFit(book('異世界はスマートフォンとともに。'), {
        title: '異世界はスマートフォンとともに。32',
      }),
    ).toBeNull();
    expect(
      recordFit(book('(仮)花嫁のやんごとなき事情～離婚できずに新婚旅行!?～'), {
        title: '（仮）花嫁のやんごとなき事情3 ～離婚できずに新婚旅行!?～ (ビーズログ文庫)',
      }),
    ).not.toBeNull();
  });
  it("manga is not a text book, but Amazon's category コミック・ラノベ・BL is every light novel's", () => {
    const b = book('青春ブタ野郎はゆめみる少女の夢を見ない');
    expect(
      recordFit(b, {
        title: '青春ブタ野郎はゆめみる少女の夢を見ない 青春ブタ野郎シリーズ (電撃文庫)',
        words: 'Kindleストア,電撃文庫,本,コミック・ラノベ・BL,ライトノベル',
      }),
    ).not.toBeNull();
    expect(
      recordFit(book('古事記'), {
        title: '古事記',
        words: '古事記,コジキ,学習漫画,マンガ,電子書籍',
      }),
    ).toBeNull();
  });
  it("the file's imprint and edition decide between two of the same title", () => {
    const b = book('海と毒薬', '海と毒薬 遠藤周作 角川文庫 令和3年5月25日 発行');
    expect(replaces(b, { title: '海と毒薬（新潮文庫）' }, { title: '海と毒薬 (角川文庫)' })).toBe(
      true,
    );
    expect(replaces(b, { title: '海と毒薬 (角川文庫)' }, { title: '海と毒薬（新潮文庫）' })).toBe(
      false,
    );
    const i = book('いつか、眠りにつく日');
    expect(
      replaces(
        i,
        { title: 'いつか、眠りにつく日 いつか眠りにつく日 (スターツ出版文庫)' },
        { title: '【完全版】いつか、眠りにつく日 (スターツ出版文庫単行本)' },
      ),
    ).toBe(false);
  });
  it('an empty page never replaces a record', () => {
    const b = book('ハリー・ポッターと炎のゴブレット');
    expect(
      replaces(b, { title: 'ハリー・ポッターと炎のゴブレット: Harry Potter' }, { title: '' }),
    ).toBe(false);
    expect(
      replaces(b, { title: '' }, { title: 'ハリー・ポッターと炎のゴブレット: Harry Potter' }),
    ).toBe(true);
  });
});

describe('a description that differs only by its spacing', () => {
  it('is no change unless it adds paragraph breaks', () => {
    expect(onlySpacing('一行目。\n\n二行目。', '一行目。二行目。')).toBe(true);
    expect(onlySpacing('一行目。二行目。', '一行目。\n\n二行目。')).toBe(false);
    expect(onlySpacing('一行目。', '別の文。')).toBe(false);
    expect(onlySpacing(null, '一行目。')).toBe(false);
  });
});
