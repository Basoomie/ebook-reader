/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { localStores } from '$lib/audio/whispersync-reader';
import { audioBookIdsOnDevice } from '$lib/audio/offline/audio-offline';
import {
  isMatched,
  liveMatchFile,
  resetMatch,
  type BookRef,
  type SyncDeps
} from '$lib/audio/whispersync-sync';
import { logger } from '$lib/data/logger';
import { database, highlightRefindChars$ } from '$lib/data/store';
import loadEpub from '$lib/functions/file-loaders/epub/load-epub';
import { LibraryApiError, type LibraryApi } from '$lib/library/api';
import { existingLocalIds } from '$lib/library/browser-open-deps';
import { deviceBookIds } from '$lib/library/device-books';
import { getLibraryStore, type CalibreLink } from '$lib/library/library-db';
import type { CatalogBookDetail, CatalogLibrary } from '$lib/library/types';
import {
  bookStateApi,
  collectionsApi,
  getSyncEngine,
  libraryViewApi,
  nextInSeriesApi,
  bookmeterApi
} from '$lib/sync/sync-service';
import { copyFromDetail, refreshCopies, type RefreshResult } from './copies';
import { updateChangedFiles, type FileUpdateDeps } from './file-updates';
import { isOpenInReader } from './open-in-reader';
import { remapPlace } from './place-remap';
import { getOfflineStore, type OfflineCopy } from './offline-db';
import { OfflineCatalog, type OfflineData } from './offline-catalog';
import { firstServerAnswer, serverReachability, type FirstAnswer } from './reachability';
import { serverCheckSeconds } from '$lib/library/settings';
import { nextInSeriesBonus$, nextInSeriesOn$ } from '$lib/library/next-in-series-settings';
import { listsByBook } from '$lib/bookmeter/plan';

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

// ---- whether to ask the server (reachability.ts) ---------------------------------------

/**
 * A page starts with this device's books at once: no network, or the server didn't
 * answer the last time any page asked (it is asked again in the background).
 */
export function startsOffline(): boolean {
  return !browserOnline() || serverReachability.knownUnreachable();
}

/** A page's first request, given up when the quick server check gets no answer. */
export function askServerFirst<T>(
  serverUrl: string,
  request: (signal: AbortSignal) => Promise<T>
): Promise<FirstAnswer<T>> {
  return firstServerAnswer(
    serverReachability,
    serverUrl,
    serverCheckSeconds(),
    request,
    isUnreachable
  );
}

/**
 * Offline: resolves to true once the server answers the quick check (the page then asks
 * it again), false at once when the quick check is off or there is no network (then only
 * "Try again" or the network coming back ask again), or when it gets no answer.
 */
export async function serverAnswersAgain(serverUrl: string): Promise<boolean> {
  const seconds = serverCheckSeconds();
  if (seconds <= 0 || !browserOnline()) return false;
  return serverReachability.check(serverUrl, seconds);
}

/**
 * "Try again" or the network came back: whether to ask the server now. With the quick
 * check on, only when it answers it (else the page stays offline without waiting for the
 * request timeout); with it off, always.
 */
export async function serverWorthAsking(serverUrl: string): Promise<boolean> {
  const seconds = serverCheckSeconds();
  if (seconds <= 0) {
    serverReachability.markReachable();
    return true;
  }
  return serverReachability.check(serverUrl, seconds);
}

/** A request got no answer: the next pages start offline. */
export function noteUnreachable(): void {
  serverReachability.markUnreachable();
}

