/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { pageOf, type ListPage } from '$lib/functions/paginate';
import { parseSort, type SortValue } from '$lib/library/sort';
import { compareText, queryWords, searchKey } from '$lib/settings/paged-list';
import {
  HIGHLIGHT_COLORS,
  isHighlightColor,
  lastChangeOf,
  type BookNotes,
  type HighlightColor,
  type HighlightItem,
  type NoteItem
} from './highlights';

/**
 * WP11c: the Notes page and the Library's series "Highlights" section (pure). Records come
 * from the local mirror (`notesByBook`); book titles, series and lengths from the
 * catalog, with offline fallbacks.
 *
 * Notes at scale (2026-11-21): a search over highlights, notes, chapters and the books'
 * titles, authors and series (folded like the Settings lists: width, case, katakana as
 * hiragana); "With a note" and "No series" filters; sorts for the Books and Highlights
 * views; pages (20 books, 25 highlights) kept in the address.
 */

export interface NotesBookInfo {
  id: string;
  title: string;
  series: { name: string; index: number | null } | null;
  /** The book's length in characters, for percents; null when unknown. */
  charCount: number | null;
  /** True when the catalog doesn't know the book (offline, hidden, removed). */
  unknown?: boolean;
  /** WP19d: author names (empty or missing when unknown). */
  authors?: string[];
  /** WP19d: absolute cover thumbnail URL, or null/missing for none. */
  thumbnail?: string | null;
}

export interface NotesFilter {
  book: string | null;
  series: string | null;
  /** Only books without a series (the Series picker's "No series"). */
  noSeries: boolean;
  colors: ReadonlySet<HighlightColor>;
  /** Only highlights with a note. */
  withNote: boolean;
  /** Only highlights this device couldn't place in its copy of the book. */
  unplacedOnly: boolean;
  /** The search box's text (as typed). */
  query: string;
}

export type NotesViewMode = 'books' | 'highlights';

/** Everything the Notes page keeps in its address. */
export interface NotesPageState {
  filter: NotesFilter;
  view: NotesViewMode;
  /** The sort the address names, or null for the view's default. */
  sort: SortValue | null;
  /** 1-based. */
  page: number;
}

export interface NotesHighlightRow {
  item: HighlightItem;
  /** This device couldn't place it in its copy of the book. */
  unplaced: boolean;
}

export interface NotesBookGroup {
  info: NotesBookInfo;
  highlights: NotesHighlightRow[];
  /** Notes about the book (and notes whose highlight is gone). */
  notes: NoteItem[];
  lastChange: number;
  /** Highlights and book notes the book has before the search and filters. */
  total: number;
  /** What the search found: the book itself (all shown), some of its items, or no search. */
  hit: 'book' | 'items' | null;
}

export const NOTES_BOOKS_PER_PAGE = 20;
export const NOTES_HIGHLIGHTS_PER_PAGE = 25;
/** Highlights shown at a time inside an opened book. */
export const NOTES_IN_BOOK_PER_PAGE = 20;

export const EMPTY_FILTER: NotesFilter = {
  book: null,
  series: null,
  noSeries: false,
  colors: new Set(),
  withNote: false,
  unplacedOnly: false,
  query: ''
};

/** Reads `?book=&series=&noseries=1&color=1,3&note=1&unplaced=1&q=` (unknown values are ignored). */
export function parseNotesFilter(params: URLSearchParams): NotesFilter {
  const colors = new Set<HighlightColor>();

  for (const part of (params.get('color') ?? '').split(',')) {
    const color = Number(part);

    if (part && isHighlightColor(color)) {
      colors.add(color);
    }
  }

  const series = params.get('series') || null;

  return {
    book: params.get('book') || null,
    series,
    noSeries: !series && params.get('noseries') === '1',
    colors,
    withNote: params.get('note') === '1',
    unplacedOnly: params.get('unplaced') === '1',
    query: params.get('q') ?? ''
  };
}

function filterParams(filter: NotesFilter): URLSearchParams {
  const params = new URLSearchParams();

  if (filter.query.trim()) params.set('q', filter.query.trim());
  if (filter.book) params.set('book', filter.book);
  if (filter.series) params.set('series', filter.series);
  else if (filter.noSeries) params.set('noseries', '1');
  if (filter.colors.size) {
    params.set('color', HIGHLIGHT_COLORS.filter((c) => filter.colors.has(c)).join(','));
  }
  if (filter.withNote) params.set('note', '1');
  if (filter.unplacedOnly) params.set('unplaced', '1');

  return params;
}

