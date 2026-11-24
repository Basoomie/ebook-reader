/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { LocalRecord } from '$lib/sync/sync-db';
import type {
  BookSummaryRecord,
  RecapResponse,
  SeriesRecapRecord,
  SummaryView
} from './summary-api';

/**
 * Book summaries on the device (session 3): every book's current summary, in each saved
 * language, kept in IndexedDB so it is there offline (book-summaries.md "Available offline").
 * The "book-summary" records say which summary and languages are current (with a digest per
 * language); a copy whose digest differs is fetched again, one whose book has no summary any
 * more is dropped. Only the current summary comes to devices; earlier versions stay on the
 * server.
 *
 * Never throws into its callers: problems are returned, and reading never waits on it.
 */

export const SUMMARY_DB_NAME = 'ttsu-summaries';
export const BOOK_SUMMARY_KIND = 'book-summary';
/** Written by the bulk "Mark completed" when its summary line is unticked. */
export const SUMMARY_SKIP_KIND = 'summary-skip';
/** Session 5: what every device knows of a series' recap ("story so far"); id = series name. */
export const SERIES_RECAP_KIND = 'series-recap';

/**
 * A series recap on the device (session 5), in one language: the server's whole answer when it
 * was kept (the recap, what it covered then and its state), so the panel reads offline too.
 */
export interface CachedRecap {
  series: string;
  lang: string;
  digest: string;
  response: RecapResponse;
  savedAt: number;
}

export interface CachedSummary {
  bookId: string;
  lang: string;
  digest: string;
  summary: SummaryView;
  savedAt: number;
}

/**
 * A book description's translation on the device (session 4b). `source` is the description it
 * was made from, exactly as the catalog gave it: the page shows the copy only while the book's
 * description is still that text, so an old translation is never shown for a new one.
 */
export interface CachedDescription {
  bookId: string;
  lang: string;
  digest: string;
  source: string;
  /** One text per paragraph, its line breaks kept. */
  paragraphs: string[];
  savedAt: number;
}

interface SummaryDbSchema extends DBSchema {
  summaries: { key: [string, string]; value: CachedSummary; indexes: { bookId: string } };
  descriptions: { key: [string, string]; value: CachedDescription; indexes: { bookId: string } };
  recaps: { key: [string, string]; value: CachedRecap; indexes: { series: string } };
}

export function createSummaryDb(name = SUMMARY_DB_NAME) {
  return openDB<SummaryDbSchema>(name, 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const s = db.createObjectStore('summaries', { keyPath: ['bookId', 'lang'] });
        s.createIndex('bookId', 'bookId');
      }
      if (oldVersion < 2) {
        const d = db.createObjectStore('descriptions', { keyPath: ['bookId', 'lang'] });
        d.createIndex('bookId', 'bookId');
      }
      if (oldVersion < 3) {
        const r = db.createObjectStore('recaps', { keyPath: ['series', 'lang'] });
        r.createIndex('series', 'series');
      }
    }
  });
}

export class SummaryCache {
  private dbPromise: Promise<IDBPDatabase<SummaryDbSchema>> | undefined;

  constructor(
    private readonly open: () => Promise<IDBPDatabase<SummaryDbSchema>> = createSummaryDb
  ) {}

  private get db() {
    this.dbPromise ??= this.open();
    return this.dbPromise;
  }

  async get(bookId: string, lang: string): Promise<CachedSummary | undefined> {
    return (await this.db).get('summaries', [bookId, lang]);
  }

  async forBook(bookId: string): Promise<CachedSummary[]> {
    return (await this.db).getAllFromIndex('summaries', 'bookId', bookId);
  }

  async put(entry: CachedSummary): Promise<void> {
    await (await this.db).put('summaries', entry);
  }

  async remove(bookId: string, lang: string): Promise<void> {
    await (await this.db).delete('summaries', [bookId, lang]);
  }

  async all(): Promise<CachedSummary[]> {
    return (await this.db).getAll('summaries');
  }

  // ---- session 4b: descriptions ----

