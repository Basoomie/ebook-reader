/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { logger } from '$lib/data/logger';
import { database } from '$lib/data/store';
import { LibraryApiError, type LibraryApi } from '$lib/library/api';
import { existingLocalIds } from '$lib/library/browser-open-deps';
import { deviceBookIds } from '$lib/library/device-books';
import { getLibraryStore, type CalibreLink } from '$lib/library/library-db';
import type { CatalogBookDetail, CatalogLibrary } from '$lib/library/types';
import { bookStateApi, collectionsApi, libraryViewApi } from '$lib/sync/sync-service';
import { copyFromDetail, refreshCopies, type RefreshResult } from './copies';
import { getOfflineStore, type OfflineCopy } from './offline-db';
import { OfflineCatalog, type OfflineData } from './offline-catalog';

/**
 * The offline Library in the browser: keeping the copies current (copies.ts) and the
 * offline catalog (offline-catalog.ts) over this device's data. Pages use:
 *
 * - `isUnreachable(error)`: the server can't be reached (offline, down, or no answer in
 *   time); the page then shows the offline catalog;
 * - `refreshOfflineCopies(api)`: after a page loaded from the server, after a book was
 *   opened from the library (`force`), after "Remove from this device" (`force`);
 * - `saveOfflineLibraries`, `saveOfflineDetail`: answers the pages got anyway;
 * - `offlineCatalog()`: the catalog to ask instead of the server.
 */

/** The notice on the Library, Collections and Home while the server can't be reached. */
export const OFFLINE_NOTICE =
  "The library server can't be reached, so only the books on this device are shown.";

/** Unforced refreshes run at most this often (a Library visit loads many lists). */
const MIN_REFRESH_INTERVAL_MS = 60_000;

export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof LibraryApiError && (error.kind === 'unreachable' || error.kind === 'timeout')
  );
}

/** False when the browser knows it has no network (then there is no point in asking). */
export function browserOnline(): boolean {
  return !browser || typeof navigator === 'undefined' || navigator.onLine !== false;
}

async function deviceLinks(): Promise<{ links: CalibreLink[]; ids: string[] }> {
  const [links, existing] = await Promise.all([
    getLibraryStore().getAllLinks(),
    existingLocalIds()
  ]);
  return {
    links: links.filter((l) => existing.has(l.localId)),
    ids: deviceBookIds(links, existing)
  };
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return response.blob();
}

let running: Promise<RefreshResult | null> | null = null;
let again = false;
let lastRun = 0;

/**
 * Brings the offline copies up to date. Never rejects; one runs at a time (a forced call
 * during a run runs once more afterwards).
 */
export function refreshOfflineCopies(
  api: LibraryApi,
  options: { force?: boolean } = {}
): Promise<RefreshResult | null> {
  if (!browser) return Promise.resolve(null);
  if (running) {
    if (options.force) again = true;
    return running;
  }
  if (!options.force && Date.now() - lastRun < MIN_REFRESH_INTERVAL_MS) {
    return Promise.resolve(null);
  }
  const run = async (): Promise<RefreshResult | null> => {
    let result: RefreshResult | null = null;
    do {
      again = false;
      lastRun = Date.now();
      try {
        result = await refreshCopies(api, {
          store: getOfflineStore(),
          deviceBookIds: async () => (await deviceLinks()).ids,
          fetchBlob,
          now: Date.now,
          warn: (message) => logger.warn(message)
        });
      } catch (error) {
        logger.warn(`Offline library: not updated: ${(error as Error)?.message ?? error}`);
      }
    } while (again);
    return result;
  };
  running = run().finally(() => {
    running = null;
  });
  return running;
}

/** The last libraries answer, for the library picker and names offline. Never rejects. */
export async function saveOfflineLibraries(libraries: CatalogLibrary[]): Promise<void> {
  if (!browser) return;
  try {
    await getOfflineStore().setLibraries(libraries, Date.now());
  } catch (error) {
    logger.warn(`Offline library: libraries not saved: ${(error as Error)?.message ?? error}`);
  }
}

