/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Library sorts (WP19a). The server sorts (GET /books?sort=&dir=, GET /groups?sort=&dir=);
 * this module names them for the Sort menu and the address (?sort=title-asc).
 *
 * Contexts:
 * - books: the All tab, an author or tag, a saved search or built-in collection.
 * - series: one series; its own order ("Series order") comes first and is the default.
 * - list: a manual collection; its own order ("Collection order") comes first and is the
 *   default (the device's order, with Reorder).
 * - completed: the built-in Completed collection; "Date completed" comes first, newest first,
 *   and is the default there.
 * - groups: the Series, Authors and Tags tabs.
 * - notes-books, notes-highlights: the Notes page's two views (sorted on the device; the
 *   last pick per view is remembered there, `notesBookSort` / `notesHighlightSort`).
 *
 * The last book sort picked outside a series or list is remembered per device
 * (`librarySort`), the last group sort too (`libraryGroupSort`). A series or a list always
 * opens in its own order unless the address says otherwise.
 */

export type BookSortKey =
  | 'added'
  | 'title'
  | 'author'
  | 'chars'
  | 'published'
  | 'level'
  | 'rating'
  | 'ratings'
  | 'readers'
  | 'completed';

/** The store ratings' sorts (the cards show their figure only under these). */
export const RATING_SORT_KEYS: readonly BookSortKey[] = ['rating', 'ratings', 'readers'];
export type GroupSortKey = 'newest' | 'name' | 'count';
export type SortDir = 'asc' | 'desc';

/** A sort as the server takes it. */
export interface ServerSort<K extends string> {
  key: K;
  dir: SortDir;
}

export type SortContext =
  | 'books'
  | 'completed'
  | 'series'
  | 'list'
  | 'groups'
  | 'notes-books'
  | 'notes-highlights';

/** One entry of the Sort menu; `own` is the series or collection order (no server sort). */
export interface SortChoice {
  key: string;
  label: string;
  /** Labels of ascending and descending, e.g. "A → Z" / "Z → A". */
  dirLabels: Record<SortDir, string>;
  /** The direction picked first. */
  defaultDir: SortDir;
  own?: boolean;
}

const BOOK_CHOICES: SortChoice[] = [
  {
    key: 'added',
    label: 'Date added',
    dirLabels: { asc: 'Oldest first', desc: 'Newest first' },
    defaultDir: 'desc'
  },
  { key: 'title', label: 'Title', dirLabels: { asc: 'A → Z', desc: 'Z → A' }, defaultDir: 'asc' },
  { key: 'author', label: 'Author', dirLabels: { asc: 'A → Z', desc: 'Z → A' }, defaultDir: 'asc' },
  {
    key: 'chars',
    label: 'Length',
    dirLabels: { asc: 'Shortest first', desc: 'Longest first' },
    defaultDir: 'desc'
  },
  {
    key: 'published',
    label: 'Publication date',
    dirLabels: { asc: 'Oldest first', desc: 'Newest first' },
    defaultDir: 'desc'
  },
  {
    key: 'level',
    label: 'Natively level',
    dirLabels: { asc: 'Easiest first', desc: 'Hardest first' },
    defaultDir: 'asc'
  },
  // Store ratings (2026-11-25): readers' stars (few ratings pulled toward the middle), how many
  // rated it, and 読書メーター's readers (shown only while 読書メーター is on: sortChoices).
  {
    key: 'rating',
    label: 'Rating',
    dirLabels: { asc: 'Lowest first', desc: 'Highest first' },
    defaultDir: 'desc'
  },
  {
    key: 'ratings',
    label: 'Most rated',
    dirLabels: { asc: 'Fewest first', desc: 'Most first' },
    defaultDir: 'desc'
  },
  {
    key: 'readers',
    label: 'Most read',
    dirLabels: { asc: 'Fewest first', desc: 'Most first' },
    defaultDir: 'desc'
  }
];

/** Date completed: offered only in the Completed collection, where it is the default. */
const COMPLETED_CHOICE: SortChoice = {
  key: 'completed',
  label: 'Date completed',
  dirLabels: { asc: 'Oldest first', desc: 'Newest first' },
  defaultDir: 'desc'
};

const GROUP_CHOICES: SortChoice[] = [
  {
    key: 'newest',
    label: 'Recently added',
    dirLabels: { asc: 'Oldest first', desc: 'Newest first' },
    defaultDir: 'desc'
  },
  { key: 'name', label: 'Name', dirLabels: { asc: 'A → Z', desc: 'Z → A' }, defaultDir: 'asc' },
  {
    key: 'count',
    label: 'Number of books',
    dirLabels: { asc: 'Fewest first', desc: 'Most first' },
    defaultDir: 'desc'
  }
];

