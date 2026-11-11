/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import { refreshAuthors, rememberedAuthors } from './book-authors';
import type { CalibreLink } from './library-db';

const link = (over: Partial<CalibreLink> = {}): CalibreLink => ({
  bookId: 'cat-1',
  libraryId: 'lib',
  calibreLibraryUuid: null,
  calibreUuid: 'u',
  calibreId: 1,
  localId: 7,
  title: 'T',
  calibreTitle: 'T',
  characters: 10,
  fileEtag: null,
  linkedAt: 1,
  how: 'imported',
  ...over
});

function store(links: CalibreLink[]) {
  const saved: CalibreLink[] = [];
  return {
    saved,
    getLinksForLocalId: async (id: number) => links.filter((l) => l.localId === id),
    putLink: async (l: CalibreLink) => void saved.push(l)
  };
}

describe('rememberedAuthors', () => {
  it('gives the authors the link remembers', async () => {
    const s = store([link({ authors: ['羽田 宇佐', 'U35'] })]);
    expect(await rememberedAuthors(s, 7)).toEqual({ author: '羽田 宇佐, U35', catalogId: 'cat-1' });
  });

  it('gives nothing for an older link or an unlinked book', async () => {
    expect(await rememberedAuthors(store([link()]), 7)).toEqual({ author: '', catalogId: 'cat-1' });
    expect(await rememberedAuthors(store([]), 7)).toEqual({ author: '', catalogId: null });
  });
});

describe('refreshAuthors', () => {
  it('asks the server and updates a link that remembers something else', async () => {
    const s = store([link({ authors: ['Old Name'] })]);
    const lookup = vi.fn(async () => ({
      books: [{ id: 'cat-1', authors: [{ name: 'New Name' }] }]
    }));
    expect(await refreshAuthors(s, lookup, 7)).toBe('New Name');
    expect(lookup).toHaveBeenCalledWith(['cat-1']);
    expect(s.saved.map((l) => l.authors)).toEqual([['New Name']]);
  });

  it('writes nothing when the link already has them', async () => {
    const s = store([link({ authors: ['Same'] })]);
    const lookup = async () => ({ books: [{ id: 'cat-1', authors: [{ name: 'Same' }] }] });
    expect(await refreshAuthors(s, lookup, 7)).toBe('Same');
    expect(s.saved).toEqual([]);
  });

  it("gives null for an unlinked book or one the server didn't return", async () => {
    const lookup = vi.fn(async () => ({ books: [] }));
    expect(await refreshAuthors(store([]), lookup, 7)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(await refreshAuthors(store([link()]), lookup, 7)).toBeNull();
  });

  it('lets a failed request through to the caller (the dialog keeps the remembered one)', async () => {
    const lookup = async () => {
      throw new Error('unreachable');
    };
    await expect(refreshAuthors(store([link()]), lookup, 7)).rejects.toThrow('unreachable');
  });
});
