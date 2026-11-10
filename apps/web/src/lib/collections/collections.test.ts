/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openSyncDb, type LocalRecord } from '$lib/sync/sync-db';
import { SyncEngine } from '$lib/sync/sync-engine';
import {
  checkName,
  checkQuery,
  COLLECTION_ITEM_KIND,
  itemsByCollection,
  placeAt,
  type CollectionItem
} from './collections';
import {
  addBooks,
  collectionsOfBook,
  CollectionError,
  createCollection,
  deleteCollection,
  getCollectionsView,
  moveBookBy,
  moveBooks,
  removeBooks,
  renameCollection,
  setCollectionQuery,
  viewFrom,
  type CollectionsDeps
} from './collections-service';
import { DIGITS, evenKeys, isOrderKey, keyBetween, MAX_KEY_LENGTH } from './order-key';

/** A small deterministic random source. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('order keys', () => {
  it('makes keys strictly between their neighbours', () => {
    const random = seeded(7);
    const pairs: [string | null, string | null][] = [
      [null, null],
      [null, 'V'],
      ['V', null],
      ['V', 'W'],
      ['V', 'V1'],
      ['0x', '1'],
      ['z', null],
      ['zz', null],
      [null, '01'],
      ['a', 'a01']
    ];
    for (const [a, b] of pairs) {
      for (let i = 0; i < 20; i++) {
        const k = keyBetween(a, b, random);
        expect(isOrderKey(k), `${a} ${b} -> ${k}`).toBe(true);
        if (a !== null) expect(k > a, `${k} > ${a}`).toBe(true);
        if (b !== null) expect(k < b, `${k} < ${b}`).toBe(true);
      }
    }
  });

  it('refuses equal or reversed neighbours', () => {
    expect(() => keyBetween('V', 'V')).toThrow();
    expect(() => keyBetween('W', 'V')).toThrow();
  });

  it('stays short when adding at the end or the start again and again', () => {
    const random = seeded(3);
    let last: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const k = keyBetween(last, null, random);
      if (last !== null) expect(k > last).toBe(true);
      last = k;
    }
    expect(last!.length).toBeLessThan(40);
    let first: string | null = null;
    for (let i = 0; i < 100; i++) {
      const k = keyBetween(null, first, random);
      if (first !== null) expect(k < first).toBe(true);
      first = k;
    }
    expect(first!.length).toBeLessThan(MAX_KEY_LENGTH);
  });

  it('spreads fresh keys evenly', () => {
    for (const n of [1, 2, 61, 62, 63, 500, 4000]) {
      const keys = evenKeys(n);
      expect(keys).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        expect(isOrderKey(keys[i])).toBe(true);
        if (i > 0) expect(keys[i] > keys[i - 1]).toBe(true);
      }
    }
    expect(DIGITS.split('').sort().join('')).toBe(DIGITS);
  });
});

const item = (bookId: string, key: string): CollectionItem => ({ collectionId: 'c', bookId, key });

function apply(items: CollectionItem[], writes: { bookId: string; key: string }[]): string[] {
  const map = new Map(items.map((i) => [i.bookId, i]));
  for (const w of writes) map.set(w.bookId, item(w.bookId, w.key));
  return [...map.values()]
    .sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.bookId < b.bookId ? -1 : 1))
    .map((i) => i.bookId);
}

describe('placing books', () => {
  const list = [item('a', 'G'), item('b', 'V'), item('c', 'k')];

  it('places books at any index with one write per book', () => {
    for (const [index, order] of [
      [0, ['x', 'a', 'b', 'c']],
      [1, ['a', 'x', 'b', 'c']],
      [3, ['a', 'b', 'c', 'x']],
      [9, ['a', 'b', 'c', 'x']]
    ] as const) {
      const writes = placeAt(list, ['x'], index, seeded());
      expect(writes).toHaveLength(1);
      expect(apply(list, writes)).toEqual(order);
    }
    expect(apply(list, placeAt(list, ['x', 'y'], 1, seeded()))).toEqual(['a', 'x', 'y', 'b', 'c']);
  });

  it('separates equal keys before placing between them', () => {
    // Two devices added b and c at the same key offline: ordered by book id.
    const equal = [item('a', 'G'), item('b', 'V'), item('c', 'V'), item('d', 'k')];
    const writes = placeAt(equal, ['x'], 2, seeded());
    expect(apply(equal, writes)).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(writes.map((w) => w.bookId)).toEqual(['x', 'c']);
  });

  it('gives the whole list fresh keys when keys get long', () => {
    let items = [item('a', 'V'), item('b', 'W')];
    // Always between the first two books: keys grow until the list is renumbered.
    let renumbered = false;
    for (let i = 0; i < 2000 && !renumbered; i++) {
      const id = `n${i}`;
      const writes = placeAt(items, [id], 1, seeded(i + 1));
      renumbered = writes.length > 1;
      const order = apply(items, writes);
      expect(order[1]).toBe(id);
      const keys = new Map(writes.map((w) => [w.bookId, w.key]));
      items = order.map((b) => item(b, keys.get(b) ?? items.find((x) => x.bookId === b)!.key));
    }
    expect(renumbered).toBe(true);
    expect(Math.max(...items.map((i) => i.key.length))).toBeLessThan(5);
  });
});

describe('checks', () => {
  it('checks names and searches', () => {
    expect(checkName('  ')).toBeTruthy();
    expect(checkName('x'.repeat(201))).toBeTruthy();
    expect(checkName(' Planned ')).toBeNull();
    expect(checkQuery('')).toBeTruthy();
    expect(checkQuery('/usr/bin')).toBeTruthy();
    expect(checkQuery('tag:SF chars:<100k')).toBeNull();
  });
});

let run = 0;
/** One clock for every test device, a millisecond per write (no equal timestamps). */
let clock = Date.UTC(2026, 10, 1);
async function setup(deviceId = '11111111-1111-4111-8111-111111111111') {
  run += 1;
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(`collections-${run}`),
    newId: () => deviceId,
    now: () => ++clock
  });
  let n = 0;
  const warnings: string[] = [];
  const deps: CollectionsDeps = {
    getEngine: async () => engine,
    warn: (m) => warnings.push(m),
    random: seeded(run),
    newId: () => `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, '0')}`
  };
  const order = async (id: string) =>
    (await getCollectionsView(deps)).items.get(id)?.map((i) => i.bookId) ?? [];
  return { engine, deps, warnings, order };
}

