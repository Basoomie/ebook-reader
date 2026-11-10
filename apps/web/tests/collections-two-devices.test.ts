/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP8b: collections and library progress between devices, against the real storage
 * server (tests/helpers/sync-harness.ts):
 * - the server's "Planned" list exists exactly once, also on a newly paired device, and
 *   stays deleted once deleted (also across a server restart);
 * - two devices reordering a list offline keep each other's moves (the later move of
 *   the same book wins); an add on one and a remove on the other both survive; a list
 *   deleted on one device while the other adds to it stays deleted;
 * - a saved search made on A works on B, and the server's built-ins match the app's;
 * - library progress is the furthest place of the current read on any device, and a
 *   Start over starts it again;
 * - collection actions write no stat-day or position records.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_COLLECTIONS } from '$lib/collections/builtins';
import {
  addBooks,
  createCollection,
  deleteCollection,
  getCollectionsView,
  moveBooks,
  removeBooks,
  type CollectionsDeps
} from '$lib/collections/collections-service';
import { LibraryApi } from '$lib/library/api';
import { bookProgressLabel } from '$lib/library/progress';
import { positionReadThroughId } from '$lib/sync/book-state';
import { getBookState, startBookOver, type BookStateDeps } from '$lib/sync/book-state-service';
import { positionRecordId } from '$lib/sync/record-position';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

/** The server's fixed id for "Planned" (storage-server src/collections/seed.ts). */
const PLANNED = '5e7d2c1a-8b4f-4c3e-9a6d-0f1b2c3d4e5f';

function collectionsDeps(device: Device): CollectionsDeps {
  return { getEngine: async () => device.engine, warn: () => {} };
}

function stateDeps(device: Device): BookStateDeps {
  return { getEngine: async () => device.engine, today: () => '2026-11-10', warn: () => {} };
}

async function order(device: Device, id: string) {
  return (await getCollectionsView(collectionsDeps(device))).items.get(id)?.map((i) => i.bookId);
}

async function names(device: Device) {
  return (await getCollectionsView(collectionsDeps(device))).collections.map((c) => c.name);
}

/** a, b, a: both devices end up with everything. */
async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