/** A details answer for a book on this device replaces its copy's details. Never rejects. */
export async function saveOfflineDetail(detail: CatalogBookDetail): Promise<void> {
  if (!browser) return;
  try {
    const { ids } = await deviceLinks();
    if (!ids.includes(detail.id)) return;
    const store = getOfflineStore();
    const old = await store.get(detail.id);
    if (old?.hasDetail && JSON.stringify(old.book) === JSON.stringify(detail)) return;
    await store.put(copyFromDetail(detail, old, Date.now()));
  } catch (error) {
    logger.warn(`Offline library: details not saved: ${(error as Error)?.message ?? error}`);
  }
}

/** After "Remove from this device". Never rejects. */
export async function removeOfflineCopy(bookId: string): Promise<void> {
  if (!browser) return;
  try {
    await getOfflineStore().delete(bookId);
  } catch (error) {
    logger.warn(`Offline library: copy not removed: ${(error as Error)?.message ?? error}`);
  }
}

// ---- reading the copies ------------------------------------------------------

/** blob: URLs of stored thumbnails, made once per thumbnail version. */
const thumbnailUrls = new Map<string, { of: string | null; url: string }>();
/** EPUB covers of books without a copy yet, by local id. */
const localCovers = new Map<number, string | null>();

function thumbnailUrl(copy: OfflineCopy): string | null {
  if (!copy.thumbnail) return null;
  const cached = thumbnailUrls.get(copy.bookId);
  if (cached && cached.of === copy.thumbnailOf) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(copy.thumbnail);
  thumbnailUrls.set(copy.bookId, { of: copy.thumbnailOf, url });
  return url;
}

async function localCover(localId: number): Promise<string | null> {
  if (localCovers.has(localId)) return localCovers.get(localId) ?? null;
  let url: string | null = null;
  try {
    const row = await (await database.db).get('data', localId);
    if (row?.coverImage instanceof Blob) url = URL.createObjectURL(row.coverImage);
  } catch {
    // No cover.
  }
  localCovers.set(localId, url);
  return url;
}

/**
 * A book on this device without a copy yet (opened before the offline Library existed and
 * not seen online since): what its library link knows.
 */
export function bookFromLink(link: CalibreLink, thumbnail: string | null): CatalogBookDetail {
  return {
    id: link.bookId,
    libraryId: link.libraryId,
    title: link.calibreTitle || link.title,
    titleSort: null,
    authorSort: null,
    authors: (link.authors ?? []).map((name) => ({ name, sort: null })),
    series: null,
    tags: [],
    addedAt: link.linkedAt,
    charCount: link.characters || null,
    charCountStatus: link.characters ? 'counted' : 'pending',
    missing: false,
    thumbnail,
    source: link.sourceKind ?? 'calibre',
    publisher: null,
    publishedAt: null,
    description: null,
    sources: []
  };
}

export async function loadOfflineData(): Promise<OfflineData> {
  const [{ links, ids }, copies, saved, states, positions, view] = await Promise.all([
    deviceLinks(),
    getOfflineStore().getAll(),
    getOfflineStore().getLibraries(),
    bookStateApi().getAll(),
    libraryViewApi().positions(),
    collectionsApi().view()
  ]);
  const byId = new Map(copies.map((c) => [c.bookId, c]));
  const books: CatalogBookDetail[] = [];
  for (const id of ids) {
    const copy = byId.get(id);
    if (copy) {
      if (!copy.hidden) books.push({ ...copy.book, thumbnail: thumbnailUrl(copy) });
      continue;
    }
    const link = links.find((l) => l.bookId === id);
    if (link) books.push(bookFromLink(link, await localCover(link.localId)));
  }
  return {
    books,
    libraries: saved?.libraries ?? [],
    states,
    positions,
    collections: view.collections,
    items: view.items
  };
}

let catalog: OfflineCatalog | undefined;

/** The catalog to ask while the server can't be reached (browser only). */
export function offlineCatalog(): OfflineCatalog {
  catalog ??= new OfflineCatalog(loadOfflineData);
  return catalog;
}
