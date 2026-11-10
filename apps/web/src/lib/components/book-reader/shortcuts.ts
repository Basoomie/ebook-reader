/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  BookReaderAvailableKeybind,
  type BookReaderKeybindMap
} from '$lib/data/book-reader-keybind';

export interface ShortcutRow {
  /** Alternatives, each shown as one key or key combination. */
  keys: string[];
  action: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export interface ShortcutContext {
  keybindMap: BookReaderKeybindMap;
  paginated: boolean;
  verticalMode: boolean;
  tapEdgeToFlip: boolean;
  mouseDragPageTurn: boolean;
  statisticsEnabled: boolean;
}

/** On-screen names of the reader actions, in the order they are listed. */
const READER_ACTIONS: [BookReaderAvailableKeybind, string][] = [
  [BookReaderAvailableKeybind.NEXT_PAGE, 'Next page'],
  [BookReaderAvailableKeybind.PREV_PAGE, 'Previous page'],
  [BookReaderAvailableKeybind.NEXT_CHAPTER, 'Next chapter'],
  [BookReaderAvailableKeybind.PREV_CHAPTER, 'Previous chapter'],
  [BookReaderAvailableKeybind.BOOKMARK, 'Bookmark this page'],
  [BookReaderAvailableKeybind.JUMP_TO_BOOKMARK, 'Go to bookmark'],
  [BookReaderAvailableKeybind.TOGGLE_ZEN, 'Zen mode (hide the bottom bar)'],
  [BookReaderAvailableKeybind.SET_READING_POINT, 'Set reading point'],
  [BookReaderAvailableKeybind.AUTO_SCROLL_TOGGLE, 'Auto-scroll on or off'],
  [BookReaderAvailableKeybind.AUTO_SCROLL_INCREASE, 'Auto-scroll faster'],
  [BookReaderAvailableKeybind.AUTO_SCROLL_DECREASE, 'Auto-scroll slower']
];

const AUTO_SCROLL = new Set([
  BookReaderAvailableKeybind.AUTO_SCROLL_TOGGLE,
  BookReaderAvailableKeybind.AUTO_SCROLL_INCREASE,
  BookReaderAvailableKeybind.AUTO_SCROLL_DECREASE
]);

const TRACKER_ACTIONS: [BookReaderAvailableKeybind, string][] = [
  [BookReaderAvailableKeybind.TOGGLE_TRACKING, 'Pause or resume the tracker'],
  [BookReaderAvailableKeybind.TOGGLE_TRACKING_FREEZE, 'Freeze the tracker position']
];

const KEY_NAMES: Record<string, string> = {
  PageDown: 'Page Down',
  PageUp: 'Page Up',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/'
};

/**
 * The keybind map holds both `KeyB` (code) and `b` (key) for every binding. Show the code
 * entries by their key cap and drop the lowercase duplicates.
 */
export function keyLabel(code: string): string | undefined {
  if (KEY_NAMES[code]) {
    return KEY_NAMES[code];
  }

  const letter = /^Key([A-Z])$/.exec(code);

  if (letter) {
    return letter[1];
  }

  const digit = /^Digit(\d)$/.exec(code);

  if (digit) {
    return digit[1];
  }

  return undefined;
}

function keysFor(map: BookReaderKeybindMap, action: BookReaderAvailableKeybind) {
  const labels: string[] = [];

  for (const [code, bound] of Object.entries(map)) {
    if (bound !== action) {
      continue;
    }

    const label = keyLabel(code);

    if (label && !labels.includes(label)) {
      labels.push(label);
    }
  }

  return labels;
}

function rowsFor(map: BookReaderKeybindMap, actions: [BookReaderAvailableKeybind, string][]) {
  const rows: ShortcutRow[] = [];

  for (const [action, label] of actions) {
    const keys = keysFor(map, action);

    if (keys.length) {
      rows.push({ keys, action: label });
    }
  }

  return rows;
}

/** Audiobook (whispersync) keys. They are fixed in whispersync's own code. */
export const AUDIOBOOK_SHORTCUTS: ShortcutRow[] = [
  { keys: ['Ctrl + Space', 'Alt + J'], action: 'Play or stop' },
  { keys: ['Alt + D'], action: 'Play or pause the current line' },
  { keys: ['Ctrl + D'], action: 'Play the current line again' },
  { keys: ['Ctrl + L'], action: 'Loop the current line' },
  { keys: ['Ctrl + Q'], action: 'Previous line' },
  { keys: ['Alt + Q'], action: 'Next line' },
  { keys: ['Ctrl + ←', 'Ctrl + ↓'], action: 'Rewind' },
  { keys: ['Ctrl + →', 'Ctrl + ↑'], action: 'Fast-forward' },
  { keys: ['Ctrl + K'], action: 'Slower' },
  { keys: ['Alt + K'], action: 'Faster' },
  { keys: ['Ctrl + E'], action: 'Create a new Anki card' },
  { keys: ['Alt + E'], action: 'Update the last Anki card' },
  { keys: ['Ctrl + B'], action: 'Bookmark the current line' },
  { keys: ['Ctrl + M'], action: 'Mark the current line for merging' },
  { keys: ['Alt + G'], action: 'Edit the current line' },
  { keys: ['Alt + Z'], action: 'Copy the current line' },
  { keys: ['Alt + H'], action: 'Show or hide the audiobook buttons' }
];

/**
 * WP10a: the `?` cheat sheet. One table for every reader shortcut and gesture; later work
 * packages add their rows here. Keys come from the live keybind map, so a changed binding
 * shows up without editing this file.
 */
export function readerShortcutGroups(context: ShortcutContext): ShortcutGroup[] {
  const { keybindMap } = context;
  // Auto-scroll exists only in continuous mode.
  const reading = rowsFor(
    keybindMap,
    context.paginated
      ? READER_ACTIONS.filter(([action]) => !AUTO_SCROLL.has(action))
      : READER_ACTIONS
  );

  if (context.paginated) {
    // book-reader-paginated.svelte: arrows and A/D turn pages; left/right swap in vertical text.
    reading.splice(
      2,
      0,
      {
        keys: context.verticalMode ? ['←', 'A', '↓'] : ['→', 'D', '↓'],
        action: 'Next page'
      },
      {
        keys: context.verticalMode ? ['→', 'D', '↑'] : ['←', 'A', '↑'],
        action: 'Previous page'
      }
    );
  }

  reading.push({ keys: ['?'], action: 'Show this list' });

  const groups: ShortcutGroup[] = [{ title: 'Reading', rows: reading }];

  if (context.statisticsEnabled) {
    groups.push({ title: 'Tracker', rows: rowsFor(keybindMap, TRACKER_ACTIONS) });
  }

  const touch: ShortcutRow[] = [];

  if (context.paginated) {
    touch.push({
      keys: [context.verticalMode ? 'Swipe right' : 'Swipe left'],
      action: 'Next page'
    });
    touch.push({
      keys: [context.verticalMode ? 'Swipe left' : 'Swipe right'],
      action: 'Previous page'
    });
  }

  if (context.paginated && context.tapEdgeToFlip) {
    touch.push({ keys: ['Tap the left or right edge'], action: 'Turn the page' });
  }

  touch.push(
    { keys: ['Two-finger tap'], action: 'Zen mode (hide the bottom bar)' },
    { keys: ['Tap the top edge'], action: 'Open the menu' }
  );

  if (context.statisticsEnabled) {
    touch.push(
      { keys: ['Tap the tracker icon'], action: 'Pause or resume the tracker' },
      { keys: ['Hold the tracker icon'], action: 'Open the tracker menu' }
    );
  }

  touch.push({ keys: ['Tap the bottom bar'], action: 'Show or hide the progress' });

  if (context.mouseDragPageTurn) {
    touch.push({
      keys: ['Drag sideways with the mouse'],
      action: 'Turn the page (when no text gets selected)'
    });
  }

  groups.push({ title: 'Touch and mouse', rows: touch });
  groups.push({ title: 'Audiobook', rows: AUDIOBOOK_SHORTCUTS });

  return groups;
}
