/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BooksDbBookData } from '$lib/data/database/books-db/versions/books-db';
import { getStorageHandler } from '$lib/data/storage/storage-handler-factory';
import { StorageKey } from '$lib/data/storage/storage-types';
import {
  cacheStorageData$,
  database,
  readingGoalsMergeMode$,
  replicationSaveBehavior$,
  requestPersistentStorage$,
  statisticsMergeMode$
} from '$lib/data/store';
import { storage } from '$lib/data/window/navigator/storage';
import loadEpub from '$lib/functions/file-loaders/epub/load-epub';
import type { LoadData } from '$lib/functions/file-loaders/types';
import type { LibraryApi } from '$lib/library/api';
import type { LocalBookInfo } from '$lib/library/decide-open';
import type { LibraryStore } from '$lib/library/library-db';
import type { ExistingBookQuestion, OpenDeps } from '$lib/library/open-calibre-book';

function toInfo(book: BooksDbBookData | undefined): LocalBookInfo | undefined {
  if (!book) return undefined;
  return {
    id: book.id,
    title: book.title,
    characters: book.characters || 0,
    isPlaceholder: !book.elementHtml,
    storageSource: book.storageSource
  };
}

/**
 * Saves a book the same way a manual import does (replicator.ts importData):
 * persistent-storage request, then the browser storage handler's
 * startContext / saveBook / saveCover, then a Manager list refresh.
 * importData itself is left untouched.
 */
async function saveLikeManualImport(content: LoadData, signal: AbortSignal): Promise<number> {
  if (requestPersistentStorage$.getValue()) {
    try {
      await storage.persist();
    } catch {
      // no-op, as in importData
    }
  }
  const handler = getStorageHandler(
    window,
    StorageKey.BROWSER,
    '',
    true,
    cacheStorageData$.getValue(),
    replicationSaveBehavior$.getValue(),
    statisticsMergeMode$.getValue(),
    readingGoalsMergeMode$.getValue()
  );
  handler.startContext({ title: content.title, imagePath: content.coverImage || '' }, signal);
  const id = await handler.saveBook(content, false);
  if (content.coverImage) await handler.saveCover(content.coverImage);
  database.dataListChanged$.next(handler);
  return id;
}

export function browserOpenDeps(
  api: LibraryApi,
  store: LibraryStore,
  calibreLibraryUuid: (libraryId: string) => Promise<string | null>,
  confirmExisting: (question: ExistingBookQuestion) => Promise<boolean>
): OpenDeps {
  return {
    api,
    store,
    getLocalBook: async (id) => toInfo(await database.getData(id)),
    getLocalBookByTitle: async (title) => toInfo(await database.getDataByTitle(title)),
    loadEpub: (file) => loadEpub(file, document, Date.now()),
    saveNewBook: saveLikeManualImport,
    calibreLibraryUuid,
    confirmExisting
  };
}

/** Local ids that still exist (cheap: keys only), to mark books as on this device. */
export async function existingLocalIds(): Promise<Set<number>> {
  const db = await database.db;
  return new Set(await db.getAllKeys('data'));
}