describe('collections between devices (real server)', () => {
  const server = new TestServer();
  const books: string[] = [];
  let tokens: string[] = [];
  let a: Device;
  let b: Device;

  beforeAll(async () => {
    for (let i = 0; i < 6; i += 1) {
      const seeded = seedServer(server, 1, { catalog: true });
      books.push(seeded.bookId);
      tokens = tokens.concat(seeded.tokens);
    }
    await server.start();
    a = new Device('A', tokens[0], server);
    b = new Device('B', tokens[1], server);
    await a.open();
    await b.open();
    await syncAll(a, b);
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('starts every device with one empty "Planned" list', async () => {
    for (const device of [a, b]) {
      const view = await getCollectionsView(collectionsDeps(device));
      expect(view.collections.map((c) => [c.id, c.name, c.type])).toEqual([
        [PLANNED, 'Planned', 'manual']
      ]);
      expect(view.items.get(PLANNED)).toBeUndefined();
    }
  });

  it('merges two devices reordering offline', async () => {
    const [b1, b2, b3, b4, b5] = books;
    expect(await addBooks(PLANNED, [b1, b2, b3, b4, b5], collectionsDeps(a))).toEqual([]);
    await syncAll(a, b);
    expect(await order(b, PLANNED)).toEqual([b1, b2, b3, b4, b5]);

    // Offline: A moves b5 to the top, B moves b1 to the bottom.
    a.online = false;
    b.online = false;
    await moveBooks(PLANNED, [b5], 0, collectionsDeps(a));
    await moveBooks(PLANNED, [b1], 99, collectionsDeps(b));
    a.online = true;
    b.online = true;
    await syncAll(a, b);
    for (const d of [a, b]) expect(await order(d, PLANNED)).toEqual([b5, b2, b3, b4, b1]);

    // Both move b3 offline; B's move is the later one and wins.
    a.online = false;
    b.online = false;
    await moveBooks(PLANNED, [b3], 0, collectionsDeps(a));
    await new Promise((r) => setTimeout(r, 5));
    await moveBooks(PLANNED, [b3], 99, collectionsDeps(b));
    a.online = true;
    b.online = true;
    await syncAll(a, b);
    for (const d of [a, b]) expect(await order(d, PLANNED)).toEqual([b5, b2, b4, b1, b3]);
  });

  it('keeps an add on one device and a remove on the other', async () => {
    const [b1, b2, , , , b6] = books;
    a.online = false;
    b.online = false;
    await addBooks(PLANNED, [b6], collectionsDeps(a));
    await removeBooks(PLANNED, [b2], collectionsDeps(b));
    a.online = true;
    b.online = true;
    await syncAll(a, b);
    for (const d of [a, b]) {
      const list = await order(d, PLANNED);
      expect(list).not.toContain(b2);
      expect(list?.[list.length - 1]).toBe(b6);
      expect(list).toContain(b1);
    }
  });

  it('keeps a list deleted on A while B added to it offline', async () => {
    const list = await createCollection({ name: '一時', type: 'manual' }, collectionsDeps(a));
    await syncAll(a, b);
    b.online = false;
    await addBooks(list, [books[0]], collectionsDeps(b));
    await deleteCollection(list, collectionsDeps(a));
    await a.sync();
    b.online = true;
    await syncAll(b, a);
    for (const d of [a, b]) {
      expect(await names(d)).not.toContain('一時');
      expect((await getCollectionsView(collectionsDeps(d))).items.has(list)).toBe(false);
    }
  });

  it('runs a saved search made on A for B, with the same built-ins as the app', async () => {
    const id = await createCollection(
      { name: 'Seeded', type: 'smart', query: 'Book' },
      collectionsDeps(a)
    );
    await syncAll(a, b);
    expect(await names(b)).toContain('Seeded');
    const api = new LibraryApi(server.url, tokens[1]);
    const cards = new Map((await api.collectionCards()).cards.map((c) => [c.id, c]));
    // Seeded books are titled "Book <id>" (seed-sync-fixture.ts).
    expect(cards.get(id)?.bookCount).toBe(books.length);
    expect(cards.get(PLANNED)?.bookCount).toBe((await order(b, PLANNED))?.length);
    expect([...cards.values()].filter((c) => c.builtin).map((c) => [c.id, c.query])).toEqual(
      BUILTIN_COLLECTIONS.map((x) => [x.id, x.query])
    );
    expect(cards.get('unread')?.bookCount).toBe(books.length);
    // A list's books in its own order, and the saved search as a scope.
    const listed = await api.lookup((await order(b, PLANNED)) ?? []);
    expect(listed.books.map((x) => x.id)).toEqual(await order(b, PLANNED));
    expect((await api.books({ scope: 'Book', limit: 2 })).books).toHaveLength(2);
  });

  it('wrote no stat-day or position records', async () => {
    for (const device of [a, b]) {
      expect(await device.engine.getAll('stat-day')).toEqual([]);
      expect(await device.engine.getAll('position')).toEqual([]);
    }
  });

  it('keeps "Planned" deleted, also on a new device and after a restart', async () => {
    await deleteCollection(PLANNED, collectionsDeps(a));
    await syncAll(a, b);
    expect(await names(b)).not.toContain('Planned');

    await server.stop();
    await server.start();
    a.connect();
    b.connect();
    const c = new Device('C', tokens[2], server);
    await c.open();
    await c.sync();
    await c.sync();
    expect(await names(c)).not.toContain('Planned');
    const planned = (await c.engine.getAll('collection')).filter((r) => r.id === PLANNED);
    expect(planned).toHaveLength(1);
    expect(planned[0].deletedAt).not.toBeNull();
    c.engine.close();
  }, 120_000);

  it('shows the furthest place of the current read on any device', async () => {
    const book = books[3];
    const write = async (device: Device, charPos: number, progress: number) => {
      const state = await getBookState(book, stateDeps(device));
      await device.engine.put(
        'position',
        positionRecordId(book, device.engine.deviceId),
        { charPos, progress, readThroughId: positionReadThroughId(state) },
        { bookId: book }
      );
    };
    const label = async (device: Device) =>
      bookProgressLabel(
        book,
        await getBookState(book, stateDeps(device)),
        await device.engine.getForBook(book).then((r) => r.filter((x) => x.kind === 'position')),
        1000
      );

    await write(a, 600, 0.6);
    await syncAll(a, b);
    // B saves an earlier place later (e.g. it opened the book where it was before).
    await write(b, 300, 0.3);
    await syncAll(b, a);
    expect(await label(a)).toBe('60%');
    expect(await label(b)).toBe('60%');

    // Start over on B: earlier places stop counting; the start is saved by the jump.
    await startBookOver(book, stateDeps(b));
    await syncAll(b, a);
    expect(await label(a)).toBeNull();
    await write(b, 0, 0);
    await syncAll(b, a);
    expect(await label(a)).toBe('0%');
    await write(a, 120, 0.12);
    await syncAll(a, b);
    expect(await label(b)).toBe('12%');
  });
});
