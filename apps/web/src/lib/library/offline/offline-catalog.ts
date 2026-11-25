/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BUILTIN_COLLECTIONS } from '$lib/collections/builtins';
import type { Collection, CollectionItem } from '$lib/collections/collections';
import {
  LibraryApiError,
  type BookListQuery,
  type GroupListQuery,
  type NameListQuery,
  type RequestOptions
} from '$lib/library/api';
import { parseQuery, type ParsedQuery, type TextField } from '$lib/library/query/parse';
import { MAX_SUGGESTIONS, rankNames, type NameCount } from '$lib/library/query/suggest';
import type { BookSortKey, GroupSortKey, ServerSort } from '$lib/library/sort';
import type {
  CatalogBook,
  CatalogBookDetail,
  CatalogGroup,
  CatalogGroupPage,
  CatalogLibrary,
  CatalogPage,
  CollectionCardData,
  GroupBy,
  GroupTile
} from '$lib/library/types';
import type { BookState } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import { summaryOf } from './copies';
import { fieldNames, groupNameMatches, matchesQuery, type MatchContext } from './match';
import { hideRecordId, nextInSeries, nextStateOf, type NextEntry } from '../next-in-series';
import {
  bookComparator,
  DEFAULT_SORT,
  groupComparator,
  newestFirst,
  seriesOrder,
  volumeOrder
} from './sort';

/**
 * The offline Library (Season 2 §2): the same answers as the server's catalog API
 * (LibraryApi's libraries, books, count, groups, lookup, book and collectionCards), computed
 * on the device from the books this device stores, so the Library, Collections and Home
 * pages run their loading code unchanged against it when the server can't be reached.
 *
 * Mirrors apps/storage-server/src/catalog/queries.ts, groups.ts and collections/cards.ts:
 * lists hide books missing from Calibre (lookup can include them), a library filter,
 * searches (match.ts), sorts (sort.ts), paging (here by offset), and group and collection
 * cards with the server's collage order. Every number counts only this device's books
 * (decided: offline the Library is limited to the books on this device).
 */

export interface OfflineData {
  /** This device's library books (offline copies, or a stand-in made from the link). */
  books: CatalogBookDetail[];
  libraries: CatalogLibrary[];
  states: ReadonlyMap<string, BookState>;
  /** Every position record (all devices), for the collage's "opened" books. */
  positions: readonly LocalRecord[];
  collections: readonly Collection[];
  items: ReadonlyMap<string, CollectionItem[]>;
  /**
   * Season 2 Phase 9: the books whose audio is downloaded here (on:audio; only books on
   * this device count, as on the server).
   */
  audioOnDevice?: ReadonlySet<string>;
  /**
   * Next in your series: the ids of the hidden series' records, and the two settings
   * (absent = the defaults: on, bonus books not offered).
   */
  nextHidden?: ReadonlySet<string>;
  nextOn?: boolean;
  nextBonus?: boolean;
}

/** Next in your series of one read of the device's data (computed once per read). */
const nextCache = new WeakMap<OfflineData, NextEntry[]>();

