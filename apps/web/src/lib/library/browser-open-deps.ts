/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BooksDbBookData } from '$lib/data/database/books-db/versions/books-db';
import { getBrowserStorageHandler } from '$lib/data/storage/storage-handler-factory';
import { database, requestPersistentStorage$ } from '$lib/data/store';
import { storage } from '$lib/data/window/navigator/storage';
import loadEpub from '$lib/functions/file-loaders/epub/load-epub';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import type { LoadData } from '$lib/functions/file-loaders/types';
import type { LibraryApi } from '$lib/library/api';
import type { LocalBookInfo } from '$lib/library/decide-open';
import type { LibraryStore } from '$lib/library/library-db';
import type { ExistingBookQuestion, OpenDeps } from '$lib/library/open-calibre-book';
import { legacyBookIdForTitle } from '$lib/sync/book-ids';

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
 * Saves a book the way the old manual import did: persistent-storage request, then the
 * browser storage handler's startContext / saveBook / saveCover. A newer copy already on
 * this device is kept (NewOnly) unless `saveBehavior` says otherwise.
 */
async function saveLikeManualImport(
  content: LoadData,
  signal: AbortSignal,
  saveBehavior = ReplicationSaveBehavior.NewOnly
): Promise<number> {
  if (requestPersistentStorage$.getValue()) {
    try {
      await storage.persist();
    } catch {
      // no-op, as in importData
    }
  }
  const handler = getBrowserStorageHandler(window, saveBehavior);
  handler.startContext({ title: content.title, imagePath: content.coverImage || '' }, signal);
  const id = await handler.saveBook(content, false);
  if (content.coverImage) await handler.saveCover(content.coverImage);
  return id;
}

export function browserOpenDeps(
  api: LibraryApi,
  store: LibraryStore,
  calibreLibraryUuid: (libraryId: string) => Promise<string | null>,
  confirmExisting: (question: ExistingBookQuestion) => Promise<boolean>,
  confirmPlaceholder: (question: ExistingBookQuestion) => Promise<boolean> = async () => false
): OpenDeps {
  return {
    api,
    store,
    getLocalBook: async (id) => toInfo(await database.getData(id)),
    getLocalBookByTitle: async (title) => toInfo(await database.getDataByTitle(title)),
    loadEpub: (file) => loadEpub(file, document, Date.now()),
    saveNewBook: (content, signal) => saveLikeManualImport(content, signal),
    calibreLibraryUuid,
    confirmExisting,
    // WP7b: a placeholder of a migrated book becomes the library copy. The title is the
    // same, so the record (and its id, bookmark and stats) is kept; Overwrite so an old
    // placeholder timestamp never keeps the empty record.
    migratedBookId: async (title) => {
      try {
        const { getSyncEngine } = await import('$lib/sync/sync-service');
        return await legacyBookIdForTitle(await getSyncEngine(), title);
      } catch {
        return null;
      }
    },
    fillPlaceholder: (content, signal) =>
      saveLikeManualImport(content, signal, ReplicationSaveBehavior.Overwrite),
    confirmPlaceholder
  };
}

/** Local ids that still exist (cheap: keys only), to mark books as on this device. */
export async function existingLocalIds(): Promise<Set<number>> {
  const db = await database.db;
  return new Set(await db.getAllKeys('data'));
}
