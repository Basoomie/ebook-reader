/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApiError } from '$lib/library/api';
import type { LocalGallery } from './local-illustrations';
import type { GalleryPicture, ServerIllustrationList } from './types';

/**
 * Season 2 §6 (decided 2026-11-15): where the book page's illustrations come from.
 * A book stored on this device shows its own copy's pictures (online and offline). Any
 * other book asks the server while it can be reached; a list the server is still making
 * is asked for again every `pollMs`. Offline, a book not on this device shows a note.
 */
export type GalleryState =
  | { kind: 'loading' }
  | { kind: 'preparing' }
  | { kind: 'ready'; pictures: GalleryPicture[]; coverSrc: string | null; local: boolean }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string }
  | { kind: 'none' };

export interface GallerySources {
  local: (bookId: string) => Promise<LocalGallery | null>;
  /** null: no library server connection. */
  server: ((bookId: string, signal: AbortSignal) => Promise<ServerIllustrationList>) | null;
  absolute: (url: string) => string;
  /** The page already knows the server can't be reached. */
  offline: boolean;
  pollMs?: number;
}

export const POLL_MS = 2000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Reports each state through `onState` until the pictures are there, or there is nothing
 * to show. Returns the local gallery when one was used (the caller releases it).
 */
export async function loadGallery(
  bookId: string,
  sources: GallerySources,
  signal: AbortSignal,
  onState: (state: GalleryState) => void
): Promise<LocalGallery | null> {
  onState({ kind: 'loading' });
  const local = await sources.local(bookId).catch(() => null);
  if (signal.aborted) {
    local?.release();
    return null;
  }
  if (local) {
    onState({ kind: 'ready', pictures: local.pictures, coverSrc: local.coverSrc, local: true });
    return local;
  }
  if (!sources.server) {
    onState({ kind: 'none' });
    return null;
  }
  if (sources.offline) {
    onState({ kind: 'offline' });
    return null;
  }
  for (;;) {
    let list: ServerIllustrationList;
    try {
      list = await sources.server(bookId, signal);
    } catch (err) {
      if (signal.aborted) return null;
      const kind = err instanceof LibraryApiError ? err.kind : undefined;
      onState(
        kind === 'unreachable' || kind === 'timeout' ? { kind: 'offline' } : { kind: 'none' }
      );
      return null;
    }
    if (signal.aborted) return null;
    if (list.status === 'ready') {
      onState({
        kind: 'ready',
        coverSrc: null,
        local: false,
        pictures: list.items.map((item) => ({
          beforeToc: item.beforeToc,
          width: item.width,
          height: item.height,
          thumbSrc: sources.absolute(item.thumbUrl),
          fullSrc: sources.absolute(item.url)
        }))
      });
      return null;
    }
    if (list.status === 'failed') {
      onState({ kind: 'failed', message: list.message });
      return null;
    }
    onState({ kind: 'preparing' });
    await sleep(sources.pollMs ?? POLL_MS, signal);
    if (signal.aborted) return null;
  }
}
