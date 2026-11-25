/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/*
 * The kinds of a book's Calibre tags, for the book page (2026-11-24): the format shown above the
 * title, the other tags in a fixed order (genres, subjects, story tags, adaptations, then any tag
 * of your own as Calibre has it).
 *
 * The labels are the Japanese labels the cleanup's stage 5 writes to Calibre
 * (apps/storage-server/src/cleanup/stage5/vocab.ts). A storage-server test keeps these lists
 * equal to it (tests/tag-kinds-parity.test.ts): change both together.
 */

export const FORMAT_LABELS: readonly string[] = [
  'ライトノベル',
  '小説',
  'ノンフィクション',
  'マンガ',
  '画像のみ'
];

export const GENRE_LABELS: readonly string[] = [
  'ファンタジー',
  '異世界',
  '恋愛',
  'ラブコメ',
  'コメディ',
  'バトル・アクション',
  '冒険',
  '学園',
  '日常',
  'ヒューマンドラマ',
  '青春',
  'ミステリー・サスペンス',
  'ホラー・怪異',
  'SF',
  '歴史・時代',
  '戦記・ミリタリー',
  '百合',
  'ボーイズラブ',
  'ティーンズラブ',
  'お色気',
  '官能',
  'スポーツ'
];

export const SUBJECT_LABELS: readonly string[] = [
  'ビジネス・経済',
  '自己啓発',
  '心理',
  '恋愛・人間関係',
  '歴史',
  '哲学・思想',
  '宗教',
  '科学・技術',
  '社会',
  '評論・文学研究',
  'エッセイ',
  '暮らし・健康・料理',
  '趣味・実用',
  '学習・資格'
];

export const STORY_TAG_LABELS: readonly string[] = [
  '男性主人公',
  '女性主人公',
  '転生',
  'ハーレム',
  '魔法',
  '最強主人公',
  '悪役令嬢',
  '乙女ゲーム',
  'ゲーム要素',
  'ダンジョン',
  '剣と魔法',
  'ダーク',
  '現代',
  '貴族',
  'ほのぼの',
  '家族',
  '強いヒロイン',
  'モンスター',
  '復讐',
  'タイムトラベル',
  'サバイバル',
  '魔法学園',
  '性転換',
  '超能力',
  '動物',
  '幼なじみ',
  'ドラゴン',
  '騎士',
  '悪魔・魔族・魔王',
  '商売・経営',
  '料理・グルメ',
  'エルフ',
  'ロボット・メカ',
  '魔女',
  'メイド',
  '姫',
  '結婚',
  '吸血鬼',
  'モンスター娘',
  'スローライフ',
  '犯罪',
  '成長',
  '友情'
];

export const ADAPTATION_LABELS: readonly string[] = ['アニメ化', 'コミカライズ'];

/** Each known label's place: kind first, then its place in the vocabulary. */
const RANK: ReadonlyMap<string, number> = new Map(
  [GENRE_LABELS, SUBJECT_LABELS, STORY_TAG_LABELS, ADAPTATION_LABELS].flatMap((list, kind) =>
    list.map((label, i) => [label, kind * 1000 + i] as const)
  )
);

const FORMATS = new Set(FORMAT_LABELS);

export interface SortedTags {
  /** The book's format tags, in the vocabulary's order (one for every book stage 5 processed). */
  formats: string[];
  /** Every other tag: the known kinds in order, then the rest in Calibre's order. */
  others: string[];
}

export function sortTags(tags: readonly string[]): SortedTags {
  const formats = FORMAT_LABELS.filter((label) => tags.includes(label));
  const known: string[] = [];
  const rest: string[] = [];
  for (const tag of tags) {
    if (FORMATS.has(tag)) continue;
    (RANK.has(tag) ? known : rest).push(tag);
  }
  known.sort((a, b) => RANK.get(a)! - RANK.get(b)!);
  return { formats, others: [...known, ...rest] };
}