  async getDescription(bookId: string, lang: string): Promise<CachedDescription | undefined> {
    return (await this.db).get('descriptions', [bookId, lang]);
  }

  async descriptionsFor(bookId: string): Promise<CachedDescription[]> {
    return (await this.db).getAllFromIndex('descriptions', 'bookId', bookId);
  }

  async putDescription(entry: CachedDescription): Promise<void> {
    await (await this.db).put('descriptions', entry);
  }

  async removeDescription(bookId: string, lang: string): Promise<void> {
    await (await this.db).delete('descriptions', [bookId, lang]);
  }

  // ---- session 5: series recaps ----

  async getRecap(series: string, lang: string): Promise<CachedRecap | undefined> {
    return (await this.db).get('recaps', [series, lang]);
  }

  async recapsFor(series: string): Promise<CachedRecap[]> {
    return (await this.db).getAllFromIndex('recaps', 'series', series);
  }

  async putRecap(entry: CachedRecap): Promise<void> {
    await (await this.db).put('recaps', entry);
  }

  async removeRecap(series: string, lang: string): Promise<void> {
    await (await this.db).delete('recaps', [series, lang]);
  }
}

export interface RecapFetcher {
  recap(series: string, lang?: string): Promise<RecapResponse>;
}

export interface RecapCacheLike {
  getRecap(series: string, lang: string): Promise<CachedRecap | undefined>;
  recapsFor(series: string): Promise<CachedRecap[]>;
  putRecap(entry: CachedRecap): Promise<void>;
  removeRecap(series: string, lang: string): Promise<void>;
}

/** The record's data, or null when it isn't one we understand. */
export function recordRecap(r: LocalRecord): SeriesRecapRecord | null {
  if (r.kind !== SERIES_RECAP_KIND || r.deletedAt !== null) return null;
  const d = r.data as Partial<SeriesRecapRecord> | undefined;
  if (!d || typeof d !== 'object') return null;
  return {
    series: typeof d.series === 'string' ? d.series : r.id,
    recap: d.recap ?? null,
    making: d.making ?? null,
    phase: d.phase ?? null,
    since: d.since ?? null,
    due: d.due ?? null,
    outcome: d.outcome ?? null,
    note: d.note ?? null
  };
}

/**
 * Session 5: the device's copies of series recaps follow the records like the summaries' do:
 * each saved language fetched when its digest or the recap changed, copies the record no longer
 * names dropped (a recap that is gone, a language no longer saved).
 */
export async function syncRecaps(
  records: LocalRecord[],
  api: RecapFetcher,
  cache: RecapCacheLike,
  now = Date.now()
): Promise<{ fetched: number; dropped: number; errors: string[] }> {
  const out = { fetched: 0, dropped: 0, errors: [] as string[] };
  for (const r of records) {
    if (r.kind !== SERIES_RECAP_KIND) continue;
    const series = r.id;
    try {
      const data = recordRecap(r);
      const langs = data?.recap?.langs ?? {};
      for (const c of await cache.recapsFor(series))
        if (!(c.lang in langs) || c.response.recap?.id !== data?.recap?.id) {
          await cache.removeRecap(series, c.lang);
          out.dropped++;
        }
      for (const [lang, digest] of Object.entries(langs)) {
        const have = await cache.getRecap(series, lang);
        if (have && have.digest === digest && have.response.recap?.id === data?.recap?.id) continue;
        const got = await api.recap(series, lang);
        if (!got.recap) continue;
        await cache.putRecap({ series, lang, digest, response: got, savedAt: now });
        out.fetched++;
      }
    } catch (err) {
      out.errors.push(`${series}: ${(err as Error)?.message ?? err}`);
    }
  }
  return out;
}

export interface DescriptionFetcher {
  description(
    bookId: string,
    lang?: string
  ): Promise<{ source: string | null; translation: { paragraphs: string[] } | null }>;
}

export interface DescriptionCacheLike {
  getDescription(bookId: string, lang: string): Promise<CachedDescription | undefined>;
  descriptionsFor(bookId: string): Promise<CachedDescription[]>;
  putDescription(entry: CachedDescription): Promise<void>;
  removeDescription(bookId: string, lang: string): Promise<void>;
}

