/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP15c: the reader's side of whispersync on the library server. For the open book it
 * gives whispersync the linked audiobook (a signed URL), the confirmed subtitle file,
 * the way to the picker, and the transport of position, saved subtitles and saved match
 * (whispersync-sync.ts). Everything here is best effort: problems are logged, never
 * raised into the reader, and reading never waits on it.
 */
import type { IDBPDatabase } from 'idb';
import { logger } from '$lib/data/logger';
import type { AudioLink } from '$lib/audio/audio-types';
import { LibraryApi } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { syncDebounceSeconds$ } from '$lib/sync/settings';
import { bookIdForLocalBook, getSyncEngine, getSyncRunner } from '$lib/sync/sync-service';
import type { LinkedAudio } from '$lib/whispersync/lib/linked-audio';
import {
  concernsBook,
  pushMatch,
  pushPosition,
  pushSubtitles,
  resetAll,
  resetMatch,
  syncBook,
  type BookRef,
  type DataRow,
  type LocalStores,
  type SyncDeps,
  type SyncResult
} from './whispersync-sync';

export interface ReaderWhispersync {
  localId: number;
  linkedAudio: LinkedAudio;
  /** The first sync of the open book: what came from another device (null: nothing to sync). */
  ready: Promise<SyncResult['changed'] | null>;
  onPositionSaved(): void;
  onSubtitlesSaved(): void;
  /** After a match was saved: uploads it (waits at most the library request time). */
  onMatchSaved(): Promise<void>;
  /** Calls `onChange` when a sync brings newer whispersync data of this book. */
  watch(onChange: () => void): () => void;
}

const warn = (message: string) => logger.warn(`Whispersync: ${message}`);

function timeoutSeconds(): number {
  return Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
}

async function libraryApi(): Promise<LibraryApi | null> {
  const connection = await getLibraryStore().getConnection();
  return connection
    ? new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds())
    : null;
}

