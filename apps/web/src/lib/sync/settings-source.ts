/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BooksDbReadingGoal } from '$lib/data/database/books-db/versions/books-db';
import { publishReadingGoals } from '$lib/sync/record-goals';
import { keysWithScope } from '$lib/sync/settings-registry';
import { applyGlobalSettings, publishSettings, type RawStorage } from '$lib/sync/settings-sync';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * The source device of the global settings (WP5 decision 3: the desktop).
 *
 * Until a device has been made the source, no device publishes or applies
 * global settings. The user presses "Use this device's shared settings" on
 * the source device: it writes the `migration` / `settings-source` marker,
 * publishes its global settings and its reading goals. Every other device,
 * on seeing the marker, first adopts the global values (it never pushes its
 * own earlier values) and from then on syncs global settings both ways.
 */

export const SETTINGS_SOURCE_RECORD = { kind: 'migration', id: 'settings-source' } as const;

export async function settingsSourceDeviceId(engine: SyncEngine): Promise<string | null> {
  const record = await engine.get(SETTINGS_SOURCE_RECORD.kind, SETTINGS_SOURCE_RECORD.id);
  if (!record || record.deletedAt !== null) return null;
  return typeof record.data.deviceId === 'string' ? record.data.deviceId : null;
}

/** Makes this device the source. Throws when the marker can't be saved. */
export async function becomeSettingsSource(
  engine: SyncEngine,
  storage: RawStorage,
  goals: BooksDbReadingGoal[],
  warn: (message: string) => void
): Promise<void> {
  await engine.write(SETTINGS_SOURCE_RECORD.kind, SETTINGS_SOURCE_RECORD.id, {
    deviceId: engine.deviceId
  });
  // Publish every global value now, even ones published before.
  const published: Record<string, string | null> = {};
  for (const key of keysWithScope('global')) {
    const raw = storage.getItem(key) ?? null;
    await engine.write('setting', `global:${key}`, { value: raw });
    published[`global:${key}`] = raw;
  }
  await engine.updateMeta((m) => {
    m.publishedSettings = { ...(m.publishedSettings ?? {}), ...published };
    m.globalSettingsAdoptedFrom = engine.deviceId;
  });
  await publishReadingGoals(engine, goals, warn);
}

export interface GlobalSettingsDeps {
  apply(key: string, raw: string | null): void;
  readStored(key: string): string | null;
}

/**
 * Whether global settings sync is on for this device. When another device is
 * the source and this device hasn't adopted its values yet, they are adopted
 * first (from the local mirror).
 */
export async function prepareGlobalSettings(
  engine: SyncEngine,
  deps: GlobalSettingsDeps
): Promise<boolean> {
  const sourceId = await settingsSourceDeviceId(engine);
  if (!sourceId) return false;
  if (sourceId === engine.deviceId) return true;
  const meta = await engine.getMeta();
  if (meta.globalSettingsAdoptedFrom !== sourceId) {
    await applyGlobalSettings(
      engine,
      await engine.getAll('setting'),
      deps.apply,
      true,
      deps.readStored
    );
    await engine.updateMeta((m) => {
      m.globalSettingsAdoptedFrom = sourceId;
    });
  }
  return true;
}

/** Before each sync: adopt if needed, then publish (global keys only when on). */
export async function publishAllSettings(
  engine: SyncEngine,
  storage: RawStorage,
  deps: GlobalSettingsDeps
): Promise<void> {
  const globalOn = await prepareGlobalSettings(engine, deps);
  await publishSettings(engine, storage, globalOn);
}

/** After a pull: apply pulled global values (adopting first when the marker just arrived). */
export async function onPulledSettings(
  engine: SyncEngine,
  records: Parameters<typeof applyGlobalSettings>[1],
  deps: GlobalSettingsDeps
): Promise<string[]> {
  const meta = await engine.getMeta();
  const sourceBefore = meta.globalSettingsAdoptedFrom ?? null;
  if (!(await prepareGlobalSettings(engine, deps))) return [];
  const sourceNow = await settingsSourceDeviceId(engine);
  // Just adopted: everything in the mirror is applied already.
  if (sourceNow !== engine.deviceId && sourceBefore !== sourceNow) return [];
  return applyGlobalSettings(engine, records, deps.apply, true, deps.readStored);
}

/** All global keys (for the migration page). */
export function globalSettingKeys(): string[] {
  return keysWithScope('global');
}
