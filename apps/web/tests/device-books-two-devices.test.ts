/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP15e: "On this device" between devices, against the real storage server
 * (tests/helpers/sync-harness.ts):
 * - each device publishes its own "device-books" record; the server answers on:device,
 *   the built-in "On this device" card and its count for the device that asks;
 * - a device can't write another device's list (owner record);
 * - removing a book from a device's list takes it out of that device's answer only;
 * - -on:device is the rest of the library;
 * - nothing here writes stat-day or position records.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryApi } from '$lib/library/api';
import {
  DEVICE_BOOKS_KIND,
  deviceBookIds,
  localIdsOfBook,
  sameBookIds
} from '$lib/library/device-books';
import type { CalibreLink } from '$lib/library/library-db';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

async function onDeviceIds(api: LibraryApi, q = 'on:device'): Promise<string[]> {
  return (await api.books({ q, limit: 50 })).books.map((b) => b.id).sort();
}

describe('"On this device" between devices (real server)', () => {
  const server = new TestServer();
  const books: string[] = [];
  let tokens: string[] = [];
  let a: Device;
  let b: Device;
  let apiA: LibraryApi;
  let apiB: LibraryApi;

  beforeAll(async () => {
    for (let i = 0; i < 4; i += 1) {
      const seeded = seedServer(server, 1, { catalog: true });
      books.push(seeded.bookId);
      tokens = tokens.concat(seeded.tokens);
    }
    await server.start();
    a = new Device('A', tokens[0], server);
    b = new Device('B', tokens[1], server);
    await a.open();
    await b.open();
    // Registers both devices (their tokens get bound to them).
    await syncAll(a, b);
    apiA = new LibraryApi(server.url, tokens[0]);
    apiB = new LibraryApi(server.url, tokens[1]);
  }, 120_000);

  afterAll(async () => {
    await server.stop();
  });

  it('matches nothing before a device has published its list', async () => {
    expect(await onDeviceIds(apiA)).toEqual([]);
    expect(await apiA.count({ q: 'on:device' })).toBe(0);
  });

  it('answers on:device, its count and the built-in card for the device that asks', async () => {
    await a.engine.put(DEVICE_BOOKS_KIND, a.engine.deviceId, { bookIds: [books[0], books[1]] });
    await b.engine.put(DEVICE_BOOKS_KIND, b.engine.deviceId, { bookIds: [books[2]] });
    await syncAll(a, b);

    expect(await onDeviceIds(apiA)).toEqual([books[0], books[1]].sort());
    expect(await onDeviceIds(apiB)).toEqual([books[2]]);
    expect(await apiA.count({ q: 'on:device' })).toBe(2);
    expect(await apiB.count({ q: 'on:device' })).toBe(1);
    // The rest of the library.
    expect(await onDeviceIds(apiA, '-on:device')).toEqual([books[2], books[3]].sort());

    const cardsA = new Map((await apiA.collectionCards()).cards.map((c) => [c.id, c]));
    const cardsB = new Map((await apiB.collectionCards()).cards.map((c) => [c.id, c]));
    expect(cardsA.get('on-device')).toMatchObject({ builtin: true, query: 'on:device' });
    expect(cardsA.get('on-device')?.bookCount).toBe(2);
    expect(cardsB.get('on-device')?.bookCount).toBe(1);
    // As a scope (Home row, the Library inside the built-in).
    expect((await apiB.books({ scope: 'on:device', limit: 10 })).books.map((x) => x.id)).toEqual([
      books[2]
    ]);
  });

  it("refuses a device writing another device's list", async () => {
    await b.engine.put(DEVICE_BOOKS_KIND, a.engine.deviceId, { bookIds: [books[3]] });
    await syncAll(a, b);
    expect((await b.engine.rejectedChanges()).map((r) => r.change.kind)).toContain(
      DEVICE_BOOKS_KIND
    );
    expect(await onDeviceIds(apiA)).toEqual([books[0], books[1]].sort());
  });

  it("takes a removed book out of that device's answer only", async () => {
    await a.engine.put(DEVICE_BOOKS_KIND, a.engine.deviceId, { bookIds: [books[1]] });
    await syncAll(a, b);
    expect(await onDeviceIds(apiA)).toEqual([books[1]]);
    expect(await onDeviceIds(apiB)).toEqual([books[2]]);
    const cardsA = new Map((await apiA.collectionCards()).cards.map((c) => [c.id, c]));
    expect(cardsA.get('on-device')?.bookCount).toBe(1);
  });

  it('wrote no stat-day or position records', async () => {
    for (const device of [a, b]) {
      expect(await device.engine.getAll('stat-day')).toEqual([]);
      expect(await device.engine.getAll('position')).toEqual([]);
    }
  });
});

describe('device-books helpers', () => {
  const link = (bookId: string, localId: number) => ({ bookId, localId }) as CalibreLink;

  it('lists library books whose local copy still exists, sorted and unique', () => {
    const links = [link('b', 2), link('a', 1), link('c', 3), link('a', 4)];
    expect(deviceBookIds(links, new Set([1, 2, 4]))).toEqual(['a', 'b']);
    expect(localIdsOfBook(links, new Set([1, 2, 4]), 'a')).toEqual([1, 4]);
    expect(localIdsOfBook(links, new Set([2]), 'a')).toEqual([]);
  });

  it('writes only when the list changed', () => {
    expect(sameBookIds(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameBookIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameBookIds(undefined, [])).toBe(false);
  });
});
