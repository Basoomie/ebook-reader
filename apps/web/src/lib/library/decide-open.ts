/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink } from '$lib/library/library-db';

/**
 * What to do when the user opens a Calibre book (WP6). Pure functions so every
 * case can be tested; open-calibre-book.ts carries them out.
 *
 * Today the local database and the file sync key books by their EPUB title,
 * so one title can hold one book. These rules never overwrite a book that is
 * already on the device.
 */

export interface LocalBookInfo {
  id: number;
  title: string;
  characters: number;
  /** A record without text (its content lives in another storage source). */
  isPlaceholder: boolean;
  storageSource?: string;
}

export type BeforeDownload =
  /** The link points at a book that is still here: open it, download nothing. */
  | { kind: 'open'; localId: number }
  /** No usable link: download and import. `staleLink` = forget the old link first. */
  | { kind: 'download'; staleLink: boolean };

/** Step 1, before any download: is this Calibre book already on the device? */
export function decideBeforeDownload(
  link: CalibreLink | undefined,
  linkedBook: Pick<LocalBookInfo, 'id' | 'title' | 'isPlaceholder'> | undefined
): BeforeDownload {
  if (!link) return { kind: 'download', staleLink: false };
  if (linkedBook && linkedBook.title === link.title && !linkedBook.isPlaceholder) {
    return { kind: 'open', localId: linkedBook.id };
  }
  // Deleted in the Manager, or replaced by another book with a different title.
  return { kind: 'download', staleLink: true };
}

export type AfterLoad =
  /** No book with this title: save the Calibre copy and link it. */
  | { kind: 'save-new' }
  /** Same title and the same character count: link the existing book and open it. */
  | { kind: 'link-existing'; localId: number }
  /** Same title, different character count: ask before linking the existing book. */
  | { kind: 'ask-existing'; localId: number; localCharacters: number; calibreCharacters: number }
  /** A placeholder holds the title; its text is elsewhere, so nothing is changed. */
  | { kind: 'placeholder'; localId: number; storageSource?: string }
  /** The title already belongs to another Calibre book; both can't be kept until Phase 2. */
  | { kind: 'title-taken'; localId: number; otherBookId: string; otherCalibreTitle: string };

/**
 * Step 2, after the EPUB was downloaded and run through the import pipeline:
 * `loaded` is the result, `existing` the local book with the same title (if
 * any) and `existingLinks` the Calibre links pointing at that book.
 */
export function decideAfterLoad(
  bookId: string,
  loaded: { title: string; characters: number },
  existing: LocalBookInfo | undefined,
  existingLinks: CalibreLink[]
): AfterLoad {
  if (!existing) return { kind: 'save-new' };

  const other = existingLinks.find((l) => l.bookId !== bookId);
  if (other) {
    return {
      kind: 'title-taken',
      localId: existing.id,
      otherBookId: other.bookId,
      otherCalibreTitle: other.calibreTitle
    };
  }

  if (existing.isPlaceholder) {
    return { kind: 'placeholder', localId: existing.id, storageSource: existing.storageSource };
  }

  if (existing.characters === loaded.characters) {
    return { kind: 'link-existing', localId: existing.id };
  }

  return {
    kind: 'ask-existing',
    localId: existing.id,
    localCharacters: existing.characters,
    calibreCharacters: loaded.characters
  };
}
