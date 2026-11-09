/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import { keysWithScope } from '$lib/sync/settings-registry';

/**
 * Settings over the record sync (WP4). Records hold the raw localStorage
 * string (or null for "never set", i.e. the default), so copying a value to
 * another device reproduces it exactly.
 */

/**
 * Global settings sync is off until a device has been made the source of the
 * global values (WP5: the desktop, see settings-source.ts). Callers pass
 * whether it is on; the default is off.
 */

export interface RawStorage {
  getItem(key: string): string | null | undefined;
}

/**
 * Publishes the settings whose stored value changed since the last publish:
 * always the device-scope ones, and the global ones when global sync is on.
 * Returns how many records were queued.
 */
export async function publishSettings(
  engine: SyncEngine,
  storage: RawStorage,
  globalEnabled = false
): Promise<number> {
  const meta = await engine.getMeta();
  const published = { ...(meta.publishedSettings ?? {}) };
  const ids: [string, string][] = keysWithScope('device').map((key) => [
    `device:${engine.deviceId}:${key}`,
    key
  ]);
  if (globalEnabled) {
    for (const key of keysWithScope('global')) ids.push([`global:${key}`, key]);
  }

  let queued = 0;
  for (const [id, key] of ids) {
    const raw = storage.getItem(key) ?? null;
    if (Object.prototype.hasOwnProperty.call(published, id) && published[id] === raw) continue;
    if (await engine.put('setting', id, { value: raw })) {
      published[id] = raw;
      queued += 1;
    }
  }
  if (queued) {
    await engine.updateMeta((m) => {
      m.publishedSettings = { ...(m.publishedSettings ?? {}), ...published };
    });
  }
  return queued;
}

/**
 * Applies pulled global settings to this device. Does nothing while global
 * sync is off. `apply` sets the value on the live setting (subject + storage).
 * `readStored` (WP5) reads the value stored after applying; it is remembered
 * as published, so a value this device keeps (the source never set the
 * setting) is not pushed back as the global value.
 */
export async function applyGlobalSettings(
  engine: SyncEngine,
  records: LocalRecord[],
  apply: (key: string, raw: string | null) => void,
  globalEnabled = false,
  readStored?: (key: string) => string | null
): Promise<string[]> {
  if (!globalEnabled) return [];
  const globals = new Set(keysWithScope('global'));
  const applied: { id: string; key: string; raw: string | null }[] = [];
  for (const record of records) {
    if (record.kind !== 'setting' || !record.id.startsWith('global:')) continue;
    if (record.deviceId === engine.deviceId) continue;
    const key = record.id.slice('global:'.length);
    if (!globals.has(key)) continue;
    const value = record.deletedAt === null ? record.data.value : null;
    const raw = typeof value === 'string' ? value : null;
    apply(key, raw);
    applied.push({ id: record.id, key, raw: readStored ? readStored(key) : raw });
  }
  if (applied.length) {
    // Remember what we applied so the next publish doesn't echo it back.
    await engine.updateMeta((m) => {
      m.publishedSettings = { ...(m.publishedSettings ?? {}) };
      for (const a of applied) m.publishedSettings[a.id] = a.raw;
    });
  }
  return applied.map((a) => a.key);
}
