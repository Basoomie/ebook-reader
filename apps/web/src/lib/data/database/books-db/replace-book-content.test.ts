/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
// The app loads the store first (it creates the shared DatabaseService); the service and
// the store import each other.
import '$lib/data/store';
import { DatabaseService } from './database.service';
import { createBooksDb } from './factory';
import type { BooksDbBookData } from './versions/books-db';

let run = 0;

async function setup() {
  run += 1;
  const db = createBooksDb(`replace-test-${run}`);
  const service = new DatabaseService(db);
  const idb = await db;
  const id = (await idb.add('data', {
    title: 'Stored title',
    styleSheet: 'old',
    elementHtml: '<p data-ttu-whispersync-matched-by="a">old</p>',
    htmlBackup: '<p>old</p>',
    blobs: { a: new Blob(['x']) },
    hasThumb: true,
    characters: 100,
    lastBookModified: 5,
    lastBookOpen: 99
  } as unknown as BooksDbBookData)) as number;
  await idb.put('bookmark', {
    dataId: id,
    exploredCharCount: 40,
    progress: 0.4,
    scrollX: 10,
    scrollY: 20,
    lastBookmarkModified: 3
  });
  return { service, idb, id };
}

const NEW = {
  title: 'New EPUB title',
  styleSheet: 'new',
  elementHtml: '<p>new</p>',
  blobs: {},
  coverImage: undefined,
  hasThumb: false,
  characters: 120,
  lastBookModified: 1,
  lastBookOpen: 0
};

describe('replaceBookContent', () => {
  it('keeps the id, title and last open; takes the new text; drops the backup and scroll', async () => {
    const { service, idb, id } = await setup();
    expect(
      await service.replaceBookContent(id, NEW, { exploredCharCount: 55, progress: 55 / 120 }, 1234)
    ).toBe(true);
    const row = await idb.get('data', id);
    expect(row).toMatchObject({
      id,
      title: 'Stored title',
      styleSheet: 'new',
      elementHtml: '<p>new</p>',
      characters: 120,
      lastBookOpen: 99,
      lastBookModified: 1234
    });
    expect(row).not.toHaveProperty('htmlBackup');
    expect(await idb.getAll('data')).toHaveLength(1);
    expect(await idb.get('bookmark', id)).toEqual({
      dataId: id,
      exploredCharCount: 55,
      progress: 55 / 120,
      lastBookmarkModified: 1234
    });
  });

  it('without a place leaves the bookmark alone; a missing or placeholder record is refused', async () => {
    const { service, idb, id } = await setup();
    await service.replaceBookContent(id, NEW, null);
    expect((await idb.get('bookmark', id))?.exploredCharCount).toBe(40);
    expect(await service.replaceBookContent(id + 100, NEW, null)).toBe(false);
    await idb.put('data', { ...(await idb.get('data', id))!, elementHtml: '' });
    expect(await service.replaceBookContent(id, NEW, null)).toBe(false);
  });
});
