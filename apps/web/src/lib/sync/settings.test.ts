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
  'lib/library/settings.ts',
  'lib/home/settings.ts',
  'lib/sync/settings.ts',
  'lib/anki/settings.ts',
  // WP17: pauses in audiobooks made on the PC
  'lib/audio/tts-settings.ts',
  // Season 2 Phase 12 session 3: read-aloud
  'lib/read-aloud/settings.ts',
  // Reader toolbars session 1: the two bar lists
  'lib/reader-toolbar/settings.ts',
  // Calibre metadata on the book page: the links and their settings
  'lib/book-links/settings.ts',
  // Calibre metadata editing: the forms' layouts and the empty rating line
  'lib/calibre-edit/settings.ts',
  'lib/summaries/settings.ts',
  // Search history (2026-11-24)
  'lib/search-history/settings.ts',
  'lib/library/search-settings.ts',
  // Recently viewed (2026-11-24)
  'lib/recently-viewed/settings.ts'
];

/** Keys and value types declared with writable*LocalStorageSubject()('key', ...). */
function declaredSettings(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /writable(\w+)LocalStorageSubject(?:<[^()]*?>)?\(\)\s*\(\s*'([^']+)'/gs;
  for (const file of SETTINGS_FILES) {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    for (const match of source.matchAll(pattern)) found.set(match[2], match[1]);
  }
  // Whispersync's own settings (vendored): writable{Boolean,Number,String}Store()('key')
  // and writeableArrayStore<T>()('key').
  const whispersync =
    /write?able(Boolean|Number|String|Array)Store(?:<[^()]*?>)?\(\)\s*\(\s*'([^']+)'/gs;
  const stores = readFileSync(path.join(SRC, WHISPERSYNC_STORES), 'utf8');
  for (const match of stores.matchAll(whispersync)) found.set(match[2], match[1]);
  return found;
}