/** "Try again", the network came back, or the server answered: ask it on the next pages. */
export function noteReachable(): void {
  serverReachability.markReachable();
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

/** file-updates.ts in the browser: this device's books database, links and whispersync. */
function fileUpdateDeps(api: LibraryApi): FileUpdateDeps {
  const whispersync = async (link: CalibreLink): Promise<{ deps: SyncDeps; book: BookRef }> => {
    const db = await database.db;
    return {
      book: {
        bookId: link.bookId,
        localId: link.localId,
        title: link.title,
        fileSha256: link.fileSha256 ?? null
      },
      deps: {
        engine: await getSyncEngine(),
        api: {
          upload: (id, name, body, modifiedAt) => api.uploadAttachment(id, name, body, modifiedAt),
          download: (id, name) => api.downloadAttachment(id, name)
        },
        local: localStores(db)
      }
    };
  };
  return {
    api,
    links: async () => (await deviceLinks()).links,
    putLink: (link) => getLibraryStore().putLink(link),
    getRow: async (localId) => (await database.db).get('data', localId),
    getPlace: async (localId) => (await database.getBookmark(localId))?.exploredCharCount ?? null,
    loadEpub: (file) => loadEpub(file, document, Date.now()),
    remapPlace: (oldHtml, newHtml, position) =>
      remapPlace(oldHtml, newHtml, position, Number(highlightRefindChars$.getValue()) || 0)
        .position,
    replace: (localId, content, place) => database.replaceBookContent(localId, content, place),
    isMatched,
    liveMatchFile: async (link) => {
      const { deps, book } = await whispersync(link);
      return liveMatchFile(deps, book);
    },
    resetMatch: async (link) => {
      const { deps, book } = await whispersync(link);
      await resetMatch(deps, book);
    },
    isOpenInReader,
    warn: (message) => logger.warn(`Library files: ${message}`)
  };
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
      // Season 2: books whose library file changed get the new file.
      if (result && !result.stopped) {
        try {
          const updated = await updateChangedFiles(fileUpdateDeps(api));
          if (updated.replaced || updated.adopted || updated.sameText) {
            logger.info(
              `Library files: ${updated.replaced} updated, ${updated.sameText} with the same text, ${updated.adopted} recorded`
            );
          }
        } catch (error) {
          logger.warn(`Library files: not checked: ${(error as Error)?.message ?? error}`);
        }
      }
    } while (again);
    catalog?.invalidate();
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
    catalog?.invalidate();
  } catch (error) {
    logger.warn(`Offline library: details not saved: ${(error as Error)?.message ?? error}`);
  }
}

/** After "Remove from this device". Never rejects. */
export async function removeOfflineCopy(bookId: string): Promise<void> {
  if (!browser) return;
  try {
    await getOfflineStore().delete(bookId);
    catalog?.invalidate();
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
  const started = Date.now();
  const [{ links, ids }, copies, saved, states, positions, view, audio, hidden, bm] =
    await Promise.all([
      deviceLinks(),
      getOfflineStore().getAll(),
      getOfflineStore().getLibraries(),
      bookStateApi().getAll(),
      libraryViewApi().positions(),
      collectionsApi().view(),
      audioBookIdsOnDevice().catch(() => [] as string[]),
      nextInSeriesApi().loadHidden(),
      bookmeterApi().reload()
    ]);
  const byId = new Map(copies.map((c) => [c.bookId, c]));
  const linkById = new Map(links.map((l) => [l.bookId, l]));
  // Books without a copy yet: their EPUB covers are read together, not one after another.
  const books = (
    await Promise.all(
      ids.map(async (id): Promise<CatalogBookDetail | null> => {
        const copy = byId.get(id);
        if (copy) return copy.hidden ? null : { ...copy.book, thumbnail: thumbnailUrl(copy) };
        const link = linkById.get(id);
        return link ? bookFromLink(link, await localCover(link.localId)) : null;
      })
    )
  ).filter((b): b is CatalogBookDetail => b !== null);
  logger.info(
    `Offline library: read ${books.length} books on this device in ${Date.now() - started} ms`
  );
  return {
    books,
    libraries: saved?.libraries ?? [],
    states,
    positions,
    collections: view.collections,
    items: view.items,
    audioOnDevice: new Set(audio),
    nextHidden: new Set(hidden.map((h) => h.id)),
    nextOn: nextInSeriesOn$.getValue(),
    nextBonus: nextInSeriesBonus$.getValue(),
    bookmeterLists: listsByBook(bm.entries)
  };
}

let catalog: OfflineCatalog | undefined;

/** The catalog to ask while the server can't be reached (browser only). */
export function offlineCatalog(): OfflineCatalog {
  if (!catalog) {
    const created = new OfflineCatalog(loadOfflineData);
    catalog = created;
    // Status, favorites, places and collections changed here or on another device.
    const invalidate = () => created.invalidate();
    void bookStateApi().onChanged(invalidate);
    void libraryViewApi().onChanged(invalidate);
    void collectionsApi().onChanged(invalidate);
    // Next in your series: a series hidden or shown again, or its settings changed.
    nextInSeriesApi().hidden.subscribe(invalidate);
    nextInSeriesOn$.subscribe(invalidate);
    nextInSeriesBonus$.subscribe(invalidate);
    // Bookmeter sync: the lists changed (a pull, or a change applied here).
    bookmeterApi().view.subscribe(invalidate);
  }
  return catalog;
}

/**
 * A page of the offline Library opened: the next offline answer reads this device again
 * (books stored or removed since), once for all of the page's requests.
 */
export function freshOfflineCatalog(): void {
  catalog?.invalidate();
}
