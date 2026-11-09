/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { randomId } from '$lib/functions/secure-context';
import type { ChangeResult, SyncTransport } from '$lib/sync/sync-api';
import {
  META_KEY,
  openSyncDb,
  type Change,
  type LocalRecord,
  type OutboxEntry,
  type SyncDb,
  type SyncMeta
} from '$lib/sync/sync-db';

/**
 * Client side of the record sync (WP4).
 *
 * Local writes go to the mirror and the outbox in one IndexedDB transaction
 * and never touch the network. sync() registers the device, pushes the outbox,
 * then pulls everything newer than the cursor. The server alone decides which
 * version of a record wins; the client adopts its answer.
 */

export interface SyncEngineOptions {
  /** Defaults to the real `ttsu-sync` database. */
  openDb?: () => Promise<SyncDb>;
  now?: () => number;
  newId?: () => string;
  pushBatchSize?: number;
  pullLimit?: number;
  warn?: (message: string) => void;
}

export interface SyncReport {
  pushed: number;
  stale: number;
  rejected: number;
  pulled: number;
  /** The server asked for a full reconcile (e.g. after a database restore). */
  reconciled: boolean;
}

export interface SyncStatus {
  deviceId: string;
  pending: number;
  rejected: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

type Listener<T> = (value: T) => void;

/** Error codes from the server the engine reacts to. */
function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

const MAX_PUSH_ROUNDS = 50;
const MAX_PULL_PAGES = 10_000;

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  private registeredWith = new WeakSet<SyncTransport>();
  private readonly localListeners = new Set<Listener<LocalRecord>>();
  private readonly remoteListeners = new Set<Listener<LocalRecord[]>>();
  private readonly now: () => number;
  private readonly pushBatchSize: number;
  private readonly pullLimit: number;
  private readonly warn: (message: string) => void;

  private constructor(
    private readonly db: SyncDb,
    private currentDeviceId: string,
    options: SyncEngineOptions
  ) {
    this.now = options.now ?? (() => Date.now());
    this.pushBatchSize = options.pushBatchSize ?? 500;
    this.pullLimit = options.pullLimit ?? 500;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Opens the local database; makes this device's id on first use. */
  static async open(options: SyncEngineOptions = {}): Promise<SyncEngine> {
    const db = await (options.openDb ?? (() => openSyncDb()))();
    const tx = db.transaction('meta', 'readwrite');
    let meta = await tx.store.get(META_KEY);
    if (!meta) {
      meta = { deviceId: (options.newId ?? randomId)(), clockOffsetMs: 0, seq: 0 };
      await tx.store.put(meta, META_KEY);
    }
    await tx.done;
    return new SyncEngine(db, meta.deviceId, options);
  }

  get deviceId(): string {
    return this.currentDeviceId;
  }

  close(): void {
    this.db.close();
  }

  // ---- local writes -------------------------------------------------------

  /** Writes a record locally and queues it. Throws on storage errors (see put). */
  async write(
    kind: string,
    id: string,
    data: Record<string, unknown>,
    options: { bookId?: string | null; deleted?: boolean } = {}
  ): Promise<LocalRecord> {
    const tx = this.db.transaction(['records', 'outbox', 'meta'], 'readwrite');
    const records = tx.objectStore('records');
    const metaStore = tx.objectStore('meta');
    const meta = (await metaStore.get(META_KEY)) as SyncMeta;
    const existing = await records.get([kind, id]);

    let updatedAt = Math.round(this.now() + meta.clockOffsetMs);
    if (existing && updatedAt <= existing.updatedAt) updatedAt = existing.updatedAt + 1;
    const deleted = options.deleted === true;

    const record: LocalRecord = {
      kind,
      id,
      bookId: options.bookId ?? existing?.bookId ?? null,
      deviceId: this.currentDeviceId,
      updatedAt,
      deletedAt: deleted ? updatedAt : null,
      rev: existing?.rev ?? null,
      data: deleted ? {} : data
    };
    meta.seq += 1;
    const entry: OutboxEntry = {
      kind,
      id,
      seq: meta.seq,
      change: { kind, id, updatedAt, deletedAt: record.deletedAt, data: record.data }
    };
    await Promise.all([
      records.put(record),
      tx.objectStore('outbox').put(entry),
      metaStore.put(meta, META_KEY),
      tx.done
    ]);
    this.emit(this.localListeners, record);
    return record;
  }

  /**
   * Writes a record locally and queues it for the server. Never throws: a
   * failure is logged and reported as false, so callers in the reader can't
   * be disturbed by sync problems.
   */
  async put(
    kind: string,
    id: string,
    data: Record<string, unknown>,
    options: { bookId?: string | null } = {}
  ): Promise<boolean> {
    try {
      await this.write(kind, id, data, options);
      return true;
    } catch (error) {
      this.warn(`Sync: could not save ${kind} ${id}: ${(error as Error)?.message ?? error}`);
      return false;
    }
  }

  /** Marks a record deleted (a deletion marker that syncs). Never throws. */
  async remove(kind: string, id: string): Promise<boolean> {
    try {
      await this.write(kind, id, {}, { deleted: true });
      return true;
    } catch (error) {
      this.warn(`Sync: could not delete ${kind} ${id}: ${(error as Error)?.message ?? error}`);
      return false;
    }
  }

  // ---- reads --------------------------------------------------------------

  get(kind: string, id: string): Promise<LocalRecord | undefined> {
    return this.db.get('records', [kind, id]);
  }

  getAll(kind: string): Promise<LocalRecord[]> {
    return this.db.getAllFromIndex('records', 'kind', kind);
  }

  getForBook(bookId: string): Promise<LocalRecord[]> {
    return this.db.getAllFromIndex('records', 'bookId', bookId);
  }

  async getMeta(): Promise<SyncMeta> {
    return (await this.db.get('meta', META_KEY)) as SyncMeta;
  }

  /** Changes local bookkeeping (e.g. which settings were published) atomically. */
  async updateMeta(change: (meta: SyncMeta) => void): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    const meta = (await tx.store.get(META_KEY)) as SyncMeta;
    change(meta);
    await Promise.all([tx.store.put(meta, META_KEY), tx.done]);
  }

