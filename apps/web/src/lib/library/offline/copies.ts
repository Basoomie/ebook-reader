/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApiError, type RequestOptions } from '$lib/library/api';
import type { CatalogBook, CatalogBookDetail } from '$lib/library/types';
import type { OfflineCopy, OfflineStore } from './offline-db';

/**
 * Keeps the offline copies current while the server can be reached (offline Library):
 * one copy per library book stored on this device, as the server describes it, with its
 * cover thumbnail.
 *
 * - The device's books (the "On this device" rule) are looked up 200 at a time, missing
 *   ones included (`missing: true` then hides them from lists, as on the server).
 * - A book's details (description, sources) are fetched only when its summary changed or
 *   the copy has none yet; its thumbnail only when the thumbnail URL changed (the URL
 *   carries a version that changes with the cover).
 * - A book the lookup no longer returns (its library switched off, gone from the catalog)
 *   is marked hidden; copies of books no longer on this device are deleted.
 * - When the server stops answering, the refresh stops and every copy stays as it was.
 */

export interface CopyApi {
  lookupIncludingMissing(
    ids: readonly string[],
    options?: RequestOptions
  ): Promise<{ books: CatalogBook[] }>;
  book(id: string, options?: RequestOptions): Promise<CatalogBookDetail>;
  absolute(relative: string): string;
}

export interface RefreshDeps {
  store: Pick<OfflineStore, 'getAll' | 'put' | 'delete'>;
  /** This device's library books (deviceBookIds). */
  deviceBookIds(): Promise<string[]>;
  /** Fetches a thumbnail (absolute URL); rejects on any failure. */
  fetchBlob(url: string): Promise<Blob>;
  now(): number;
  warn(message: string): void;
}

export interface RefreshResult {
  checked: number;
  details: number;
  thumbnails: number;
  removed: number;
  /** Stopped early because the server could not be reached. */
  stopped: boolean;
}

const LOOKUP_CHUNK = 200;

/** The summary's fields as sent by the server (description and sources left out). */
export function summaryOf(book: CatalogBookDetail | CatalogBook): CatalogBook {
  const { description: _d, sources: _s, ...rest } = book as CatalogBookDetail;
  return rest;
}

function sameSummary(a: CatalogBook, b: CatalogBook): boolean {
  return JSON.stringify(summaryOf(a)) === JSON.stringify(summaryOf(b));
}

function unreachable(error: unknown): boolean {
  return (
    error instanceof LibraryApiError &&
    (error.kind === 'unreachable' || error.kind === 'timeout' || error.kind === 'aborted')
  );
}

/** Saves the copy of one book from a details answer (the details page, a fresh open). */
export function copyFromDetail(
  detail: CatalogBookDetail,
  old: OfflineCopy | undefined,
  now: number
): OfflineCopy {
  return {
    bookId: detail.id,
    book: detail,
    hasDetail: true,
    thumbnail: old && old.thumbnailOf === detail.thumbnail ? old.thumbnail : null,
    thumbnailOf: old && old.thumbnailOf === detail.thumbnail ? old.thumbnailOf : null,
    hidden: false,
    savedAt: now
  };
}

export async function refreshCopies(api: CopyApi, deps: RefreshDeps): Promise<RefreshResult> {
  const result: RefreshResult = {
    checked: 0,
    details: 0,
    thumbnails: 0,
    removed: 0,
    stopped: false
  };
  const ids = await deps.deviceBookIds();
  const onDevice = new Set(ids);
  const copies = new Map((await deps.store.getAll()).map((c) => [c.bookId, c]));

  for (const id of copies.keys()) {
    if (onDevice.has(id)) continue;
    await deps.store.delete(id);
    copies.delete(id);
    result.removed += 1;
  }

  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK);
    let found: Map<string, CatalogBook>;
    try {
      found = new Map((await api.lookupIncludingMissing(chunk)).books.map((b) => [b.id, b]));
    } catch (error) {
      if (!unreachable(error))
        deps.warn(`Offline library: lookup failed: ${(error as Error).message}`);
      result.stopped = true;
      return result;
    }
    for (const id of chunk) {
      result.checked += 1;
      const old = copies.get(id);
      const current = found.get(id);
      if (!current) {
        if (old && !old.hidden) await deps.store.put({ ...old, hidden: true, savedAt: deps.now() });
        continue;
      }
      let book: CatalogBookDetail = old?.hasDetail
        ? { ...current, description: old.book.description, sources: old.book.sources }
        : { ...current, description: null, sources: [] };
      let hasDetail = old?.hasDetail ?? false;
      const changed = !old || !old.hasDetail || old.hidden || !sameSummary(old.book, current);
      if (changed) {
        try {
          const detail = await api.book(id);
          book = { ...current, description: detail.description ?? null, sources: detail.sources };
          hasDetail = true;
          result.details += 1;
        } catch (error) {
          if (unreachable(error)) {
            result.stopped = true;
            return result;
          }
          deps.warn(`Offline library: details of ${id} failed: ${(error as Error).message}`);
        }
      }
      let thumbnail = old?.thumbnail ?? null;
      let thumbnailOf = old?.thumbnailOf ?? null;
      if (current.thumbnail !== thumbnailOf) {
        if (current.thumbnail === null) {
          thumbnail = null;
          thumbnailOf = null;
        } else {
          try {
            thumbnail = await deps.fetchBlob(api.absolute(current.thumbnail));
            thumbnailOf = current.thumbnail;
            result.thumbnails += 1;
          } catch (error) {
            // Kept as it was; tried again next time.
            deps.warn(`Offline library: cover of ${id} failed: ${(error as Error).message}`);
          }
        }
      }
      if (
        !changed &&
        old &&
        hasDetail === old.hasDetail &&
        thumbnailOf === old.thumbnailOf &&
        thumbnail === old.thumbnail
      ) {
        continue;
      }
      await deps.store.put({
        bookId: id,
        book,
        hasDetail,
        thumbnail,
        thumbnailOf,
        hidden: false,
        savedAt: deps.now()
      });
    }
  }
  return result;
}