/** The next volumes among this device's books, newest finished series first. */
export function offlineNext(data: OfflineData): NextEntry[] {
  let entries = nextCache.get(data);
  if (!entries) {
    entries =
      data.nextOn === false
        ? []
        : nextInSeries(
            data.books.map((b) => ({
              id: b.id,
              libraryId: b.libraryId,
              series: b.series,
              addedAt: b.addedAt,
              visible: !b.missing
            })),
            (id) => nextStateOf(data.states.get(id)),
            {
              bonus: data.nextBonus === true,
              hidden: (lib, name) => data.nextHidden?.has(hideRecordId(lib, name)) ?? false
            }
          );
    nextCache.set(data, entries);
  }
  return entries;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_LOOKUP_IDS = 200;
const TILE_COUNT = 4;
const TILE_SCAN = 60;

const BOOK_SORTS: BookSortKey[] = [
  'added',
  'title',
  'author',
  'chars',
  'published',
  'level',
  'rating',
  'ratings',
  'readers'
];
const GROUP_SORTS: GroupSortKey[] = ['newest', 'name', 'count'];

const FIELD: Record<GroupBy, TextField> = { series: 'series', author: 'author', tag: 'tag' };

function parseOrThrow(text: string | undefined): ParsedQuery {
  if (!text) return { terms: [] };
  const result = parseQuery(text);
  if (!result.ok) {
    throw new LibraryApiError('server', result.error.message, 422, 'invalid_query', {
      start: result.error.start,
      end: result.error.end
    });
  }
  return result.query;
}

function checkAborted(options?: RequestOptions) {
  if (options?.signal?.aborted) throw new LibraryApiError('aborted', 'Cancelled');
}

function page<T>(all: T[], cursor: string | undefined, limit: number | undefined) {
  const match = cursor ? /^o(\d+)$/.exec(cursor) : null;
  const start = match ? Number(match[1]) : 0;
  const size = Math.min(Math.max(1, limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return {
    items: all.slice(start, start + size),
    nextCursor: start + size < all.length ? `o${start + size}` : null
  };
}

/** As the server's tileOfSummary (catalog/groups.ts). */
function tileOf(book: CatalogBook): GroupTile {
  return {
    bookId: book.id,
    thumbnail: book.thumbnail,
    tags: book.tags,
    title: book.title,
    authors: [...new Set(book.authors.map((a) => a.name))],
    illustrators: [...new Set(book.illustrators ?? [])],
    series: book.series?.name ?? null,
    charCount: book.charCount
  };
}

/** Book ids with a live position record, most recently saved first (any device). */
export function openedOrder(positions: readonly LocalRecord[]): string[] {
  const latest = new Map<string, number>();
  for (const p of positions) {
    if (p.kind !== 'position' || p.deletedAt !== null || !p.bookId) continue;
    latest.set(p.bookId, Math.max(latest.get(p.bookId) ?? -Infinity, p.updatedAt));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Up to four book ids in the decided collage order (groups.ts pickCollage, cards.ts
 * collageFromMembers): opened books (most recent first), then one lowest-index volume per
 * series among the 60 newest, newest series first, then the newest books.
 */
export function collage(members: readonly CatalogBook[], opened: readonly string[]): string[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const picked: string[] = [];
  const seriesShown = new Set<string>();
  const add = (m: CatalogBook) => {
    if (picked.length >= TILE_COUNT || picked.includes(m.id)) return;
    picked.push(m.id);
    if (m.series) seriesShown.add(m.series.name);
  };
  for (const id of opened) {
    if (picked.length >= TILE_COUNT) return picked;
    const m = byId.get(id);
    if (m) add(m);
  }
  if (picked.length >= TILE_COUNT) return picked;
  const firstOf = new Map<string, CatalogBook>();
  for (const m of members) {
    if (!m.series) continue;
    const best = firstOf.get(m.series.name);
    if (!best || volumeOrder(m, best) < 0) firstOf.set(m.series.name, m);
  }
  const newest = [...members].sort(newestFirst).slice(0, TILE_SCAN);
  for (const m of newest) {
    if (picked.length >= TILE_COUNT) break;
    if (!m.series || seriesShown.has(m.series.name)) continue;
    seriesShown.add(m.series.name);
    const first = firstOf.get(m.series.name);
    if (first) add(first);
  }
  for (const m of newest) add(m);
  return picked;
}

function groupKeys(book: CatalogBook, by: GroupBy): (string | null)[] {
  if (by === 'series') return [book.series?.name ?? null];
  return fieldNames(book, FIELD[by]);
}

export class OfflineCatalog {
  private reading: Promise<OfflineData> | null = null;
  private cached: OfflineData | null = null;
  /** Bumped by invalidate(): a read started before it is not kept. */
  private generation = 0;

  /**
   * `load` reads the device's data. It is read once and kept until `invalidate()` (a
   * page visit, a change to book states, positions, collections or the copies), so the
   * many requests of one page (a list, its count, the tab and chip counts) don't each
   * read every copy and record again.
   */
  constructor(private readonly load: () => Promise<OfflineData>) {}

  /** The next request reads the device's data again. */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.reading = null;
  }

  /** Requests made at the same moment share one read; later ones use what it read. */
  private data(): Promise<OfflineData> {
    if (this.cached) return Promise.resolve(this.cached);
    if (!this.reading) {
      const generation = this.generation;
      const reading = this.load();
      this.reading = reading;
      reading.then(
        (data) => {
          if (this.reading === reading) this.reading = null;
          if (this.generation === generation) this.cached = data;
        },
        () => {
          if (this.reading === reading) this.reading = null;
        }
      );
    }
    return this.reading;
  }

  /** Thumbnails are already blob: URLs. */
  absolute(url: string): string {
    return url;
  }

  private context(data: OfflineData): MatchContext {
    const ids = new Set(data.books.map((b) => b.id));
    const audio = data.audioOnDevice ?? new Set<string>();
    let next: Set<string> | undefined;
    return {
      states: data.states,
      onDevice: (id) => ids.has(id),
      audioOnDevice: (id) => ids.has(id) && audio.has(id),
      isNext: (id) => {
        next ??= new Set(offlineNext(data).map((e) => e.bookId));
        return next.has(id);
      }
    };
  }

  private visible(
    data: OfflineData,
    opts: { library?: string; includeMissing?: boolean } = {}
  ): CatalogBookDetail[] {
    return data.books.filter(
      (b) => (!opts.library || b.libraryId === opts.library) && (opts.includeMissing || !b.missing)
    );
  }

  /** The books of a list, unsorted (books() and count()). */
  private listed(data: OfflineData, query: BookListQuery): CatalogBookDetail[] {
    const parsed = parseOrThrow(query.q);
    const scoped = query.scope ? parseOrThrow(query.scope) : null;
    const ctx = this.context(data);
    const members = query.collection
      ? new Set((data.items.get(query.collection) ?? []).map((i) => i.bookId))
      : null;
    const g = query.group;
    return this.visible(data, { library: query.library }).filter(
      (b) =>
        (!g ||
          (g.by === 'series'
            ? (b.series?.name ?? null) === g.name
            : g.name !== null && fieldNames(b, FIELD[g.by]).includes(g.name))) &&
        (!members || members.has(b.id)) &&
        (!scoped || matchesQuery(b, scoped, ctx)) &&
        matchesQuery(b, parsed, ctx)
    );
  }

  async libraries(options?: RequestOptions): Promise<{
    indexer: { enabled: boolean; error: string | null };
    libraries: CatalogLibrary[];
  }> {
    const data = await this.data();
    checkAborted(options);
    return { indexer: { enabled: true, error: null }, libraries: data.libraries };
  }

  async books(
    query: BookListQuery & { cursor?: string; limit?: number; sort?: ServerSort<string> },
    options?: RequestOptions
  ): Promise<CatalogPage> {
    const data = await this.data();
    const list = this.listed(data, query);
    checkAborted(options);
    const bySeriesIndex = !query.sort && query.group?.by === 'series' && query.group.name !== null;
    const sort =
      query.sort && BOOK_SORTS.includes(query.sort.key as BookSortKey)
        ? (query.sort as ServerSort<BookSortKey>)
        : DEFAULT_SORT;
    list.sort(bySeriesIndex ? seriesOrder : bookComparator(sort));
    const { items, nextCursor } = page(list, query.cursor, query.limit);
    return { books: items.map(summaryOf), nextCursor };
  }

  /** Every book id of a list (select mode's Select All), from this device's books. */
  async bookIds(query: BookListQuery, options?: RequestOptions): Promise<string[]> {
    const data = await this.data();
    const ids = this.listed(data, query).map((b) => b.id);
    checkAborted(options);
    return ids;
  }

  async count(query: BookListQuery, options?: RequestOptions): Promise<number> {
    const data = await this.data();
    const n = this.listed(data, query).length;
    checkAborted(options);
    return n;
  }

  /** Next in your series: the books' ids in the row's order (this device's books only). */
  async nextInSeries(options?: RequestOptions): Promise<string[]> {
    const data = await this.data();
    checkAborted(options);
    return offlineNext(data).map((e) => e.bookId);
  }

  async lookup(
    ids: readonly string[],
    q?: string,
    options?: RequestOptions
  ): Promise<{ books: CatalogBook[] }> {
    return this.lookupWith(ids, { q, includeMissing: false }, options);
  }

  async lookupIncludingMissing(
    ids: readonly string[],
    options?: RequestOptions
  ): Promise<{ books: CatalogBook[] }> {
    return this.lookupWith(ids, { includeMissing: true }, options);
  }

  private async lookupWith(
    ids: readonly string[],
    opts: { q?: string; includeMissing: boolean },
    options?: RequestOptions
  ): Promise<{ books: CatalogBook[] }> {
    const data = await this.data();
    const parsed = parseOrThrow(opts.q);
    const ctx = this.context(data);
    const byId = new Map(
      this.visible(data, { includeMissing: opts.includeMissing }).map((b) => [b.id, b])
    );
    const books = [...new Set(ids)]
      .slice(0, MAX_LOOKUP_IDS)
      .map((id) => byId.get(id))
      .filter((b): b is CatalogBookDetail => !!b && matchesQuery(b, parsed, ctx))
      .map(summaryOf);
    checkAborted(options);
    return { books };
  }

  async book(id: string, options?: RequestOptions): Promise<CatalogBookDetail> {
    const data = await this.data();
    checkAborted(options);
    const book = data.books.find((b) => b.id === id);
    if (!book) {
      throw new LibraryApiError('server', 'This book is not on this device.', 404, 'not_found');
    }
    return book;
  }

  /** Search suggestions (search palette step 1): the same as the server's GET /names. */
  async names(query: NameListQuery): Promise<NameCount[]> {
    const data = await this.data();
    const counts = new Map<string, number>();
    for (const b of this.visible(data, { library: query.library })) {
      for (const name of fieldNames(b, query.field)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const all = [...counts].map(([name, count]) => ({ name, count }));
    return rankNames(all, query.text, [], query.limit ?? MAX_SUGGESTIONS);
  }

  async groups(query: GroupListQuery, options?: RequestOptions): Promise<CatalogGroupPage> {
    const data = await this.data();
    const parsed = parseOrThrow(query.q);
    const ctx = this.context(data);
    const field = FIELD[query.by];
    // A collection's books only (2026-11-24): every number counts only those books.
    const scoped = query.scope ? parseOrThrow(query.scope) : null;
    const inCollection = query.collection
      ? new Set((data.items.get(query.collection) ?? []).map((i) => i.bookId))
      : null;
    const visible = this.visible(data, { library: query.library }).filter(
      (b) => (!inCollection || inCollection.has(b.id)) && (!scoped || matchesQuery(b, scoped, ctx))
    );

    const members = new Map<string | null, CatalogBookDetail[]>();
    for (const b of visible) {
      for (const key of groupKeys(b, query.by)) {
        const list = members.get(key) ?? [];
        list.push(b);
        members.set(key, list);
      }
    }
    const filtered = parsed.terms.length > 0;
    const hits = new Set<string | null>();
    if (filtered) {
      for (const b of visible) {
        if (!matchesQuery(b, parsed, ctx)) continue;
        for (const key of groupKeys(b, query.by)) {
          if (key === null || groupNameMatches(key, parsed, field)) hits.add(key);
        }
      }
    }
    const rows = [...members.entries()]
      .filter(([name]) => (query.by === 'series' || name !== null) && (!filtered || hits.has(name)))
      .map(([name, books]) => ({
        name,
        books,
        bookCount: books.length,
        newestAddedAt: books.reduce((n, b) => Math.max(n, b.addedAt), 0)
      }));
    const sort =
      query.sort && GROUP_SORTS.includes(query.sort.key as GroupSortKey)
        ? (query.sort as ServerSort<GroupSortKey>)
        : undefined;
    rows.sort(groupComparator(sort));
    const { items, nextCursor } = page(rows, query.cursor, query.limit);
    const opened = openedOrder(data.positions);
    const groups: CatalogGroup[] = items.map((r) => {
      const card: CatalogGroup = {
        by: query.by,
        name: r.name,
        bookCount: r.bookCount,
        newestAddedAt: r.newestAddedAt,
        chars: {
          total: r.books.reduce((n, b) => n + (b.charCount ?? 0), 0),
          counted: r.books.filter((b) => b.charCountStatus === 'counted').length,
          pending: r.books.filter((b) => (b.charCountStatus ?? 'pending') === 'pending').length,
          failed: r.books.filter((b) => b.charCountStatus === 'error').length
        }
      };
      if (query.by === 'series' && r.name !== null) {
        const ordered = [...r.books].sort(seriesOrder);
        card.bookIds = ordered.map((b) => b.id);
        card.cover = ordered.length ? tileOf(ordered[0]) : null;
      } else {
        const byId = new Map(r.books.map((b) => [b.id, b]));
        card.tiles = collage(r.books, opened).map((id) => tileOf(byId.get(id) as CatalogBook));
      }
      return card;
    });
    checkAborted(options);
    return { groups, nextCursor, total: rows.length };
  }

  /** The Collections page's cards (cards.ts): built-ins, then collections by id. */
  async collectionCards(options?: RequestOptions): Promise<{ cards: CollectionCardData[] }> {
    const data = await this.data();
    const ctx = this.context(data);
    const visible = this.visible(data).sort(newestFirst);
    const byId = new Map(visible.map((b) => [b.id, b]));
    const opened = openedOrder(data.positions);
    const cards: CollectionCardData[] = [];
    const add = (card: CollectionCardData, members: () => CatalogBook[]) => {
      try {
        const list = members();
        cards.push({
          ...card,
          bookCount: list.length,
          tiles: collage(list, opened).map((id) => tileOf(byId.get(id) as CatalogBook))
        });
      } catch (error) {
        const code = error instanceof LibraryApiError && error.code ? error.code : 'failed';
        cards.push({ ...card, error: { code, message: (error as Error).message } });
      }
    };
    const search = (query: string) => () => {
      const parsed = parseOrThrow(query);
      return visible.filter((b) => matchesQuery(b, parsed, ctx));
    };
    for (const b of BUILTIN_COLLECTIONS) {
      add({ id: b.id, builtin: true, query: b.query, bookCount: 0, tiles: [] }, search(b.query));
    }
    const sorted = [...data.collections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const c of sorted) {
      if (c.type === 'smart') {
        const query = c.query ?? '';
        add({ id: c.id, builtin: false, query, bookCount: 0, tiles: [] }, search(query));
      } else {
        add({ id: c.id, builtin: false, bookCount: 0, tiles: [] }, () => {
          const ids = new Set((data.items.get(c.id) ?? []).map((i) => i.bookId));
          return visible.filter((b) => ids.has(b.id));
        });
      }
    }
    checkAborted(options);
    return { cards };
  }
}