function queryString(params: URLSearchParams) {
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The query string of a filter (empty for no filter), for links and the address bar. */
export function notesFilterQuery(filter: NotesFilter): string {
  return queryString(filterParams(filter));
}

/** The address of the whole page: the filter, then the view, the sort and the page. */
export function parseNotesPage(params: URLSearchParams): NotesPageState {
  const view: NotesViewMode = params.get('view') === 'highlights' ? 'highlights' : 'books';
  const page = Math.floor(Number(params.get('page')));

  return {
    filter: parseNotesFilter(params),
    view,
    sort: parseSort(params.get('sort'), view === 'books' ? 'notes-books' : 'notes-highlights'),
    page: Number.isFinite(page) && page >= 1 ? page : 1
  };
}

export function notesPageQuery(state: NotesPageState): string {
  const params = filterParams(state.filter);

  if (state.view === 'highlights') params.set('view', 'highlights');
  if (state.sort) params.set('sort', `${state.sort.key}-${state.sort.dir}`);
  if (state.page > 1) params.set('page', String(state.page));

  return queryString(params);
}

/** Any narrowing at all, the search included (for "Nothing matches"). */
export function isFiltered(filter: NotesFilter) {
  return !!filter.query.trim() || activeFilterCount(filter) > 0;
}

/** How many filters are on, the search left out (the "Filters (N)" button). */
export function activeFilterCount(filter: NotesFilter) {
  return (
    (filter.book ? 1 : 0) +
    (filter.series || filter.noSeries ? 1 : 0) +
    filter.colors.size +
    (filter.withNote ? 1 : 0) +
    (filter.unplacedOnly ? 1 : 0)
  );
}

/** Info for a book the catalog didn't return. */
export function unknownBookInfo(id: string, title?: string | null): NotesBookInfo {
  return { id, title: title || 'Unknown book', series: null, charCount: null, unknown: true };
}

function compareTitles(a: NotesBookInfo, b: NotesBookInfo) {
  return compareText(a.title, b.title) || (a.id < b.id ? -1 : 1);
}

/** Series order: by volume number (unnumbered last), then title. */
export function bySeriesOrder(a: NotesBookInfo, b: NotesBookInfo) {
  const ai = a.series?.index ?? Number.POSITIVE_INFINITY;
  const bi = b.series?.index ?? Number.POSITIVE_INFINITY;
  return ai === bi ? compareTitles(a, b) : ai - bi;
}

// ---- Search ----------------------------------------------------------------------------

/**
 * Folded search text per record or book object. The mirror gives new objects only when
 * something changed, so typing never folds the same text twice.
 */
const folded = new WeakMap<object, string>();

function foldedOf(object: object, text: () => string): string {
  let key = folded.get(object);
  if (key === undefined) {
    key = searchKey(text());
    folded.set(object, key);
  }
  return key;
}

const bookKey = (book: NotesBookInfo) =>
  foldedOf(book, () => [book.title, ...(book.authors ?? []), book.series?.name ?? ''].join('\n'));

const highlightKey = (item: HighlightItem) =>
  foldedOf(item, () => [item.text, item.note?.body ?? '', item.chapter ?? ''].join('\n'));

const noteKey = (note: NoteItem) => foldedOf(note, () => [note.body, note.quote ?? ''].join('\n'));

/** Every word is in the book's own text or the item's (a word may be in either). */
function itemMatches(words: readonly string[], book: string, item: string) {
  return words.every((w) => book.includes(w) || item.includes(w));
}

// ---- Books view --------------------------------------------------------------------------

export interface NotesViewOptions {
  /**
   * Book order to use (the Library's series order); books not in it follow in series
   * order. Without it, the sort is used; without that, a series filter sorts by volume and
   * everything else by the newest change.
   */
  order?: readonly string[];
  sort?: SortValue | null;
}

/** The Books view's sort when the address names none. */
export function defaultBookSort(filter: NotesFilter, remembered?: string | null): SortValue {
  if (filter.series) return { key: 'series', dir: 'asc' };
  return parseSort(remembered, 'notes-books') ?? { key: 'changed', dir: 'desc' };
}

/** The Highlights view's sort when the address names none. */
export function defaultHighlightSort(remembered?: string | null): SortValue {
  return parseSort(remembered, 'notes-highlights') ?? { key: 'created', dir: 'desc' };
}

function authorOf(book: NotesBookInfo) {
  return (book.authors ?? [])[0] ?? '';
}

/** Missing values (no author, no series) go last in either direction. */
function compareMaybe(a: string, b: string, dir: number) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return dir * compareText(a, b);
}