const WHISPERSYNC_STORES = 'lib/whispersync/lib/stores.ts';

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
    expect(declared.size).toBeGreaterThan(190);
    expect([...declared.keys()].filter((k) => k.startsWith('ttu-whispersync-'))).toHaveLength(78);
    const missing = [...declared.keys()].filter((k) => !(k in SETTINGS_REGISTRY));
    const stale = Object.keys(SETTINGS_REGISTRY).filter((k) => !declared.has(k));
    expect(missing, 'add these keys to SETTINGS_REGISTRY').toEqual([]);
    expect(stale, 'these keys no longer exist').toEqual([]);
    for (const [key, type] of declared) {
      expect(SETTINGS_REGISTRY[key].type, key).toBe(type);
    }
  });

  it("keeps the old sync's leftover keys local, and unknown keys local", () => {
    // WP15e removed the old sync; its keys may still sit in localStorage (unlisted = local).
    for (const key of ['syncTarget', 'selfHostStorageSource', 'autoReplication', 'readingGoal']) {
      expect(settingScope(key)).toBe('local');
    }
    expect(settingScope('somethingNew')).toBe('local');
    expect(settingScope('fontSize')).toBe('device');
    expect(settingScope('trackerIdleTime')).toBe('device');
  });

  it('shares every setting a device keeps for itself, except the AnkiConnect keys and bookkeeping', () => {
    // Whispersync's own settings are per device ("Copy settings from another device").
    expect(settingScope('ttu-whispersync-player-rewind-time')).toBe('device');
    expect(settingScope('ttu-whispersync-action-list-of-reader')).toBe('device');
    expect(settingScope('ttu-whispersync-menu-position')).toBe('device');
    // Remembered choices, copied with the rest.
    expect(settingScope('lastBlurredTrackerItems')).toBe('device');
    expect(settingScope('lastReadingDataHeatmapAggregationMode')).toBe('device');
    // Never leave the device.
    for (const key of [
      'ankiConnectKey',
      'ttu-whispersync-anki-key',
      'readingGoal',
      'lastReadingGoalsModified',
      'domainHintSeen',
      'ttu-whispersync-side-menu-width'
    ]) {
      expect(settingScope(key), key).toBe('local');
    }
    expect(keysWithScope('global')).toHaveLength(36); // + searchHeaderButton (search palette step 2) + 2 search help (searchSuggestionsOn, searchReadsAsOn; 2026-11-24) + 5 recently viewed (recentlyViewedOn, recentlyViewedDwellSeconds, recentlyViewedKeep, recentlyViewedKeepBooks, recentlyViewedKeepDays; 2026-11-24) + libraryThemes (library themes, 2026-11-24) + 4 search history (searchHistoryOn, searchHistoryLimit, bookSearchHistoryOn, bookSearchHistoryLimit; 2026-11-24) + 15 + ankiAutoEnrich (Phase 8) + ankiAutoEnrichSeconds + ttsDialoguePauseMs (Phase 12 session 4) + speakerUnsureBelow (session 5) + summaryLanguages (book summaries session 3) + summarySpoilerBlur (session 4) + summaryAutoOnFirstCompletion (session 4b) + summaryRecapAuto (book summaries session 5)
    expect(keysWithScope('device')).toHaveLength(
      95 + 2 + 77 + 1 + 8 + 1 + 2 + 4 + 2 + 2 + 1 + 2 - 3 + 4 + 3 + 2 + 2 + 2 + 1 + 1
    ); // + cleanupLibrariesAs (manga part B), + searchPaletteCtrlK (search palette step 2), + 2 library theme picks (libraryLightTheme, libraryDarkTheme; 2026-11-24), + 2 collection views (collectionGroupsAs, collectionSectionsBy), + 2 summary layouts (summaryCharacterLayout, summaryRelationshipLayout; book summaries session 4), + 3 Calibre editing (bookEditAs, seriesEditAs, bookRatingEmpty), + 4 book links (bookLinks, bookLinksPlacement, bookLinksMoreAs, bookLinksSearch), + libraryServerCheckSeconds, + 8 pacer (Phase 10), + bookIllustrationsPosition (Season 2 §6), + 2 on-track dot (Season 2 §9), + 4 read-aloud (Phase 12), + 2 Notes sorts (notesBookSort, notesHighlightSort), + 2 select-mode downloads (libraryBulkDownloadMode, libraryDownloadConfirmGb), + libraryCoverBlur (Hidden covers), + readerToolbar and readerBottomBar - the 3 bottom-bar switches they replace (reader toolbars session 1)
    expect(keysWithScope('local')).toHaveLength(7); // + summaryViewLang (book summaries session 4) + descriptionViewLang (session 4b)
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

  it('does not publish a never-set global key it has not taken over (Phase 7 bug 2)', async () => {
    const e = await engine();
    const values: Record<string, string> = {};
    await publishSettings(e, storage(values), true);
    expect(await e.get('setting', 'global:ankiFieldMapping')).toBeUndefined();
    // Set here: published, and from then on every change is.
    values.ankiFieldMapping = '{"JPMN":{}}';
    expect(await publishSettings(e, storage(values), true)).toBe(1);
    expect((await e.get('setting', 'global:ankiFieldMapping'))?.data).toEqual({
      value: '{"JPMN":{}}'
    });
    delete values.ankiFieldMapping;
    expect(await publishSettings(e, storage(values), true)).toBe(1);
    expect((await e.get('setting', 'global:ankiFieldMapping'))?.data).toEqual({ value: null });
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
    // The applied value counts as published: no echo on the next publish. The other
    // global keys are never set here and not taken over: not published either.
    expect(await publishSettings(e, storage({ startDayHoursForTracker: '4' }), true)).toBe(
      keysWithScope('device').length
    );
    expect(await e.get('setting', 'global:customThemes')).toBeUndefined();
  });
});
