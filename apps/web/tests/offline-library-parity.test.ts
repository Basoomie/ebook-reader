/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 §2, offline Library: the device's offline catalog answers exactly as the real
 * storage server does (tests/helpers/sync-harness.ts) when every book is on the device.
 * A varied catalog (apps/storage-server/tests/helpers/seed-catalog-fixture.ts) plus book
 * state, favorite, position, collection and device-books records from the device; the
 * offline copies are made by the real refresh code from that server. Then a table of
 * searches, sorts, tabs, groups, scopes, collections, lookups and counts must give the
 * same ids in the same order, the same totals, group numbers and collage tiles.
 */
import 'fake-indexeddb/auto';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTION_ITEM_KIND,
  COLLECTION_KIND,
  collectionsFrom,
  itemsByCollection
} from '$lib/collections/collections';
import { LibraryApi, type BookListQuery } from '$lib/library/api';
import { DEVICE_BOOKS_KIND } from '$lib/library/device-books';
import { refreshCopies } from '$lib/library/offline/copies';
import type { OfflineCopy } from '$lib/library/offline/offline-db';
import { OfflineCatalog } from '$lib/library/offline/offline-catalog';
import type { CatalogBook, CatalogGroupPage, GroupBy } from '$lib/library/types';
import type { ServerSort } from '$lib/library/sort';
import {
  getAllBookStates,
  setBooksFavorite,
  setBooksStatus,
  type BookStateDeps
} from '$lib/sync/book-state-service';
import { BOOK_STATUS_KIND } from '$lib/sync/book-state';
import { Device, TestServer, runServerScript } from './helpers/sync-harness';

const BOOK_SORTS = ['added', 'title', 'author', 'chars', 'published'] as const;
const GROUP_SORTS = ['newest', 'name', 'count'] as const;
const DIRS = ['asc', 'desc'] as const;

const QUERIES = [
  '',
  'gj',
  'ＧＪ',
  'ｇｊ部',
  'NO推理',
  'ＮＯ推理',
  '魔女の旅々20',
  'author:日向',
  'author:=gj作家',
  'author:ａｕｔｈｏｒ',
  'author:gj作家,日向夏',
  '-author:日向',
  'series:薬屋',
  'series:="ＧＪ部"',
  '-series:ＧＪ',
  'tag:ミステリー',
  'tag:sf',
  'tag:ホラー tag:sf',
  'tag:ホラー,短編',
  '-tag:needs-metadata',
  'chars:<10000',
  'chars:>=100k',
  'chars:50000-120000',
  '-chars:<10000',
  'status:reading',
  'status:unread',
  'status:completed,dropped',
  '-status:unread',
  'favorite:yes',
  'favorite:no',
  'on:device',
  '-on:device',
  // Season 2 Phase 9: the books whose audio is downloaded on the device.
  'on:audio',
  '-on:audio',
  'on:audio status:reading',
  '-on:audio favorite:yes',
  '/^ＧＪ/',
  '/gj/i',
  '/ＧＪ/',
  'author:/^Co/',
  '"Re:ゼロ"',
  'Re:ゼロ',
  '1/2',
  '100%',
  'a_b',
  'でんき',
  '薬屋 -tag:ミステリー',
  'status:reading favorite:yes'
];

function deps(device: Device): BookStateDeps {
  return { getEngine: async () => device.engine, today: () => '2026-11-14', warn: () => {} };
}

type Source = Pick<LibraryApi, 'books' | 'groups' | 'count' | 'lookup' | 'collectionCards'>;