/** The Notes page's Books view (lib/notes/notes-view.ts sorts by these keys). */
const NOTES_BOOK_CHOICES: SortChoice[] = [
  {
    key: 'changed',
    label: 'Recently changed',
    dirLabels: { asc: 'Oldest first', desc: 'Newest first' },
    defaultDir: 'desc'
  },
  { key: 'title', label: 'Title', dirLabels: { asc: 'A → Z', desc: 'Z → A' }, defaultDir: 'asc' },
  { key: 'author', label: 'Author', dirLabels: { asc: 'A → Z', desc: 'Z → A' }, defaultDir: 'asc' },
  {
    key: 'series',
    label: 'Series',
    dirLabels: { asc: 'A → Z', desc: 'Z → A' },
    defaultDir: 'asc'
  },
  {
    key: 'count',
    label: 'Number of highlights',
    dirLabels: { asc: 'Fewest first', desc: 'Most first' },
    defaultDir: 'desc'
  }
];

/** The Notes page's Highlights view. */
const NOTES_HIGHLIGHT_CHOICES: SortChoice[] = [
  {
    key: 'created',
    label: 'Date highlighted',
    dirLabels: { asc: 'Oldest first', desc: 'Newest first' },
    defaultDir: 'desc'
  },
  {
    key: 'book',
    label: 'Book',
    dirLabels: { asc: 'A → Z', desc: 'Z → A' },
    defaultDir: 'asc'
  }
];

const OWN_LABEL: Record<'series' | 'list', string> = {
  series: 'Series order',
  list: 'Collection order'
};

/** What the Sort menu offers in a context. */
export function sortChoices(context: SortContext): SortChoice[] {
  if (context === 'groups') return GROUP_CHOICES;
  if (context === 'books') return BOOK_CHOICES;
  if (context === 'completed') return [COMPLETED_CHOICE, ...BOOK_CHOICES];
  if (context === 'notes-books') return NOTES_BOOK_CHOICES;
  if (context === 'notes-highlights') return NOTES_HIGHLIGHT_CHOICES;
  return [
    {
      key: context,
      label: OWN_LABEL[context],
      dirLabels: { asc: '', desc: '' },
      defaultDir: 'asc',
      own: true
    },
    ...BOOK_CHOICES
  ];
}

/** A picked sort: a choice's key and a direction (the own order has no direction). */
export interface SortValue {
  key: string;
  dir: SortDir;
}

export const DEFAULT_BOOK_SORT: SortValue = { key: 'added', dir: 'desc' };
export const DEFAULT_GROUP_SORT: SortValue = { key: 'newest', dir: 'desc' };

/** The sort a context starts with when the address has none. */
export function defaultSort(
  context: SortContext,
  remembered: { books: string; groups: string }
): SortValue {
  if (context === 'series' || context === 'list') return { key: context, dir: 'asc' };
  // The Completed collection always opens newest completed first (not the device's last pick).
  if (context === 'completed') return { key: 'completed', dir: 'desc' };
  if (context === 'groups') return parseSort(remembered.groups, 'groups') ?? DEFAULT_GROUP_SORT;
  return parseSort(remembered.books, 'books') ?? DEFAULT_BOOK_SORT;
}

/** "title-asc" (or "series" for the own order); null when it isn't valid in the context. */
export function parseSort(text: string | null | undefined, context: SortContext): SortValue | null {
  if (!text) return null;
  const choices = sortChoices(context);
  const own = choices.find((c) => c.own && c.key === text);
  if (own) return { key: own.key, dir: 'asc' };
  const m = /^([a-z]+)-(asc|desc)$/.exec(text);
  if (!m) return null;
  const choice = choices.find((c) => !c.own && c.key === m[1]);
  return choice ? { key: choice.key, dir: m[2] as SortDir } : null;
}

export function formatSort(value: SortValue, context: SortContext): string {
  const choice = sortChoices(context).find((c) => c.key === value.key);
  return choice?.own ? choice.key : `${value.key}-${value.dir}`;
}

export function sameSort(a: SortValue, b: SortValue): boolean {
  return a.key === b.key && (a.dir === b.dir || a.key === 'series' || a.key === 'list');
}

/** What the server is asked for: nothing for the own order. */
export function serverSort(value: SortValue, context: SortContext): ServerSort<string> | undefined {
  const choice = sortChoices(context).find((c) => c.key === value.key);
  if (!choice || choice.own) return undefined;
  return { key: value.key, dir: value.dir };
}

/** The Sort button's text, e.g. "Title · A → Z" or "Series order". */
export function sortLabel(value: SortValue, context: SortContext): string {
  const choice = sortChoices(context).find((c) => c.key === value.key);
  if (!choice) return '';
  return choice.own ? choice.label : `${choice.label} · ${choice.dirLabels[value.dir]}`;
}

/** Picking a key keeps the direction when it is the same key, else uses the key's default. */
export function pickKey(current: SortValue, key: string, context: SortContext): SortValue {
  const choice = sortChoices(context).find((c) => c.key === key);
  if (!choice) return current;
  if (current.key === key) return current;
  return { key, dir: choice.defaultDir };
}
