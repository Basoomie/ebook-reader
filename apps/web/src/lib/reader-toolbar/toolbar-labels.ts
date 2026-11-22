/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Reader toolbars session 2: the name and one line on what each toolbar entry does, as
 * Settings > Reader > Toolbars shows them. Settings search (settings-catalog.ts) reads the
 * same words, so the screen and search can't drift. Plain text only (no icons, no stores).
 * A key works whether or not its button is shown (decision 6).
 */

import type { BottomId, TopId } from './toolbar-layout';

export interface ToolbarLabel {
  name: string;
  description: string;
  /** Extra words for Settings search. */
  keywords?: string;
}

export const TOP_LABELS: Record<TopId, ToolbarLabel> = {
  toc: {
    name: 'Table of contents',
    description: 'The book’s chapters. Shows when the book has them.',
    keywords: 'toc chapters'
  },
  appearance: {
    name: 'Appearance',
    description: 'Theme, font, size and page layout.',
    keywords: 'aa font theme'
  },
  search: { name: 'Search', description: 'Search in this book. Key /.' },
  notes: {
    name: 'Highlights and notes',
    description: 'Your highlights, notes and bookmarks in this book. Key L.'
  },
  jumpBackForward: {
    name: 'Back / Forward',
    description: 'After a jump: back to where you were, or forward again. Keys [ and ].',
    keywords: 'jump history'
  },
  returnMarker: {
    name: 'Back to where you were reading',
    description: 'After a jump: goes back to the place you were reading before it.'
  },
  speed: {
    name: 'Speed readout',
    description: 'The autoscroll speed (“20x”). Scrolling mode, with a mouse.',
    keywords: 'autoscroll multiplier'
  },
  gap: {
    name: 'Gap',
    description:
      'Space that pushes the buttons after it to the right edge. Hidden: one row from the left.',
    keywords: 'space spacer right left'
  },
  images: {
    name: 'Images',
    description: 'The book’s pictures. Shows when the book has them.',
    keywords: 'gallery illustrations'
  },
  jump: {
    name: 'Jump',
    description: 'Jump to a position or a percentage.',
    keywords: 'position go to'
  },
  addBookmark: {
    name: 'Add bookmark',
    description: 'Keep this page under a name; your saved place stays. Key K.'
  },
  pacer: { name: 'Pacer', description: 'Paragraph mode, text reveal, disappearing text. Key S.' },
  readAloud: {
    name: 'Read aloud',
    description: 'Read the book aloud with the PC’s voice. Key V.',
    keywords: 'tts voice'
  },
  shortcuts: {
    name: 'Shortcuts',
    description: 'The keys and gestures. Key ?.',
    keywords: 'keys help'
  },
  fullscreen: {
    name: 'Fullscreen',
    description: 'Fill the screen. Shows when the browser allows it.'
  },
  settings: { name: 'Settings', description: 'Opens Settings.' },
  home: { name: 'Home', description: 'Opens Home.' },
  menu: {
    name: 'Menu button',
    description: 'Opens the entries set to Menu. Shows only when one of them can show.',
    keywords: 'more ☰'
  },
  savePlace: {
    name: 'Save my place',
    description: 'Saves where you are in this book. Key B.',
    keywords: 'bookmark'
  },
  returnToSaved: {
    name: 'Return to saved place',
    description: 'Goes back to your saved place. Shows when there is one. Key R.'
  },
  readingPoint: {
    name: 'Reading point',
    description:
      'Show, set or reset the reading point. Pages mode, or with the custom reading line.',
    keywords: 'custom point crosshairs'
  },
  completeBook: {
    name: 'Complete book',
    description: 'Marks the book as read to the end.',
    keywords: 'finish'
  },
  statistics: {
    name: 'Statistics',
    description: 'Opens Statistics on this book.',
    keywords: 'stats'
  },
  ankiEnrich: {
    name: 'Enrich Anki card',
    description: 'Adds the sentence, audio, cover and link to your newest Anki note. Key E.'
  },
  bookStatus: {
    name: 'Book status',
    description: 'Status, favorite and Start over. Library books only.'
  },
  addToCollection: {
    name: 'Add to collection',
    description: 'Adds this book to a collection. Library books only.'
  },
  zen: {
    name: 'Zen mode',
    description: 'Hides or shows the bottom bar. Key Z, or a two-finger tap.'
  },
  library: { name: 'Library', description: 'Opens the Library.' }
};

export const BOTTOM_LABELS: Record<BottomId, ToolbarLabel> = {
  tracker: {
    name: 'Tracker',
    description:
      'Tap to pause or resume the reading tracker, long-press for its menu. Shows while Track reading time is on.',
    keywords: 'statistics pause'
  },
  anki: {
    name: 'Enrich Anki card',
    description: 'Enrich your newest Anki note in one tap. Key E.',
    keywords: 'anki button in the bottom bar'
  },
  pacer: {
    name: 'Pacer',
    description: 'Start or pause the pacer. Shows while a pacer mode is picked. Key S.'
  },
  readAloud: {
    name: 'Read aloud',
    description: 'Play or pause read-aloud. It also shows while read-aloud is on. Key V.',
    keywords: 'read-aloud button in the bottom bar tts'
  },
  returnMarker: {
    name: 'Way back after a jump',
    description:
      'After a jump (search, contents, a highlight or bookmark), shows where you were reading; tap it to go back.',
    keywords: 'return marker'
  },
  audiobook: {
    name: 'Audiobook',
    description:
      'The audiobook’s menu and its own buttons. Shows when the book’s audiobook is ready.',
    keywords: 'whispersync audio player'
  }
};

/** Where the audiobook's own buttons are set (user, 2026-11-22: say where, no link). */
export const AUDIOBOOK_OWN_BUTTONS =
  'Its own buttons: open a book with its audiobook, tap the playlist icon, then Settings › Footer actions.';
