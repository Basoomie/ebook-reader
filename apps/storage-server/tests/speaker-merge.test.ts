/**
 * Season 2 Phase 12 session 5: characters found per window, merged into one list
 * (speaker-merge.ts), and the book as the speaker model reads it (speaker-text.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  CharacterMerger,
  isJoiningName,
  normalizeName,
  type FoundCharacter,
} from '../src/audio/speakers/speaker-merge';
import { speakerBook, textKey } from '../src/audio/speakers/speaker-text';
import type { BookScript } from '../src/audio/book-script';

const f = (
  name: string,
  aliases: string[] = [],
  window = 0,
  extra: Partial<FoundCharacter> = {},
): FoundCharacter => ({
  name,
  aliases,
  firstPerson: [],
  gender: '不明',
  window,
  ...extra,
});

describe('names as compared', () => {
  it('folds width, separators and one honorific', () => {
    expect(normalizeName('ナツキ・スバル')).toBe('ナツキスバル');
    expect(normalizeName('ﾗｲﾄ様')).toBe('ライト');
    expect(normalizeName('ロレンスさん')).toBe('ロレンス');
    expect(normalizeName('エミリアたん')).toBe('エミリア');
    expect(normalizeName('オットー兄ィ')).toBe('オットー');
    // A name that is only an honorific stays.
    expect(normalizeName('先生')).toBe('先生');
    expect(normalizeName('様')).toBe('様');
  });

  it('never joins on generic forms of address', () => {
    expect(isJoiningName('ご主人様')).toBe(false);
    expect(isJoiningName('少女')).toBe(false);
    expect(isJoiningName('ホロ')).toBe(true);
  });
});

describe('merging the characters of every window', () => {
  it('joins a name with the same name, an alias of the first, or the reverse', () => {
    const m = new CharacterMerger();
    const holo = m.add(f('ホロ', ['賢狼ホロ'], 0));
    expect(m.add(f('ホロ', [], 1))).toBe(holo);
    expect(m.add(f('賢狼ホロ', [], 2))).toBe(holo);
    const lawrence = m.add(f('クラフト・ロレンス', [], 0));
    expect(m.add(f('ロレンス', ['クラフト・ロレンス'], 3))).toBe(lawrence);
    expect(m.characters()).toHaveLength(2);
    expect(m.byId(holo)!.windows).toEqual([0, 1, 2]);
  });

  it('never joins two characters that share only an alias (a description the model gave both)', () => {
    const m = new CharacterMerger();
    const holo = m.add(f('ホロ', ['旅の連れ', '羊飼い']));
    const lawrence = m.add(f('ロレンス', ['旅の連れ']));
    const husk = m.add(f('ハスキンズ', ['羊飼い']));
    expect(new Set([holo, lawrence, husk]).size).toBe(3);
    // A later entry named by that shared alias is ambiguous: a new character, not either.
    const other = m.add(f('旅の連れ'));
    expect([holo, lawrence].includes(other)).toBe(false);
  });

  it('never joins family members by a shared family name', () => {
    const m = new CharacterMerger();
    const r = m.add(f('ラインハルト', ['ラインハルト・ヴァン・アストレア']));
    const w = m.add(f('ヴィルヘルム', ['ヴィルヘルム・ヴァン・アストレア']));
    expect(r).not.toBe(w);
    expect(m.add(f('アストレア'))).not.toBe(r);
  });

  it('names a character by the name most windows used', () => {
    const m = new CharacterMerger();
    const id = m.add(f('ナツキ・スバル', ['スバル'], 0));
    m.add(f('スバル', [], 1));
    m.add(f('スバル', [], 2));
    expect(m.byId(id)!.name).toBe('スバル');
    expect(m.byId(id)!.aliases).toContain('ナツキ・スバル');
  });

  it('applies the model groups and keeps the user’s character', () => {
    const m = new CharacterMerger([
      {
        id: 1,
        name: 'メイ',
        aliases: [],
        firstPerson: [],
        gender: '女',
        windows: [0],
        narrator: false,
        fixed: true,
      },
    ]);
    const maid = m.add(f('探求者メイド', [], 1));
    expect(maid).toBe(2);
    m.applyGroups([[2, 1]]);
    expect(m.characters()).toHaveLength(1);
    expect(m.byId(1)!.name).toBe('メイ');
    expect(m.byId(1)!.aliases).toContain('探求者メイド');
    // The user's name is never replaced by a vote.
    m.add(f('探求者メイド', [], 3));
    m.add(f('探求者メイド', [], 4));
    expect(m.byId(1)!.name).toBe('メイ');
  });

  it('applies a model group only when the names overlap (step A: ユーグ+フラン, エミリア+ベアトリス)', () => {
    const m = new CharacterMerger();
    const yugh = m.add(f('ユーグ', ['ハフナー・ユーグ']))!;
    const fran = m.add(f('フラン', ['フラン・ヴォネリ']))!;
    const natsuki = m.add(f('ナツキ', ['ナツキくん']))!;
    const subaru = m.add(f('スバル', ['ナツキ・スバル']))!;
    m.add(f('スバル', [], 1));
    m.applyGroups([
      [yugh, fran],
      [subaru, natsuki],
    ]);
    expect(m.byId(fran)).toBeDefined();
    expect(m.byId(yugh)).toBeDefined();
    // ナツキ and スバル (alias ナツキ・スバル) are one person: the lower id stays, named by the
    // name the windows used most.
    expect(m.byId(subaru)).toBeUndefined();
    expect(m.byId(natsuki)!.name).toBe('スバル');
    expect(m.byId(natsuki)!.aliases).toEqual(expect.arrayContaining(['ナツキ', 'ナツキ・スバル']));
    expect(m.characters()).toHaveLength(3);
  });

  it('never names a character by a first-person word', () => {
    const m = new CharacterMerger();
    const holo = m.add(f('わっち', ['ホロ', '賢狼'], 0, { firstPerson: ['わっち'] }))!;
    expect(m.byId(holo)!.name).toBe('ホロ');
    expect(m.byId(holo)!.firstPerson).toContain('わっち');
    expect(m.add(f('僕'))).toBeNull();
    expect(m.add(f('我輩', ['ゴールド']))).not.toBeNull();
  });

  it('marks the narrator, adding it when the list lacks it', () => {
    const m = new CharacterMerger();
    m.add(f('ライト', ['ダーク']));
    expect(m.setNarrator('ライト')).toBe(1);
    expect(m.byId(1)!.narrator).toBe(true);
    const id = m.setNarrator('僕の兄');
    expect(m.byId(id)!.narrator).toBe(true);
    expect(m.byId(1)!.narrator).toBe(false);
  });
});

describe('paragraphs and quotes of a script', () => {
  const script: BookScript = {
    version: 3,
    characters: 100,
    chapters: [
      {
        index: 0,
        title: '一',
        startCharacter: 0,
        characters: 50,
        sentences: [
          {
            text: '「おはよう。',
            reading: '',
            position: 0,
            paragraphEnd: false,
            parts: [{ start: 0, end: 6, role: 'dialogue', quote: 0 }],
          },
          {
            text: '今日は晴れだね」',
            reading: '',
            position: 5,
            paragraphEnd: true,
            parts: [{ start: 0, end: 8, role: 'dialogue', quote: 0 }],
          },
          { text: 'ホロは言った。', reading: '', position: 12, paragraphEnd: true },
          {
            text: '「うむ」「𠮷」',
            reading: '',
            position: 18,
            paragraphEnd: true,
            parts: [
              { start: 0, end: 4, role: 'dialogue', quote: 1 },
              { start: 4, end: 8, role: 'dialogue', quote: 2 },
            ],
          },
        ],
      },
    ],
  };

  it('rebuilds paragraphs, with a quote over two sentences as one span', () => {
    const b = speakerBook(script);
    expect(b.paragraphs.map((p) => p.text)).toEqual([
      '「おはよう。今日は晴れだね」',
      'ホロは言った。',
      '「うむ」「𠮷」',
    ]);
    expect(b.paragraphs[0].quotes).toEqual([{ quote: 0, start: 0, end: 14 }]);
    expect(b.quotes.map((q) => [q.quote, q.text, q.paragraph])).toEqual([
      [0, '「おはよう。今日は晴れだね」', 0],
      [1, '「うむ」', 2],
      [2, '「𠮷」', 2],
    ]);
  });

  it('keys a quote by its text and occurrence', () => {
    expect(textKey(' 「Ａ　Ｂ」 ')).toBe('「AB」');
    const b = speakerBook(script);
    expect(b.quotes[1].key).toBe('1|「うむ」');
  });
});
