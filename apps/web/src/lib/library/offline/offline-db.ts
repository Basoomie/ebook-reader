/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CatalogBookDetail, CatalogLibrary } from '$lib/library/types';

/**
 * The offline Library's copy of the catalog (Season 2 §2, "Offline Library"): for each
 * library book stored on this device, what the server said about it the last time it was
 * asked, and its cover thumbnail. The offline catalog (offline-catalog.ts) answers the
 * Library, Collections and Home from it when the server can't be reached.
 *
 * Its own IndexedDB database, not a new version of `ttsu-library`: an older build opens
 * `ttsu-library` at version 1, which fails once the database is at version 2 (the same
 * reason WP6 kept `books` apart). An older build simply ignores this one.
 */
export const OFFLINE_DB_NAME = 'ttsu-library-offline';

export interface OfflineCopy {
  bookId: string;
  /**
   * The book as the server sent it: the list summary (with titleSort and authorSort) plus,
   * when `hasDetail`, the details page's description and sources.
   */
  book: CatalogBookDetail;
  hasDetail: boolean;
  /** The cover thumbnail, or null when the book has none (or it couldn't be fetched). */
  thumbnail: Blob | null;
  /** The thumbnail URL `thumbnail` came from (its version changes with the cover). */
  thumbnailOf: string | null;
  /**
   * The server's last lookup didn't return the book (its library was switched off, or it
   * is gone from the catalog): hidden offline too, as the server hides it.
   */
  hidden: boolean;
  savedAt: number;
}

export interface SavedLibraries {
  libraries: CatalogLibrary[];
  savedAt: number;
}

interface OfflineDbSchema extends DBSchema {
  copies: { key: string; value: OfflineCopy };
  meta: { key: string; value: SavedLibraries };
}

const LIBRARIES_KEY = 'libraries';

export function createOfflineDb(name = OFFLINE_DB_NAME) {
  return openDB<OfflineDbSchema>(name, 1, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('copies', { keyPath: 'bookId' });
        db.createObjectStore('meta');
      }
    }
  });
}

export class OfflineStore {
  private dbPromise: Promise<IDBPDatabase<OfflineDbSchema>> | undefined;

  constructor(private readonly open: () => Promise<IDBPDatabase<OfflineDbSchema>>) {}

  private get db() {
    this.dbPromise ??= this.open();
    return this.dbPromise;
  }

  async getAll(): Promise<OfflineCopy[]> {
    return (await this.db).getAll('copies');
  }

  async get(bookId: string): Promise<OfflineCopy | undefined> {
    return (await this.db).get('copies', bookId);
  }

  async put(copy: OfflineCopy): Promise<void> {
    await (await this.db).put('copies', copy);
  }

  async delete(bookId: string): Promise<void> {
    await (await this.db).delete('copies', bookId);
  }

  async getLibraries(): Promise<SavedLibraries | undefined> {
    return (await this.db).get('meta', LIBRARIES_KEY);
  }

  async setLibraries(libraries: CatalogLibrary[], savedAt: number): Promise<void> {
    await (await this.db).put('meta', { libraries, savedAt }, LIBRARIES_KEY);
  }
}

let shared: OfflineStore | undefined;

/** The app's offline catalog store (browser only). */
export function getOfflineStore(): OfflineStore {
  shared ??= new OfflineStore(() => createOfflineDb());
  return shared;
}
