/**
 * More Bookmeter coverage, step 1: the measuring tools' rule pieces (scripts/lib/
 * bookmeter-rules.ts). Nothing here is used by the running stages; the baseline must agree with
 * acceptBookmeter so the measured gains are against today's rule.
 */
import { describe, expect, it } from 'vitest';
import { acceptBookmeter, editionNotes } from '../src/cleanup/stage4/store-links';
import {
  acceptWith,
  dropParens,
  judge,
  makeRules,
  nameKeys,
  parseFullTitles,
  seriesFrontMatch,
  subtitleMatch,
  type BookRow,
  type Hit,
} from '../scripts/lib/bookmeter-rules';

const hit = (id: string, title: string, authors: string[], full: string | null = null): Hit => ({
  id,
  title,
  authors,
  pages: null,
  edOk: editionNotes(title).length === 0,
  full,
  edOkFull: full === null ? null : editionNotes(full).length === 0,
});
const book = (t: string, au: string[], hits: Hit[], extra: Partial<BookRow> = {}): BookRow => ({
  uuid: 'u',
  cid: 1,
  gid: null,
  t,
  au,
  se: null,
  ix: null,
  kind: null,
  calTitle: t,
  opfTitle: t,
  hits,
  searched: true,
  stored: null,
  base: null,
  stores: null,
  searchFile: null,
  ...extra,
});

