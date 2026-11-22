/**
 * WP21d follow-up (2026-11-20): the eight fixes from the 50-recording spot check, on the cases
 * found there. Pure rules and decisions (`metaRules`, `decideUnit`, `sharedPositions`) with
 * model answers written as the stored ones; the corrections step through the stage on a fresh
 * database.
 */
import { describe, expect, it } from 'vitest';
import { setUserValue, valuesOf } from '../src/cleanup/ai/values';
import {
  decideUnit,
  sameBookSeries,
  sharedPositions,
  type SameBookUnit,
} from '../src/cleanup/audio/meta-decide';
import { nameGroups, personKey, respell, respellAll } from '../src/cleanup/audio/meta-names';
import type { MetaEvidence, RecordBrief } from '../src/cleanup/audio/meta-evidence';
import { META_FIELDS, metaEvidenceText } from '../src/cleanup/audio/meta-prompt';
import {
  hasPrintedVolume,
  isImprintSeries,
  isNotPerson,
  metaRules,
  onlyEditionOrNumberChange,
  recordAuthors,
  tagPeopleOf,
  artistIsNarrator,
  VOLUME_NO_SERIES,
} from '../src/cleanup/audio/meta-rules';

function brief(over: Partial<RecordBrief> = {}): RecordBrief {
  return {
    id: 'audible:B000000000',
    source: 'audible',
    title: 'Title',
    subtitle: null,
    authors: ['著者 名'],
    narrators: ['朗読 者'],
    minutes: 300,
    publisher: 'KADOKAWA',
    releaseDate: '2021-05-20',
    language: 'japanese',
    format: 'unabridged',
    categories: [],
    series: [],
    description: '',
    cover: null,
    fromSearchPage: false,
    ...over,
  };
}

function ev(over: Partial<MetaEvidence> = {}, record: RecordBrief | null = brief()): MetaEvidence {
  return {
    kind: record ? 'record' : 'no_record',
    name: 'name',
    minutes: 300,
    files: 1,
    copies: 1,
    stage4: { class: record ? 'auto' : 'unknown', reason: null, detail: 'asin_name' },
    title: 'Title',
    otherTitles: [],
    seriesTitles: [],
    volume: null,
    drama: false,
    dramaNumber: null,
    nameAuthors: [],
    tagNarrators: [],
    paths: ['TMW/[著者 名] Title/Title [B000000000].m4b'],
    tags: null,
    record,
    candidates: [],
    ...over,
  };
}

/** A model's stored answer: only the fields given, the rest "can't tell". */
const answer = (a: Record<string, unknown>) => ({
  record: null,
  title: null,
  authors: null,
  narrators: null,
  series: null,
  drama: null,
  confidence: {},
  ...a,
});

function decide(e: MetaEvidence, p: Record<string, unknown> | null, s = p) {
  return decideUnit(
    e,
    { primary: p ? answer(p) : null, secondary: s ? answer(s) : null },
    metaEvidenceText(e),
    {
      multiNarratorMin: 2,
    },
  ).fields;
}

