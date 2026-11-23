import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CLEANUP_MIGRATIONS } from '../src/cleanup/cleanup-db';
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

describe('cleanup.db v26: the list of shortened titles and the holds opened again', () => {
  // The migrations up to 25 by hand (the AI move's own check aside), then 26 on held rows.
  const db = new Database(':memory:');
  for (const m of CLEANUP_MIGRATIONS.filter((x) => x.version <= 25)) db.exec(m.sql);
  const put = db.prepare(
    `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
       source, evidence_json, class, review_reason, state, created_at, updated_at)
     VALUES (?, 'lib', ?, ?, ?, '"old"', ?, 's', ?, ?, ?, 'proposed', 1, 1)`,
  );
  const LONG = "Too long for a folder name in Calibre's library";
  const held = {
    s2: Number(
      put.run(2, 1, 'u1', 'title', '"t"', '{}', 'review', `${LONG} (288 bytes)`).lastInsertRowid,
    ),
    s5: Number(put.run(5, 2, 'u2', 'tags', '{}', '{}', 'review', LONG).lastInsertRowid),
    s4: Number(put.run(4, 3, 'u3', 'title', '"t"', '{}', 'review', LONG).lastInsertRowid),
    other: Number(
      put.run(2, 4, 'u4', 'title', '"t"', '{}', 'review', 'Calibre has its own title')
        .lastInsertRowid,
    ),
  };
  db.exec(CLEANUP_MIGRATIONS.find((x) => x.version === 26)!.sql);
  const cls = (id: number) =>
    db.prepare('SELECT class, review_reason FROM proposed_changes WHERE id = ?').get(id);

  it('opens again the holds that were automatic before (stages 2 and 5), never stage 4 or others', () => {
    expect(cls(held.s2)).toEqual({ class: 'auto', review_reason: null });
    expect(cls(held.s5)).toEqual({ class: 'auto', review_reason: null });
    expect(cls(held.s4)).toEqual({ class: 'review', review_reason: LONG });
    expect(cls(held.other)).toEqual({
      class: 'review',
      review_reason: 'Calibre has its own title',
    });
  });

  it('lists every shortened or cut title change from its evidence, kept in step by triggers', () => {
    const fit = (step: string) =>
      JSON.stringify({ fit: { from: '長い題名', step, rules: ['wave-subtitle'] } });
    const id = Number(
      put.run(4, 9, 'u9', 'title', '"短い題名"', fit('shortened'), 'auto', null).lastInsertRowid,
    );
    put.run(4, 10, 'u10', 'title', '"整えた題名"', fit('cleaned'), 'auto', null);
    put.run(4, 11, 'u11', 'authors', '["a"]', fit('cut'), 'auto', null);
    const list = () =>
      db
        .prepare('SELECT change_id, calibre_id, original, written, step FROM calibre_title_fits')
        .all();
    expect(list()).toEqual([
      {
        change_id: id,
        calibre_id: 9,
        original: '長い題名',
        written: '短い題名',
        step: 'shortened',
      },
    ]);
    db.prepare(
      `UPDATE proposed_changes SET new_json = '"短い…"', evidence_json = ? WHERE id = ?`,
    ).run(fit('cut'), id);
    expect(list()).toEqual([
      { change_id: id, calibre_id: 9, original: '長い題名', written: '短い…', step: 'cut' },
    ]);
    db.prepare(`UPDATE proposed_changes SET evidence_json = '{}' WHERE id = ?`).run(id);
    expect(list()).toEqual([]);
    db.prepare(`UPDATE proposed_changes SET evidence_json = ? WHERE id = ?`).run(fit('cut'), id);
    db.prepare('DELETE FROM proposed_changes WHERE id = ?').run(id);
    expect(list()).toEqual([]);
  });
});

describe('the new queries read indexes (lessons 3-4)', () => {
  const db = new Database(':memory:');
  for (const m of CLEANUP_MIGRATIONS) db.exec(m.sql);
  const plan = (sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
  it('the list, the triggers, the planner and the passes', () => {
    const list = plan(
      `SELECT f.id FROM calibre_title_fits f
       LEFT JOIN proposed_changes p ON p.id = f.change_id
       LEFT JOIN calibre_arrival_files a ON a.id = f.arrival_file_id
       WHERE f.library_id = 'l' ORDER BY f.id DESC LIMIT 20`,
    );
    expect(list).not.toMatch(/SCAN (p|a)\b/u);
    expect(plan(`DELETE FROM calibre_title_fits WHERE change_id = 1`)).toMatch(/USING INDEX/u);
    expect(
      plan(
        `SELECT id, calibre_uuid, field, new_json FROM proposed_changes
         WHERE stage = 5 AND state = 'proposed' AND class = 'review' AND library_id = 'l'
           AND review_reason = 'x' AND decided_by IS NULL`,
      ),
    ).toMatch(/USING INDEX proposed_changes_stage|USING INDEX proposed_changes_counts/u);
    expect(
      plan(
        `SELECT id FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = 'l' AND calibre_uuid = 'u' AND stage = 5 AND field = 'title'
           AND state = 'proposed' AND source = 'title-fit' LIMIT 1`,
      ),
    ).toMatch(/proposed_changes_book/u);
    expect(
      plan(
        `SELECT DISTINCT calibre_uuid FROM proposed_changes
         WHERE stage = 4 AND library_id = 'l' AND state = 'proposed' AND class = 'review'
           AND decided_by IS NULL AND review_reason LIKE 'Too long for a folder name%'`,
      ),
    ).not.toMatch(/SCAN proposed_changes\b(?! USING)/u);
    expect(
      plan(
        `SELECT 1 FROM calibre_arrival_batch_items i JOIN calibre_arrival_files f ON f.id = i.file_id
         WHERE i.batch_id = 1 AND json_extract(f.facts_json, '$.addTitle') IS NOT NULL LIMIT 1`,
      ),
    ).not.toMatch(/SCAN (i|f)\b(?! USING)/u);
  });
});
