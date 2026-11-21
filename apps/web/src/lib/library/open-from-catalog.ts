/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { confirmDestructive } from '$lib/confirm/confirm';
import { openLibraryCopyCopy, openOwnCopyCopy } from '$lib/confirm/confirm-copy';
import type { LibraryApi } from './api';
import { browserOpenDeps } from './browser-open-deps';
import type { LibraryStore } from './library-db';
import {
  openCalibreBook,
  type ExistingBookQuestion,
  type OpenOutcome,
  type OpenTarget,
  type OpenStage
} from './open-calibre-book';
import type { CatalogLibrary } from './types';

/**
 * Opening a catalog book from a page (Library, Home: WP7b), with the browser's
 * dependencies and the "Already on this device" question. The rules are WP6's
 * (open-calibre-book.ts, decide-open.ts), unchanged.
 */

export function askExistingBook(question: ExistingBookQuestion): Promise<boolean> {
  return confirmDestructive({ ...openOwnCopyCopy(question), testid: 'open-own-copy-dialog' });
}

/** WP7b: before a migrated placeholder becomes the library copy with another count. */
export function askPlaceholderBook(question: ExistingBookQuestion): Promise<boolean> {
  return confirmDestructive({
    ...openLibraryCopyCopy(question),
    testid: 'open-library-copy-dialog'
  });
}

export function openCatalogBook(
  book: OpenTarget,
  api: LibraryApi,
  store: LibraryStore,
  libraries: readonly CatalogLibrary[],
  signal: AbortSignal,
  onStage: (stage: OpenStage) => void
): Promise<OpenOutcome> {
  const deps = browserOpenDeps(
    api,
    store,
    async (libraryId) => libraries.find((l) => l.id === libraryId)?.calibreLibraryUuid ?? null,
    askExistingBook,
    askPlaceholderBook
  );
  return openCalibreBook(book, deps, signal, onStage).then((outcome) => {
    // WP15e: a new copy on this device shows in "On this device" (also one stored before
    // its audiobook step was cancelled).
    if (
      outcome.status === 'opened' ||
      (outcome.status === 'cancelled' && outcome.storedLocalId !== undefined)
    ) {
      void import('$lib/sync/sync-service')
        .then(({ publishDeviceBooks }) => publishDeviceBooks())
        .catch(() => {});
      // Season 2 §2: its offline Library copy (opening a stored book asks nothing of the
      // server, and the refresh stops quietly when it can't be reached).
      void import('$lib/library/offline/offline-source')
        .then(({ refreshOfflineCopies }) => refreshOfflineCopies(api, { force: true }))
        .catch(() => {});
    }
    return outcome;
  });
}
