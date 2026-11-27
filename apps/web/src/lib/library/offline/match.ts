/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { Matcher, ParsedQuery, QueryTerm, TextField } from '$lib/library/query/parse';
import type { CatalogBook } from '$lib/library/types';
import type { BookState } from '$lib/sync/book-state';
import { figureMatches, type FigureKey } from '$lib/library/series-figures';

/**
 * The library search evaluated on the device (offline Library), term by term the same as
 * the server's SQL (apps/storage-server/src/catalog/search-sql.ts):
 *
 * - text and `=` compare folded text (NFKC, then lower case; the server's fold.ts), so
 *   full-width and half-width letters and digits match alike; /patterns/ (Unicode mode,
 *   optional i) run on the original text;
 * - plain text: the title, the series name or any author or illustrator name (not tags);
 * - chars: books without a count never match, negated or not;
 * - level: the Natively level; books without one never match, negated or not;
 * - status: no record = unread; `next` is the next volume of a series (next-in-series.ts);
 *   favorite: no record = not a favorite;
 * - on:device: the books this device stores (offline, every listed book);
 * - "-" negates a term: NOT IFNULL(cond, 0), so `-series:x` keeps books without a series.
 * - kept: the book's series' "Went on to vol 2"; on the Series tab rating:, ratings: and
 *   readers: test the series' figures (volume 1), not the book (series-figures.ts). Books
 *   without the figure never match, negated or not.
 */

/** The server's fold (catalog/fold.ts, foldForSearch). */
export function foldForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export interface MatchContext {
  states: ReadonlyMap<string, BookState>;
  onDevice(bookId: string): boolean;
  /** Season 2 Phase 9: on:audio, the book's audio is downloaded on this device. */
  audioOnDevice(bookId: string): boolean;
  /** status:next: the next volume of a series you are reading (next-in-series.ts). */
  isNext?(bookId: string): boolean;
  /** bookmeter: the 読書メーター lists the book is on (Bookmeter sync's records). */
  bookmeterLists?(bookId: string): ReadonlySet<string>;
  /**
   * Series figures (series-figures.ts): kept: reads the book's series in its library; with
   * `seriesTab`, rating:/ratings:/readers: read the book's series group. Null: no figure.
   */
  figure?(book: CatalogBook, key: FigureKey): number | null;
  seriesTab?: boolean;
}

const regexCache = new Map<string, RegExp>();

