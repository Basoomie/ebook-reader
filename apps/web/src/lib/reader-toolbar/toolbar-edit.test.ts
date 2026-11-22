/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  menuButtonHiddenWithEntries,
  moveBottom,
  moveBottomTo,
  moveTop,
  moveTopTo,
  resetBottom,
  resetTop,
  setBottomShown,
  setTopPlace,
  topChoices
} from './toolbar-edit';
import { BOTTOM_DEFAULT, BOTTOM_IDS, TOP_DEFAULT, TOP_IDS } from './toolbar-layout';
import { BOTTOM_LABELS, TOP_LABELS } from './toolbar-labels';

const topIds = (list: { id: string }[]) => list.map(({ id }) => id);

describe('toolbar edits: moving', () => {
  it('up at the top and down at the bottom change nothing', () => {
    expect(moveTop(undefined, 'toc', -1)).toEqual(TOP_DEFAULT);
    expect(moveTop(undefined, 'library', 1)).toEqual(TOP_DEFAULT);
    expect(moveBottom(undefined, 'tracker', -1)).toEqual(BOTTOM_DEFAULT);
    expect(moveBottom(undefined, 'audiobook', 1)).toEqual(BOTTOM_DEFAULT);
  });

  it('moves one step in the middle and keeps every place', () => {
    const up = moveTop(undefined, 'search', -1);
    expect(topIds(up).slice(0, 3)).toEqual(['toc', 'search', 'appearance']);
    expect(up.find((e) => e.id === 'search')?.place).toBe('bar');
    expect(up).toHaveLength(TOP_IDS.length);

    const down = moveBottom(undefined, 'anki', 1);
    expect(topIds(down)).toEqual([
      'tracker',
      'pacer',
      'anki',
      'readAloud',
      'returnMarker',
      'audiobook'
    ]);
    expect(down.find((e) => e.id === 'anki')?.shown).toBe(false);
  });

  it('a drop moves to the exact index, both ways; out of range changes nothing', () => {
    const last = TOP_IDS.length - 1;
    expect(topIds(moveTopTo(undefined, 0, last)).at(-1)).toBe('toc');
    expect(topIds(moveTopTo(undefined, last, 0))[0]).toBe('library');
    expect(topIds(moveBottomTo(undefined, 5, 1))).toEqual([
      'tracker',
      'audiobook',
      'anki',
      'pacer',
      'readAloud',
      'returnMarker'
    ]);
    expect(moveTopTo(undefined, 0, 99)).toEqual(TOP_DEFAULT);
    expect(moveTopTo(undefined, -1, 2)).toEqual(TOP_DEFAULT);
    expect(moveBottomTo(undefined, 2, 2)).toEqual(BOTTOM_DEFAULT);
  });
});

describe('toolbar edits: places', () => {
  it('Bar, Menu and Hidden on an ordinary entry', () => {
    for (const place of ['menu', 'hidden', 'bar'] as const) {
      expect(setTopPlace(undefined, 'search', place).find((e) => e.id === 'search')?.place).toBe(
        place
      );
    }
  });

  it('Menu is refused for the gap, the speed readout and the menu button', () => {
    for (const id of ['gap', 'speed', 'menu'] as const) {
      expect(topChoices(id)).toEqual(['bar', 'hidden']);
      expect(setTopPlace(undefined, id, 'menu')).toEqual(TOP_DEFAULT);
      expect(setTopPlace(undefined, id, 'hidden').find((e) => e.id === id)?.place).toBe('hidden');
    }
    expect(topChoices('zen')).toEqual(['bar', 'menu', 'hidden']);
  });

  it('Shown and Hidden in the bottom bar', () => {
    expect(setBottomShown(undefined, 'anki', true).find((e) => e.id === 'anki')?.shown).toBe(true);
    expect(setBottomShown(undefined, 'tracker', false).find((e) => e.id === 'tracker')?.shown).toBe(
      false
    );
  });

  it('the menu-button hint: entries in the menu while the button is hidden', () => {
    expect(menuButtonHiddenWithEntries(undefined)).toBe(false);
    const hidden = setTopPlace(undefined, 'menu', 'hidden');
    expect(menuButtonHiddenWithEntries(hidden)).toBe(false);
    expect(menuButtonHiddenWithEntries(setTopPlace(hidden, 'zen', 'menu'))).toBe(true);
    expect(menuButtonHiddenWithEntries(setTopPlace(undefined, 'zen', 'menu'))).toBe(false);
  });
});

describe('toolbar edits: reset and odd stored lists', () => {
  it('reset gives the defaults, as fresh copies', () => {
    expect(resetTop()).toEqual(TOP_DEFAULT);
    expect(resetBottom()).toEqual(BOTTOM_DEFAULT);
    expect(resetTop()).not.toBe(resetTop());
    resetTop()[0].place = 'hidden';
    expect(TOP_DEFAULT[0].place).toBe('bar');
  });

  it('an edit of a stored list with unknown, duplicate or missing ids stores a clean full list', () => {
    const stored = [
      { id: 'zen', place: 'bar' },
      { id: 'nonsense', place: 'bar' },
      { id: 'zen', place: 'menu' },
      { id: 'toc', place: 'menu' },
      { id: 'search', place: 'sideways' }
    ];
    const next = moveTop(stored, 'toc', -1);
    expect(topIds(next).slice(0, 2)).toEqual(['toc', 'zen']);
    expect(next.find((e) => e.id === 'toc')?.place).toBe('menu');
    expect(next.find((e) => e.id === 'zen')?.place).toBe('bar');
    // Everything the list lacked is added at the end, hidden (decision 7).
    expect(next).toHaveLength(TOP_IDS.length);
    expect(new Set(topIds(next)).size).toBe(TOP_IDS.length);
    expect(next.find((e) => e.id === 'search')?.place).toBe('hidden');
    expect(topIds(next)).not.toContain('nonsense');

    const bottom = setBottomShown('not a list', 'pacer', false);
    expect(topIds(bottom)).toEqual([...BOTTOM_IDS]);
  });
});

describe('toolbar labels', () => {
  it('every entry of both bars has a name and a description', () => {
    for (const id of TOP_IDS) {
      expect(TOP_LABELS[id]?.name, id).toBeTruthy();
      expect(TOP_LABELS[id]?.description, id).toBeTruthy();
    }
    for (const id of BOTTOM_IDS) {
      expect(BOTTOM_LABELS[id]?.name, id).toBeTruthy();
      expect(BOTTOM_LABELS[id]?.description, id).toBeTruthy();
    }
    expect(Object.keys(TOP_LABELS).sort()).toEqual([...TOP_IDS].sort());
    expect(Object.keys(BOTTOM_LABELS).sort()).toEqual([...BOTTOM_IDS].sort());
  });
});
