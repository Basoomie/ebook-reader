/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BehaviorSubject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  BOTTOM_DEFAULT,
  BOTTOM_IDS,
  TOP_DEFAULT,
  TOP_IDS,
  bottomBarSwitch,
  migrateBottomBarSwitches,
  resolveBottomBar,
  resolveTopBar,
  visibleTopBar,
  type TopId
} from './toolbar-layout';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

describe('top bar defaults', () => {
  it("are the user's PC answers, with the speed readout and the gap where they are today", () => {
    expect(TOP_DEFAULT.map(({ id, place }) => `${id}:${place}`)).toEqual([
      'toc:bar',
      'appearance:bar',
      'search:bar',
      'notes:bar',
      'jumpBackForward:bar',
      'returnMarker:bar',
      'speed:bar',
      'gap:bar',
      'images:bar',
      'jump:bar',
      'addBookmark:bar',
      'pacer:bar',
      'readAloud:bar',
      'shortcuts:bar',
      'fullscreen:bar',
      'settings:bar',
      'home:bar',
      'menu:bar',
      'savePlace:hidden',
      'returnToSaved:hidden',
      'readingPoint:hidden',
      'completeBook:hidden',
      'statistics:hidden',
      'ankiEnrich:hidden',
      'bookStatus:hidden',
      'addToCollection:hidden',
      'zen:hidden',
      'library:hidden'
    ]);
  });

  it('read as the defaults when nothing usable is stored', () => {
    for (const stored of [undefined, null, '', {}, 'bar']) {
      expect(resolveTopBar(stored)).toEqual(TOP_DEFAULT);
    }
  });

  it('show no menu button with the defaults (nothing is set to the menu)', () => {
    const { bar, menu } = visibleTopBar(resolveTopBar(undefined), () => true);
    expect(menu).toEqual([]);
    expect(bar).not.toContain('menu');
    expect(bar.at(-1)).toBe('home');
  });
});

describe('bottom bar defaults', () => {
  it("are today's order with the old switches' defaults", () => {
    expect(BOTTOM_DEFAULT).toEqual([
      { id: 'tracker', shown: true },
      { id: 'anki', shown: false },
      { id: 'pacer', shown: true },
      { id: 'readAloud', shown: false },
      { id: 'returnMarker', shown: false },
      { id: 'audiobook', shown: true }
    ]);
    expect(resolveBottomBar(undefined)).toEqual(BOTTOM_DEFAULT);
  });
});

describe('resolving a stored top bar', () => {
  it('keeps the stored order and places', () => {
    const stored = [...TOP_DEFAULT].reverse().map(({ id }, i) => ({
      id,
      place: i % 3 === 0 ? 'menu' : i % 3 === 1 ? 'bar' : 'hidden'
    }));
    const resolved = resolveTopBar(stored);
    expect(resolved.map(({ id }) => id)).toEqual(stored.map(({ id }) => id));
    const plain = resolved.filter(({ id }) => !['menu', 'speed', 'gap'].includes(id));
    expect(plain.map(({ place }) => place)).toEqual(
      stored.filter(({ id }) => !['menu', 'speed', 'gap'].includes(id)).map(({ place }) => place)
    );
  });

  it('ignores unknown ids, repeated ids, invalid places and malformed entries', () => {
    const resolved = resolveTopBar([
      { id: 'home', place: 'bar' },
      { id: 'teleport', place: 'bar' },
      { id: 'home', place: 'hidden' },
      { id: 'toc', place: 'sideways' },
      { id: 'search' },
      'settings',
      null,
      { id: 'settings', place: 'menu' }
    ]);
    expect(resolved.slice(0, 2)).toEqual([
      { id: 'home', place: 'bar' },
      { id: 'settings', place: 'menu' }
    ]);
    expect(resolved.find(({ id }) => id === 'toc')).toEqual({ id: 'toc', place: 'hidden' });
    expect(resolved.map(({ id }) => id).sort()).toEqual([...TOP_IDS].sort());
  });

  it('adds every button the stored list lacks at the end, hidden, in default order (decision 7)', () => {
    const resolved = resolveTopBar([
      { id: 'home', place: 'bar' },
      { id: 'toc', place: 'bar' }
    ]);
    expect(resolved.slice(0, 2)).toEqual([
      { id: 'home', place: 'bar' },
      { id: 'toc', place: 'bar' }
    ]);
    const rest = resolved.slice(2);
    expect(rest.map(({ id }) => id)).toEqual(TOP_IDS.filter((id) => id !== 'home' && id !== 'toc'));
    expect(rest.every(({ place }) => place === 'hidden')).toBe(true);
  });

  it('never makes the menu button, the speed readout or the gap a menu entry', () => {
    const resolved = resolveTopBar([
      { id: 'menu', place: 'menu' },
      { id: 'speed', place: 'menu' },
      { id: 'gap', place: 'menu' }
    ]);
    expect(resolved.slice(0, 3).map(({ place }) => place)).toEqual(['bar', 'bar', 'bar']);
  });
});

describe('resolving a stored bottom bar', () => {
  it('keeps order, ignores unknown or bad entries, adds missing buttons hidden at the end', () => {
    const resolved = resolveBottomBar([
      { id: 'audiobook', shown: true },
      { id: 'radio', shown: true },
      { id: 'anki', shown: 'yes' },
      { id: 'audiobook', shown: false },
      { id: 'pacer', shown: false }
    ]);
    expect(resolved).toEqual([
      { id: 'audiobook', shown: true },
      { id: 'pacer', shown: false },
      { id: 'tracker', shown: false },
      { id: 'anki', shown: false },
      { id: 'readAloud', shown: false },
      { id: 'returnMarker', shown: false }
    ]);
    expect(resolved.map(({ id }) => id).sort()).toEqual([...BOTTOM_IDS].sort());
  });
});

