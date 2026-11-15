/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PendingClip } from './pending-clip';

/**
 * Where waiting sentence-audio clips are kept: their own IndexedDB on this device (like
 * `ttsu-library-offline`). Never synced: each device has its own AnkiConnect and Anki
 * collection, and audio stays out of the replicator.
 */

export const PENDING_DB_NAME = 'ttsu-anki-pending';

interface PendingDbSchema extends DBSchema {
  clips: { key: string; value: PendingClip };
}

export function createPendingDb(name = PENDING_DB_NAME) {
  return openDB<PendingDbSchema>(name, 1, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('clips', { keyPath: 'id' });
      }
    }
  });
}

export class PendingStore {
  private dbPromise: Promise<IDBPDatabase<PendingDbSchema>> | undefined;
  private readonly listeners = new Set<() => void>();
  /** Tells this app's other tabs about changes (their Settings lists refresh). */
  private channel: BroadcastChannel | null | undefined;

  constructor(
    private readonly open: () => Promise<IDBPDatabase<PendingDbSchema>>,
    private readonly channelName: string | null = null
  ) {}

  private get db() {
    this.dbPromise ??= this.open();
    return this.dbPromise;
  }

  private getChannel(): BroadcastChannel | null {
    if (this.channel === undefined) {
      this.channel = null;

      try {
        if (this.channelName && typeof BroadcastChannel !== 'undefined') {
          this.channel = new BroadcastChannel(this.channelName);
          this.channel.onmessage = () => this.notify();
        }
      } catch {
        // No other tabs are told; each tab's list still refreshes on its own changes.
      }
    }

    return this.channel;
  }

  /** Called after every change, in this tab or another (the Settings list refreshes). */
  onChange(listener: () => void): () => void {
    this.getChannel();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener's problem is its own.
      }
    }
  }

  private changed(): void {
    this.notify();

    try {
      this.getChannel()?.postMessage('changed');
    } catch {
      // Other tabs see it when their list is opened again.
    }
  }

  async all(): Promise<PendingClip[]> {
    return (await this.db).getAll('clips');
  }

  async get(id: string): Promise<PendingClip | undefined> {
    return (await this.db).get('clips', id);
  }

  async add(clip: PendingClip): Promise<void> {
    await (await this.db).add('clips', clip);
    this.changed();
  }

  async delete(id: string): Promise<void> {
    await (await this.db).delete('clips', id);
    this.changed();
  }

  /**
   * Changes a record only if it still exists (it may have been cancelled meanwhile), in
   * one transaction. Resolves to the new record, or undefined when it was gone.
   */
  async update(
    id: string,
    change: (clip: PendingClip) => PendingClip
  ): Promise<PendingClip | undefined> {
    const tx = (await this.db).transaction('clips', 'readwrite');
    const current = await tx.store.get(id);
    let next: PendingClip | undefined;

    if (current) {
      next = change(current);
      await tx.store.put(next);
    }

    await tx.done;
    if (next) this.changed();
    return next;
  }

  /**
   * Takes a record for one tab until `until` (one transaction, so two tabs can't both take
   * it). False when another tab holds it, or it is gone.
   */
  async claim(id: string, by: string, now: number, until: number): Promise<boolean> {
    const tx = (await this.db).transaction('clips', 'readwrite');
    const current = await tx.store.get(id);
    let taken = false;

    if (current && (!current.claim || current.claim.by === by || current.claim.until <= now)) {
      await tx.store.put({ ...current, claim: { by, until } });
      taken = true;
    }

    await tx.done;
    return taken;
  }

  /** Gives a record back (if it still exists). */
  async release(id: string, by: string): Promise<void> {
    const tx = (await this.db).transaction('clips', 'readwrite');
    const current = await tx.store.get(id);

    if (current?.claim?.by === by) {
      const rest = { ...current };
      delete rest.claim;
      await tx.store.put(rest);
    }

    await tx.done;
  }
}

let shared: PendingStore | undefined;

/** This device's waiting clips (browser only). */
export function getPendingStore(): PendingStore {
  shared ??= new PendingStore(() => createPendingDb(), PENDING_DB_NAME);
  return shared;
}