function bookComparator(sort: SortValue): (a: NotesBookGroup, b: NotesBookGroup) => number {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const byId = (a: NotesBookGroup, b: NotesBookGroup) => (a.info.id < b.info.id ? -1 : 1);

  switch (sort.key) {
    case 'title':
      return (a, b) => dir * compareTitles(a.info, b.info);
    case 'author':
      return (a, b) =>
        compareMaybe(authorOf(a.info), authorOf(b.info), dir) || compareTitles(a.info, b.info);
    case 'series':
      return (a, b) =>
        compareMaybe(a.info.series?.name ?? '', b.info.series?.name ?? '', dir) ||
        bySeriesOrder(a.info, b.info);
    case 'count':
      return (a, b) =>
        dir * (a.highlights.length - b.highlights.length) ||
        b.lastChange - a.lastChange ||
        byId(a, b);
    default:
      return (a, b) => dir * (a.lastChange - b.lastChange) || byId(a, b);
  }
}

/**
 * The books with highlights or notes that pass the filter and the search, each with its
 * highlights in place order (and their notes) and its book notes. A color, "With a note"
 * or "couldn't place" filter leaves out notes about the book (they have no color, are
 * notes themselves, and have no place). When the search matches a book's title, author or
 * series, all of its (filtered) items show; otherwise only the items that match.
 */
export function buildNotesView(
  all: ReadonlyMap<string, BookNotes>,
  info: ReadonlyMap<string, NotesBookInfo>,
  unplaced: ReadonlySet<string>,
  filter: NotesFilter,
  options: NotesViewOptions = {}
): NotesBookGroup[] {
  const groups: NotesBookGroup[] = [];
  const onlyHighlights = filter.colors.size > 0 || filter.unplacedOnly || filter.withNote;
  const words = queryWords(filter.query);

  for (const [bookId, entry] of all) {
    if (filter.book && bookId !== filter.book) continue;

    const book = info.get(bookId) ?? unknownBookInfo(bookId);

    if (filter.series && book.series?.name !== filter.series) continue;
    if (filter.noSeries && book.series) continue;

    let highlights = entry.highlights
      .filter((h) => !filter.colors.size || filter.colors.has(h.color))
      .filter((h) => !filter.withNote || !!h.note)
      .map((item) => ({ item, unplaced: unplaced.has(item.id) }))
      .filter((row) => !filter.unplacedOnly || row.unplaced);
    let notes = onlyHighlights ? [] : entry.notes;
    let hit: NotesBookGroup['hit'] = null;

    if (words.length) {
      const key = bookKey(book);

      if (words.every((w) => key.includes(w))) {
        hit = 'book';
      } else {
        hit = 'items';
        highlights = highlights.filter((row) => itemMatches(words, key, highlightKey(row.item)));
        notes = notes.filter((note) => itemMatches(words, key, noteKey(note)));
      }
    }

    if (!highlights.length && !notes.length) continue;

    groups.push({
      info: book,
      highlights,
      notes,
      lastChange: lastChangeOf(entry),
      total: entry.highlights.length + entry.notes.length,
      hit
    });
  }

  if (options.order) {
    const rank = new Map(options.order.map((id, i) => [id, i]));
    return groups.sort((a, b) => {
      const ra = rank.get(a.info.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.info.id) ?? Number.POSITIVE_INFINITY;
      return ra === rb ? bySeriesOrder(a.info, b.info) : ra - rb;
    });
  }

  return groups.sort(bookComparator(options.sort ?? defaultBookSort(filter)));
}

/** Highlights and notes shown for a book (a highlight's note counts as a note). */
export function groupCounts(group: Pick<NotesBookGroup, 'highlights' | 'notes'>) {
  return {
    highlights: group.highlights.length,
    notes: group.notes.length + group.highlights.filter((r) => r.item.note).length
  };
}

/** Totals over the books shown (all pages). */
export function viewTotals(groups: readonly NotesBookGroup[]) {
  let highlights = 0;
  let notes = 0;
  for (const g of groups) {
    const c = groupCounts(g);
    highlights += c.highlights;
    notes += c.notes;
  }
  return { books: groups.length, highlights, notes };
}

