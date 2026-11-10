/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
// Load the store first, like the app does (store.ts and database.service.ts import each other).
import '$lib/data/store';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLOBAL_SETTING_SUBJECTS } from './settings-apply';
import {
  keysWithScope,
  parseStoredValue,
  settingScope,
  SETTINGS_REGISTRY
} from './settings-registry';
import { applyGlobalSettings, publishSettings } from './settings-sync';
import { openSyncDb, type LocalRecord } from './sync-db';
import { SyncEngine } from './sync-engine';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Files that declare localStorage-backed settings. */
const SETTINGS_FILES = [
  'lib/data/store.ts',
  'lib/data/storage/storage-view.ts',
  'lib/library/settings.ts',
  'lib/home/settings.ts',
  'lib/sync/settings.ts'
];

/** Keys and value types declared with writable*LocalStorageSubject()('key', ...). */
function declaredSettings(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /writable(\w+)LocalStorageSubject(?:<[^()]*?>)?\(\)\s*\(\s*'([^']+)'/gs;
  for (const file of SETTINGS_FILES) {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    for (const match of source.matchAll(pattern)) found.set(match[2], match[1]);
  }
  return found;
}

let run = 0;
async function engine() {
  run += 1;
  const name = `settings-test-${run}`;
  return SyncEngine.open({
    openDb: () => openSyncDb(name),
    newId: () => '11111111-1111-4111-8111-111111111111'
  });
}

function storage(values: Record<string, string>) {
  return { getItem: (key: string) => values[key] ?? null };
}

describe('settings registry', () => {
  it('classifies every localStorage setting, with the right value type', () => {
    const declared = declaredSettings();
    expect(declared.size).toBeGreaterThan(90);
    const missing = [...declared.keys()].filter((k) => !(k in SETTINGS_REGISTRY));
    const stale = Object.keys(SETTINGS_REGISTRY).filter((k) => !declared.has(k));
    expect(missing, 'add these keys to SETTINGS_REGISTRY').toEqual([]);
    expect(stale, 'these keys no longer exist').toEqual([]);
    for (const [key, type] of declared) {
      expect(SETTINGS_REGISTRY[key].type, key).toBe(type);
    }
  });

  it('keeps credentials and legacy sync settings local, and unknown keys local', () => {
    for (const key of ['syncTarget', 'selfHostStorageSource', 'autoReplication', 'readingGoal']) {
      expect(settingScope(key)).toBe('local');
    }
    expect(settingScope('somethingNew')).toBe('local');
    expect(settingScope('fontSize')).toBe('device');
    expect(settingScope('trackerIdleTime')).toBe('device');
  });

  it('has a live setting for every global key', () => {
    expect(Object.keys(GLOBAL_SETTING_SUBJECTS).sort()).toEqual(keysWithScope('global').sort());
  });

  it('parses stored strings the way the setting subjects do', () => {
    expect(parseStoredValue('Number', '4')).toBe(4);
    expect(parseStoredValue('Boolean', '1')).toBe(true);
    expect(parseStoredValue('Boolean', '0')).toBe(false);
    expect(parseStoredValue('Object', '{"a":1}')).toEqual({ a: 1 });
    expect(parseStoredValue('Set', '["x"]')).toEqual(new Set(['x']));
    expect(parseStoredValue('String', 'dark')).toBe('dark');
  });
});

describe('publishing settings', () => {
  it('publishes device settings once, then only what changed', async () => {
    const e = await engine();
    const values: Record<string, string> = { fontSize: '24', syncTarget: 'secret' };
    const first = await publishSettings(e, storage(values));
    expect(first).toBe(keysWithScope('device').length);
    const font = await e.get('setting', `device:${e.deviceId}:fontSize`);
    expect(font?.data).toEqual({ value: '24' });
    // Never-set settings are published as null (= the default).
    expect((await e.get('setting', `device:${e.deviceId}:theme`))?.data).toEqual({ value: null });
    // Local and (while off) global settings are never published.
    expect(await e.get('setting', `device:${e.deviceId}:syncTarget`)).toBeUndefined();
    expect(await e.getAll('setting')).toHaveLength(keysWithScope('device').length);

    expect(await publishSettings(e, storage(values))).toBe(0);
    values.fontSize = '30';
    expect(await publishSettings(e, storage(values))).toBe(1);
    expect((await e.get('setting', `device:${e.deviceId}:fontSize`))?.data).toEqual({
      value: '30'
    });
  });

  it('publishes global settings only when global sync is on', async () => {
    const e = await engine();
    await publishSettings(e, storage({ startDayHoursForTracker: '4' }), true);
    expect((await e.get('setting', 'global:startDayHoursForTracker'))?.data).toEqual({
      value: '4'
    });
  });
});

describe('applying pulled global settings', () => {
  const record = (id: string, value: unknown, deviceId = 'other'): LocalRecord => ({
    kind: 'setting',
    id,
    bookId: null,
    deviceId,
    updatedAt: 1,
    deletedAt: null,
    rev: 1,
    data: { value }
  });

  it('does nothing while global sync is off (WP4 default)', async () => {
    const e = await engine();
    const applied: string[] = [];
    const keys = await applyGlobalSettings(
      e,
      [record('global:startDayHoursForTracker', '4')],
      (key) => applied.push(key)
    );
    expect(keys).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('when on, applies other devices’ global values and does not echo them back', async () => {
    const e = await engine();
    const applied: [string, string | null][] = [];
    const keys = await applyGlobalSettings(
      e,
      [
        record('global:startDayHoursForTracker', '4'),
        record('global:fontSize', '99'), // not a global key: ignored
        record(`device:x:fontSize`, '99'),
        record('global:overwriteBookCompletion', '1', e.deviceId) // our own write
      ],
      (key, raw) => applied.push([key, raw]),
      true
    );
    expect(keys).toEqual(['startDayHoursForTracker']);
    expect(applied).toEqual([['startDayHoursForTracker', '4']]);
    // The applied value counts as published: no echo on the next publish.
    expect(await publishSettings(e, storage({ startDayHoursForTracker: '4' }), true)).toBe(
      keysWithScope('device').length + keysWithScope('global').length - 1
    );
  });
});