  async status(): Promise<SyncStatus> {
    const [meta, pending, rejected] = await Promise.all([
      this.getMeta(),
      this.db.count('outbox'),
      this.db.count('rejected')
    ]);
    return {
      deviceId: this.currentDeviceId,
      pending,
      rejected,
      lastSyncAt: meta.lastSyncAt ?? null,
      lastError: meta.lastError ?? null
    };
  }

  /** Called after every local write (the runner uses it to schedule a sync). */
  onLocalWrite(listener: Listener<LocalRecord>): () => void {
    this.localListeners.add(listener);
    return () => this.localListeners.delete(listener);
  }

  /** Called with the records a pull changed locally. */
  onRemoteChange(listener: Listener<LocalRecord[]>): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  // ---- sync ---------------------------------------------------------------

  /**
   * One sync cycle: register, push, pull. Concurrent calls share the running
   * cycle. Throws on network and server errors (the runner retries later);
   * the error is also stored for the status display.
   */
  sync(transport: SyncTransport): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.runCycle(transport).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runCycle(transport: SyncTransport): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, stale: 0, rejected: 0, pulled: 0, reconciled: false };
    try {
      await this.withRegistration(transport, () => this.pushAll(transport, report));
      try {
        await this.withRegistration(transport, () => this.pullAll(transport, report));
      } catch (error) {
        if (errorCode(error) !== 'cursor_reset') throw error;
        // The server lost or replaced its data: re-send what this device wrote
        // and pull everything from the start.
        report.reconciled = true;
        await this.prepareReconcile();
        await this.pushAll(transport, report);
        await this.pullAll(transport, report);
      }
      await this.updateMeta((meta) => {
        meta.lastSyncAt = this.now();
        delete meta.lastError;
      });
      return report;
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      await this.updateMeta((meta) => {
        meta.lastError = message;
      }).catch(() => {});
      throw error;
    }
  }

  private async ensureRegistered(transport: SyncTransport): Promise<void> {
    if (this.registeredWith.has(transport)) return;
    let response;
    try {
      response = await this.timed(() => transport.register(this.currentDeviceId));
    } catch (error) {
      if (errorCode(error) !== 'token_bound_to_other_device') throw error;
      // This token already belongs to another device id (e.g. this database was
      // cleared but the connection kept): adopt the id the server knows.
      response = await this.timed(() => transport.register(null));
    }
    if (response.device.id !== this.currentDeviceId) {
      this.warn(
        `Sync: this device is known to the server as ${response.device.id}; adopting that id`
      );
      const adopted = response.device.id;
      await this.updateMeta((meta) => {
        meta.deviceId = adopted;
      });
      this.currentDeviceId = adopted;
    }
    this.registeredWith.add(transport);
  }

  private async withRegistration<T>(transport: SyncTransport, fn: () => Promise<T>): Promise<T> {
    await this.ensureRegistered(transport);
    try {
      return await fn();
    } catch (error) {
      if (errorCode(error) !== 'device_not_registered') throw error;
      this.registeredWith.delete(transport);
      await this.ensureRegistered(transport);
      return fn();
    }
  }

  /** Runs a request and updates the clock offset from the server's time. */
  private async timed<T extends { serverTime: number }>(request: () => Promise<T>): Promise<T> {
    const start = this.now();
    const response = await request();
    const end = this.now();
    if (typeof response.serverTime === 'number') {
      const offset = Math.round(response.serverTime - (start + end) / 2);
      await this.updateMeta((meta) => {
        meta.clockOffsetMs = offset;
      });
    }
    return response;
  }

  private async pushAll(transport: SyncTransport, report: SyncReport): Promise<void> {
    for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
      const entries = await this.db.getAllFromIndex('outbox', 'seq', undefined, this.pushBatchSize);
      if (!entries.length) return;
      const response = await this.timed(() => transport.push(entries.map((e) => e.change)));
      await this.applyPushResults(entries, response.results, report);
      if (entries.length < this.pushBatchSize) return;
    }
  }

  private async applyPushResults(
    entries: OutboxEntry[],
    results: ChangeResult[],
    report: SyncReport
  ): Promise<void> {
    const tx = this.db.transaction(['records', 'outbox', 'rejected'], 'readwrite');
    const outbox = tx.objectStore('outbox');
    const records = tx.objectStore('records');
    const adopted: LocalRecord[] = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const result = results[i];
      if (!result || result.kind !== entry.kind || result.id !== entry.id) {
        this.warn(`Sync: no matching push result for ${entry.kind} ${entry.id}`);
        continue;
      }
      const key: [string, string] = [entry.kind, entry.id];
      const current = await outbox.get(key);
      // An edit made while this push was in flight stays queued.
      const unchanged = current?.seq === entry.seq;

      if (result.status === 'stale') {
        report.stale += 1;
        if (unchanged) {
          await outbox.delete(key);
          const record = { ...result.record };
          await records.put(record);
          adopted.push(record);
        }
      } else if (result.status !== 'rejected') {
        // applied or duplicate
        report.pushed += 1;
        if (unchanged) await outbox.delete(key);
        const record = await records.get(key);
        if (
          record &&
          record.updatedAt === entry.change.updatedAt &&
          record.deviceId === this.currentDeviceId
        ) {
          record.rev = result.rev;
          await records.put(record);
        }
      } else {
        report.rejected += 1;
        if (unchanged) await outbox.delete(key);
        await tx.objectStore('rejected').add({
          change: entry.change,
          error: result.error,
          at: this.now()
        });
        this.warn(
          `Sync: the server refused ${entry.kind} ${entry.id}: ${result.error.code} (${result.error.message})`
        );
      }
    }
    await tx.done;
    if (adopted.length) this.emit(this.remoteListeners, adopted);
  }

  private async pullAll(transport: SyncTransport, report: SyncReport): Promise<void> {
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const { cursor } = await this.getMeta();
      const response = await this.timed(() => transport.pull(cursor, this.pullLimit));

      const tx = this.db.transaction(['records', 'outbox', 'meta'], 'readwrite');
      const records = tx.objectStore('records');
      const outbox = tx.objectStore('outbox');
      const changed: LocalRecord[] = [];
      for (const incoming of response.records) {
        const key: [string, string] = [incoming.kind, incoming.id];
        // A queued local edit is settled by the next push, not overwritten here.
        if (await outbox.get(key)) continue;
        const record: LocalRecord = {
          kind: incoming.kind,
          id: incoming.id,
          bookId: incoming.bookId ?? null,
          deviceId: incoming.deviceId,
          updatedAt: incoming.updatedAt,
          deletedAt: incoming.deletedAt ?? null,
          rev: incoming.rev,
          data: incoming.data ?? {}
        };
        await records.put(record);
        changed.push(record);
      }
      const metaStore = tx.objectStore('meta');
      const meta = (await metaStore.get(META_KEY)) as SyncMeta;
      meta.cursor = response.cursor;
      await metaStore.put(meta, META_KEY);
      await tx.done;

      report.pulled += response.records.length;
      if (changed.length) this.emit(this.remoteListeners, changed);
      if (!response.more) return;
    }
  }

  /** Queues every record this device wrote (unless queued already) and resets the cursor. */
  private async prepareReconcile(): Promise<void> {
    const tx = this.db.transaction(['records', 'outbox', 'meta'], 'readwrite');
    const outbox = tx.objectStore('outbox');
    const metaStore = tx.objectStore('meta');
    const meta = (await metaStore.get(META_KEY)) as SyncMeta;
    const mine = (await tx.objectStore('records').getAll()).filter(
      (r) => r.deviceId === this.currentDeviceId
    );
    for (const record of mine) {
      const key: [string, string] = [record.kind, record.id];
      if (await outbox.get(key)) continue;
      meta.seq += 1;
      const change: Change = {
        kind: record.kind,
        id: record.id,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
        data: record.data
      };
      await outbox.put({ kind: record.kind, id: record.id, seq: meta.seq, change });
    }
    delete meta.cursor;
    await metaStore.put(meta, META_KEY);
    await tx.done;
  }

  private emit<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        this.warn(`Sync: listener failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }
}