function compiled(source: string, ignoreCase: boolean): RegExp {
  const key = `${ignoreCase ? 'i' : ''}/${source}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(source, ignoreCase ? 'iu' : 'u');
    if (regexCache.size >= 16) regexCache.delete(regexCache.keys().next().value as string);
    regexCache.set(key, re);
  }
  return re;
}

/** One matcher on one stored text (null: no value, never matches). */
export function matchesText(value: string | null | undefined, m: Matcher): boolean {
  if (typeof value !== 'string') return false;
  if (m.kind === 'regex') return compiled(m.source, m.ignoreCase).test(value);
  const folded = foldForSearch(value);
  const term = foldForSearch(m.value);
  return m.exact ? folded === term : folded.includes(term);
}

function anyMatcher(value: string | null | undefined, matchers: readonly Matcher[]): boolean {
  return matchers.some((m) => matchesText(value, m));
}

/** The names a book has for a text field (authors, illustrators and tags without repeats). */
export function fieldNames(book: CatalogBook, field: TextField): string[] {
  switch (field) {
    case 'author':
      return [...new Set(book.authors.map((a) => a.name))];
    case 'illustrator':
      // Absent on copies made before the server sent illustrators: no names.
      return [...new Set(book.illustrators ?? [])];
    case 'series':
      return book.series ? [book.series.name] : [];
    case 'tag':
      return [...new Set(book.tags)];
  }
}

function fieldMatches(book: CatalogBook, field: TextField, matchers: readonly Matcher[]): boolean {
  return fieldNames(book, field).some((name) => anyMatcher(name, matchers));
}

function termMatches(book: CatalogBook, term: QueryTerm, ctx: MatchContext): boolean {
  switch (term.type) {
    case 'any':
      return (
        matchesText(book.title, term.matcher) ||
        fieldMatches(book, 'series', [term.matcher]) ||
        fieldMatches(book, 'author', [term.matcher]) ||
        fieldMatches(book, 'illustrator', [term.matcher])
      );
    case 'field':
      return fieldMatches(book, term.field, term.matchers);
    case 'chars': {
      const n = book.charCount;
      if (n === null || n === undefined) return false;
      return (term.min === null || n >= term.min) && (term.max === null || n <= term.max);
    }
    case 'level': {
      const n = book.nativelyLevel?.level;
      if (n === null || n === undefined) return false;
      return (term.min === null || n >= term.min) && (term.max === null || n <= term.max);
    }
    case 'rating':
    case 'myrating':
    case 'ratings':
    case 'readers': {
      const n = rangeValue(book, term.type);
      if (n === null) return false;
      return (term.min === null || n >= term.min) && (term.max === null || n <= term.max);
    }
    case 'status':
      return (
        term.values.includes(ctx.states.get(book.id)?.status ?? 'unread') ||
        (term.values.includes('next') && (ctx.isNext?.(book.id) ?? false))
      );
    case 'favorite':
      return (ctx.states.get(book.id)?.favorite ?? false) === term.value;
    case 'kept':
      // Answered in termHolds (series figures).
      return false;
    case 'device':
      return ctx.onDevice(book.id);
    case 'deviceAudio':
      return ctx.audioOnDevice(book.id);
    case 'bookmeter': {
      const lists = ctx.bookmeterLists?.(book.id);
      return !!lists && term.values.some((v) => lists.has(v));
    }
  }
}

/**
 * Store ratings' search values as the server compares them: rating: the pooled stars x10,
 * myrating: your Calibre rating (half stars) as tenths, ratings: the count, readers: 読書メーター.
 */
function rangeValue(
  book: CatalogBook,
  type: 'rating' | 'myrating' | 'ratings' | 'readers'
): number | null {
  switch (type) {
    case 'rating':
      return book.storeRating ? Math.round(book.storeRating.avg * 10) : null;
    case 'myrating':
      return book.rating ? book.rating * 5 : null;
    case 'ratings':
      return book.storeRating?.count ?? null;
    case 'readers':
      return book.readers ?? null;
  }
}

/** Whether one term holds for the book, negation included. */
export function termHolds(book: CatalogBook, term: QueryTerm, ctx: MatchContext): boolean {
  if (
    term.type === 'kept' ||
    (ctx.seriesTab &&
      (term.type === 'rating' || term.type === 'ratings' || term.type === 'readers'))
  ) {
    const value = ctx.figure?.(book, term.type) ?? null;
    return figureMatches(value, term.min, term.max, term.negated);
  }
  if (term.type === 'chars' && term.negated) {
    // A book without a count is never included, negated or not.
    const n = book.charCount;
    return n !== null && n !== undefined && !termMatches(book, { ...term, negated: false }, ctx);
  }
  if (
    (term.type === 'rating' ||
      term.type === 'myrating' ||
      term.type === 'ratings' ||
      term.type === 'readers') &&
    term.negated
  ) {
    // A book without a value is never included, negated or not (the server's search-sql.ts).
    return (
      rangeValue(book, term.type) !== null && !termMatches(book, { ...term, negated: false }, ctx)
    );
  }
  if (term.type === 'level' && term.negated) {
    // A book without a level is never included, negated or not.
    const n = book.nativelyLevel?.level;
    return n !== null && n !== undefined && !termMatches(book, { ...term, negated: false }, ctx);
  }
  const hit = termMatches(book, term, ctx);
  return term.negated ? !hit : hit;
}

/** All terms (ANDed). */
export function matchesQuery(book: CatalogBook, query: ParsedQuery, ctx: MatchContext): boolean {
  return query.terms.every((t) => termHolds(book, t, ctx));
}

/**
 * In a grouped tab, the terms on the grouping field also filter the groups by name
 * (the server's groupNameSql): in Authors, `author:日向` lists 日向夏, not every co-author.
 */
export function groupNameMatches(name: string, query: ParsedQuery, field: TextField): boolean {
  return query.terms.every((t) => {
    if (t.type !== 'field' || t.field !== field) return true;
    const hit = anyMatcher(name, t.matchers);
    return t.negated ? !hit : hit;
  });
}
