/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Settings page's long lists (linked audiobooks, devices, sent messages, pronunciation
 * fixes, …): search, one filter, one sort and pages, so a list never makes the page grow
 * with the library. Pure: the list component (settings/paged-list.svelte) only draws it.
 */

export interface ListSort<T> {
  id: string;
  label: string;
  compare: (a: T, b: T) => number;
}

export interface ListFilter<T> {
  id: string;
  label: string;
  test: (item: T) => boolean;
  testid?: string;
}

export interface PageRequest<T> {
  query?: string;
  /** The searchable text of an item (title, author, folder, …). */
  text?: (item: T) => string;
  filter?: ListFilter<T> | null;
  sort?: ListSort<T> | null;
  /** 1-based; clamped to the pages there are. */
  page: number;
  pageSize: number;
}

export interface PageResult<T> {
  rows: T[];
  /** Items after the filter and the search. */
  matched: number;
  /** Items before the filter and the search. */
  total: number;
  /** The page shown (1-based, clamped). */
  page: number;
  /** At least 1. */
  pages: number;
  /** Index of the first row in the matched list (0-based). */
  start: number;
}

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;

/**
 * Text for matching: NFKC (full-width letters and digits, half-width kana), lower case,
 * katakana as hiragana, so 「ハルヒ」 finds 「はるひ」 and ＡＢＣ finds abc.
 */
export function searchKey(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of folded) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

/** The query's words, each folded like `searchKey`. */
export function queryWords(query: string): string[] {
  return searchKey(query).split(/\s+/).filter(Boolean);
}

/** True when every word of the query is in the text (any order). */
export function matchesQuery(text: string, words: string[]): boolean {
  if (!words.length) return true;
  const key = searchKey(text);
  return words.every((w) => key.includes(w));
}

export function pageOf<T>(items: readonly T[], request: PageRequest<T>): PageResult<T> {
  const pageSize = Math.max(1, Math.floor(request.pageSize) || 1);
  let list: T[] = request.filter ? items.filter(request.filter.test) : [...items];
  const words = queryWords(request.query ?? '');
  if (words.length && request.text) {
    const text = request.text;
    list = list.filter((item) => matchesQuery(text(item), words));
  }
  if (request.sort) list.sort(request.sort.compare);
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(request.page) || 1), pages);
  const start = (page - 1) * pageSize;
  return {
    rows: list.slice(start, start + pageSize),
    matched: list.length,
    total: items.length,
    page,
    pages,
    start
  };
}

/** "21–40 of 4,812" (an en dash), or "" when nothing matched. */
export function rangeText(result: Pick<PageResult<unknown>, 'start' | 'rows' | 'matched'>): string {
  if (!result.matched) return '';
  const first = result.start + 1;
  const last = result.start + result.rows.length;
  return `${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${result.matched.toLocaleString('en-US')}`;
}

/** Japanese-aware text order for sorts by title or name. */
export const compareText = (a: string, b: string): number =>
  a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