describe('collections service', () => {
  it('creates, renames and edits collections', async () => {
    const t = await setup();
    const list = await createCollection({ name: ' 積読 ', type: 'manual' }, t.deps);
    const smart = await createCollection({ name: 'SF', type: 'smart', query: 'tag:SF' }, t.deps);
    await expect(createCollection({ name: '', type: 'manual' }, t.deps)).rejects.toThrow(
      CollectionError
    );
    await expect(
      createCollection({ name: 'x', type: 'smart', query: '/usr/bin' }, t.deps)
    ).rejects.toThrow(CollectionError);
    await renameCollection(list, 'あとで', t.deps);
    await setCollectionQuery(smart, 'tag:SF -tag:BL', t.deps);
    await expect(setCollectionQuery(list, 'tag:SF', t.deps)).rejects.toThrow(CollectionError);
    const view = await getCollectionsView(t.deps);
    expect(view.collections.map((c) => [c.name, c.type, c.query])).toEqual([
      ['SF', 'smart', 'tag:SF -tag:BL'],
      ['あとで', 'manual', null]
    ]);
    const record = await t.engine.get('collection', list);
    expect(record?.data).toEqual({ name: 'あとで', type: 'manual' });
  });

  it('adds at the end in order, keeps existing places, removes and moves', async () => {
    const t = await setup();
    const id = await createCollection({ name: 'Q', type: 'manual' }, t.deps);
    expect(await addBooks(id, ['b1', 'b2', 'b3'], t.deps)).toEqual([]);
    await addBooks(id, ['b4', 'b2', 'b4'], t.deps);
    expect(await t.order(id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    await moveBooks(id, ['b4'], 0, t.deps);
    expect(await t.order(id)).toEqual(['b4', 'b1', 'b2', 'b3']);
    await moveBookBy(id, 'b1', 1, t.deps);
    expect(await t.order(id)).toEqual(['b4', 'b2', 'b1', 'b3']);
    await moveBookBy(id, 'b4', -1, t.deps);
    expect(await t.order(id)).toEqual(['b4', 'b2', 'b1', 'b3']);
    await moveBooks(id, ['b3', 'b4'], 99, t.deps);
    expect(await t.order(id)).toEqual(['b2', 'b1', 'b3', 'b4']);
    expect(await removeBooks(id, ['b1', 'nope'], t.deps)).toEqual([]);
    expect(await t.order(id)).toEqual(['b2', 'b3', 'b4']);
    expect(await collectionsOfBook('b2', t.deps)).toEqual(new Set([id]));
    expect(await collectionsOfBook('b1', t.deps)).toEqual(new Set());
    // Added again: at the end, not at its old place.
    await addBooks(id, ['b1'], t.deps);
    expect(await t.order(id)).toEqual(['b2', 'b3', 'b4', 'b1']);
  });

  it('refuses books for a saved search and a deleted collection', async () => {
    const t = await setup();
    const smart = await createCollection({ name: 'S', type: 'smart', query: 'x' }, t.deps);
    await expect(addBooks(smart, ['b1'], t.deps)).rejects.toThrow(CollectionError);
    const list = await createCollection({ name: 'L', type: 'manual' }, t.deps);
    await addBooks(list, ['b1', 'b2'], t.deps);
    await deleteCollection(list, t.deps);
    await expect(addBooks(list, ['b3'], t.deps)).rejects.toThrow(CollectionError);
    const view = await getCollectionsView(t.deps);
    expect(view.collections.map((c) => c.name)).toEqual(['S']);
    expect(view.items.has(list)).toBe(false);
    const items = await t.engine.getAll(COLLECTION_ITEM_KIND);
    expect(items.every((r) => r.deletedAt !== null)).toBe(true);
  });

  it('writes only collection records', async () => {
    const t = await setup();
    const id = await createCollection({ name: 'Q', type: 'manual' }, t.deps);
    await addBooks(id, ['b1', 'b2'], t.deps);
    await moveBooks(id, ['b2'], 0, t.deps);
    await removeBooks(id, ['b1'], t.deps);
    await deleteCollection(id, t.deps);
    const kinds = new Set<string>();
    for (const kind of [
      'position',
      'stat-day',
      'book-status',
      'collection',
      COLLECTION_ITEM_KIND
    ]) {
      if ((await t.engine.getAll(kind)).length) kinds.add(kind);
    }
    expect(kinds).toEqual(new Set(['collection', COLLECTION_ITEM_KIND]));
  });
});

/** What two devices' item records look like after both synced (lww per record). */
function merge(...devices: LocalRecord[][]): LocalRecord[] {
  const out = new Map<string, LocalRecord>();
  for (const list of devices) {
    for (const r of list) {
      const key = `${r.kind}|${r.id}`;
      const old = out.get(key);
      if (
        !old ||
        r.updatedAt > old.updatedAt ||
        (r.updatedAt === old.updatedAt && r.deviceId > old.deviceId)
      ) {
        out.set(key, r);
      }
    }
  }
  return [...out.values()];
}

describe('two devices reordering offline (merge rule)', () => {
  it('keeps both devices moves of different books and the later move of the same book', async () => {
    const a = await setup('aaaaaaaa-0000-4000-8000-000000000001');
    const id = await createCollection({ name: 'Planned', type: 'manual' }, a.deps);
    await addBooks(id, ['b1', 'b2', 'b3', 'b4', 'b5'], a.deps);
    const shared = await a.engine.getAll(COLLECTION_ITEM_KIND);

    // Device B starts from the same records.
    const b = await setup('bbbbbbbb-0000-4000-8000-000000000002');
    for (const r of shared) {
      await b.engine.write(r.kind, r.id, r.data, { bookId: r.bookId });
    }
    await b.engine.write('collection', id, { name: 'Planned', type: 'manual' });

    // Offline: A moves b5 to the top, B moves b1 to the bottom.
    await moveBooks(id, ['b5'], 0, a.deps);
    await moveBooks(id, ['b1'], 99, b.deps);
    let merged = merge(
      await a.engine.getAll(COLLECTION_ITEM_KIND),
      await b.engine.getAll(COLLECTION_ITEM_KIND)
    );
    expect(
      itemsByCollection(merged)
        .get(id)
        ?.map((i) => i.bookId)
    ).toEqual(['b5', 'b2', 'b3', 'b4', 'b1']);

    // Both move b3; B moves later, so B's place wins.
    await moveBooks(id, ['b3'], 0, a.deps);
    await moveBooks(id, ['b3'], 99, b.deps);
    merged = merge(
      await a.engine.getAll(COLLECTION_ITEM_KIND),
      await b.engine.getAll(COLLECTION_ITEM_KIND)
    );
    const order = itemsByCollection(merged)
      .get(id)!
      .map((i) => i.bookId);
    expect(order[order.length - 1]).toBe('b3');
    expect(order.filter((x) => x !== 'b3')).toEqual(['b5', 'b2', 'b4', 'b1']);
  });

  it('keeps an add on one device and a remove on the other', async () => {
    const a = await setup('aaaaaaaa-0000-4000-8000-000000000003');
    const id = await createCollection({ name: 'Q', type: 'manual' }, a.deps);
    await addBooks(id, ['b1', 'b2'], a.deps);
    const b = await setup('bbbbbbbb-0000-4000-8000-000000000004');
    for (const r of await a.engine.getAll(COLLECTION_ITEM_KIND)) {
      await b.engine.write(r.kind, r.id, r.data, { bookId: r.bookId });
    }
    await b.engine.write('collection', id, { name: 'Q', type: 'manual' });
    await addBooks(id, ['b3'], a.deps);
    await removeBooks(id, ['b1'], b.deps);
    const merged = merge(
      await a.engine.getAll(COLLECTION_ITEM_KIND),
      await b.engine.getAll(COLLECTION_ITEM_KIND)
    );
    expect(
      viewFrom([await a.engine.get('collection', id)!].filter(Boolean) as LocalRecord[], merged)
        .items.get(id)
        ?.map((i) => i.bookId)
    ).toEqual(['b2', 'b3']);
  });
});
