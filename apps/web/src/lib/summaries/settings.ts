/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableArrayLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';

/**
 * Book summaries: the languages a summary can be shown in, the same on every device
 * (book-summaries.md "Languages"; its row is in Settings › Library › Summaries). A summary is
 * written in its book's language; another one is a translation, made item by item the first
 * time it is chosen.
 */
export const summaryLanguages$ = writableArrayLocalStorageSubject<string>()('summaryLanguages', [
  'en',
  'ja'
]);

/**
 * Spoiler blur, the same on every device (session 4): 'completed' shows the summary only for
 * books whose status is Completed now (the default, decided with the user 2026-11-23),
 * 'always' blurs every summary, 'never' shows every one. Anything unknown reads as the default.
 */
export type SummaryBlur = 'completed' | 'always' | 'never';
export const summarySpoilerBlur$ = writableStringLocalStorageSubject<SummaryBlur>()(
  'summarySpoilerBlur',
  'completed'
);

/** How the Characters tab looks on this device: a list, cards in columns, or a carousel. */
export type SummaryCharacterLayout = 'list' | 'cards' | 'carousel';
export const summaryCharacterLayout$ = writableStringLocalStorageSubject<SummaryCharacterLayout>()(
  'summaryCharacterLayout',
  'cards'
);

/** How the Relationships tab looks on this device: a list, or a diagram fitted to the width. */
export type SummaryRelationshipLayout = 'list' | 'diagram';
export const summaryRelationshipLayout$ =
  writableStringLocalStorageSubject<SummaryRelationshipLayout>()(
    'summaryRelationshipLayout',
    'list'
  );

/** The language last chosen on this device's book pages ('' = the book's own). Never synced. */
export const summaryViewLang$ = writableStringLocalStorageSubject<string>()('summaryViewLang', '');

/**
 * "Make a summary when a book is first completed", the same on every device (session 4b; on by
 * default). Off: completing a book makes no summary (the device writes a "summary-skip" with
 * the completion and the server checks the setting too), so turning it on again makes none for
 * the books completed meanwhile. A summary can still be made from the book page.
 */
export const summaryAutoOnFirstCompletion$ = writableBooleanLocalStorageSubject()(
  'summaryAutoOnFirstCompletion',
  true
);

/**
 * The language last chosen for book descriptions on this device ('' = the original), apart
 * from the summary's (decided with the user, 2026-11-23). Never synced.
 */
export const descriptionViewLang$ = writableStringLocalStorageSubject<string>()(
  'descriptionViewLang',
  ''
);