describe("2. titles: the rules' title stands against an edition mark dropped or a number added", () => {
  it('judges the change', () => {
    // 新装版 dropped (フルメタル・パニック！ 3, 16 recordings), 【通常版】 dropped.
    expect(
      onlyEditionOrNumberChange(
        'フルメタル・パニック！ 3 揺れるイントゥ・ザ・ブルー 新装版',
        'フルメタル・パニック！ 3 揺れるイントゥ・ザ・ブルー',
      ),
    ).toBe(true);
    expect(
      onlyEditionOrNumberChange(
        'リアルサウンド～風のリグレット～ 【通常版】',
        'リアルサウンド～風のリグレット～',
      ),
    ).toBe(true);
    // A number added from "[3巻]" (バチカン奇跡調査官, 23 recordings), with and without 巻.
    expect(
      onlyEditionOrNumberChange('バチカン奇跡調査官 闇の黄金', 'バチカン奇跡調査官 3 闇の黄金'),
    ).toBe(true);
    expect(onlyEditionOrNumberChange('蜘蛛ですが、なにか？', '蜘蛛ですが、なにか？ 1巻')).toBe(
      true,
    );
    // Everything else stays a disagreement: the kanji numeral to a digit, a mark added or changed,
    // a series name or imprint cut, a different number, equal titles.
    expect(onlyEditionOrNumberChange('わたしの幸せな結婚 十', 'わたしの幸せな結婚 10')).toBe(false);
    expect(onlyEditionOrNumberChange('宮本武蔵 08 円明の巻', '宮本武蔵08 円明の巻')).toBe(false);
    expect(onlyEditionOrNumberChange('魔性の子 十二国記', '魔性の子')).toBe(false);
    expect(onlyEditionOrNumberChange('神さまのビオトープ 講談社タイガ', '神さまのビオトープ')).toBe(
      false,
    );
    expect(onlyEditionOrNumberChange('華氏451度', '華氏451度 新装版')).toBe(false);
    expect(onlyEditionOrNumberChange('華氏451度 新装版', '華氏451度 完全版')).toBe(false);
    expect(onlyEditionOrNumberChange('A 3', 'A 4')).toBe(false);
    expect(onlyEditionOrNumberChange('A', 'A')).toBe(false);
  });

  it("decideUnit keeps the rules' title (source rules, not flagged) and decides anything else as before", () => {
    const e = ev({}, brief({ title: '[3巻] バチカン奇跡調査官 闇の黄金' }));
    const f = decide(e, { title: 'バチカン奇跡調査官 3 闇の黄金' });
    expect(f.title!.decision).toMatchObject({
      value: 'バチカン奇跡調査官 闇の黄金',
      source: 'rules',
      flagged: false,
    });
    // Another disagreement works as before: both models agree against the rules, flagged guess.
    const g = decide(e, { title: 'バチカン奇跡調査官' });
    expect(g.title!.decision).toMatchObject({
      value: 'バチカン奇跡調査官',
      source: 'secondary_guess',
      flagged: true,
    });
    // A title the rules are not sure of is not touched.
    const open = ev({}, brief({ title: '[3巻] 魔性の子 [特装]' }));
    expect(decide(open, { title: '魔性の子' }).title!.decision.source).not.toBe('rules');
  });
});

describe('3. ドラマCD: true only when the names, title or series say so', () => {
  it('the models cannot make it true (T024, T034, 腹を割ったら血が出るだけさ)', () => {
    const e = ev({}, brief({ title: '誰かが私を殺した' }));
    const f = decide(e, { drama: true });
    expect(f.drama!.decision).toMatchObject({ value: false, source: 'rules', flagged: false });
    // The rules still say true for a ドラマCD, whatever the models answer.
    const cd = ev(
      { paths: ['TMW/[CD2]本好きの下剋上ドラマCD2.m4b'] },
      brief({ title: '[CD2]本好きの下剋上ドラマCD2' }),
    );
    expect(decide(cd, { drama: false }).drama!.decision).toMatchObject({
      value: true,
      source: 'rules',
    });
    expect(metaRules(cd, cd.record, true).drama).toMatchObject({ value: true, final: true });
  });
});

describe('4. a publisher, store or company is never a narrator or an author', () => {
  const pan = (over: Partial<RecordBrief>) =>
    brief({ publisher: 'パンローリング株式会社', ...over });

  it('the list and the publisher test', () => {
    for (const n of [
      'でじじ',
      'パンローリング',
      'パンローリング株式会社',
      'いずみ書房',
      'フロンティアワークス',
      'ジュピタースタジオ',
    ])
      expect(isNotPerson(n, null)).toBe(true);
    // A person who publishes under their own name stays (小泉健一, 飛立未鳥), a company publisher drops.
    expect(isNotPerson('小泉 健一', '小泉 健一')).toBe(false);
    expect(isNotPerson('飛立 未鳥', '飛立未鳥')).toBe(false);
    expect(isNotPerson('双葉社', '双葉社')).toBe(true);
    expect(isNotPerson('斉藤 範子', 'パンローリング株式会社')).toBe(false);
  });

  it('narrators: companies out; nothing left is unknown, 複数ナレーター follows', () => {
    // 宮沢賢治童話全集2: Audible lists the publisher.
    const only = ev({}, pan({ narrators: ['パンローリング'] }));
    expect(metaRules(only, only.record, true).narrators).toMatchObject({
      value: null,
      auto: false,
    });
    const none = decide(only, null);
    expect(none.narrators!.decision).toMatchObject({ value: null, source: 'unknown' });
    expect(none.multi_narr!.decision.value).toBeNull();
    // 黒蜥蜴: でじじ next to a person.
    const two = ev({}, pan({ narrators: ['でじじ', '斉藤 範子'] }));
    expect(metaRules(two, two.record, true).narrators).toMatchObject({
      value: ['斉藤範子'],
      auto: true,
    });
    const f = decide(two, null);
    expect(f.narrators!.decision.value).toEqual(['斉藤範子']);
    expect(f.multi_narr!.decision.value).toBe(false);
    // The models' answers are filtered too: a company alone is no answer.
    const g = decide(only, { narrators: ['パンローリング'] });
    expect(g.narrators!.decision).toMatchObject({ value: null, source: 'unknown' });
  });

  it("authors: companies out, in the rules and in the models' answers", () => {
    expect(recordAuthors(pan({ authors: ['パンローリング株式会社'] }))).toMatchObject({
      value: [],
      auto: false,
    });
    expect(recordAuthors(pan({ authors: ['いずみ書房'] }))).toMatchObject({
      value: [],
      auto: false,
    });
    const e = ev({}, brief({ publisher: '小学館', authors: ['ジュピタースタジオ'] }));
    expect(metaRules(e, e.record, true).authors).toMatchObject({ value: [], auto: false });
    expect(decide(e, { authors: ['ジュピタースタジオ'] }).authors!.decision.value).toEqual([]);
  });
});

