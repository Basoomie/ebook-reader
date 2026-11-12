/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
import { dialogManager } from '$lib/data/dialog-manager';
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
  return new Promise((resolve) => {
    dialogManager.dialogs$.next([
      {
        component: ConfirmDialog,
        disableCloseOnClick: true,
        props: {
          dialogHeader: 'Already on this device',
          dialogMessage:
            `You already have "${question.title}" on this device ` +
            `(${question.localCharacters.toLocaleString()} characters). The library copy has ` +
            `${question.calibreCharacters.toLocaleString()} characters, so it may be a different ` +
            'edition. Confirm opens your copy and remembers it as this library book; your copy ' +
            'and its progress are not changed.',
          resolver: (canceled: boolean) => resolve(!canceled)
        }
      }
    ]);
  });
}

/** WP7b: before a migrated placeholder becomes the library copy with another count. */
export function askPlaceholderBook(question: ExistingBookQuestion): Promise<boolean> {
  return new Promise((resolve) => {
    dialogManager.dialogs$.next([
      {
        component: ConfirmDialog,
        disableCloseOnClick: true,
        props: {
          dialogHeader: 'Open the library copy?',
          dialogMessage:
            `Your old copy of "${question.title}" had ${question.localCharacters.toLocaleString()} ` +
            `characters; the library copy has ${question.calibreCharacters.toLocaleString()}, so ` +
            'your place may move a little. Confirm opens the library copy from now on; your ' +
            'reading place, bookmark and stats are kept.',
          resolver: (canceled: boolean) => resolve(!canceled)
        }
      }
    ]);
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
    // WP15e: a new copy on this device shows in "On this device".
    if (outcome.status === 'opened') {
      void import('$lib/sync/sync-service')
        .then(({ publishDeviceBooks }) => publishDeviceBooks())
        .catch(() => {});
    }
    return outcome;
  });
}
