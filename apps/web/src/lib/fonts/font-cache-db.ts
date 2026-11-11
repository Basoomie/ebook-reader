/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * This device's copies of the server's custom fonts (WP13), so they work offline.
 *
 * IndexedDB, not the Cache API: the app is served over plain http, where browsers
 * offer no Cache API or service worker. A separate database, like `ttsu-library` and
 * `ttsu-sync`: an older app build never opens it.
 */
export const FONT_CACHE_DB_NAME = 'ttsu-fonts';

export interface CachedFont {
  /** The font's id (its sync record id). */
  id: string;
  /** Family name the font is registered under. */
  name: string;
  format: string;
  size: number;
  sha256: string;
  blob: Blob;
  savedAt: number;
}

interface FontCacheSchema extends DBSchema {
  files: { key: string; value: CachedFont };
}

export function openFontCacheDb(name = FONT_CACHE_DB_NAME): Promise<IDBPDatabase<FontCacheSchema>> {
  return openDB<FontCacheSchema>(name, 1, {
    upgrade(db) {
      db.createObjectStore('files', { keyPath: 'id' });
    }
  });
}

/** The font file store the font service works with (tests pass an in-memory one). */
export interface FontCache {
  getAll(): Promise<CachedFont[]>;
  put(font: CachedFont): Promise<void>;
  delete(id: string): Promise<void>;
}

export class IdbFontCache implements FontCache {
  private db: Promise<IDBPDatabase<FontCacheSchema>> | null = null;

  constructor(
    private readonly open: () => Promise<IDBPDatabase<FontCacheSchema>> = openFontCacheDb
  ) {}

  private get handle() {
    if (!this.db) {
      this.db = this.open();
      this.db.catch(() => {
        this.db = null; // try again next time
      });
    }
    return this.db;
  }

  async getAll(): Promise<CachedFont[]> {
    return (await this.handle).getAll('files');
  }

  async put(font: CachedFont): Promise<void> {
    await (await this.handle).put('files', font);
  }

  async delete(id: string): Promise<void> {
    await (await this.handle).delete('files', id);
  }
}
