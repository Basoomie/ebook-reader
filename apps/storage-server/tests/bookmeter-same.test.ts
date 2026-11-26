/**
 * Bookmeter listings, second look (bookmeter-listings.md 8): the same-book check
 * (stage4/bookmeter-same.ts). Every form it takes, and every case the blind samples and the
 * library-wide random looks showed it must refuse, from real listings.
 */
import { describe, expect, it } from 'vitest';
import {
  romanValue,
  sameBook,
  sameTitle,
  volKey,
  type SameBook,
} from '../src/cleanup/stage4/bookmeter-same';
import type { BookmeterHit } from '../src/cleanup/stage4/store-links';

const book = (title: string, authors: string[], over: Partial<SameBook> = {}): SameBook => ({
  title,
  authors,
  series: null,
  fmt: 'light novel',
  own: [title],
  ...over,
});
const hit = (title: string, authors: string[]): BookmeterHit => ({
  id: 'x',
  title,
  authors,
  pages: null,
  registrations: 1,
});

describe('Bookmeter listings: the same book written another way', () => {
  it.each([
    ['狼と香辛料II', '狼と香辛料 (2) (電撃文庫)', 'as-written'],
    ['ルナティック・ムーンII', 'ルナティック・ムーンII (電撃文庫 ふ 7-2)', 'as-written'],
    ['戦闘妖精・雪風(改)', '戦闘妖精・雪風〈改〉 (ハヤカワ文庫 JA カ 3-27)', 'as-written'],
    ['エッジ 下', 'エッジ 下 (角川ホラー文庫)', 'as-written'],
    ['狼と香辛料VIII 対立の町＜上＞', '狼と香辛料VIII対立の町(上) (電撃文庫)', 'as-written'],
    ['キノの旅IV the Beautiful World', 'キノの旅 (4) The Beautiful World (電撃文庫)', 'as-written'],
    ['星刻の竜騎士 X', '星刻の竜騎士(10) (MF文庫J)', 'as-written'],
    ['東京空港殺人事件', '東京空港殺人事件 新装版', 'as-written'],
    [
      '夢をかなえるゾウ3 ブラックガネーシャの教え',
      '夢をかなえるゾウ3 ブラックガネーシャの教え＜文庫版＞',
      'as-written',
    ],
    ['緋弾のアリア II 燃える銀氷', '緋弾のアリア (2) 燃える銀氷 ダイヤモンドダスト', 'reading'],
    ['とある魔術の禁書目録2', 'とある魔術の禁書目録(インデックス) (2) (電撃文庫)', 'reading'],
    ['ゼロの使い魔 7 銀の降臨祭', 'ゼロの使い魔(7)', 'subtitle'],
    ['丘の家のミッキー8', '丘の家のミッキー 8 ツルへの恩返しの巻 (コバルト文庫)', 'subtitle'],
    ['警察庁α特務班 キメラの刻印', 'キメラの刻印: 警察庁α特務班 (徳間文庫 り 7-21)', 'order'],
  ])('%s = %s (%s)', (b, h, how) => {
    expect(sameTitle(h, b)).toBe(how);
  });

  it.each([
    // Another volume or part.
    ['狼と香辛料II', '狼と香辛料 (3) (電撃文庫)'],
    ['エッジ 下', 'エッジ 上 (角川ホラー文庫)'],
    ['霊獣紀 蛟龍の書(下)', '霊獣紀 蛟龍の書(上) (講談社文庫 し 120-3)'],
    ['森羅万象を統べる者II', '森羅万象を統べる者II 〝閉じた小部屋〟上 (MF文庫J)'],
    ['C3 -シーキューブ- III', 'C3 ‐シーキューブ‐ (電撃文庫 み 7-7)'],
    ['キノの旅XXII the Beautiful World', 'キノの旅 the Beautiful World (電撃文庫)'],
    ['CNN ENGLISH EXPRESS 2026年1月号', '【音声DL付き】CNN ENGLISH EXPRESS 2023年 1月号'],
    // A side book, another work of the series, a sub-series.
    ['異世界拷問姫外伝3 入れ替わりロンドと眠り姫の口づけ', '異世界拷問姫3 (MF文庫J)'],
    ['とらドラ・スピンオフ2! 虎、肥ゆる秋', 'とらドラ2! (電撃文庫)'],
    ['風の大陸 氷の島3 雨の魔女', '風の大陸 第3部 (富士見ファンタジア文庫 2-3)'],
    ['織田信奈の野望 全国版10', '織田信奈の野望 10 (GA文庫)'],
    ['狼と香辛料II', '新説 狼と香辛料 狼と羊皮紙II (電撃文庫)'],
    ['ソードアート・オンライン', 'ソードアート・オンライン プログレッシブ'],
    ['さよならドビュッシー 前奏曲', 'さよならドビュッシー'],
    ['悪逆騎士団II そのエルフ、凶暴につき', '悪逆騎士団 そのエルフ、凶暴につき (電撃文庫)'],
    [
      '機動戦士ガンダム 逆襲のシャア',
      '機動戦士ガンダム 逆襲のシャア―ベルトーチカ・チルドレン (角川文庫―スニーカー文庫)',
    ],
    // A part of the title in brackets.
    ['出会うヒト〈境〉', '出会うヒト＜幽＞'],
  ])('%s ≠ %s', (b, h) => {
    expect(sameTitle(h, b)).toBeNull();
  });

  it('refuses sets, comics, adaptations and other authors, never エロマンガ先生 as a comic', () => {
    const eromanga = book('エロマンガ先生(2) 妹と世界で一番面白い小説', ['伏見つかさ'], {
      series: 'エロマンガ先生',
    });
    expect(
      sameBook(
        hit('エロマンガ先生(2) 妹と世界で一番面白い小説 (電撃文庫)', ['伏見 つかさ']),
        eromanga,
      ).fails,
    ).toEqual([]);
    expect(
      sameBook(hit('エロマンガ先生 (2) (電撃コミックスNEXT)', ['rin']), eromanga).fails,
    ).toEqual(expect.arrayContaining(['author', 'comic']));
    const lunatic = book('ルナティック・ムーン', ['藤原祐']);
    expect(
      sameBook(hit('ルナティック・ムーン 文庫 1-5巻セット (電撃文庫)', ['藤原 祐']), lunatic).fails,
    ).toContain('set');
    const ln = book('異世界魔王と召喚少女の奴隷魔術 3', ['むらさきゆきや']);
    expect(
      sameBook(hit('異世界魔王と召喚少女の奴隷魔術 3', ['福田 直叶,(原作)むらさき ゆきや']), ln)
        .fails,
    ).toContain('adaptation');
    // A manga book may have its comic listings.
    expect(
      sameBook(hit('ゴールデンキッズ 2 (愛蔵版コミックス)', ['作者']), {
        ...book('ゴールデンキッズ 2', ['作者']),
        fmt: 'manga',
      }).fails,
    ).toEqual([]);
  });

  it('reads the printed volume: numbers with repeats, years, whole Roman numerals, part marks', () => {
    expect(volKey('狼と香辛料 (2) (電撃文庫)')).toBe('2');
    expect(volKey('ルナティック・ムーンII (電撃文庫 ふ 7-2)')).toBe('2');
    expect(volKey('C3 -シーキューブ- III')).toBe('3,3');
    expect(volKey('キノの旅XXII the Beautiful World')).toBe('22');
    expect(volKey('CNN ENGLISH EXPRESS 2026年1月号')).toBe('1,2026');
    expect(volKey('水属性の魔法使い 第一部 中央諸国編IV')).toBe('1,4');
    expect(volKey('従妹ベット(下)')).toBe('|下');
    expect(volKey('天下争覇1 征夷大将軍になれ!!')).toBe('1');
    expect(volKey('本好きの下剋上 第三部')).toBe('3');
    expect(romanValue('XIV')).toBe(14);
    expect(romanValue('IIII')).toBeNull();
    expect(romanValue('VX')).toBeNull();
  });
});