/**
 * Session 4b: the device's copies of description translations follow the records like the
 * summaries' do: each language the record names is fetched when its digest changed, and a copy
 * the record no longer names (the description changed, or it was never made) is dropped.
 */
export async function syncDescriptions(
  records: LocalRecord[],
  api: DescriptionFetcher,
  cache: DescriptionCacheLike,
  now = Date.now()
): Promise<{ fetched: number; dropped: number; errors: string[] }> {
  const out = { fetched: 0, dropped: 0, errors: [] as string[] };
  for (const r of records) {
    if (r.kind !== BOOK_SUMMARY_KIND) continue;
    const bookId = r.id;
    try {
      const d = r.deletedAt === null ? (r.data as { descriptions?: unknown } | undefined) : null;
      const raw = d?.descriptions;
      const langs: Record<string, string> =
        raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
      for (const c of await cache.descriptionsFor(bookId))
        if (langs[c.lang] !== c.digest) {
          await cache.removeDescription(bookId, c.lang);
          out.dropped++;
        }
      for (const [lang, digest] of Object.entries(langs)) {
        if (typeof digest !== 'string') continue;
        const have = await cache.getDescription(bookId, lang);
        if (have && have.digest === digest) continue;
        const got = await api.description(bookId, lang);
        if (!got.translation || got.source === null) continue;
        await cache.putDescription({
          bookId,
          lang,
          digest,
          source: got.source,
          paragraphs: got.translation.paragraphs,
          savedAt: now
        });
        out.fetched++;
      }
    } catch (err) {
      out.errors.push(`${bookId}: ${(err as Error)?.message ?? err}`);
    }
  }
  return out;
}

export interface SummaryFetcher {
  get(bookId: string, lang?: string): Promise<{ summary: SummaryView | null }>;
}

export interface CacheLike {
  get(bookId: string, lang: string): Promise<CachedSummary | undefined>;
  forBook(bookId: string): Promise<CachedSummary[]>;
  put(entry: CachedSummary): Promise<void>;
  remove(bookId: string, lang: string): Promise<void>;
}

/** The record's data, or null when it isn't one we understand. */
export function recordSummary(r: LocalRecord): BookSummaryRecord | null {
  if (r.kind !== BOOK_SUMMARY_KIND || r.deletedAt !== null) return null;
  const d = r.data as Partial<BookSummaryRecord> | undefined;
  if (!d || typeof d !== 'object') return null;
  return {
    summary: d.summary ?? null,
    making: d.making ?? null,
    outcome: d.outcome ?? null,
    note: d.note ?? null
  };
}

/**
 * Brings the device's copies in line with the records: fetches each current summary in each
 * saved language whose digest changed, drops the copies of languages or books without one.
 */
export async function syncSummaries(
  records: LocalRecord[],
  api: SummaryFetcher,
  cache: CacheLike,
  now = Date.now()
): Promise<{ fetched: number; dropped: number; errors: string[] }> {
  const out = { fetched: 0, dropped: 0, errors: [] as string[] };
  for (const r of records) {
    if (r.kind !== BOOK_SUMMARY_KIND) continue;
    const bookId = r.id;
    try {
      const data = recordSummary(r);
      const langs = data?.summary?.langs ?? {};
      for (const c of await cache.forBook(bookId))
        if (!(c.lang in langs) || c.summary.id !== data?.summary?.id) {
          await cache.remove(bookId, c.lang);
          out.dropped++;
        }
      for (const [lang, digest] of Object.entries(langs)) {
        const have = await cache.get(bookId, lang);
        if (have && have.digest === digest && have.summary.id === data?.summary?.id) continue;
        const got = await api.get(bookId, lang);
        if (!got.summary) continue;
        await cache.put({ bookId, lang, digest, summary: got.summary, savedAt: now });
        out.fetched++;
      }
    } catch (err) {
      out.errors.push(`${bookId}: ${(err as Error)?.message ?? err}`);
    }
  }
  return out;
}
