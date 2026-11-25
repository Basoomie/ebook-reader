/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { sortTags } from './tag-kinds';

describe('sortTags', () => {
  it('takes the format out and orders genres, subjects, story tags, adaptations, then the rest', () => {
    const tags = [
      '友情',
      'お気に入り',
      'アニメ化',
      'ライトノベル',
      '恋愛',
      'ファンタジー',
      '転生',
      '読了'
    ];
    expect(sortTags(tags)).toEqual({
      formats: ['ライトノベル'],
      others: ['ファンタジー', '恋愛', '転生', '友情', 'アニメ化', 'お気に入り', '読了']
    });
  });

  it('keeps every format a book has, in the vocabulary order', () => {
    expect(sortTags(['画像のみ', 'マンガ']).formats).toEqual(['マンガ', '画像のみ']);
  });

  it('gives no format for a book stage 5 never tagged', () => {
    expect(sortTags(['b', 'a'])).toEqual({ formats: [], others: ['b', 'a'] });
    expect(sortTags([])).toEqual({ formats: [], others: [] });
  });

  it('orders subjects after genres (恋愛 the genre, 恋愛・人間関係 the subject)', () => {
    expect(sortTags(['エッセイ', '恋愛・人間関係', 'ノンフィクション']).others).toEqual([
      '恋愛・人間関係',
      'エッセイ'
    ]);
  });
});
