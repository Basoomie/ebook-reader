/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
// Load the store first, like the app does (store.ts and database.service.ts import each other).
import {
  einkMode$,
  fontSize$,
  lastBlurredTrackerItems$,
  readerBottomBar$,
  readerToolbar$,
  theme$
} from '$lib/data/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ankiConnectKey$ } from '$lib/anki/settings';
import {
  BOTTOM_DEFAULT,
  TOP_DEFAULT,
  resolveBottomBar,
  resolveTopBar
} from '$lib/reader-toolbar/toolbar-layout';
import { liveStorageSettings } from '$lib/data/internal/writable-storage-subject';
import { localStorage } from '$lib/data/window/local-storage';
import { homeRows$ } from '$lib/home/settings';
import { LINKS_DEFAULT, resolveLinks } from '$lib/book-links/link-layout';
import {
  bookLinks$,
  bookLinksMoreAs$,
  bookLinksPlacement$,
  bookLinksSearch$
} from '$lib/book-links/settings';
import { settings$ } from '$lib/whispersync/lib/stores';
// Calibre metadata editing's per-device settings, loaded as the book page and Settings load them.
import '$lib/calibre-edit/settings';
import { applyDeviceSettings } from './apply-device-settings';
import { keysWithScope } from './settings-registry';

const KEYS = [
  'fontSize',
  'einkMode',
  'homeRows',
  'lastBlurredTrackerItems',
  'theme',
  'ttu-whispersync-player-rewind-time',
  'ttu-whispersync-reader-enable-auto-reload',
  'ttu-whispersync-action-list-of-footer',
  'ankiConnectKey',
  'ttu-whispersync-anki-key',
  'startDayHoursForTracker',
  'readerToolbar',
  'readerBottomBar',
  'bookLinks',
  'bookLinksPlacement',
  'bookLinksMoreAs',
  'bookLinksSearch'
];

beforeEach(() => {
  // Back to "never set" on this device.
  applyDeviceSettings(Object.fromEntries(KEYS.map((k) => [k, null])));
  localStorage.removeItem('ankiConnectKey');
  localStorage.removeItem('ttu-whispersync-anki-key');
  localStorage.removeItem('startDayHoursForTracker');
});

