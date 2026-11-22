/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  faArrowLeft,
  faArrowRight,
  faBars,
  faCrosshairs,
  faExpand,
  faFlag,
  faFont,
  faHighlighter,
  faList,
  faMagnifyingGlass,
  faReply,
  faRotateLeft,
  type IconDefinition
} from '@fortawesome/free-solid-svg-icons';
import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
import type { TopId } from './toolbar-layout';

/** The events the reader's top bar sends (book-reader-header.svelte; unchanged names). */
export type HeaderEvent =
  | 'tocClick'
  | 'bookmarkClick'
  | 'scrollToBookmarkClick'
  | 'jumpClick'
  | 'completeBook'
  | 'bookStateClick'
  | 'addToCollectionClick'
  | 'fullscreenClick'
  | 'showCustomReadingPoint'
  | 'setCustomReadingPoint'
  | 'resetCustomReadingPoint'
  | 'statisticsClick'
  | 'readerImageGalleryClick'
  | 'settingsClick'
  | 'domainHintClick'
  | 'homeClick'
  | 'libraryClick'
  | 'zenClick'
  | 'shortcutsClick'
  | 'searchClick'
  | 'appearanceClick'
  | 'notesClick'
  | 'returnMarkerClick'
  | 'addBookmarkClick'
  | 'jumpBackClick'
  | 'jumpForwardClick'
  | 'ankiEnrichClick'
  | 'pacerClick'
  | 'readAloudClick';

/** One control: its name (the menu's label), tooltip, icon and the event it sends. */
export interface ToolbarAction {
  label: string;
  title: string;
  icon: IconDefinition;
  event: HeaderEvent;
}

function fromMerged(
  entry: { label: string; title: string; icon: IconDefinition },
  event: HeaderEvent
) {
  return { label: entry.label, title: entry.title, icon: entry.icon, event };
}

/**
 * Every top-bar entry that is a plain button (the tooltips are today's, with their keys).
 * Back / Forward, Reading point, Save my place, Statistics (the Domain hint on the old
 * address), the speed readout, the gap and the menu button are built by the header.
 */
export const TOOLBAR_ACTIONS: Partial<Record<TopId, ToolbarAction>> = {
  toc: {
    label: 'Table of contents',
    title: 'Open Table of Contents',
    icon: faList,
    event: 'tocClick'
  },
  appearance: {
    label: 'Appearance',
    title: 'Appearance: theme, font, size, page',
    icon: faFont,
    event: 'appearanceClick'
  },
  search: {
    label: 'Search',
    title: 'Search in this book (/)',
    icon: faMagnifyingGlass,
    event: 'searchClick'
  },
  notes: {
    label: 'Highlights and notes',
    title: 'Highlights and notes in this book (L)',
    icon: faHighlighter,
    event: 'notesClick'
  },
  returnMarker: {
    label: 'Back to where you were reading',
    title: 'Back to where you were reading',
    icon: faReply,
    event: 'returnMarkerClick'
  },
  images: fromMerged(mergeEntries.READER_IMAGE_GALLERY, 'readerImageGalleryClick'),
  jump: fromMerged(mergeEntries.JUMP_TO_POSITION, 'jumpClick'),
  addBookmark: fromMerged(mergeEntries.ADD_BOOKMARK, 'addBookmarkClick'),
  pacer: fromMerged(mergeEntries.PACER, 'pacerClick'),
  readAloud: fromMerged(mergeEntries.READ_ALOUD, 'readAloudClick'),
  shortcuts: fromMerged(mergeEntries.SHORTCUTS, 'shortcutsClick'),
  fullscreen: {
    label: 'Fullscreen',
    title: 'Toggle Fullscreen',
    icon: faExpand,
    event: 'fullscreenClick'
  },
  settings: fromMerged(mergeEntries.SETTINGS, 'settingsClick'),
  home: fromMerged(mergeEntries.HOME, 'homeClick'),
  returnToSaved: {
    label: 'Return to saved place',
    title: 'Return to saved place (R)',
    icon: faRotateLeft,
    event: 'scrollToBookmarkClick'
  },
  completeBook: {
    label: 'Complete book',
    title: 'Complete Book',
    icon: faFlag,
    event: 'completeBook'
  },
  ankiEnrich: fromMerged(mergeEntries.ANKI_ENRICH, 'ankiEnrichClick'),
  bookStatus: fromMerged(mergeEntries.BOOK_STATUS, 'bookStateClick'),
  addToCollection: fromMerged(mergeEntries.ADD_TO_COLLECTION, 'addToCollectionClick'),
  zen: fromMerged(mergeEntries.ZEN_MODE, 'zenClick'),
  library: fromMerged(mergeEntries.LIBRARY, 'libraryClick')
};

export const JUMP_BACK: ToolbarAction = {
  label: 'Back',
  title: 'Back to where you were before the jump ([)',
  icon: faArrowLeft,
  event: 'jumpBackClick'
};

export const JUMP_FORWARD: ToolbarAction = {
  label: 'Forward again',
  title: 'Forward again (])',
  icon: faArrowRight,
  event: 'jumpForwardClick'
};

export const STATISTICS: ToolbarAction = fromMerged(mergeEntries.STATISTICS, 'statisticsClick');

/** On ttu's old web address, Statistics' place shows the hint about the new one (as before). */
export const DOMAIN_HINT: ToolbarAction = fromMerged(mergeEntries.DOMAIN_HINT, 'domainHintClick');

export const SAVE_PLACE_TITLE = 'Save my place (B)';
export const SAVE_PLACE_LABEL = 'Save my place';

export const READING_POINT_ICON = faCrosshairs;
export const READING_POINT_TITLE = 'Open Custom Point Actions';

export const MENU_ICON = faBars;
export const MENU_TITLE = 'More';