describe('5. imprint names are never a series', () => {
  it('the list', () => {
    for (const n of [
      '幻冬舎新書',
      '週刊東洋経済eビジネス新書',
      '星新一オーディオブックス',
      '吉川英治朗読文庫',
      '小学館の名作文芸朗読 ~江戸川 乱歩~',
      'モバラジ研究会 江戸川乱歩朗読全集',
      '[CD] ガガガ文庫',
    ])
      expect(isImprintSeries(n)).toBe(true);
    for (const n of [
      'ムーミン全集',
      '宮沢賢治童話全集',
      '三体 シリーズ',
      '新海誠作品オーディオブックプロジェクト',
      '機龍警察シリーズ',
    ])
      expect(isImprintSeries(n)).toBe(false);
  });

  it("the store's series, the torrent folder and the models' answers", () => {
    const rec = brief({
      series: [{ name: '星新一オーディオブックス', sequence: '1', sort: '1', id: 'B1' }],
    });
    const e = ev({}, rec);
    expect(metaRules(e, rec, true).series.value).toEqual([]);
    // The torrent's folder names an imprint.
    const folder = ev(
      { paths: ['General/[著者 名] 幻冬舎新書/[03] Title [B0].m4b'] },
      brief({ title: 'Title 3' }),
    );
    expect(metaRules(folder, folder.record, true).series.value).not.toEqual([
      expect.objectContaining({ name: '幻冬舎新書' }),
    ]);
    // Both models name one: removed from what they answer (週刊東洋経済eビジネス新書 #266).
    const m = { series: [{ name: '週刊東洋経済eビジネス新書', position: 266, label: null }] };
    const f = decide(ev({}, brief({ title: '連鎖する貧困' })), m);
    expect(f.series!.decision.value).toEqual([]);
  });
});