/** Every page of a list (small pages, so paging is exercised too). */
async function allBooks(
  s: Source,
  query: BookListQuery & { sort?: ServerSort<string> }
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await s.books({ ...query, limit: 7, cursor });
    ids.push(...page.books.map((b) => b.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('too many pages');
}

async function allGroups(
  s: Source,
  query: { by: GroupBy; q?: string; library?: string; sort?: ServerSort<string> }
) {
  const groups: CatalogGroupPage['groups'] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await s.groups({ ...query, limit: 3, cursor });
    groups.push(...page.groups);
    total = page.total;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return {
    total,
    groups: groups.map((g) => ({
      name: g.name,
      bookCount: g.bookCount,
      newestAddedAt: g.newestAddedAt,
      chars: g.chars,
      bookIds: g.bookIds,
      cover: g.cover?.bookId ?? g.cover,
      tiles: g.tiles?.map((t) => t.bookId)
    }))
  };
}

function strip(books: CatalogBook[]) {
  return books.map(({ thumbnail: _t, ...rest }) => rest);
}

describe('offline Library answers like the server (real server)', () => {
  const server = new TestServer();
  let device: Device;
  let api: LibraryApi;
  let offline: OfflineCatalog;
  let bookIds: string[] = [];
  let audioIds = new Set<string>();
  const listId = randomUUID();
  const smartId = randomUUID();

  beforeAll(async () => {
    const output = runServerScript([
      path.join('tests', 'helpers', 'seed-catalog-fixture.ts'),
      server.dbDir,
      '1'
    ]);
    const line = output.split(/\r?\n/).find((l) => l.startsWith('SEED '));
    if (!line) throw new Error(`seed script printed no result:\n${output}`);
    const seeded = JSON.parse(line.slice(5)) as { tokens: string[]; bookIds: string[] };
    bookIds = seeded.bookIds;
    await server.start();
    device = new Device('A', seeded.tokens[0], server);
    await device.open();
    await device.sync();
    api = new LibraryApi(server.url, seeded.tokens[0]);

    const b = bookIds;
    // Completed goes through its own dialog step in the app: its record directly.
    for (const i of [0, 13]) {
      await device.engine.put(
        BOOK_STATUS_KIND,
        b[i],
        { status: 'completed', auto: false },
        { bookId: b[i] }
      );
    }
    expect(await setBooksStatus([b[5], b[9], b[17]], 'reading', deps(device))).toEqual([]);
    expect(await setBooksStatus([b[7]], 'dropped', deps(device))).toEqual([]);
    expect(await setBooksStatus([b[8]], 'unread', deps(device))).toEqual([]);
    expect(await setBooksFavorite([b[9], b[11], b[23]], true, deps(device))).toEqual([]);
    // Positions saved one after another (collage order: most recent first).
    for (const i of [3, 7, 12, 1, 23]) {
      await device.engine.put(
        'position',
        `${b[i]}:${device.engine.deviceId}`,
        { charPos: 10 + i, progress: 0.1, readThroughId: null },
        { bookId: b[i] }
      );
      await new Promise((r) => setTimeout(r, 5));
    }
    // Audio downloaded for four books (one of them in the switched-off library or missing
    // would be hidden on both sides alike).
    const audio = [b[2], b[5], b[9], b[21]];
    await device.engine.put(DEVICE_BOOKS_KIND, device.engine.deviceId, {
      bookIds: [...b].sort(),
      audioBookIds: [...audio].sort()
    });
    audioIds = new Set(audio);
    await device.engine.put(COLLECTION_KIND, listId, { name: 'List', type: 'manual' });
    await device.engine.put(COLLECTION_KIND, smartId, {
      name: 'Smart',
      type: 'smart',
      query: 'author:日向 -status:dropped'
    });
    for (const [i, key] of [
      [11, 'a'],
      [2, 'b'],
      [21, 'c'],
      [6, 'd'],
      [18, 'e']
    ] as const) {
      await device.engine.put(COLLECTION_ITEM_KIND, `${listId}:${b[i]}`, { key }, { bookId: b[i] });
    }
    await device.sync();
    await device.sync();

    const stored = new Map<string, OfflineCopy>();
    const result = await refreshCopies(api, {
      store: {
        getAll: async () => [...stored.values()],
        put: async (c) => void stored.set(c.bookId, c),
        delete: async (id) => void stored.delete(id)
      },
      deviceBookIds: async () => b,
      fetchBlob: async () => new Blob(['cover']),
      now: Date.now,
      warn: (m) => {
        throw new Error(m);
      }
    });
    expect(result.stopped).toBe(false);
    // (The seeded libraries have no index state, which /libraries needs; lists don't.)
    offline = new OfflineCatalog(async () => ({
      books: [...stored.values()].filter((c) => !c.hidden).map((c) => c.book),
      libraries: [],
      states: await getAllBookStates(deps(device)),
      positions: await device.engine.getAll('position'),
      collections: collectionsFrom(await device.engine.getAll(COLLECTION_KIND)),
      items: itemsByCollection(await device.engine.getAll(COLLECTION_ITEM_KIND)),
      audioOnDevice: audioIds
    }));
  }, 180_000);

  afterAll(async () => {
    device?.engine.close();
    await server.stop();
  });

  it('hides the switched-off library and keeps the missing book only for lookups', async () => {
    const all = await allBooks(api, {});
    expect(all).toHaveLength(bookIds.length - 2);
    expect(await allBooks(offline, {})).toEqual(all);
  });

  it('every search in every sort and direction, across pages, with the same count', async () => {
    // The table means something: most searches find books, some all, some few.
    const counts = await Promise.all(QUERIES.map((q) => api.count({ q: q || undefined })));
    expect(counts.filter((n) => n > 0).length).toBeGreaterThan(QUERIES.length - 5);
    expect(new Set(counts).size).toBeGreaterThan(10);
    expect(await api.count({ q: 'NO推理' })).toBe(2);
    for (const q of QUERIES) {
      for (const key of BOOK_SORTS) {
        for (const dir of DIRS) {
          const query = { q: q || undefined, sort: { key, dir } };
          expect(await allBooks(offline, query), `${q} ${key} ${dir}`).toEqual(
            await allBooks(api, query)
          );
        }
      }
      const plain = { q: q || undefined };
      expect(await allBooks(offline, plain), `${q} default`).toEqual(await allBooks(api, plain));
      expect(await offline.count(plain), `${q} count`).toBe(await api.count(plain));
    }
  }, 300_000);

  it('the library picker, open groups (series order unless sorted) and scopes', async () => {
    const cases: (BookListQuery & { sort?: ServerSort<string> })[] = [
      { library: 'lib2' },
      { library: 'lib1', q: 'author:日向' },
      { group: { by: 'series', name: 'ＧＪ部' } },
      { group: { by: 'series', name: 'ＧＪ部' }, sort: { key: 'title', dir: 'desc' } },
      { group: { by: 'series', name: '薬屋' } },
      { group: { by: 'series', name: '薬屋' }, library: 'lib1' },
      { group: { by: 'series', name: null } },
      { group: { by: 'author', name: '日向夏' } },
      { group: { by: 'author', name: 'Zed Last' }, sort: { key: 'chars', dir: 'asc' } },
      { group: { by: 'tag', name: 'ミステリー' } },
      { group: { by: 'tag', name: 'ミステリー' }, q: 'status:unread' },
      { scope: 'status:reading' },
      { scope: 'favorite:yes', q: 'Zed' },
      { scope: 'on:device', sort: { key: 'author', dir: 'desc' } },
      { scope: 'on:audio', sort: { key: 'title', dir: 'asc' } },
      { collection: listId, sort: { key: 'title', dir: 'asc' } },
      { collection: listId, q: 'tag:ミステリー', sort: { key: 'added', dir: 'desc' } }
    ];
    for (const c of cases) {
      const label = JSON.stringify(c);
      expect(await allBooks(offline, c), label).toEqual(await allBooks(api, c));
      expect(await offline.count(c), `${label} count`).toBe(await api.count(c));
    }
  });

  it('tabs: groups with their numbers, covers and collages, in every sort', async () => {
    for (const by of ['series', 'author', 'tag'] as GroupBy[]) {
      for (const q of [
        '',
        'author:日向',
        'series:ＧＪ',
        'status:reading',
        'tag:ミステ',
        '-author:Zed',
        'gj'
      ]) {
        for (const key of GROUP_SORTS) {
          for (const dir of DIRS) {
            const query = { by, q: q || undefined, sort: { key, dir } };
            expect(await allGroups(offline, query), JSON.stringify(query)).toEqual(
              await allGroups(api, query)
            );
          }
        }
        const plain = { by, q: q || undefined };
        expect(await allGroups(offline, plain), JSON.stringify(plain)).toEqual(
          await allGroups(api, plain)
        );
      }
      const lib = { by, library: 'lib2' };
      expect(await allGroups(offline, lib)).toEqual(await allGroups(api, lib));
    }
  }, 300_000);

  it('lookups (a list in its own order) and the summaries themselves', async () => {
    const ids = [bookIds[21], bookIds[2], bookIds[22], bookIds[6], bookIds[2], randomUUID()];
    for (const q of [undefined, 'tag:sf', 'status:unread']) {
      expect((await offline.lookup(ids, q)).books.map((b) => b.id)).toEqual(
        (await api.lookup(ids, q)).books.map((b) => b.id)
      );
    }
    expect(strip((await offline.lookupIncludingMissing(bookIds)).books)).toEqual(
      strip((await api.lookupIncludingMissing(bookIds)).books)
    );
    expect(strip((await offline.books({ limit: 200 })).books)).toEqual(
      strip((await api.books({ limit: 200 })).books)
    );
  });

  it('collection cards: counts and collage tiles of built-ins and both kinds', async () => {
    const simplify = (cards: Awaited<ReturnType<Source['collectionCards']>>['cards']) =>
      cards.map((c) => ({
        id: c.id,
        builtin: c.builtin,
        query: c.query,
        bookCount: c.bookCount,
        tiles: c.tiles.map((t) => t.bookId),
        error: c.error?.code
      }));
    const server = simplify((await api.collectionCards()).cards).filter(
      // The server seeds "Planned" only for real apps (test apps turn it off), and the
      // device has the same records, but compare by id to be safe.
      () => true
    );
    expect(simplify((await offline.collectionCards()).cards)).toEqual(server);
  });

  it('details: the copy is the server detail', async () => {
    for (const id of [bookIds[7], bookIds[21], bookIds[20]]) {
      const { thumbnail: _a, ...fromServer } = await api.book(id);
      const { thumbnail: _b, ...fromCopy } = await offline.book(id);
      expect(fromCopy).toEqual(fromServer);
    }
  });
});
