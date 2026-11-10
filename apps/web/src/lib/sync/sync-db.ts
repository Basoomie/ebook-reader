/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Local side of the record sync (WP4): a mirror of the synced records plus
 * the outbox of local changes not yet acknowledged by the server.
 *
 * A separate IndexedDB database, like `ttsu-library`: an older app build
 * never opens it, so rolling back can't hit a version error in `books`.
 */
export const SYNC_DB_NAME = 'ttsu-sync';

/** A synced record as stored locally. */
export interface LocalRecord {
  kind: string;
  id: string;
  bookId: string | null;
  /** Last writer. */
  deviceId: string;
  updatedAt: number;
  deletedAt: number | null;
  /** Server rev once the server has it; null for a local write not yet acknowledged. */
  rev: number | null;
  data: Record<string, unknown>;
}

/** What is pushed for a record. */
export interface Change {
  kind: string;
  id: string;
  updatedAt: number;
  deletedAt: number | null;
  data: Record<string, unknown>;
}

/** At most one pending change per record: a newer edit replaces the older one. */
export interface OutboxEntry {
  kind: string;
  id: string;
  /** Local write counter; an acknowledgement only removes the entry it was sent for. */
  seq: number;
  change: Change;
}

/** A change the server refused (kept for the bug report; never retried). */
export interface RejectedEntry {
  key?: number;
  change: Change;
  error: { code: string; message: string };
  at: number;
}

export interface SyncMeta {
  deviceId: string;
  /** Opaque pull cursor from the server; absent = pull from the start. */
  cursor?: string;
  /** serverTime - local clock, from the last sync. */
  clockOffsetMs: number;
  /** Last value of the local write counter. */
  seq: number;
  lastSyncAt?: number;
  lastError?: string;
  /** Raw localStorage values last published as device settings, by key. */
  publishedSettings?: Record<string, string | null>;
  /**
   * "Continue from...?" (WP9): position record id -> updatedAt of the version
   * already answered on this device, so it isn't offered again.
   */
  positionPromptHandled?: Record<string, number>;
  /**
   * WP5: the settings-source device whose global values this device adopted
   * (or its own id on the source device). Global settings sync starts then.
   */
  globalSettingsAdoptedFrom?: string;
  /**
   * A Start over the server refused because that number was already finished
   * elsewhere, re-planned as the next free number: bookId -> the refused
   * read-through ids and the new one. Only this device's own position record is
   * read through it (it may carry a refused id); no record is rewritten.
   */
  startOverMoves?: Record<string, { from: string[]; to: string }>;
}

export interface SyncDbSchema extends DBSchema {
  meta: { key: string; value: SyncMeta };
  records: {
    key: [string, string];
    value: LocalRecord;
    indexes: { kind: string; bookId: string };
  };
  outbox: { key: [string, string]; value: OutboxEntry; indexes: { seq: number } };
  rejected: { key: number; value: RejectedEntry };
}

export type SyncDb = IDBPDatabase<SyncDbSchema>;

export const META_KEY = 'state';

export function openSyncDb(name = SYNC_DB_NAME): Promise<SyncDb> {
  return openDB<SyncDbSchema>(name, 1, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('meta');
        const records = db.createObjectStore('records', { keyPath: ['kind', 'id'] });
        records.createIndex('kind', 'kind');
        records.createIndex('bookId', 'bookId');
        const outbox = db.createObjectStore('outbox', { keyPath: ['kind', 'id'] });
        outbox.createIndex('seq', 'seq');
        db.createObjectStore('rejected', { keyPath: 'key', autoIncrement: true });
      }
    }
  });
}