describe('6. no store record: the tags', () => {
  const none = (tags: Record<string, string>, over: Partial<MetaEvidence> = {}) =>
    ev(
      {
        kind: 'no_record',
        stage4: { class: 'unknown', reason: null, detail: null },
        tags,
        ...over,
      },
      null,
    );

  it('a composer tag: artist = authors, composer = narrators', () => {
    const e = none({ artist: '芥川 龍之介', composer: '佐々木 健' });
    expect(tagPeopleOf(e)).toEqual({ authors: ['芥川龍之介'], narrators: ['佐々木健'] });
    const r = metaRules(e, null, false);
    expect(r.authors).toMatchObject({ value: ['芥川龍之介'], auto: false });
    expect(r.narrators).toMatchObject({ value: ['佐々木健'], auto: false });
  });

  // audiobook.jp's bare tag form (title, artist, album, genre "Audiobook"; WP21f-1 stop 2).
  const abjp = (artist: string) => ({
    title: '灰色のピーターパン',
    artist,
    album: '灰色のピーターパン',
    genre: 'Audiobook',
  });

  it('an artist tag alone lists the narrators (audiobook.jp files); the authors stay unknown', () => {
    const e = none(abjp('遠藤大輔, あいざわゆりか, 臼木健士朗, 加藤優里'));
    expect(tagPeopleOf(e)).toEqual({
      authors: [],
      narrators: ['遠藤大輔', 'あいざわゆりか', '臼木健士朗', '加藤優里'],
    });
    const r = metaRules(e, null, false);
    expect(r.authors.value).toBeNull();
    expect(r.narrators.value).toHaveLength(4);
    // "ほか" is no one.
    expect(tagPeopleOf(none(abjp('山根綺, 佐藤榛夏, ほか'))).narrators).toEqual([
      '山根綺',
      '佐藤榛夏',
    ]);
    // No tags: unknown.
    expect(metaRules(none({}), null, false).narrators.value).toBeNull();
  });

  it("an artist tag alone in any other form is the author (the app's downloads, Audible's form): WP21f-1 stop 2", () => {
    // The three mp3 books unpacked at stop 2 (the tags as stage 2 stored them).
    const app = none({
      title: '第一部 五月【1】',
      album: 'かがみの孤城',
      artist: '辻村深月',
      genre: 'オーディオブック',
    });
    expect(artistIsNarrator(app.tags)).toBe(false);
    expect(tagPeopleOf(app)).toEqual({ authors: ['辻村深月'], narrators: [] });
    const r = metaRules(app, null, false);
    expect(r.authors.value).toEqual(['辻村深月']);
    expect(r.narrators.value).toBeNull();
    // Audible's form (album_artist, date) and a file without a genre: the author.
    for (const tags of [
      {
        title: '告白',
        artist: '湊 かなえ',
        album_artist: '湊 かなえ',
        album: '告白',
        genre: 'Audiobook',
        date: '2019',
      },
      { title: '終電の神様', artist: '阿川大樹', album: '終電の神様', comment: 'x' },
    ])
      expect(tagPeopleOf(none(tags)).narrators, tags.title).toEqual([]);
    // The bare form, whatever the width or case of its genre: the narrators.
    expect(artistIsNarrator({ artist: 'x', genre: ' ＡＵＤＩＯＢＯＯＫ ' })).toBe(true);
    expect(artistIsNarrator(null)).toBe(false);
  });

  it('unconfirmed: a rules guess when the models give nothing, and AI books are not touched', () => {
    const e = none(abjp('古賀葵, 田澤茉純'));
    const f = decide(e, null);
    expect(f.narrators!.decision).toMatchObject({
      value: ['古賀葵', '田澤茉純'],
      source: 'rules_guess',
      flagged: true,
    });
    expect(f.authors!.decision).toMatchObject({ value: null, source: 'unknown' });
    const ai = ev(
      {
        kind: 'ai',
        tags: { artist: 'x', composer: 'y' },
        nameAuthors: ['著 者'],
        tagNarrators: ['朗 読'],
      },
      null,
    );
    expect(metaRules(ai, null, false).narrators.value).toEqual(['朗読']);
  });
});

describe('7. a printed volume number and no store series: unknown', () => {
  it('finds the printed volume number', () => {
    for (const t of [
      'ずたぼろ令嬢は姉の元婚約者に溺愛される 1',
      '淫靡な洞窟のその奥で 3',
      '今度は絶対に邪魔しませんっ！1',
      '冒険者をクビになったので、錬金術師として出直します! ～辺境開拓？よし、俺に任せとけ! 1',
      '[1巻] 経験済みなキミと、 経験ゼロなオレが、 お付き合いする話。',
      '主従そろって出稼ぎライフ！ 1 〜このダンジョンには、オーガの坊ちゃんが有能メイド',
    ])
      expect(hasPrintedVolume(t), t).toBe(true);
    for (const t of [
      'やがて恋するヴィヴィ・レイン1',
      'ラブ&ポップ: トパーズ2',
      'スローターハウス5',
      '1984',
      '6',
      '武器になる哲学 人生を生き抜くための哲学・思想のキーコンセプト50',
      '生業としての小説家戦略 専業作家として一生食っていくための「稼げる」マニュアル5',
      '栞と嘘の季節',
    ])
      expect(hasPrintedVolume(t), t).toBe(false);
  });

  it("the models' guess stays unconfirmed, unknown only when they give none; other cases are unchanged", () => {
    const e = ev({}, brief({ title: '淫靡な洞窟のその奥で 1' }));
    const r = metaRules(e, e.record, true);
    expect(r.series).toMatchObject({ value: null, auto: false, reason: VOLUME_NO_SERIES });
    const guess = [{ name: '淫靡な洞窟のその奥で', position: 1, label: null }];
    // Both models give it: it stays, from the models, flagged (unconfirmed: the store has no series).
    const f = decide(e, { series: guess });
    expect(f.series!.decision).toMatchObject({
      value: guess,
      source: 'both_models',
      flagged: true,
      reason: VOLUME_NO_SERIES,
    });
    // Only Luna (the second model) gives it: its flagged guess, as for every open field.
    const one = decide(e, null, { series: guess });
    expect(one.series!.decision).toMatchObject({ value: guess, flagged: true });
    // The models disagree: Luna's guess, flagged.
    const dis = decide(e, { series: guess }, { series: [] });
    expect(dis.series!.decision.flagged).toBe(true);
    // Neither gives one (null, or "no series"): unknown.
    for (const none of [null, { series: null }, { series: [] }]) {
      const u = decide(e, none as Record<string, unknown> | null);
      expect(u.series!.decision).toMatchObject({ value: null, source: 'unknown', flagged: true });
    }
    // No printed number: still "no series" (a standalone book).
    const solo = ev({}, brief({ title: '栞と嘘の季節' }));
    expect(metaRules(solo, solo.record, true).series).toEqual({ value: [], auto: true });
    // The store's own series is never replaced.
    const own = ev(
      {},
      brief({ title: 'X 1', series: [{ name: 'X', sequence: '1', sort: '1', id: 'B' }] }),
    );
    expect(metaRules(own, own.record, true).series.value).toEqual([
      { name: 'X', position: 1, label: '1' },
    ]);
  });
});

