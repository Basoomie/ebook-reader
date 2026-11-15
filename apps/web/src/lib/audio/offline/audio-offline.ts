/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { logger } from '$lib/data/logger';
import { requestPersistentStorage$ } from '$lib/data/store';
import {
  canEstimateStorage,
  canPersistStorage,
  isSecureContext
} from '$lib/functions/secure-context';
import { LibraryApi } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { AudioDownloads } from './audio-download';
import { getAudioOfflineStore, type AudioCopy, type AudioOfflineStore } from './audio-offline-db';

/**
 * The app's downloaded audio (Season 2 Phase 9): the download manager with the browser's
 * own fetch, storage and server connection, and what playback and the Library read.
 */

/**
 * Downloads are offered only at an https address (decided 2026-11-15): over plain http the
 * app can't open without the server (no service worker), can't ask for persistent storage
 * and can't tell the free room, so a copy there would not make the reader usable offline.
 */
export function canDownloadAudio(): boolean {
  return isSecureContext();
}

function timeoutSeconds(): number {
  return Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
}

async function libraryApi(): Promise<LibraryApi> {
  const connection = await getLibraryStore().getConnection();
  if (!connection) throw new Error('This device is not connected to a library server.');
  return new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds());
}

let downloads: AudioDownloads | undefined;

/** The app's download manager (browser only); continues stopped downloads when online. */
export function getAudioDownloads(): AudioDownloads {
  if (downloads) return downloads;
  const store = getAudioOfflineStore();
  const manager = new AudioDownloads({
    store,
    link: async (bookId) => (await libraryApi()).audioLink(bookId),
    subtitle: async (bookId) => (await libraryApi()).linkedSubtitleFile(bookId),
    absolute: async (url) => (await libraryApi()).absolute(url),
    fetch: (input, init) => fetch(input, init),
    stallSeconds: timeoutSeconds,
    estimate: async () => {
      if (!canEstimateStorage()) return null;
      const { quota, usage } = await navigator.storage.estimate();
      return typeof quota === 'number' && typeof usage === 'number' ? { quota, usage } : null;
    },
    persist: async () => {
      if (!requestPersistentStorage$.getValue() || !canPersistStorage()) return;
      try {
        await navigator.storage.persist();
      } catch {
        // no-op, as when a book is opened
      }
    },
    published: async () => {
      const { publishDeviceBooks } = await import('$lib/sync/sync-service');
      await publishDeviceBooks();
    },
    now: () => Date.now(),
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    log: (message) => logger.warn(message)
  });
  if (browser) window.addEventListener('online', () => manager.onOnline());
  downloads = manager;
  return manager;
}

/** Library book ids whose audio is fully downloaded on this device. */
export async function audioBookIdsOnDevice(
  store: AudioOfflineStore = getAudioOfflineStore()
): Promise<string[]> {
  return (await store.getAll()).filter((c) => c.complete).map((c) => c.bookId);
}

/** The stored copy of the book, or null (never throws). */
export async function storedAudio(bookId: string): Promise<AudioCopy | null> {
  try {
    return (await getAudioOfflineStore().get(bookId)) ?? null;
  } catch (error) {
    logger.warn(`Offline audio: ${(error as Error)?.message ?? error}`);
    return null;
  }
}

/** The copy as one file (its pieces stay on disk), or null when it isn't complete. */
export async function audioFileOf(
  copy: AudioCopy,
  store: AudioOfflineStore = getAudioOfflineStore()
): Promise<File | null> {
  if (!copy.complete) return null;
  const pieces = await store.pieces(copy.bookId);
  const file = new File(pieces, copy.fileName, { type: copy.contentType });
  return file.size === copy.size ? file : null;
}

let playing: string | null = null;

/**
 * A blob: URL for whispersync to play, and the same file for reading its cover and
 * chapters. Only one is kept: the one made before is revoked (one book plays at a time).
 */
export async function localSource(copy: AudioCopy): Promise<{ url: string; file: File } | null> {
  const file = await audioFileOf(copy);
  if (!file) return null;
  if (playing) URL.revokeObjectURL(playing);
  playing = URL.createObjectURL(file);
  return { url: playing, file };
}

/**
 * Keeps the link's subtitle file with a finished copy (linked after the download, or
 * changed since), so whispersync follows the text offline too. Never throws.
 */
export async function keepSubtitle(copy: AudioCopy, relPath: string, file: File): Promise<void> {
  try {
    const store = getAudioOfflineStore();
    const current = await store.get(copy.bookId);
    if (!current || !current.complete || current.version !== copy.version) return;
    await store.put({ ...current, subtitle: { relPath, name: file.name, blob: file } });
  } catch (error) {
    logger.warn(`Offline audio: subtitles not kept: ${(error as Error)?.message ?? error}`);
  }
}

/** Removes the book's downloaded audio (stops a running download first). Never throws. */
export async function removeAudio(bookId: string): Promise<void> {
  try {
    await getAudioDownloads().remove(bookId);
  } catch (error) {
    logger.warn(`Offline audio: not removed: ${(error as Error)?.message ?? error}`);
  }
}
