/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

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
  colors: ReadonlySet<HighlightColor>;
  /** Only highlights this device couldn't place in its copy of the book. */
  unplacedOnly: boolean;
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
}

export const EMPTY_FILTER: NotesFilter = {
  book: null,
  series: null,
  colors: new Set(),
  unplacedOnly: false
};

/** Reads `?book=&series=&color=1,3&unplaced=1` (unknown values are ignored). */
export function parseNotesFilter(params: URLSearchParams): NotesFilter {
  const colors = new Set<HighlightColor>();

  for (const part of (params.get('color') ?? '').split(',')) {
    const color = Number(part);

    if (part && isHighlightColor(color)) {
      colors.add(color);
    }
  }

  return {
    book: params.get('book') || null,
    series: params.get('series') || null,
    colors,
    unplacedOnly: params.get('unplaced') === '1'
  };
}

/** The query string of a filter (empty for no filter), for links and the address bar. */
export function notesFilterQuery(filter: NotesFilter): string {
  const params = new URLSearchParams();

  if (filter.book) params.set('book', filter.book);
  if (filter.series) params.set('series', filter.series);
  if (filter.colors.size) {
    params.set('color', HIGHLIGHT_COLORS.filter((c) => filter.colors.has(c)).join(','));
  }
  if (filter.unplacedOnly) params.set('unplaced', '1');

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function isFiltered(filter: NotesFilter) {
  return !!(filter.book || filter.series || filter.colors.size || filter.unplacedOnly);
}

/** Info for a book the catalog didn't return. */
export function unknownBookInfo(id: string, title?: string | null): NotesBookInfo {
  return { id, title: title || 'Unknown book', series: null, charCount: null, unknown: true };
}

function compareTitles(a: NotesBookInfo, b: NotesBookInfo) {
  return a.title.localeCompare(b.title, 'ja') || (a.id < b.id ? -1 : 1);
}

/** Series order: by volume number (unnumbered last), then title. */
export function bySeriesOrder(a: NotesBookInfo, b: NotesBookInfo) {
  const ai = a.series?.index ?? Number.POSITIVE_INFINITY;
  const bi = b.series?.index ?? Number.POSITIVE_INFINITY;
  return ai === bi ? compareTitles(a, b) : ai - bi;
}

export interface NotesViewOptions {
  /**
   * Book order to use (the Library's series order); books not in it follow in series
   * order. Without it, a series filter sorts by volume and everything else by the newest
   * change.
   */
  order?: readonly string[];
}

/**
 * The books with highlights or notes that pass the filter, each with its highlights in
 * place order (and their notes) and its book notes. A color or "couldn't place" filter
 * leaves out notes about the book (they have no color or place).
 */
export function buildNotesView(
  all: ReadonlyMap<string, BookNotes>,
  info: ReadonlyMap<string, NotesBookInfo>,
  unplaced: ReadonlySet<string>,
  filter: NotesFilter,
  options: NotesViewOptions = {}
): NotesBookGroup[] {
  const groups: NotesBookGroup[] = [];
  const onlyHighlights = filter.colors.size > 0 || filter.unplacedOnly;

  for (const [bookId, entry] of all) {
    if (filter.book && bookId !== filter.book) continue;

    const book = info.get(bookId) ?? unknownBookInfo(bookId);

    if (filter.series && book.series?.name !== filter.series) continue;

    const highlights = entry.highlights
      .filter((h) => !filter.colors.size || filter.colors.has(h.color))
      .map((item) => ({ item, unplaced: unplaced.has(item.id) }))
      .filter((row) => !filter.unplacedOnly || row.unplaced);
    const notes = onlyHighlights ? [] : entry.notes;

    if (!highlights.length && !notes.length) continue;

    groups.push({ info: book, highlights, notes, lastChange: lastChangeOf(entry) });
  }

  if (options.order) {
    const rank = new Map(options.order.map((id, i) => [id, i]));
    return groups.sort((a, b) => {
      const ra = rank.get(a.info.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.info.id) ?? Number.POSITIVE_INFINITY;
      return ra === rb ? bySeriesOrder(a.info, b.info) : ra - rb;
    });
  }

  if (filter.series) {
    return groups.sort((a, b) => bySeriesOrder(a.info, b.info));
  }

  return groups.sort((a, b) => b.lastChange - a.lastChange || (a.info.id < b.info.id ? -1 : 1));
}

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

  return [...names].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** Highlight count over some books (the Library's "Highlights (N)"). */
export function highlightCount(all: ReadonlyMap<string, BookNotes>, bookIds: readonly string[]) {
  return bookIds.reduce((sum, id) => sum + (all.get(id)?.highlights.length ?? 0), 0);
}

/** "34.5%" of a position in a book, or '' when the length is unknown. */
export function percentOf(position: number, charCount: number | null) {
  if (!charCount || charCount <= 0) return '';
  return `${Math.min(100, Math.max(0, (position / charCount) * 100)).toFixed(1)}%`;
}
