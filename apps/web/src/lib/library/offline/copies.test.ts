/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { LibraryApiError } from '$lib/library/api';
import type { CatalogBook, CatalogBookDetail } from '$lib/library/types';
import { copyFromDetail, refreshCopies, type CopyApi, type RefreshDeps } from './copies';
import type { OfflineCopy } from './offline-db';

function summary(id: string, over: Partial<CatalogBook> = {}): CatalogBook {
  return {
    id,
    libraryId: 'lib1',
    title: `T ${id}`,
    titleSort: null,
    authors: [],
    authorSort: null,
    series: null,
    tags: [],
    addedAt: 1,
    charCount: 10,
    charCountStatus: 'counted',
    missing: false,
    thumbnail: `/api/v1/books/${id}/thumbnail?v=1`,
    source: 'calibre',
    publisher: null,
    publishedAt: null,
    ...over
  };
}

class FakeServer implements CopyApi {
  books = new Map<string, CatalogBook>();
  lookups = 0;
  details: string[] = [];
  down = false;
  lookupIncludingMissing = async (ids: readonly string[]) => {
    if (this.down) throw new LibraryApiError('unreachable', 'no');
    this.lookups += 1;
    return { books: ids.map((id) => this.books.get(id)).filter((b): b is CatalogBook => !!b) };
  };
  book = async (id: string): Promise<CatalogBookDetail> => {
    this.details.push(id);
    const b = this.books.get(id);
    if (!b) throw new LibraryApiError('server', 'gone', 404, 'not_found');
    return { ...b, description: `about ${id}`, sources: [] };
  };
  absolute = (path: string) => `http://server${path}`;
}

function setup(ids: string[]) {
  const server = new FakeServer();
  const stored = new Map<string, OfflineCopy>();
  const fetched: string[] = [];
  const deps: RefreshDeps = {
    store: {
      getAll: async () => [...stored.values()],
      put: async (c) => void stored.set(c.bookId, c),
      delete: async (id) => void stored.delete(id)
    },
    deviceBookIds: async () => ids,
    fetchBlob: async (url) => {
      fetched.push(url);
      if (url.includes('broken')) throw new Error('404');
      return new Blob([url]);
    },
    now: () => 5,
    warn: () => {}
  };
  return { server, stored, fetched, deps };
}

describe('offline copies', () => {
  it('saves summary, details and thumbnail of each book on the device', async () => {
    const { server, stored, fetched, deps } = setup(['a', 'b']);
    server.books.set('a', summary('a'));
    server.books.set('b', summary('b', { thumbnail: null }));
    const result = await refreshCopies(server, deps);
    expect(result).toMatchObject({ checked: 2, details: 2, thumbnails: 1, stopped: false });
    expect(stored.get('a')?.book.description).toBe('about a');
    expect(stored.get('a')?.thumbnailOf).toBe('/api/v1/books/a/thumbnail?v=1');
    expect(fetched).toEqual(['http://server/api/v1/books/a/thumbnail?v=1']);
    expect(stored.get('b')?.thumbnail).toBeNull();
  });

  it('asks again only for what changed', async () => {
    const { server, stored, fetched, deps } = setup(['a', 'b']);
    server.books.set('a', summary('a'));
    server.books.set('b', summary('b'));
    await refreshCopies(server, deps);
    const before = stored.get('a');
    server.details = [];
    fetched.length = 0;
    expect(await refreshCopies(server, deps)).toMatchObject({ details: 0, thumbnails: 0 });
    expect(stored.get('a')).toBe(before);

    server.books.set(
      'a',
      summary('a', { title: 'New', thumbnail: '/api/v1/books/a/thumbnail?v=2' })
    );
    const result = await refreshCopies(server, deps);
    expect(result).toMatchObject({ details: 1, thumbnails: 1 });
    expect(server.details).toEqual(['a']);
    expect(stored.get('a')?.book.title).toBe('New');
  });

  it('marks a book the server no longer lists hidden, removes books no longer on the device', async () => {
    const { server, stored, deps } = setup(['a', 'b']);
    server.books.set('a', summary('a'));
    server.books.set('b', summary('b'));
    await refreshCopies(server, deps);
    server.books.delete('b');
    await refreshCopies(server, { ...deps, deviceBookIds: async () => ['b'] });
    expect(stored.has('a')).toBe(false);
    expect(stored.get('b')?.hidden).toBe(true);
    server.books.set('b', summary('b'));
    await refreshCopies(server, { ...deps, deviceBookIds: async () => ['b'] });
    expect(stored.get('b')?.hidden).toBe(false);
  });

  it('keeps the copies as they were when the server stops answering or a cover fails', async () => {
    const { server, stored, deps } = setup(['a']);
    server.books.set('a', summary('a'));
    await refreshCopies(server, deps);
    const before = stored.get('a');
    server.down = true;
    expect((await refreshCopies(server, deps)).stopped).toBe(true);
    expect(stored.get('a')).toBe(before);

    server.down = false;
    server.books.set('a', summary('a', { thumbnail: '/broken' }));
    await refreshCopies(server, deps);
    expect(stored.get('a')?.thumbnailOf).toBe('/api/v1/books/a/thumbnail?v=1');
    expect(stored.get('a')?.thumbnail).toBe(before?.thumbnail);
  });

  it('keeps the detail’s identifiers, and fetches a copy stored without them once', async () => {
    const { server, stored, deps } = setup(['a']);
    server.books.set('a', summary('a'));
    server.book = async (id: string): Promise<CatalogBookDetail> => {
      server.details.push(id);
      return {
        ...server.books.get(id)!,
        description: 'd',
        sources: [],
        identifiers: { honto: '1' }
      };
    };
    // A copy from before (no identifiers): its detail is fetched again.
    stored.set('a', {
      bookId: 'a',
      book: { ...summary('a'), description: 'old', sources: [] },
      hasDetail: true,
      thumbnail: null,
      thumbnailOf: '/api/v1/books/a/thumbnail?v=1',
      hidden: false,
      savedAt: 1
    });
    expect((await refreshCopies(server, deps)).details).toBe(1);
    expect(stored.get('a')?.book.identifiers).toEqual({ honto: '1' });
    // Then only when the summary changes; the identifiers are kept meanwhile.
    expect((await refreshCopies(server, deps)).details).toBe(0);
    expect(stored.get('a')?.book.identifiers).toEqual({ honto: '1' });
    server.books.set('a', summary('a', { illustrators: ['あずーる'] }));
    expect((await refreshCopies(server, deps)).details).toBe(1);
    expect(stored.get('a')?.book.illustrators).toEqual(['あずーる']);
  });

  it('a details answer keeps the cover only for the same thumbnail', () => {
    const blob = new Blob(['x']);
    const old: OfflineCopy = {
      bookId: 'a',
      book: { ...summary('a'), description: null, sources: [] },
      hasDetail: false,
      thumbnail: blob,
      thumbnailOf: '/api/v1/books/a/thumbnail?v=1',
      hidden: false,
      savedAt: 1
    };
    const same = copyFromDetail({ ...summary('a'), description: 'd', sources: [] }, old, 2);
    expect(same).toMatchObject({ hasDetail: true, thumbnail: blob });
    const other = copyFromDetail(
      { ...summary('a', { thumbnail: '/v2' }), description: 'd', sources: [] },
      old,
      2
    );
    expect(other.thumbnail).toBeNull();
  });
});
