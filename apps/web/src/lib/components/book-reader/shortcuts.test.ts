/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { BookReaderAvailableKeybind } from '$lib/data/book-reader-keybind';
import { bookReaderKeybindMap$ } from '$lib/data/store';
import { keyLabel, readerShortcutGroups, type ShortcutContext } from './shortcuts';

function context(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
  return {
    keybindMap: bookReaderKeybindMap$.getValue(),
    paginated: true,
    verticalMode: true,
    tapEdgeToFlip: false,
    mouseDragPageTurn: true,
    statisticsEnabled: true,
    ...overrides
  };
}

function find(groups: ReturnType<typeof readerShortcutGroups>, title: string) {
  const group = groups.find((g) => g.title === title);
  if (!group) throw new Error(`no group ${title}`);
  return group.rows;
}

describe('keyLabel', () => {
  it('names key codes by their key cap and skips the lowercase duplicates', () => {
    expect(keyLabel('KeyZ')).toBe('Z');
    expect(keyLabel('PageDown')).toBe('Page Down');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('z')).toBeUndefined();
    expect(keyLabel(' ')).toBeUndefined();
  });
});

describe('readerShortcutGroups', () => {
  it('lists every action of the keybind map once', () => {
    const groups = readerShortcutGroups(context({ paginated: false }));
    const listed = groups.flatMap((g) => g.rows.flatMap((r) => r.keys));
    const map = bookReaderKeybindMap$.getValue();
    for (const [code] of Object.entries(map)) {
      const label = keyLabel(code);
      if (label) expect(listed, code).toContain(label);
    }
  });

  it('shows the Zen key, the two-finger tap and the cheat sheet key', () => {
    const groups = readerShortcutGroups(context());
    const reading = find(groups, 'Reading');
    expect(reading).toContainEqual({ keys: ['Z'], action: 'Zen mode (hide the bottom bar)' });
    expect(reading).toContainEqual({ keys: ['?'], action: 'Show this list' });
    expect(find(groups, 'Touch and mouse')).toContainEqual({
      keys: ['Two-finger tap'],
      action: 'Zen mode (hide the bottom bar)'
    });
  });

  it('lists the jump history keys right after "Return to saved place"', () => {
    const reading = find(readerShortcutGroups(context()), 'Reading');
    const index = reading.findIndex((r) => r.action === 'Return to saved place');
    expect(reading[index + 1]).toEqual({
      keys: ['['],
      action: 'Back to where you were before a jump'
    });
    expect(reading[index + 2]).toEqual({ keys: [']'], action: 'Forward again' });
    expect(reading[index + 3]).toEqual({ keys: ['/'], action: 'Search in this book' });
  });

  it('lists the highlight keys and the long-press', () => {
    const groups = readerShortcutGroups(context());
    const reading = find(groups, 'Reading');
    expect(reading.map((r) => r.keys[0])).toEqual(expect.arrayContaining(['H', '1', 'L', 'K']));
    expect(find(groups, 'Touch and mouse').map((r) => r.action)).toContain(
      'Show the highlight bar (colors, note)'
    );
  });

  it('follows a changed keybind map', () => {
    const map = {
      ...bookReaderKeybindMap$.getValue(),
      KeyX: BookReaderAvailableKeybind.TOGGLE_ZEN
    };
    const reading = find(readerShortcutGroups(context({ keybindMap: map })), 'Reading');
    expect(reading.find((r) => r.action.startsWith('Zen'))?.keys).toEqual(['Z', 'X']);
  });

  it('shows the paginated arrow keys by writing direction and drops auto-scroll', () => {
    const vertical = find(readerShortcutGroups(context({ verticalMode: true })), 'Reading');
    expect(vertical).toContainEqual({ keys: ['←', 'A', '↓'], action: 'Next page' });
    expect(vertical.some((r) => r.action.startsWith('Auto-scroll'))).toBe(false);

    const horizontal = find(readerShortcutGroups(context({ verticalMode: false })), 'Reading');
    expect(horizontal).toContainEqual({ keys: ['→', 'D', '↓'], action: 'Next page' });
  });

  it('shows auto-scroll in continuous mode', () => {
    const reading = find(readerShortcutGroups(context({ paginated: false })), 'Reading');
    expect(reading).toContainEqual({ keys: ['Space'], action: 'Auto-scroll on or off' });
  });

  it('leaves out the tracker without statistics, and optional gestures when off', () => {
    const groups = readerShortcutGroups(
      context({ statisticsEnabled: false, mouseDragPageTurn: false })
    );
    expect(groups.some((g) => g.title === 'Tracker')).toBe(false);
    const touch = find(groups, 'Touch and mouse');
    expect(touch.some((r) => r.keys[0].startsWith('Drag'))).toBe(false);
    expect(touch.some((r) => r.keys[0].includes('tracker'))).toBe(false);
    expect(touch.some((r) => r.keys[0].includes('edge') && r.action === 'Turn the page')).toBe(
      false
    );
  });

  it('lists the edge taps when they are on', () => {
    const touch = find(readerShortcutGroups(context({ tapEdgeToFlip: true })), 'Touch and mouse');
    expect(touch).toContainEqual({ keys: ['Tap the left or right edge'], action: 'Turn the page' });
  });

  it('lists the audiobook keys', () => {
    const audio = find(readerShortcutGroups(context()), 'Audiobook');
    expect(audio).toContainEqual({
      keys: ['Alt + E'],
      action: 'Update the last Anki card from the current line'
    });
    expect(audio).toContainEqual({
      keys: ['Ctrl + E'],
      action: 'Create a new Anki card from the current line'
    });
  });

  it('lists E for Enrich last Anki card (WP14)', () => {
    const reading = find(readerShortcutGroups(context()), 'Reading');
    expect(reading).toContainEqual({
      keys: ['E'],
      action: 'Enrich the last Anki card (tag, sentence, audio, cover, link)'
    });
  });
});
