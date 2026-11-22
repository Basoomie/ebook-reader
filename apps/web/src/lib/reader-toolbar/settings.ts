/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableArrayLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';
import { localStorage } from '$lib/data/window/local-storage';
import {
  BOTTOM_DEFAULT,
  TOP_DEFAULT,
  migrateBottomBarSwitches,
  type BottomEntry,
  type TopEntry
} from './toolbar-layout';

/**
 * Reader toolbars session 1 (per device, re-exported by lib/data/store.ts): the top bar's
 * buttons in order, each in the bar, the menu or hidden; and the bottom bar's left side in
 * order, each shown or hidden. The bars show `resolveTopBar` / `resolveBottomBar` of these
 * stored lists (toolbar-layout.ts). Copied by "Copy settings from another device".
 */
export const readerToolbar$ = writableArrayLocalStorageSubject<TopEntry>()('readerToolbar', [
  ...TOP_DEFAULT
]);

// The three old bottom-bar switches move into readerBottomBar once, before it is read.
migrateBottomBarSwitches(localStorage);

export const readerBottomBar$ = writableArrayLocalStorageSubject<BottomEntry>()('readerBottomBar', [
  ...BOTTOM_DEFAULT
]);