// ---- Highlights view ---------------------------------------------------------------------

/** One card of the Highlights view: a highlight (with its note) or a note about a book. */
export interface NotesFlatRow {
  key: string;
  book: NotesBookInfo;
  highlight: NotesHighlightRow | null;
  note: NoteItem | null;
  createdAt: number;
}

/**
 * Every highlight and book note of the books shown, as one list: newest or oldest first
 * (by when it was made), or by book (title, then place in the book, then its notes).
 */
export function flattenNotesView(
  groups: readonly NotesBookGroup[],
  sort: SortValue
): NotesFlatRow[] {
  const rows: NotesFlatRow[] = [];
  const byBook = sort.key === 'book';
  const ordered = byBook
    ? [...groups].sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * compareTitles(a.info, b.info))
    : groups;

  for (const g of ordered) {
    for (const row of g.highlights) {
      rows.push({
        key: row.item.id,
        book: g.info,
        highlight: row,
        note: null,
        createdAt: row.item.createdAt
      });
    }
    for (const note of g.notes) {
      rows.push({ key: note.id, book: g.info, highlight: null, note, createdAt: note.createdAt });
    }
  }

  if (byBook) return rows;

  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => dir * (a.createdAt - b.createdAt) || (a.key < b.key ? -1 : 1));
}

// ---- Pages ---------------------------------------------------------------------------------

/** One page (1-based, as in the address); clamped to the pages there are. */
export function notesPage<T>(items: readonly T[], page: number, size: number): ListPage<T> {
  return pageOf(items, page - 1, size);
}

// ---- Pickers -------------------------------------------------------------------------------

/** Books (with highlights or notes) for the book picker, by title. */
export function bookChoices(
  all: ReadonlyMap<string, BookNotes>,
  info: ReadonlyMap<string, NotesBookInfo>
): NotesBookInfo[] {
  return [...all.keys()].map((id) => info.get(id) ?? unknownBookInfo(id)).sort(compareTitles);
}

/** Series of the books with highlights or notes, by name. */
export function seriesChoices(
  all: ReadonlyMap<string, BookNotes>,
  info: ReadonlyMap<string, NotesBookInfo>
): string[] {
  const names = new Set<string>();

  for (const id of all.keys()) {
    const name = info.get(id)?.series?.name;
    if (name) names.add(name);
  }

  return [...names].sort(compareText);
}

/** Highlights per series name ('' for books without a series), for the picker's counts. */
export function seriesHighlightCounts(
  all: ReadonlyMap<string, BookNotes>,
  info: ReadonlyMap<string, NotesBookInfo>
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const [id, entry] of all) {
    const name = info.get(id)?.series?.name ?? '';
    counts.set(name, (counts.get(name) ?? 0) + entry.highlights.length + entry.notes.length);
  }

  return counts;
}

/** Highlight count over some books (the Library's "Highlights (N)"). */
export function highlightCount(all: ReadonlyMap<string, BookNotes>, bookIds: readonly string[]) {
  return bookIds.reduce((sum, id) => sum + (all.get(id)?.highlights.length ?? 0), 0);
}

/** Highlights this device couldn't place that still exist (the filter is offered only then). */
export function unplacedCount(all: ReadonlyMap<string, BookNotes>, unplaced: ReadonlySet<string>) {
  if (!unplaced.size) return 0;
  let n = 0;
  for (const entry of all.values()) {
    for (const h of entry.highlights) if (unplaced.has(h.id)) n += 1;
  }
  return n;
}

/** "Series #2" (or the name alone without a number), '' without a series. */
export function seriesLine(book: NotesBookInfo) {
  if (!book.series) return '';
  return book.series.index === null
    ? book.series.name
    : `${book.series.name} #${book.series.index}`;
}

/** The book line on a card of the Highlights view: "Title · Series #2". */
export function cardBookLine(book: NotesBookInfo) {
  return [book.title, seriesLine(book)].filter(Boolean).join(' · ');
}

/** "34.5%" of a position in a book, or '' when the length is unknown. */
export function percentOf(position: number, charCount: number | null) {
  if (!charCount || charCount <= 0) return '';
  return `${Math.min(100, Math.max(0, (position / charCount) * 100)).toFixed(1)}%`;
}
