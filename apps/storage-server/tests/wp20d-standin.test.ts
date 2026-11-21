/**
 * WP20d: BookWalker in Amazon's place for light novels (src/cleanup/stage4/bw-standin.ts). The
 * measured behaviour is in scripts/measure-stage4-bw.ts; these pin the rules found on the way.
 */
import { describe, expect, it } from 'vitest';
import { bwSettles, commonSeries, titleStem } from '../src/cleanup/stage4/bw-standin';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';

const rec = (title: string, vols: string[], kana: string): RefRecord =>
  ({
    calibre: { cal_title: title, cal_authors: 'Unknown', cal_tags: '', has_cover: 1 },
    file: {
      opf_title: title,
      creators: [{ name: '星野 一郎', role: 'aut' }],
      chars: 100000,
      images: 3,
      front_text: '',
      colophon_text: '',
    },
    amazon: {},
    ranobedb: {},
    bookwalker: {
      detail: {
        title,
        keywords: `${title},${kana},星野一郎,挿絵次郎,テスト文庫,ライトノベル,電子書籍`,
      },
      series_candidates: vols.map((v, i) => [`https://bookwalker.jp/de${i}/`, v]),
    },
  }) as unknown as RefRecord;

describe('BookWalker standing in for Amazon', () => {
  it('reads a volume number written with a prefix (life.4, #04) as the end of the series name', () => {
    expect(titleStem('ひとりぼっちの異世界攻略　life.4　王女よ偽迷宮に散れ')).toBe(
      'ひとりぼっちの異世界攻略',
    );
    expect(titleStem('声優ラジオのウラオモテ　#04 夕陽とやすみは力になりたい？')).toBe(
      '声優ラジオのウラオモテ',
    );
    expect(titleStem('獄門撫子此処ニ在リ　３　修羅の巷で宴する')).toBe('獄門撫子此処ニ在リ');
  });

  it('keeps a closing wave dash that pairs with an opening one (WP20e)', () => {
    expect(titleStem('無職転生 ～異世界行ったら本気だす～ 21')).toBe(
      '無職転生 ~異世界行ったら本気だす~',
    );
    expect(titleStem('フェアリーテイル・クロニクル ～空気読まない異世界ライフ～ 3')).toBe(
      'フェアリーテイル・クロニクル ~空気読まない異世界ライフ~',
    );
    expect(titleStem('転生したらスライムだった件 〜魔国暮らしのトリニティ〜 第3巻')).toBe(
      '転生したらスライムだった件 〜魔国暮らしのトリニティ〜',
    );
    expect(titleStem('喰 -kuu- 3')).toBe('喰 -kuu-');
    expect(titleStem('ソード-アート - 3')).toBe('ソード-アート');
    // An unpaired dash before the number is still cut.
    expect(titleStem('ソードアート・オンライン ～ 3')).toBe('ソードアート・オンライン');
    const vols = ['無職転生 ~異世界行ったら本気だす~ 1', '無職転生 ~異世界行ったら本気だす~ 2'];
    expect(commonSeries(vols, '無職転生 ～異世界行ったら本気だす～ 21')).toBe(
      '無職転生 ~異世界行ったら本気だす~',
    );
  });

  it('takes the title stem only when more than half the volumes start with it', () => {
    const vols = ['最強の悪役が往く２　～副題～', '最強の悪役が往く　～副題～'];
    // One of two volumes is not a majority: the volumes' common start.
    expect(commonSeries(vols, '最強の悪役が往く ～副題～')).toBe('最強の悪役が往く');
  });

  it('never settles "no series" for a numbered title, and settles a light novel with a series list', () => {
    // Numbered, no series list: Amazon is asked.
    expect(bwSettles(rec('星降る街の物語 3', [], 'ホシフルマチノモノガタリ03'))).toBe(false);
    const vols = ['星降る街の物語 1', '星降る街の物語 2', '星降る街の物語 3'];
    expect(bwSettles(rec('星降る街の物語 2', vols, 'ホシフルマチノモノガタリ02'))).toBe(true);
    // A volume number BookWalker reads differently from the title: Amazon is asked.
    expect(bwSettles(rec('星降る街の物語 2', vols, 'ホシフルマチノモノガタリ03'))).toBe(false);
  });
});
