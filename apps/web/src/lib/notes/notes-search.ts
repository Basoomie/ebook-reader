/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { searchKey } from '$lib/settings/paged-list';

/**
 * Notes at scale (2026-11-21): the search's words marked in a highlight or note. The
 * search folds text (width, case, katakana as hiragana: `searchKey`), so the marks are
 * found in a folded copy that remembers where each folded character came from.
 */

export interface MarkPart {
  text: string;
  hit: boolean;
}

/** Combining marks stay with the character before them (ｶﾞ folds to が as one). */
const MARK = /^[\p{M}ﾞﾟ]$/u;

/** The folded text and, per folded UTF-16 unit, the start of its source in `text`. */
function foldWithMap(text: string): { key: string; from: number[] } {
  const chars = Array.from(text);
  let key = '';
  const from: number[] = [];
  let pos = 0;

  for (let i = 0; i < chars.length; ) {
    const start = pos;
    let cluster = chars[i];
    pos += chars[i].length;
    i += 1;
    while (i < chars.length && MARK.test(chars[i])) {
      cluster += chars[i];
      pos += chars[i].length;
      i += 1;
    }
    const f = searchKey(cluster);
    key += f;
    for (let u = 0; u < f.length; u += 1) from.push(start);
  }

  from.push(text.length);
  return { key, from };
}

/** Where `text` ends the cluster that holds folded unit `unit` (exclusive). */
function endOf(from: number[], unit: number) {
  const start = from[unit];
  let u = unit + 1;
  while (u < from.length - 1 && from[u] === start) u += 1;
  return from[u];
}

/** `text` split into plain and marked parts; one plain part when nothing matches. */
export function markParts(text: string, words: readonly string[]): MarkPart[] {
  const wanted = words.filter(Boolean);
  if (!text || !wanted.length) return [{ text, hit: false }];

  const { key, from } = foldWithMap(text);
  const hits: [number, number][] = [];

  for (const word of wanted) {
    for (let at = key.indexOf(word); at >= 0; at = key.indexOf(word, at + 1)) {
      hits.push([from[at], endOf(from, at + word.length - 1)]);
    }
  }

  if (!hits.length) return [{ text, hit: false }];

  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [s, e] of hits) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const parts: MarkPart[] = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) parts.push({ text: text.slice(pos, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
  return parts;
}
