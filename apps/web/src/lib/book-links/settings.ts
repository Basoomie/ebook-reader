/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableArrayLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';
import { LINKS_DEFAULT, type LinkEntry } from './link-layout';

/**
 * The book page's links (Settings > Library), all per device and copied by "Copy settings
 * from another device".
 */

/** The links in order, each Button, Menu (behind More) or Hidden; shown as `resolveLinks`. */
export const bookLinks$ = writableArrayLocalStorageSubject<LinkEntry>()('bookLinks', [
  ...LINKS_DEFAULT
]);

/**
 * Where the links go on a Calibre book's page: 'section' (a full-width section below the
 * description, the default), 'buttons' (under the buttons) or 'panel' (an own panel under
 * About this book). Anything unknown reads as the default.
 */
export const bookLinksPlacement$ = writableStringLocalStorageSubject<
  'section' | 'buttons' | 'panel'
>()('bookLinksPlacement', 'section');

/** How More shows the links set to Menu: 'dropdown' (the default) or 'modal'. */
export const bookLinksMoreAs$ = writableStringLocalStorageSubject<'dropdown' | 'modal'>()(
  'bookLinksMoreAs',
  'dropdown'
);

/** Off: a store with no saved id for the book isn't shown (no search link). */
export const bookLinksSearch$ = writableBooleanLocalStorageSubject()('bookLinksSearch', true);
