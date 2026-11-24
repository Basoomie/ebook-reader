/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { logger } from '$lib/data/logger';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import { DEFAULT_COST_PER_100K, localBulkPlan, type BulkPlan } from './bulk-summaries';
import { SummaryApi, type BookSummaryRecord } from './summary-api';
import {
  BOOK_SUMMARY_KIND,
  SERIES_RECAP_KIND,
  SUMMARY_SKIP_KIND,
  recordRecap,
  recordSummary,
  SummaryCache,
  syncDescriptions,
  syncRecaps,
  syncSummaries,
  type CachedDescription,
  type CachedRecap,
  type CachedSummary
} from './summary-cache';
import type { SeriesRecapRecord } from './summary-api';

/**
 * Book summaries on this device (session 3): keeps the current summaries in step with their
 * "book-summary" records (at start, and after each pull that brings one), and answers session
 * 4's book page from the device's copy, offline too. Never throws; reading never waits on it.
 */

let cache: SummaryCache | null = null;
function getCache(): SummaryCache {
  cache ??= new SummaryCache();
  return cache;
}

/** The summaries' API on the library server, or null when this device isn't connected. */
export async function summaryApi(timeoutSeconds?: number): Promise<SummaryApi | null> {
  return api(timeoutSeconds);
}

async function api(timeoutSeconds?: number): Promise<SummaryApi | null> {
  const c = await getLibraryStore().getConnection();
  if (!c) return null;
  return new SummaryApi(
    c.serverUrl,
    c.token,
    timeoutSeconds ?? Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0)
  );
}

let running: Promise<void> = Promise.resolve();

/** Fetches what the records say changed (one run at a time). */
function sync(records: LocalRecord[]): Promise<void> {
  const mine = records.filter((r) => r.kind === BOOK_SUMMARY_KIND);
  // Session 5: the series recaps the records name, kept on the device too.
  const recaps = records.filter((r) => r.kind === SERIES_RECAP_KIND);
  if (recaps.length && browser)
    running = running.then(async () => {
      try {
        const a = await api();
        if (!a) return;
        const r = await syncRecaps(recaps, a, getCache());
        for (const e of r.errors.slice(0, 3)) logger.warn(`Summaries: story so far ${e}`);
      } catch (err) {
        logger.warn(`Summaries: ${(err as Error)?.message ?? err}`);
      }
    });
  if (!mine.length || !browser) return running;
  running = running.then(async () => {
    try {
      const a = await api();
      if (!a) return;
      const r = await syncSummaries(mine, a, getCache());
      for (const e of r.errors.slice(0, 3)) logger.warn(`Summaries: ${e}`);
      // Session 4b: the descriptions' translations named by the same records.
      const d = await syncDescriptions(mine, a, getCache());
      for (const e of d.errors.slice(0, 3)) logger.warn(`Summaries: description ${e}`);
    } catch (err) {
      logger.warn(`Summaries: ${(err as Error)?.message ?? err}`);
    }
  });
  return running;
}

/** Starts keeping the summaries on this device (sync-service's startSync). */
export function startSummarySync(engine: SyncEngine): void {
  if (!browser) return;
  engine.onRemoteChange((records) => void sync(records));
  void engine
    .getAll(BOOK_SUMMARY_KIND)
    .then((all) => sync(all))
    .catch((err) => logger.warn(`Summaries: ${(err as Error)?.message ?? err}`));
  void engine
    .getAll(SERIES_RECAP_KIND)
    .then((all) => sync(all))
    .catch((err) => logger.warn(`Summaries: ${(err as Error)?.message ?? err}`));
}

/** The device's copy of a series recap in a language (offline too), if it has one. */
export async function getRecapCopy(series: string, lang: string): Promise<CachedRecap | null> {
  try {
    return (await getCache().getRecap(series, lang)) ?? null;
  } catch {
    return null;
  }
}

/** Every language the device keeps a series recap in (to open offline in any of them). */
export async function recapCopies(series: string): Promise<CachedRecap[]> {
  try {
    return await getCache().recapsFor(series);
  } catch {
    return [];
  }
}

/** What this device knows of a series' recap (made, being made, failed). */
export async function recapState(
  engine: Pick<SyncEngine, 'get'>,
  series: string
): Promise<SeriesRecapRecord | null> {
  const r = await engine.get(SERIES_RECAP_KIND, series);
  return r ? recordRecap(r) : null;
}

/** The device's copy of a book's current summary in a language (offline too), if it has one. */
export async function getSummary(bookId: string, lang: string): Promise<CachedSummary | null> {
  try {
    return (await getCache().get(bookId, lang)) ?? null;
  } catch {
    return null;
  }
}

/** The device's copy of a book description's translation (session 4b), if it has one. */
export async function getDescriptionTranslation(
  bookId: string,
  lang: string
): Promise<CachedDescription | null> {
  try {
    return (await getCache().getDescription(bookId, lang)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keeps a translation the page just got from the server (before its record arrives). The
 * record's digest replaces this copy at the next sync. Never throws.
 */
export async function keepDescriptionTranslation(
  entry: Omit<CachedDescription, 'digest' | 'savedAt'>
): Promise<void> {
  try {
    const have = await getCache().getDescription(entry.bookId, entry.lang);
    if (have && have.source === entry.source && same(have.paragraphs, entry.paragraphs)) return;
    await getCache().putDescription({ ...entry, digest: '', savedAt: Date.now() });
  } catch {
    /* the page shows it anyway; the next sync keeps it */
  }
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The last cost per 100,000 characters the server gave (for an estimate offline). */
const RATE_KEY = 'ttu-summary-cost-per-100k';

function lastRate(): number | null {
  try {
    const v = Number(window.localStorage.getItem(RATE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The bulk "Mark completed" plan: the server's estimate (it knows which books were completed
 * before), else the device's own from its records and the last known cost.
 */
export async function bulkSummaryPlan(
  engine: Pick<SyncEngine, 'get'>,
  books: { id: string; charCount: number | null }[],
  completedBefore: (id: string) => boolean
): Promise<BulkPlan> {
  try {
    // A short wait: the dialog opens with the device's own plan when the server is slow.
    const a = await api(8);
    if (a) {
      const est = await a.estimate(books.map((b) => b.id));
      try {
        window.localStorage.setItem(RATE_KEY, String(est.per100k));
      } catch {
        /* private mode */
      }
      return { books: est.books, usd: est.usd };
    }
  } catch {
    /* offline or an older server: the device's own plan */
  }
  const has = new Set<string>();
  for (const b of books) {
    const s = await summaryState(engine, b.id).catch(() => null);
    if (s?.summary || s?.outcome) has.add(b.id);
  }
  return localBulkPlan(books, {
    completedBefore,
    hasSummary: (id) => has.has(id),
    per100k: lastRate() ?? DEFAULT_COST_PER_100K
  });
}

/**
 * The bulk line unticked: no automatic summary for these books. Written before the completions
 * so the server sees it in the same push (offline too).
 */
export async function skipAutomaticSummaries(
  engine: Pick<SyncEngine, 'put'>,
  bookIds: string[]
): Promise<void> {
  for (const id of bookIds) await engine.put(SUMMARY_SKIP_KIND, id, {}, { bookId: id });
}

/** What this device knows of a book's summary (made, being made, failed, no text). */
export async function summaryState(
  engine: Pick<SyncEngine, 'get'>,
  bookId: string
): Promise<BookSummaryRecord | null> {
  const r = await engine.get(BOOK_SUMMARY_KIND, bookId);
  return r ? recordSummary(r) : null;
}
