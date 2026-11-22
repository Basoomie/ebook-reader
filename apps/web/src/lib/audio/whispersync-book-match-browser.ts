/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The book page's Match in the browser: whispersync-book-match.ts with the app's own pieces
 * (the reader's books database and sync engine, whispersync's stores, parser and matcher).
 * Loaded only when the Subtitles row needs it.
 */
import { database } from '$lib/data/store';
import { storedAudio } from '$lib/audio/offline/audio-offline';
import type { LinkAnswer } from '$lib/audio/offline/play-choice';
import type { LibraryApi } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { getSyncEngine, getSyncRunner } from '$lib/sync/sync-service';
import { persistedSubtitles, updateSubtitles } from '$lib/whispersync/lib/files';
import { matchSubtitles } from '$lib/whispersync/lib/match';
import { settings$ } from '$lib/whispersync/lib/stores';
import type { BookMatchDeps } from './whispersync-book-match';
import { hasLiveMatch } from './whispersync-book-match';
import { localStores, subtitleFileFor, syncDeps, withinRequestTime } from './whispersync-reader';
import type { BookRef } from './whispersync-sync';

export async function bookMatchDeps(api: LibraryApi, bookId: string): Promise<BookMatchDeps> {
  const db = await database.db;
  const engine = await getSyncEngine();
  const {
    matchLineIgnoreRp$,
    matchLineSimilarityThreshold$,
    matchLineMaxAttempts$,
    subtitlesGlobalStartPadding$,
    subtitlesGlobalEndPadding$,
    readerEnableFilesystemApi$
  } = settings$;
  return {
    ...syncDeps(engine, localStores(db), api),
    async hasPickedSubtitleFile(title) {
      // AudioBookMenu: `$filesystemApiEnabled$ = supportsFileSystem && $readerEnableFilesystemApi$`.
      if (!('showOpenFilePicker' in window) || !readerEnableFilesystemApi$.get()) return false;
      const handle = await db.get('handle', [title, 'subtitle']).catch(() => undefined);
      return !!handle?.handle;
    },
    async linkedSubtitleFile() {
      let answer: LinkAnswer;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) answer = { ok: false };
      else {
        try {
          answer = { ok: true, link: await api.audioLink(bookId) };
        } catch {
          answer = { ok: false };
        }
      }
      return subtitleFileFor(answer, answer.ok ? api : null, await storedAudio(bookId));
    },
    parseSubtitleFile: (file) => updateSubtitles(file, document),
    savedLines: (saved) =>
      // The book page plays nothing: no audio length to keep the times inside.
      persistedSubtitles(
        saved,
        subtitlesGlobalStartPadding$.get(),
        subtitlesGlobalEndPadding$.get(),
        0
      ),
    settings: {
      ignoreRp: () => matchLineIgnoreRp$.get(),
      similarityThreshold: () => matchLineSimilarityThreshold$.get(),
      maxAttempts: () => matchLineMaxAttempts$.get()
    },
    matcher: matchSubtitles,
    withinRequestTime: (promise, fallback) => withinRequestTime(promise, fallback),
    now: () => Date.now()
  };
}

/** This book's copy on this device as whispersync knows it, or null when there is none. */
export async function bookRefOnDevice(bookId: string): Promise<BookRef | null> {
  const link = await getLibraryStore()
    .getLink(bookId)
    .catch(() => undefined);
  if (!link) return null;
  const db = await database.db;
  const row = await db.get('data', link.localId);
  if (!row) return null;
  return {
    bookId,
    localId: link.localId,
    title: row.title,
    fileSha256: link.how === 'imported' ? (link.fileSha256 ?? null) : null
  };
}

/** The server's saved match, after fetching the latest records (at most the request time). */
export async function matchStateOf(bookId: string): Promise<'matched' | 'not-matched'> {
  await withinRequestTime(getSyncRunner()?.syncNow() ?? Promise.resolve(null), null);
  return (await hasLiveMatch(await getSyncEngine(), bookId)) ? 'matched' : 'not-matched';
}

/** The reader's opening sync first (fetch the latest records, at most the request time). */
export async function fetchLatest(): Promise<void> {
  await withinRequestTime(getSyncRunner()?.syncNow() ?? Promise.resolve(null), null);
}
