import { describe, expect, it } from 'vitest';
import { calibreNameBytes, NAME_MAX_BYTES } from '../src/cleanup/calibre-names';
import { cutTitle, fitTitle, removeRepeat, UNKNOWN_ID } from '../src/cleanup/title-fit';

// Real titles from the library, the held proposals and the new arrivals (stop B, 2026-11-22).
const fits = (id: number, t: string, a: string) => calibreNameBytes(id, t, a) <= NAME_MAX_BYTES;

describe('fitTitle: only titles too long change', () => {
  it('leaves a title that fits exactly as it is, branding and repeats included', () => {
    for (const t of [
      '人間失格 -- 太宰治 (Osamu Dazai) -- 6d5015682827304a6a4972139f816212 -- Anna’s Archive',
      'HAPPINESS HAPPINESS 3',
      '電子書籍特典\u3000駄菓子屋ヤハギ\u3000異世界に出店します３',
      '_14 - よつばと!(14) (368 MiB) | mokuro',
    ]) {
      const f = fitTitle(t, { calibreId: 67306, firstAuthor: '太宰治' });
      expect(f.step).toBe('none');
      expect(f.title).toBe(t);
    }
  });

  it('cleans first: stage 2 markers and an Anna’s Archive name', () => {
    const raw =
      '【電子版限定特典付き】信じていた仲間達にダンジョン奥地で殺されかけたがギフト『無限ガチャ』でレベル9999の仲間達を手に入れて元パーティーメンバーと世界に復讐＆『ざまぁ！』します！ 1';
    const f = fitTitle(raw, { calibreId: UNKNOWN_ID, firstAuthor: '明鏡シスイ' });
    expect(f.step).toBe('cleaned');
    expect(f.title.startsWith('信じていた仲間達に')).toBe(true);
    expect(f.title.endsWith(' 1')).toBe(true);
    expect(fits(UNKNOWN_ID, f.title, '明鏡シスイ')).toBe(true);
  });

  it('a title said twice keeps the numbered part when it is too long', () => {
    const raw =
      '解雇された宮廷錬金術師は辺境で大農園を作り上げる7～祖国を追い出されたけど、最強領地でスローライフを謳歌する～ 解雇された宮廷錬金術師は辺境で大農園を作り上げる～祖国を追い出されたけど、最強領地でスローライフを謳歌する～';
    const f = fitTitle(raw, { calibreId: 70188, firstAuthor: '錬金王' });
    expect(f.rules).toContain('repeat');
    expect(f.title).toBe(
      '解雇された宮廷錬金術師は辺境で大農園を作り上げる7～祖国を追い出されたけど、最強領地でスローライフを謳歌する～',
    );
  });

  it('drops a ～subtitle～ and keeps the number before it', () => {
    const raw =
      '左遷された無能王子は実力を隠したい2 ～二度転生した最強賢者、今世では楽したいので手を抜いてたら、王家を追放された。今更帰ってこいと言われても遅い、領民に実力がバレて、実家に帰してくれないから……～';
    const f = fitTitle(raw, { calibreId: 17789, firstAuthor: '茨木野' });
    expect(f).toMatchObject({ step: 'shortened', title: '左遷された無能王子は実力を隠したい2' });
  });

  it('drops a label before the number first, which is enough on its own', () => {
    const raw =
      '不敗の雑魚将軍～ハズレスキルだと実家を追放されましたが、「神解」スキルを使って帝国で成り上がります。気づけば帝国最強の大将軍として語られてました～（サーガフォレスト）１';
    const f = fitTitle(raw, { calibreId: 16345, firstAuthor: '藤原みけ' });
    expect(f.step).toBe('shortened');
    expect(f.rules).toEqual(['clean', 'label']);
    expect(f.title).toBe(
      '不敗の雑魚将軍～ハズレスキルだと実家を追放されましたが、「神解」スキルを使って帝国で成り上がります。気づけば帝国最強の大将軍として語られてました～ 1',
    );
  });

  it('stops as soon as the names fit: the label alone is enough here', () => {
    const raw =
      'アメリカ人の物語12 血塗られた夏の日: 革命の剣 ジョージ・ワシントン4 アメリカ独立戦争(ロング・アイランドの戦い・ハーレム高地の戦い・ホワイト・プレーンズの戦い) (歴史世界叢書)';
    const f = fitTitle(raw, { calibreId: 54294, firstAuthor: '西川秀和' });
    expect(f.rules).toEqual(['label']);
    expect(f.title.endsWith('ホワイト・プレーンズの戦い)')).toBe(true);
  });

  it('drops a KDP subtitle after ": "', () => {
    const raw =
      '「社会の裏側！」111……高齢者の運転ミスが、もし「認知症治療薬」の副作用だったとしたら！: じつは、フランスでは4種類の治療薬の保険適用を、ストップしました。効果も無く、脱力などの副作用の酷さのため。でも日本では、服用した高齢者が今日もハンドルを……';
    const f = fitTitle(raw, { calibreId: 43162, firstAuthor: '佐藤直樹' });
    expect(f.rules).toEqual(['colon-subtitle']);
    expect(f.title).toBe(
      '「社会の裏側！」111……高齢者の運転ミスが、もし「認知症治療薬」の副作用だったとしたら！',
    );
  });

  it('never drops a volume mark the rest of the title lacks', () => {
    const raw =
      'Kindle本の返品/再ダウンロード・パソコンで読む方法などキンドル小技集～KDPシステムの利用ティップス集～: はじめての方でもよくわかる！電子出版するためのティップス集その８（簡易読みきり版）';
    const f = fitTitle(raw, { calibreId: 58710, firstAuthor: '川口浩治' });
    expect(f.rules).not.toContain('colon-subtitle');
    expect(f.title).toContain('その8');
    expect(fits(58710, f.title, '川口浩治')).toBe(true);
  });

  it('cuts at the last punctuation mark with "…" when nothing else is enough', () => {
    const raw =
      '３万件以上のカウンセリングからの発見！人生格差はここから始まる！「仕事に行くだけで精一杯タイプ」「忍耐・我慢で出世を願うタイプ」「やる気一杯の実力派・起業家タイプ」身体を「成功体質」に変えると生き方が変わる！';
    const f = fitTitle(raw, { calibreId: 59858, firstAuthor: '岩本和也' });
    expect(f.step).toBe('cut');
    expect(f.title.endsWith('」…')).toBe(true);
    expect(f.bytesAfter).toBeLessThanOrEqual(NAME_MAX_BYTES);
  });

  it('the cut keeps a trailing volume number after "…"', () => {
    const head = 'ながいながいおはなしのはじまり、そしてつづき'.repeat(5);
    const t = cutTitle(`${head} 3`, { calibreId: 12345, firstAuthor: '作者' });
    expect(t.endsWith('… 3')).toBe(true);
    expect(fits(12345, t, '作者')).toBe(true);
  });

  it('a first author too long alone is bad data: nothing is fitted', () => {
    const author = 'ハルヒと出会ってから俺はすっかり忘れた言葉だが'.repeat(6);
    const f = fitTitle('涼宮ハルヒの退屈', { calibreId: 38199, firstAuthor: author });
    expect(f).toMatchObject({ step: 'author_too_long', title: '涼宮ハルヒの退屈' });
  });

  it('every fitted title fits, at the edge of 255 bytes too', () => {
    for (let n = 70; n <= 120; n++) {
      const t = 'あ'.repeat(n);
      const f = fitTitle(t, { calibreId: 99999, firstAuthor: '著者' });
      expect(f.bytesAfter).toBeLessThanOrEqual(NAME_MAX_BYTES);
      if (calibreNameBytes(99999, t, '著者') <= NAME_MAX_BYTES) expect(f.title).toBe(t);
    }
  });
});

describe('removeRepeat', () => {
  it('keeps the right part, never a false repeat', () => {
    expect(removeRepeat('HAPPINESS HAPPINESS 3')).toBe('HAPPINESS 3');
    expect(removeRepeat('ブランケット タイム ブランケットタイム')).toBe('ブランケット タイム');
    expect(
      removeRepeat(
        '目覚めると従姉妹を護る美少女剣士になっていた4 目覚めると従姉妹を護る美少女剣士になっていたシリーズ',
      ),
    ).toBe('目覚めると従姉妹を護る美少女剣士になっていた4');
    expect(removeRepeat('wonder wonderful 上・1')).toBe('wonder wonderful 上・1');
    expect(removeRepeat('エロマンガ先生(4) エロマンガ先生VSエロマンガ先生G')).toBe(
      'エロマンガ先生(4) エロマンガ先生VSエロマンガ先生G',
    );
  });
});