describe('bookmeter coverage measuring', () => {
  it('reads the whole titles from the cover alt text', () => {
    const html =
      '<ul><li class="group__book"><div class="book__thumbnail"><div class="thumbnail__cover"><a href="/books/5283950"><img alt="子ひつじは迷わない 贈るひつじが6ぴき (角川スニーカー文庫)" class="cover__image" src="x" /></a></div></div><div class="detail__title"><a href="/books/5283950">子ひつじは迷わない 贈るひつじが6ぴき (角…</a></div></li>' +
      '<li class="group__book"><a href="/books/7"><img alt="A &amp; B" /></a></li></ul>';
    const m = parseFullTitles(html);
    expect(m.get('5283950')).toBe('子ひつじは迷わない 贈るひつじが6ぴき (角川スニーカー文庫)');
    expect(m.get('7')).toBe('A & B');
  });

  it('the baseline accepts what acceptBookmeter accepts', () => {
    const cases: [string, string[], Hit[]][] = [
      ['神様のメモ帳2', ['杉井光'], [hit('1', '神様のメモ帳2 (電撃文庫 す 9-5)', ['杉井 光'])]],
      [
        '転生したら剣でした 13',
        ['棚架ユウ'],
        [hit('2', '転生したら剣でした 13 (GCノベルズ)', ['棚架ユウ'])],
      ],
      ['悪の説得術', ['x'], [hit('3', '【大活字シリーズ】悪の説得術', ['x'])]],
      ['A 2', ['x'], [hit('4', 'A 3', ['x']), hit('5', 'A 2', ['x'])]],
    ];
    const base = makeRules({});
    for (const [t, au, hits] of cases) {
      const own = [t];
      const expected = acceptBookmeter(hits, { title: t, authors: au, own }).hit?.id ?? null;
      expect(acceptWith(base, book(t, au, hits))?.id ?? null).toBe(expected);
    }
  });

  it('drops labels and series brackets but keeps a volume in brackets', () => {
    expect(dropParens('輝きの彼方 6 (砂の民の伝説)')).toBe('輝きの彼方 6');
    expect(dropParens('ケモノガリ (5)')).toBe('ケモノガリ (5)');
    expect(dropParens('雪 (下) (ハヤカワepi文庫)')).toBe('雪 (下)');
  });

  it('takes a subtitle only after a separator', () => {
    expect(
      subtitleMatch('ディヴィジョン・マニューバ ―英雄転生―', 'ディヴィジョン・マニューバ'),
    ).toBe(true);
    expect(subtitleMatch('影執事マルクの忘却', '影執事マルク')).toBe(false);
    expect(subtitleMatch('雪 新訳版', '雪')).toBe(false);
  });

  it('matches a title with its series in front', () => {
    expect(seriesFrontMatch('砂の民の伝説(6) 輝きの彼方', '砂の民の伝説', '輝きの彼方 6')).toBe(
      true,
    );
    expect(seriesFrontMatch('砂の民の伝説(6) 輝きの彼方', '砂の民の伝説', '別の話 6')).toBe(false);
  });

  it('splits names, drops roles, ・ and old kanji forms when asked', () => {
    const all = { authSplit: true, authDot: true, authKanji: true };
    expect([...nameKeys(['棚架ユウ,るろお'], { authSplit: true })]).toEqual(['棚架ユウ', 'るろお']);
    expect([...nameKeys(['(原作)山田 鐘人'], { authSplit: true })]).toEqual(['山田鐘人']);
    expect([...nameKeys(['エブリスタ/編'], { authSplit: true })]).toEqual(['エブリスタ']);
    expect([...nameKeys(['ハセガワ・ケイスケ'], all)]).toEqual(['ハセガワケイスケ']);
    expect([...nameKeys(['柳田 國男'], all)]).toEqual(['柳田国男']);
    expect([...nameKeys(['棚架ユウ,るろお'], {})]).toEqual(['棚架ユウ,るろお']);
  });

  it('accepts a whole title the list cut, and keeps the volume check', () => {
    const r = makeRules({ full: true, paren: true });
    const b = book(
      '自重しない元勇者の強くて楽しいニューゲーム 3',
      ['新木伸'],
      [
        hit(
          '1',
          '自重しない元勇者の強くて楽しいニューゲーム …',
          ['新木 伸'],
          '自重しない元勇者の強くて楽しいニューゲーム 5 (ダッシュエックス文庫)',
        ),
        hit(
          '2',
          '自重しない元勇者の強くて楽しいニューゲーム …',
          ['新木 伸'],
          '自重しない元勇者の強くて楽しいニューゲーム 3 (ダッシュエックス文庫)',
        ),
      ],
    );
    expect(acceptWith(makeRules({}), b)).toBeNull();
    expect(acceptWith(r, b)?.id).toBe('2');
  });

  it('flags a match whose volume differs from the label', () => {
    const h = hit(
      '1',
      'x',
      ['新木 伸'],
      '自重しない元勇者の強くて楽しいニューゲーム 5 (ダッシュエックス文庫)',
    );
    const g = {
      t: '自重しない元勇者の強くて楽しいニューゲーム 3',
      au: ['新木伸'],
      se: null,
      ix: 3,
    };
    expect(judge(h, g)).toEqual({ ok: false, why: ['title', 'volume'] });
    const h2 = hit(
      '2',
      'x',
      ['新木 伸'],
      '自重しない元勇者の強くて楽しいニューゲーム 3 (ダッシュエックス文庫)',
    );
    expect(judge(h2, g).ok).toBe(true);
  });
});

describe('series name after the title', () => {
  it('drops a trailing <series> or words repeating the series or the title start', async () => {
    const { dropSeriesTail } = await import('../scripts/lib/bookmeter-rules');
    expect(dropSeriesTail('司書とハサミと短い鉛筆2<司書とハサミと短い鉛筆>', null)).toBe(
      '司書とハサミと短い鉛筆2',
    );
    expect(dropSeriesTail('無責任三国志5 三匹快進撃 無責任シリーズ', '無責任')).toBe(
      '無責任三国志5 三匹快進撃',
    );
    expect(dropSeriesTail('ブランケット タイム ブランケットタイム', null)).toBe(
      'ブランケット タイム',
    );
    expect(dropSeriesTail('上京物語 僕の人生を変えた', null)).toBe('上京物語 僕の人生を変えた');
  });
});
