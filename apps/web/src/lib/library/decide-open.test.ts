/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { decideAfterLoad, decideBeforeDownload, type LocalBookInfo } from './decide-open';
import type { CalibreLink } from './library-db';

function link(overrides: Partial<CalibreLink> = {}): CalibreLink {
  return {
    bookId: 'book-a',
    libraryId: 'lib',
    calibreLibraryUuid: 'cal-lib',
    calibreUuid: 'uuid-a',
    calibreId: 1,
    localId: 7,
    title: 'EPUB Title',
    calibreTitle: 'Calibre Title',
    characters: 100,
    fileEtag: null,
    linkedAt: 1,
    how: 'imported',
    ...overrides
  };
}

const local = (overrides: Partial<LocalBookInfo> = {}): LocalBookInfo => ({
  id: 7,
  title: 'EPUB Title',
  characters: 100,
  isPlaceholder: false,
  ...overrides
});

describe('decideBeforeDownload', () => {
  it('downloads when there is no link', () => {
    expect(decideBeforeDownload(undefined, undefined)).toEqual({
      kind: 'download',
      staleLink: false
    });
  });

  it('opens the linked book without downloading', () => {
    expect(decideBeforeDownload(link(), local())).toEqual({ kind: 'open', localId: 7 });
  });

  it('treats a link as stale when the book was deleted, renamed or is a placeholder', () => {
    const stale = { kind: 'download', staleLink: true };
    expect(decideBeforeDownload(link(), undefined)).toEqual(stale);
    expect(decideBeforeDownload(link(), local({ title: 'Something else' }))).toEqual(stale);
    expect(decideBeforeDownload(link(), local({ isPlaceholder: true }))).toEqual(stale);
  });
});

describe('decideAfterLoad', () => {
  const loaded = { title: 'EPUB Title', characters: 100 };

  it('saves when no book has the title', () => {
    expect(decideAfterLoad('book-a', loaded, undefined, [])).toEqual({ kind: 'save-new' });
  });

  it('links an unlinked book with the same title and character count', () => {
    expect(decideAfterLoad('book-a', loaded, local(), [])).toEqual({
      kind: 'link-existing',
      localId: 7
    });
  });

  it('re-links a book already linked to this same Calibre book', () => {
    expect(decideAfterLoad('book-a', loaded, local(), [link()])).toEqual({
      kind: 'link-existing',
      localId: 7
    });
  });

  it('asks when the character counts differ', () => {
    expect(decideAfterLoad('book-a', loaded, local({ characters: 90 }), [])).toEqual({
      kind: 'ask-existing',
      localId: 7,
      localCharacters: 90,
      calibreCharacters: 100
    });
  });

  it('never touches a placeholder the migration did not link to this book', () => {
    expect(
      decideAfterLoad('book-a', loaded, local({ isPlaceholder: true, storageSource: 'nas' }), [])
    ).toEqual({ kind: 'placeholder', localId: 7, storageSource: 'nas' });
    expect(
      decideAfterLoad(
        'book-a',
        loaded,
        local({ isPlaceholder: true, storageSource: 'nas' }),
        [],
        'book-other'
      )
    ).toEqual({ kind: 'placeholder', localId: 7, storageSource: 'nas' });
  });

  it('fills a migrated placeholder with the library copy (WP7b), asking when counts differ', () => {
    const placeholder = (characters: number) =>
      local({ isPlaceholder: true, storageSource: 'nas', characters });
    expect(decideAfterLoad('book-a', loaded, placeholder(loaded.characters), [], 'book-a')).toEqual(
      { kind: 'fill-placeholder', localId: 7 }
    );
    // An unknown count (0) is not a difference.
    expect(decideAfterLoad('book-a', loaded, placeholder(0), [], 'book-a')).toEqual({
      kind: 'fill-placeholder',
      localId: 7
    });
    expect(
      decideAfterLoad('book-a', loaded, placeholder(loaded.characters + 5), [], 'book-a')
    ).toEqual({
      kind: 'ask-placeholder',
      localId: 7,
      localCharacters: loaded.characters + 5,
      calibreCharacters: loaded.characters
    });
  });

  it('refuses a title that belongs to another Calibre book', () => {
    expect(
      decideAfterLoad('book-b', loaded, local(), [link({ calibreTitle: 'Other edition' })])
    ).toEqual({
      kind: 'title-taken',
      localId: 7,
      otherBookId: 'book-a',
      otherCalibreTitle: 'Other edition'
    });
    // Even when it is also a placeholder or the counts match.
    expect(decideAfterLoad('book-b', loaded, local({ isPlaceholder: true }), [link()]).kind).toBe(
      'title-taken'
    );
  });
});