describe('applyDeviceSettings', () => {
  it('has exactly one live setting for every per-device key (whispersync included)', () => {
    const missing = keysWithScope('device').filter((k) => liveStorageSettings(k).length !== 1);
    expect(missing).toEqual([]);
  });

  it('applies values by type, as this device would read them on load', () => {
    const footer = JSON.stringify([{ action: 'Rewind', enabled: true }]);
    const changed = applyDeviceSettings({
      fontSize: '26',
      einkMode: '1',
      homeRows: '[{"id":"continue","visible":true}]',
      lastBlurredTrackerItems: '["charactersRead"]',
      'ttu-whispersync-player-rewind-time': '15',
      'ttu-whispersync-reader-enable-auto-reload': '0',
      'ttu-whispersync-action-list-of-footer': footer
    });
    expect(changed.sort()).toEqual(
      [
        'einkMode',
        'fontSize',
        'homeRows',
        'lastBlurredTrackerItems',
        'ttu-whispersync-action-list-of-footer',
        'ttu-whispersync-player-rewind-time',
        'ttu-whispersync-reader-enable-auto-reload'
      ].sort()
    );
    expect(fontSize$.getValue()).toBe(26);
    expect(einkMode$.getValue()).toBe(true);
    expect(homeRows$.getValue()).toEqual([{ id: 'continue', visible: true }]);
    expect(lastBlurredTrackerItems$.getValue()).toEqual(new Set(['charactersRead']));
    expect(settings$.playerRewindTime$.get()).toBe(15);
    expect(settings$.readerEnableAutoReload$.get()).toBe(false);
    expect(settings$.actionListOfFooter$.get()).toEqual([{ action: 'Rewind', enabled: true }]);
    // The other device's exact strings are stored.
    expect(localStorage.getItem('fontSize')).toBe('26');
    expect(localStorage.getItem('ttu-whispersync-action-list-of-footer')).toBe(footer);
  });

  it('resets a setting the other device never set to the default, leaving nothing stored', () => {
    applyDeviceSettings({
      fontSize: '30',
      theme: 'dark-theme',
      'ttu-whispersync-player-rewind-time': '9'
    });
    expect(localStorage.getItem('theme')).toBe('dark-theme');
    const changed = applyDeviceSettings({
      fontSize: null,
      theme: null,
      'ttu-whispersync-player-rewind-time': null
    });
    expect(changed.sort()).toEqual(['fontSize', 'theme', 'ttu-whispersync-player-rewind-time']);
    expect(fontSize$.getValue()).toBe(20);
    expect(theme$.getValue()).toBe('light-theme');
    expect(settings$.playerRewindTime$.get()).toBe(5);
    expect(localStorage.getItem('fontSize') ?? null).toBeNull();
    expect(localStorage.getItem('theme') ?? null).toBeNull();
    expect(localStorage.getItem('ttu-whispersync-player-rewind-time') ?? null).toBeNull();
  });

  it('counts only settings whose stored string changes', () => {
    applyDeviceSettings({ fontSize: '24', einkMode: null });
    expect(applyDeviceSettings({ fontSize: '24', einkMode: null })).toEqual([]);
    expect(applyDeviceSettings({ fontSize: '25', einkMode: null })).toEqual(['fontSize']);
  });

  it('copies both toolbar lists exactly, the three old bottom-bar switches with them', () => {
    const toolbar = JSON.stringify([
      { id: 'home', place: 'bar' },
      { id: 'toc', place: 'menu' },
      { id: 'menu', place: 'bar' }
    ]);
    const bottom = JSON.stringify([
      { id: 'audiobook', shown: true },
      { id: 'anki', shown: true },
      { id: 'readAloud', shown: true },
      { id: 'returnMarker', shown: true }
    ]);
    const changed = applyDeviceSettings({ readerToolbar: toolbar, readerBottomBar: bottom });
    expect(changed.sort()).toEqual(['readerBottomBar', 'readerToolbar']);
    expect(localStorage.getItem('readerToolbar')).toBe(toolbar);
    expect(localStorage.getItem('readerBottomBar')).toBe(bottom);
    expect(resolveTopBar(readerToolbar$.getValue()).slice(0, 3)).toEqual([
      { id: 'home', place: 'bar' },
      { id: 'toc', place: 'menu' },
      { id: 'menu', place: 'bar' }
    ]);
    const shown = (id: string) =>
      resolveBottomBar(readerBottomBar$.getValue()).find((e) => e.id === id)?.shown;
    expect(shown('anki')).toBe(true);
    expect(shown('readAloud')).toBe(true);
    expect(shown('returnMarker')).toBe(true);

    // A device that never set them: the defaults, nothing stored.
    applyDeviceSettings({ readerToolbar: null, readerBottomBar: null });
    expect(readerToolbar$.getValue()).toEqual(TOP_DEFAULT);
    expect(readerBottomBar$.getValue()).toEqual(BOTTOM_DEFAULT);
    expect(localStorage.getItem('readerBottomBar') ?? null).toBeNull();
    expect(shown('readAloud')).toBe(false);
  });

  it('copies the book page’s links list and its three settings', () => {
    const list = JSON.stringify([
      { id: 'unext', place: 'button' },
      { id: 'amazon', place: 'hidden' }
    ]);
    const changed = applyDeviceSettings({
      bookLinks: list,
      bookLinksPlacement: 'panel',
      bookLinksMoreAs: 'modal',
      bookLinksSearch: '0'
    });
    expect(changed.sort()).toEqual([
      'bookLinks',
      'bookLinksMoreAs',
      'bookLinksPlacement',
      'bookLinksSearch'
    ]);
    expect(localStorage.getItem('bookLinks')).toBe(list);
    expect(resolveLinks(bookLinks$.getValue()).slice(0, 2)).toEqual([
      { id: 'unext', place: 'button' },
      { id: 'amazon', place: 'hidden' }
    ]);
    expect(bookLinksPlacement$.getValue()).toBe('panel');
    expect(bookLinksMoreAs$.getValue()).toBe('modal');
    expect(bookLinksSearch$.getValue()).toBe(false);

    applyDeviceSettings({
      bookLinks: null,
      bookLinksPlacement: null,
      bookLinksMoreAs: null,
      bookLinksSearch: null
    });
    expect(bookLinks$.getValue()).toEqual(LINKS_DEFAULT);
    expect(bookLinksPlacement$.getValue()).toBe('section');
    expect(bookLinksMoreAs$.getValue()).toBe('dropdown');
    expect(bookLinksSearch$.getValue()).toBe(true);
  });

  it('never writes the AnkiConnect keys or a shared setting, whatever it is given', () => {
    ankiConnectKey$.next('mine');
    settings$.ankiKey$.set('mine too');
    const changed = applyDeviceSettings({
      ankiConnectKey: 'theirs',
      'ttu-whispersync-anki-key': 'theirs',
      startDayHoursForTracker: '7',
      fontSize: '22'
    });
    expect(changed).toEqual(['fontSize']);
    expect(ankiConnectKey$.getValue()).toBe('mine');
    expect(settings$.ankiKey$.get()).toBe('mine too');
    expect(localStorage.getItem('startDayHoursForTracker') ?? null).toBeNull();
  });
});