describe('1. positions two recordings of one Audible series share', () => {
  const u = (
    key: string,
    title: string,
    name: string,
    position: number | null,
    over: Partial<SameBookUnit> = {},
  ): SameBookUnit => ({
    key,
    name: key,
    audibleRecord: true,
    audibleSeries: true,
    title,
    authors: ['a'],
    series: [{ name, position, label: position === null ? null : String(position) }],
    ...over,
  });

  it('drops the number for every recording at a shared position, nothing else', () => {
    const units = [
      u('x', '灼眼のシャナX', '灼眼のシャナ', 11),
      u('xi', '灼眼のシャナXI', '灼眼のシャナ', 11),
      u('ix', '灼眼のシャナIX', '灼眼のシャナ', 9),
      // Copies of one book: equal titles, not a collision.
      u('c1', '通常攻撃が全体攻撃で二回攻撃のお母さんは好きですか？', 'お母さん', 1),
      u('c2', '通常攻撃が全体攻撃で二回攻撃のお母さんは好きですか?', 'お母さん', 1),
      // One recording in its series.
      u('one', 'ただ一冊', 'ひとつだけ', 3),
      // The same position in another series is another group.
      u('o', '別の本', '別のシリーズ', 11),
      // A user's value and a non-Audible record never count or change.
      u('user', '灼眼のシャナXII', '灼眼のシャナ', 11, { user: true }),
      u('kiku', '灼眼のシャナ外', '灼眼のシャナ', 11, { audibleRecord: false }),
    ];
    const out = sharedPositions(units);
    expect([...out.keys()].sort()).toEqual(['x', 'xi']);
    expect(out.get('x')).toEqual([{ name: '灼眼のシャナ', position: null, label: '11' }]);
    // D県警: four stories at 1; the drama companion entry (position null) is left alone.
    const d = sharedPositions([
      u('a', '陰の季節', 'D県警', 1),
      u('b', '動機', 'D県警', 1),
      u('c', '半落ち', 'D県警', 2),
    ]);
    expect([...d.keys()].sort()).toEqual(['a', 'b']);
    // From GOAT: every recording has its own position, so nothing is dropped.
    const goat = sharedPositions([
      u('g1', '嘔吐', 'From GOAT Vol.1', 1),
      u('g2', '全身政治家', 'From GOAT Vol.1', 2),
    ]);
    expect(goat.size).toBe(0);
  });

  it('is evaluated again on every pass, so a later recording makes the collision', () => {
    const base = [u('a', 'Book A', 'S', 4), u('b', 'Book B', 'S', 5)];
    expect(sharedPositions(base).size).toBe(0);
    expect(sharedPositions([...base, u('c', 'Book C', 'S', 5)]).size).toBe(2);
  });
});

describe("8. corrections are the user's own values", () => {
  it('names the fields the step may write', () => {
    expect(Object.keys(META_FIELDS)).toContain('authors');
  });
});

// The stage-level step (setUserValue kept by a later pass) is covered with the stage in
// wp21d-audio-meta.test.ts ("a user value stays"); the corrections list itself is data.
void setUserValue;
void valuesOf;