/** Resolves `promise`, or `fallback` after the library request time (0 = no wait). */
export function withinRequestTime<T>(
  promise: Promise<T>,
  fallback: T,
  seconds = timeoutSeconds()
): Promise<T> {
  if (seconds <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

function localStores(db: IDBPDatabase<any>): LocalStores {
  return {
    getAudioBook: (title) => db.get('audioBook', title),
    putAudioBook: async (row) => void (await db.put('audioBook', row)),
    getSubtitle: (title) => db.get('subtitle', title),
    putSubtitle: async (row) => void (await db.put('subtitle', row)),
    getData: (localId) => db.get('data', localId) as Promise<DataRow | undefined>,
    putData: async (row) => void (await db.put('data', row))
  };
}

function changedAnything(result: SyncResult): boolean {
  return result.changed.position || result.changed.subtitles || result.changed.match;
}

export function createReaderWhispersync(options: {
  localId: number;
  title: string;
  db: IDBPDatabase<any>;
  /** Leaves the reader for another page the way the reader's own buttons do. */
  leave: (route: string) => void;
}): ReaderWhispersync {
  const local = localStores(options.db);
  const bookIdPromise = bookIdForLocalBook(options.localId, options.title).catch(() => null);

  async function context(): Promise<{ book: BookRef; deps: SyncDeps; api: LibraryApi } | null> {
    const bookId = await bookIdPromise;
    if (!bookId) return null;
    const api = await libraryApi();
    if (!api) return null;
    const engine = await getSyncEngine();
    return {
      book: { bookId, localId: options.localId, title: options.title },
      api,
      deps: {
        engine,
        local,
        api: {
          upload: (id, name, body, modifiedAt) => api.uploadAttachment(id, name, body, modifiedAt),
          download: (id, name) => api.downloadAttachment(id, name)
        }
      }
    };
  }

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      warn(`${label}: ${(error as Error)?.message ?? error}`);
    }
  }

  async function syncNow(): Promise<SyncResult | null> {
    const ctx = await context();
    if (!ctx) return null;
    const result = await syncBook(ctx.deps, ctx.book);
    for (const problem of result.problems) warn(problem);
    return result;
  }

  // whispersync saves its position on every time update while playing: send the newest
  // after the sync debounce (a user setting). One not sent before the reader closes still
  // goes up on the next open (this device's copy is then the newer one).
  let positionTimer: ReturnType<typeof setTimeout> | undefined;

  // On open, fetch the latest records first (another device may have listened since),
  // at most for the library request time.
  const ready = withinRequestTime(getSyncRunner()?.syncNow() ?? Promise.resolve(null), null)
    .then(() => syncNow())
    .then((result) => result?.changed ?? null)
    .catch((error) => {
      warn(`opening: ${(error as Error)?.message ?? error}`);
      return null;
    });

  // The book's link, read once per open book (both the audio and the subtitle step use it).
  let linkPromise: Promise<{ link: AudioLink | null; api: LibraryApi } | null> | null = null;
  function bookLink() {
    linkPromise ??= context().then(async (ctx) =>
      ctx ? { link: await ctx.api.audioLink(ctx.book.bookId), api: ctx.api } : null
    );
    linkPromise.catch(() => (linkPromise = null));
    return linkPromise;
  }

  const linkedAudio: LinkedAudio = {
    async playUrl() {
      try {
        const found = await bookLink();
        const url = found?.link?.playUrl;
        return found && url ? found.api.absolute(url) : null;
      } catch (error) {
        warn(`linked audiobook: ${(error as Error)?.message ?? error}`);
        return null;
      }
    },
    async subtitleFile() {
      try {
        const found = await bookLink();
        const link = found?.link;
        // Only a confirmed subtitle file that is still there is fetched.
        if (!found || !link || link.subtitleState !== 'linked' || link.subtitleStatus !== 'ok') {
          return null;
        }
        return await found.api.linkedSubtitleFile(link.bookId);
      } catch (error) {
        warn(`linked subtitles: ${(error as Error)?.message ?? error}`);
        return null;
      }
    },
    async canLink() {
      return !!(await bookIdPromise);
    },
    linkAudiobook() {
      void bookIdPromise.then((bookId) => {
        if (bookId) options.leave(`/library/book?id=${encodeURIComponent(bookId)}`);
      });
    },
    async resetMatch() {
      await run('reset match', async () => {
        const ctx = await context();
        if (ctx) await resetMatch(ctx.deps, ctx.book);
      });
    },
    async resetAll() {
      await run('reset all', async () => {
        const ctx = await context();
        if (ctx) await resetAll(ctx.deps, ctx.book);
      });
    }
  };

  return {
    localId: options.localId,
    linkedAudio,
    ready,
    onPositionSaved() {
      clearTimeout(positionTimer);
      const seconds = Math.max(0, Number(syncDebounceSeconds$.getValue()) || 0);
      positionTimer = setTimeout(() => {
        void run('position', async () => {
          const ctx = await context();
          if (ctx) await pushPosition(ctx.deps, ctx.book);
        });
      }, seconds * 1000);
    },
    onSubtitlesSaved() {
      void run('subtitles', async () => {
        const ctx = await context();
        if (ctx) await pushSubtitles(ctx.deps, ctx.book);
      });
    },
    async onMatchSaved() {
      const upload = run('match', async () => {
        const ctx = await context();
        if (ctx) await pushMatch(ctx.deps, ctx.book);
      });
      // The page reloads next: never hold it longer than a library request may take.
      await withinRequestTime(upload, undefined);
    },
    watch(onChange) {
      let off: (() => void) | null = null;
      let stopped = false;
      void Promise.all([getSyncEngine(), bookIdPromise])
        .then(([engine, bookId]) => {
          if (stopped || !bookId) return;
          off = engine.onRemoteChange((records) => {
            if (!concernsBook(records, bookId)) return;
            void syncNow().then((result) => {
              if (result && changedAnything(result) && !stopped) onChange();
            });
          });
        })
        .catch((error) => warn(`watching: ${(error as Error)?.message ?? error}`));
      return () => {
        stopped = true;
        off?.();
      };
    }
  };
}
