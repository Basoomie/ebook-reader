/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Per-device data for the Calibre library (WP6, interim option): the server
 * connection and which local book each opened Calibre book became.
 *
 * Deliberately a separate IndexedDB database, not a new version of `books`:
 * an older app build can still open `books` (v6) after a rollback, and the
 * links survive the import code replacing whole book records.
 */
export const LIBRARY_DB_NAME = 'ttsu-library';

export interface LibraryConnection {
  /** Storage server origin, e.g. http://tower:3081 (no trailing slash). */
  serverUrl: string;
  /** Per-device `ttsu_` API token. */
  token: string;
  /** Device label the token was made for (from the pairing code). */
  label: string;
  connectedAt: number;
}

/**
 * One opened Calibre book. Holds everything the later migration (WP5) needs to
 * match the local book to its catalog entry exactly.
 */
export interface CalibreLink {
  /** Server book ID (stable reader ID). */
  bookId: string;
  /** Server library ID. */
  libraryId: string;
  calibreLibraryUuid: string | null;
  /** Calibre's book UUID; null for an uploaded book (WP7b). */
  calibreUuid: string | null;
  /** Where the file came from (WP7b); missing on links made before WP7b (all Calibre). */
  sourceKind?: 'calibre' | 'upload';
  calibreId: number | null;
  /** Key of the book in the local `books.data` store. */
  localId: number;
  /** EPUB title: today's local and sync key. */
  title: string;
  /** Title in Calibre's metadata.db (may differ from the EPUB title). */
  calibreTitle: string;
  characters: number;
  /** ETag of the downloaded file, to notice a changed file later. */
  fileEtag: string | null;
  linkedAt: number;
  /** imported = saved from the Calibre file; matched = an existing local book was linked. */
  how: 'imported' | 'matched';
  /**
   * WP19d: the catalog's author names, for quote images made in the reader (which knows
   * no authors). Written when the book is opened from the library and refreshed whenever
   * the server is asked again; missing on older links.
   */
  authors?: string[];
}

interface LibraryDbSchema extends DBSchema {
  connection: { key: string; value: LibraryConnection };
  calibreLinks: { key: string; value: CalibreLink; indexes: { localId: number } };
}

const CONNECTION_KEY = 'current';

export function createLibraryDb(name = LIBRARY_DB_NAME) {
  return openDB<LibraryDbSchema>(name, 1, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('connection');
        const links = db.createObjectStore('calibreLinks', { keyPath: 'bookId' });
        links.createIndex('localId', 'localId');
      }
    }
  });
}

export class LibraryStore {
  private dbPromise: Promise<IDBPDatabase<LibraryDbSchema>> | undefined;

  constructor(private readonly open: () => Promise<IDBPDatabase<LibraryDbSchema>>) {}

  private get db() {
    this.dbPromise ??= this.open();
    return this.dbPromise;
  }

  async getConnection(): Promise<LibraryConnection | undefined> {
    return (await this.db).get('connection', CONNECTION_KEY);
  }

  async setConnection(connection: LibraryConnection): Promise<void> {
    await (await this.db).put('connection', connection, CONNECTION_KEY);
  }

  async clearConnection(): Promise<void> {
    await (await this.db).delete('connection', CONNECTION_KEY);
  }

  async getLink(bookId: string): Promise<CalibreLink | undefined> {
    return (await this.db).get('calibreLinks', bookId);
  }

  /** Links pointing at a local book (normally zero or one). */
  async getLinksForLocalId(localId: number): Promise<CalibreLink[]> {
    return (await this.db).getAllFromIndex('calibreLinks', 'localId', localId);
  }

  async getAllLinks(): Promise<CalibreLink[]> {
    return (await this.db).getAll('calibreLinks');
  }

  async putLink(link: CalibreLink): Promise<void> {
    await (await this.db).put('calibreLinks', link);
  }

  async deleteLink(bookId: string): Promise<void> {
    await (await this.db).delete('calibreLinks', bookId);
  }
}

let shared: LibraryStore | undefined;

/** The app's library store (browser only). */
export function getLibraryStore(): LibraryStore {
  shared ??= new LibraryStore(() => createLibraryDb());
  return shared;
}