describe('one person, one spelling', () => {
  const u = (key: string, authors: string[] | null, narrators: string[] | null, user = false) => ({
    key,
    authors,
    narrators,
    userNarrators: user,
  });

  it('keys by ・, spaces and case only', () => {
    expect(personKey('エミリー・ロッダ')).toBe(personKey('エミリーロッダ'));
    expect(personKey('ハマ・カズシ')).toBe(personKey('ハマカズシ'));
    expect(personKey('TESTOSTERONE')).toBe(personKey('Testosterone'));
    expect(personKey('미아키 스가루')).toBe(personKey('미아키스가루'));
    expect(personKey('岡井 カツノリ')).toBe(personKey('岡井・カツノリ'));
    // WP21f-2 stop B3: a full stop in the place of ・ (思い出のマーニー 上 and 下).
    expect(personKey('ジョーン・G.ロビンソン')).toBe(personKey('ジョーン・G・ロビンソン'));
    expect(personKey('ジョーン・G．ロビンソン')).toBe(personKey('ジョーン・G・ロビンソン'));
    const marnie = nameGroups([
      u('m1', ['ジョーン・G・ロビンソン'], null),
      u('m2', ['ジョーン・G.ロビンソン'], null),
    ]);
    // On a tie the spelling with ・ stands.
    expect([...marnie.values()].map((g) => g.canonical)).toEqual(['ジョーン・G・ロビンソン']);
    // Different people stay different.
    expect(personKey('山田太郎')).not.toBe(personKey('山田花子'));
    expect(personKey('アーサー')).not.toBe(personKey('アーサ'));
  });

  it('takes the spelling most recordings have, on a tie the one with ・, then spaces, then code order', () => {
    const units = [
      ...Array.from({ length: 16 }, (_, i) => u(`a${i}`, null, ['ランズベリー・アーサー'])),
      ...Array.from({ length: 13 }, (_, i) => u(`b${i}`, null, ['ランズベリーアーサー'])),
      u('c', ['ハマカズシ'], null),
      u('d', ['ハマ・カズシ'], null),
      u('e', ['TESTOSTERONE'], null),
      u('f', ['Testosterone'], null),
      u('g', ['미아키스가루'], null),
      u('h', ['미아키 스가루'], null),
      u('i', ['山田太郎'], ['山田花子']),
    ];
    const groups = nameGroups(units);
    expect([...groups.values()].map((g) => g.canonical).sort()).toEqual(
      ['TESTOSTERONE', 'ハマ・カズシ', 'ランズベリー・アーサー', '미아키 스가루'].sort(),
    );
    const out = respellAll(units, groups);
    expect(out.get('b0')).toEqual({ narrators: ['ランズベリー・アーサー'] });
    expect(out.has('a0')).toBe(false);
    expect(out.get('c')).toEqual({ authors: ['ハマ・カズシ'] });
    expect(out.has('i')).toBe(false);
    // The order of the library never changes the choice.
    expect([...nameGroups([...units].reverse()).values()].map((g) => g.canonical).sort()).toEqual(
      [...groups.values()].map((g) => g.canonical).sort(),
    );
  });

  it('authors and narrators count together; a user value is counted and never changed; a person named twice stays once', () => {
    const units = [
      u('p', ['エミリー・ロッダ'], null),
      u('q', ['エミリー・ロッダ'], null),
      u('r', null, ['エミリーロッダ'], true),
      u('s', null, ['エミリーロッダ', 'エミリー・ロッダ', '他の人']),
    ];
    const out = respellAll(units);
    expect(out.has('r')).toBe(false);
    expect(out.get('s')).toEqual({ narrators: ['エミリー・ロッダ', '他の人'] });
    expect(respell(['x'], nameGroups(units))).toBeNull();
  });
});

describe('7 (narrowed) with the same-book step', () => {
  it("a kept guess is still replaced by the Audible twin's series", () => {
    const base = {
      name: 'x',
      audibleSeries: false,
      audibleRecord: false,
      authors: ['著者'],
    };
    const twin = {
      ...base,
      key: 't',
      audibleSeries: true,
      audibleRecord: true,
      title: 'ダンジョン 3',
      series: [{ name: 'ダンジョン', position: 3, label: '3' }],
    };
    const me = {
      ...base,
      key: 'm',
      title: 'ダンジョン 3',
      series: [{ name: 'ダンジョン', position: 3, label: null }],
    };
    expect(sameBookSeries([twin, { ...me, volumeGuess: true }]).has('m')).toBe(true);
    expect(sameBookSeries([twin, me]).has('m')).toBe(false);
  });
});
