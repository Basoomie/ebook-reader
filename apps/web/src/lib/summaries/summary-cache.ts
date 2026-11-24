/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { BookSummaryRecord, SummaryView } from './summary-api';

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

export interface CachedSummary {
  bookId: string;
  lang: string;
  digest: string;
  summary: SummaryView;
  savedAt: number;
}

interface SummaryDbSchema extends DBSchema {
  summaries: { key: [string, string]; value: CachedSummary; indexes: { bookId: string } };
}

export function createSummaryDb(name = SUMMARY_DB_NAME) {
  return openDB<SummaryDbSchema>(name, 1, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const s = db.createObjectStore('summaries', { keyPath: ['bookId', 'lang'] });
        s.createIndex('bookId', 'bookId');
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
