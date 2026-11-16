/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

export enum BookReaderAvailableKeybind {
  AUTO_SCROLL_TOGGLE = 'autoScrollToggle',
  AUTO_SCROLL_INCREASE = 'autoScrollIncrease',
  AUTO_SCROLL_DECREASE = 'autoScrollDecrease',
  BOOKMARK = 'bookmark',
  JUMP_TO_BOOKMARK = 'jumpToBookmark',
  NEXT_CHAPTER = 'nextChapter',
  NEXT_PAGE = 'nextPage',
  PREV_CHAPTER = 'prevChapter',
  PREV_PAGE = 'prevPage',
  SET_READING_POINT = 'setCustomReadingPoint',
  TOGGLE_TRACKING = 'toggleTracking',
  TOGGLE_TRACKING_FREEZE = 'toggleTrackingFreeze',
  TOGGLE_ZEN = 'toggleZen',
  /** WP14 "Enrich last Anki card". */
  ANKI_ENRICH = 'ankiEnrich',
  /** Season 2 pacer: start / pause. */
  PACER_TOGGLE = 'pacerToggle',
  /** Season 2 Phase 12 session 3: read-aloud play / pause. */
  READ_ALOUD_TOGGLE = 'readAloudToggle'
}

export type BookReaderKeybindMap = Record<string, BookReaderAvailableKeybind>;