describe('which top-bar entries show', () => {
  const list = resolveTopBar([
    { id: 'toc', place: 'bar' },
    { id: 'menu', place: 'bar' },
    { id: 'home', place: 'bar' },
    { id: 'images', place: 'menu' },
    { id: 'statistics', place: 'menu' },
    { id: 'zen', place: 'menu' }
  ]);

  it('lists menu entries in order, and only those whose condition holds', () => {
    const { bar, menu } = visibleTopBar(list, (id) => id !== 'images');
    expect(menu).toEqual(['statistics', 'zen']);
    expect(bar).toEqual(['toc', 'menu', 'home']);
  });

  it('drops the menu button when none of its entries can show', () => {
    const only: TopId[] = ['toc', 'home'];
    const { bar, menu } = visibleTopBar(list, (id) => only.includes(id));
    expect(menu).toEqual([]);
    expect(bar).toEqual(['toc', 'home']);
  });

  it('leaves out bar buttons whose condition does not hold', () => {
    const { bar } = visibleTopBar(resolveTopBar(undefined), (id) => id !== 'jumpBackForward');
    expect(bar).not.toContain('jumpBackForward');
    expect(bar).toContain('returnMarker');
  });
});

describe('migrating the three old bottom-bar switches', () => {
  const KEYS = ['ankiBottomBarButton', 'readAloudBottomBarButton', 'showReturnMarker'];

  it('carries every combination into readerBottomBar, in order, and removes the old keys', () => {
    for (let combo = 0; combo < 8; combo++) {
      const [anki, readAloud, returnMarker] = [0, 1, 2].map((bit) => !!(combo & (1 << bit)));
      const storage = memoryStorage({
        ankiBottomBarButton: anki ? '1' : '0',
        readAloudBottomBarButton: readAloud ? '1' : '0',
        showReturnMarker: returnMarker ? '1' : '0',
        fontSize: '22'
      });
      expect(migrateBottomBarSwitches(storage)).toBe(true);
      expect(JSON.parse(storage.values.get('readerBottomBar') ?? 'null')).toEqual([
        { id: 'tracker', shown: true },
        { id: 'anki', shown: anki },
        { id: 'pacer', shown: true },
        { id: 'readAloud', shown: readAloud },
        { id: 'returnMarker', shown: returnMarker },
        { id: 'audiobook', shown: true }
      ]);
      for (const key of KEYS) expect(storage.values.has(key), key).toBe(false);
      expect(storage.values.get('fontSize')).toBe('22');
    }
  });

  it('keeps the old default (off) for a switch that was never set', () => {
    const storage = memoryStorage({ readAloudBottomBarButton: '1' });
    migrateBottomBarSwitches(storage);
    const list = resolveBottomBar(JSON.parse(storage.values.get('readerBottomBar') ?? 'null'));
    expect(list.filter(({ shown }) => shown).map(({ id }) => id)).toEqual([
      'tracker',
      'pacer',
      'readAloud',
      'audiobook'
    ]);
  });

  it('writes nothing when no old switch was ever set', () => {
    const storage = memoryStorage({ fontSize: '22' });
    expect(migrateBottomBarSwitches(storage)).toBe(false);
    expect([...storage.values.keys()]).toEqual(['fontSize']);
  });

  it('runs only once: a stored readerBottomBar is left alone', () => {
    const own = JSON.stringify([{ id: 'audiobook', shown: false }]);
    const storage = memoryStorage({ readerBottomBar: own, ankiBottomBarButton: '1' });
    expect(migrateBottomBarSwitches(storage)).toBe(false);
    expect(storage.values.get('readerBottomBar')).toBe(own);
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
      removeItem: () => undefined
    };
    expect(migrateBottomBarSwitches(broken)).toBe(false);
  });
});

describe('the old switches as views of readerBottomBar', () => {
  it('read and write the entry, and follow changes to the list', () => {
    const subject = new BehaviorSubject<unknown>([...BOTTOM_DEFAULT]);
    const anki = bottomBarSwitch(subject, 'anki');
    const seen: boolean[] = [];
    const stop = anki.subscribe((value) => seen.push(value));

    anki.set(true);
    expect(resolveBottomBar(subject.getValue()).find(({ id }) => id === 'anki')?.shown).toBe(true);
    // Order and the other entries are kept.
    expect(resolveBottomBar(subject.getValue()).map(({ id }) => id)).toEqual(BOTTOM_IDS);

    subject.next([{ id: 'anki', shown: false }]);
    expect(anki.getValue()).toBe(false);
    // Unrelated list changes don't re-emit the switch.
    subject.next([
      { id: 'anki', shown: false },
      { id: 'pacer', shown: true }
    ]);
    expect(seen).toEqual([false, true, false]);

    stop();
    anki.set(true);
    expect(seen).toEqual([false, true, false]);
  });

  it('does not rewrite the list when set to its current value', () => {
    const stored = [{ id: 'anki', shown: true }];
    const subject = new BehaviorSubject<unknown>(stored);
    bottomBarSwitch(subject, 'anki').set(true);
    expect(subject.getValue()).toBe(stored);
  });
});
