/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// Every module that declares a per-device setting, so each live setting exists before a
// copy writes it (the whispersync stores are otherwise loaded only by the reader).
import '$lib/data/store';
import '$lib/library/settings';
import '$lib/home/settings';
import '$lib/sync/settings';
import '$lib/anki/settings';
import '$lib/audio/tts-settings';
// Season 2 Phase 12 session 3: read-aloud's per-device settings.
import '$lib/read-aloud/settings';
import '$lib/whispersync/lib/stores';
import { liveStorageSettings } from '$lib/data/internal/writable-storage-subject';
import { localStorage } from '$lib/data/window/local-storage';
import { keysWithScope } from '$lib/sync/settings-registry';

export interface RawSettingStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * "Copy settings from another device": applies another device's stored strings
 * (null = never set there) to this device's per-device settings, in registry order (the
 * theme before fonts and sizes, so a theme's own font doesn't win over the copied one).
 *
 * Each live setting gets what it would read on page load with that string stored, and
 * the stored string becomes exactly the other device's. Only per-device keys are written:
 * global and local ones (the AnkiConnect keys) are never touched, whatever `values` holds.
 * Returns the keys whose stored string changed.
 */
export function applyDeviceSettings(
  values: Partial<Record<string, string | null>>,
  storage: RawSettingStorage = localStorage
): string[] {
  const changed: string[] = [];

  for (const key of keysWithScope('device')) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;

    const raw = values[key] ?? null;

    if ((storage.getItem(key) ?? null) === raw) continue;

    for (const live of liveStorageSettings(key)) {
      live.subject.next(raw ? live.mapFromString(raw) : live.defaultValue);
    }

    // The subject stored its own form of the value (or the default); keep the other
    // device's exact string, or nothing for "never set".
    if (raw === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, raw);
    }

    changed.push(key);
  }

  return changed;
}
