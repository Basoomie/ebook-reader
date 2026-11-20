/**
 * WP20d: the search pick (src/cleanup/stage4/pick.ts) and BookWalker's second query
 * (bookwalkerRetryQuery), as found on the live run 2026-11-19.
 */
import { describe, expect, it } from 'vitest';
import { bookwalkerRetryQuery } from '../src/cleanup/stage4/analysis';
import { pickByVolume } from '../src/cleanup/stage4/pick';

describe('the search pick', () => {
  it('takes an edition marked "【特典SS付】" when every result carries such a note', () => {
    const cands: [string, string][] = [
      ['B01', 'めざせ牢獄！～悪役令嬢は番外編で愛されたい～【特典SS付】 (アイリスNEO)'],
    ];
    expect(pickByVolume('めざせ牢獄!~悪役令嬢は番外編で愛されたい~', cands)?.[0]).toBe('B01');
    // Volume numbers still decide among them.
    const vols: [string, string][] = [
      [
        'B09',
        '転生したら最愛の家族にもう一度出会えました 9 前世のチートで【電子書店共通特典SS付】',
      ],
      [
        'B01',
        '転生したら最愛の家族にもう一度出会えました 1 前世のチートで【電子書店共通特典SS付】',
      ],
    ];
    expect(
      pickByVolume('転生したら最愛の家族にもう一度出会えました1 前世のチートで', vols)?.[0],
    ).toBe('B01');
  });

  it('still skips bonus stories of their own, and prefers an unmarked edition', () => {
    const bonus: [string, string][] = [
      [
        'B02',
        '【購入特典】『負けヒロインが多すぎる！ ８』BOOK☆WALKER限定書き下ろしショートストーリー',
      ],
    ];
    expect(pickByVolume('負けヒロインが多すぎる! 8', bonus)).toBeNull();
    const both: [string, string][] = [
      ['B03', 'ある本【特典SS付】 (テスト文庫)'],
      ['B04', 'ある本 (テスト文庫)'],
    ];
    expect(pickByVolume('ある本', both)?.[0]).toBe('B04');
  });

  it('asks BookWalker once more by the title up to its volume number', () => {
    expect(bookwalkerRetryQuery('鋼鉄の白兎騎士団10')).toBe('鋼鉄の白兎騎士団');
    expect(bookwalkerRetryQuery('ハイスクールD×D 06 体育館裏のホーリー')).toBe('ハイスクールD×D');
    expect(bookwalkerRetryQuery('最果てのパラディンI 死者の街の少年')).toBe('最果てのパラディン');
    // No volume number: the same query again would find nothing new.
    expect(bookwalkerRetryQuery('ふしぎな本')).toBeNull();
  });
});
