/**
 * One-off corrections of store errors (WP21d follow-up, 2026-11-20): values written as the
 * user's own (`ai_values.source = 'user'`) after each stage-5 pass, only where the user has no
 * value yet, so no later pass, rules change or model answer overwrites them. Keyed by the store
 * record's id ("audible:B0…", "audiobookjp:90310"). Every entry is researched and approved by
 * the user before it is added; the evidence is in `decisions.md`, "WP21d follow-up".
 */
export interface Correction {
  /** The store record the recording was matched to. */
  record: string;
  field: 'authors' | 'narrators' | 'multi_narr' | 'series';
  value: string[] | boolean | { name: string; position: number | null; label: string | null }[];
}

/** Approved by the user, 2026-11-20 (evidence in decisions.md, "WP21d follow-up"). */
const MARK_BOOK = ['audiobookjp:90310', 'audiobookjp:132097', 'audiobookjp:109881'];
const ANIMA = [
  'audible:B0GHXFN2KW',
  'audible:B0GHX95FH1',
  'audible:B0GHX3P41Y',
  'audible:B0GHXNGM34',
  'audible:B0GHXNHH9D',
];

export const CORRECTIONS: Correction[] = [
  // マーク・ブック is the 朗読執事 app's character, voiced by 近藤隆: one narrator.
  ...MARK_BOOK.flatMap((record): Correction[] => [
    { record, field: 'narrators', value: ['近藤隆'] },
    { record, field: 'multi_narr', value: false },
  ]),
  // エヴァンゲリオン ANIMA 1-5: 企画・執筆 山下いくと, 原作 カラー (counts), 企画・編集 柏原康雄 (not).
  ...ANIMA.map(
    (record): Correction => ({ record, field: 'authors', value: ['山下いくと', 'カラー'] }),
  ),
  // 君の話: 岡井 カツノリ listed under two spellings, one person.
  { record: 'audible:B0HHY712SG', field: 'narrators', value: ['岡井カツノリ'] },
  { record: 'audible:B0HHY712SG', field: 'multi_narr', value: false },
  // ST 警視庁科学特捜班 黄の調査ファイル (audiobook.jp 269786, which gives no number): ST シリーズ
  // #6 (ST 1-3, then 青 4, 赤 5, 黄 6), as Audiobookshelf kept it after the cleanup wrote it
  // without one (user, 2026-11-21: "#6 is right"; audiobook cleanup leftovers, item 6).
  // 色シリーズ first, as decided: the book's folder follows the first series with a number, so
  // it stays in 色シリーズ/Vol 3 (STシリーズ first would move it next to the Audible edition).
  {
    record: 'audiobookjp:269786',
    field: 'series',
    value: [
      { name: '色シリーズ', position: 3, label: null },
      { name: 'STシリーズ', position: 6, label: null },
    ],
  },
];
