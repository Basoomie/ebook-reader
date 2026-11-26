/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CollectionItem } from '$lib/collections/collections';
import { LibraryApiError } from '$lib/library/api';
import { parseQuery } from '$lib/library/query/parse';
import type { CatalogBookDetail } from '$lib/library/types';
import type { BookState } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';
import { foldForSearch, matchesQuery } from './match';
import { collage, OfflineCatalog, openedOrder, type OfflineData } from './offline-catalog';
import { bookComparator, compareCodePoints, groupComparator } from './sort';

let added = 1000;

function book(id: string, over: Partial<CatalogBookDetail> = {}): CatalogBookDetail {
  added += 10;
  return {
    id,
    libraryId: 'lib1',
    title: `Title ${id}`,
    titleSort: null,
    authorSort: null,
    authors: [],
    series: null,
    tags: [],
    addedAt: added,
    charCount: 1000,
    charCountStatus: 'counted',
    missing: false,
    thumbnail: `blob:${id}`,
    source: 'calibre',
    publisher: null,
    publishedAt: null,
    description: null,
    sources: [],
    ...over
  };
}

function state(bookId: string, over: Partial<BookState>): BookState {
  return {
    bookId,
    status: 'unread',
    statusAuto: false,
    favorite: false,
    blur: 'inherit',
    readThroughs: [],
    ...over
  };
}

function position(bookId: string, updatedAt: number, deletedAt: number | null = null): LocalRecord {
  return {
    kind: 'position',
    id: `${bookId}:dev`,
    bookId,
    deviceId: 'dev',
    updatedAt,
    deletedAt,
    rev: 1,
    data: { charPos: 1, progress: 0.1 }
  } as LocalRecord;
}

function data(over: Partial<OfflineData> = {}): OfflineData {
  return {
    books: [],
    libraries: [],
    states: new Map(),
    positions: [],
    collections: [],
    items: new Map(),
    ...over
  };
}

const ctx = (
  states = new Map<string, BookState>(),
  device = () => true,
  audio: (id: string) => boolean = () => false
) => ({
  states,
  onDevice: device,
  audioOnDevice: audio
});

function q(text: string) {
  const parsed = parseQuery(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.query;
}

describe('offline search terms', () => {
  const b = book('a', {
    title: 'ＧＪ部 第２０巻',
    authors: [
      { name: '著者一', sort: 'ちょしゃいち' },
      { name: 'Co Author', sort: 'Author, Co' }
    ],
    series: { name: '月と灯台', index: 3 },
    tags: ['ホラー', 'SF']
  });

  it('folds width and case like the server', () => {
    expect(foldForSearch('ＧＪ部')).toBe('gj部');
    // A kana with a separate (combining) voiced mark, as 178 names in the real library.
    expect(foldForSearch('て' + String.fromCharCode(0x3099))).toBe(foldForSearch('で'));
    expect(matchesQuery(b, q('gj'), ctx())).toBe(true);
    expect(matchesQuery(b, q('20巻'), ctx())).toBe(true);
    expect(matchesQuery(b, q('ｇｊ部'), ctx())).toBe(true);
  });

  it('plain text looks at title, series and authors, not tags', () => {
    expect(matchesQuery(b, q('灯台'), ctx())).toBe(true);
    expect(matchesQuery(b, q('co author'), ctx())).toBe(true);
    expect(matchesQuery(b, q('ホラー'), ctx())).toBe(false);
  });

  it('fields, exact and any-of', () => {
    expect(matchesQuery(b, q('author:著者'), ctx())).toBe(true);
    expect(matchesQuery(b, q('author:=著者'), ctx())).toBe(false);
    expect(matchesQuery(b, q('author:=著者一'), ctx())).toBe(true);
    expect(matchesQuery(b, q('tag:sf'), ctx())).toBe(true);
    expect(matchesQuery(b, q('tag:x,ホラ'), ctx())).toBe(true);
    expect(matchesQuery(b, q('tag:x tag:ホラ'), ctx())).toBe(false);
    expect(matchesQuery(b, q('series:=月と灯台'), ctx())).toBe(true);
  });

  it('matches illustrators: the illustrator: field and plain text', () => {
    const drawn = book('i', {
      title: '本',
      authors: [{ name: '著者', sort: null }],
      illustrators: ['あずーる', 'ＢＢ画伯']
    });
    expect(matchesQuery(drawn, q('illustrator:bb画伯'), ctx())).toBe(true);
    expect(matchesQuery(drawn, q('illustrator:="あずーる"'), ctx())).toBe(true);
    expect(matchesQuery(drawn, q('illustrator:著者'), ctx())).toBe(false);
    expect(matchesQuery(drawn, q('author:あずーる'), ctx())).toBe(false);
    expect(matchesQuery(drawn, q('あずーる'), ctx())).toBe(true);
    expect(matchesQuery(drawn, q('-illustrator:あずーる'), ctx())).toBe(false);
    // A copy stored before illustrators were sent has none.
    const old = book('o', { illustrators: undefined });
    expect(matchesQuery(old, q('illustrator:x'), ctx())).toBe(false);
    expect(matchesQuery(old, q('-illustrator:x'), ctx())).toBe(true);
  });

  it('patterns run on the original text', () => {
    expect(matchesQuery(b, q('/ＧＪ/'), ctx())).toBe(true);
    expect(matchesQuery(b, q('/gj/i'), ctx())).toBe(false);
    expect(matchesQuery(b, q('author:/^Co/'), ctx())).toBe(true);
  });

  it('negation keeps books without the field', () => {
    const plain = book('p');
    expect(matchesQuery(plain, q('-series:月'), ctx())).toBe(true);
    expect(matchesQuery(plain, q('-author:著者'), ctx())).toBe(true);
    expect(matchesQuery(b, q('-series:月'), ctx())).toBe(false);
  });

  it('books without a count never match chars:, also negated', () => {
    const none = book('n', { charCount: null });
    expect(matchesQuery(none, q('chars:<5000'), ctx())).toBe(false);
    expect(matchesQuery(none, q('-chars:<5000'), ctx())).toBe(false);
    expect(matchesQuery(b, q('chars:500-1000'), ctx())).toBe(true);
    expect(matchesQuery(b, q('-chars:>1000'), ctx())).toBe(true);
    expect(matchesQuery(b, q('chars:>1000'), ctx())).toBe(false);
  });

  it('level: the Natively level; books without one never match, also negated', () => {
    const none = book('n');
    const easy = book('e', { nativelyLevel: { level: 18, temporary: true } });
    const hard = book('h', { nativelyLevel: { level: 31, temporary: false } });
    expect(matchesQuery(none, q('level:<40'), ctx())).toBe(false);
    expect(matchesQuery(none, q('-level:<40'), ctx())).toBe(false);
    expect(matchesQuery(easy, q('level:<20'), ctx())).toBe(true);
    expect(matchesQuery(hard, q('level:<20'), ctx())).toBe(false);
    expect(matchesQuery(hard, q('-level:<20'), ctx())).toBe(true);
    expect(matchesQuery(hard, q('level:30-35'), ctx())).toBe(true);
  });

  it('rating:, ratings:, readers:, myrating: as the server compares them; no value never matches', () => {
    const none = book('n');
    const good = book('g', { storeRating: { avg: 4.6, count: 300, score: 4569 }, readers: 1500 });
    const few = book('f', { storeRating: { avg: 5, count: 3, score: 4217 }, rating: 8 });
    expect(matchesQuery(none, q('rating:>=1'), ctx())).toBe(false);
    expect(matchesQuery(none, q('-rating:>=4'), ctx())).toBe(false);
    expect(matchesQuery(good, q('rating:>=4.5'), ctx())).toBe(true);
    expect(matchesQuery(good, q('rating:4'), ctx())).toBe(true);
    expect(matchesQuery(few, q('rating:4'), ctx())).toBe(false);
    expect(matchesQuery(few, q('-rating:4'), ctx())).toBe(true);
    expect(matchesQuery(good, q('ratings:>=100'), ctx())).toBe(true);
    expect(matchesQuery(few, q('ratings:>=100'), ctx())).toBe(false);
    expect(matchesQuery(good, q('readers:>=1k'), ctx())).toBe(true);
    expect(matchesQuery(few, q('readers:>=1'), ctx())).toBe(false);
    expect(matchesQuery(few, q('myrating:4'), ctx())).toBe(true);
    expect(matchesQuery(good, q('-myrating:4'), ctx())).toBe(false);
    // The Rating sort uses the score (few ratings pulled toward the middle), books without last.
    expect(
      [few, none, good].sort(bookComparator({ key: 'rating', dir: 'desc' })).map((x) => x.id)
    ).toEqual(['g', 'f', 'n']);
    expect(
      [few, none, good].sort(bookComparator({ key: 'ratings', dir: 'asc' })).map((x) => x.id)
    ).toEqual(['f', 'g', 'n']);
  });

  it('sorts by the day completed, books without one last in either direction', () => {
    const [few, none, good] = [{ id: 'f' }, { id: 'n' }, { id: 'g' }] as never[];
    const day: Record<string, number | null> = {
      f: Date.parse('2026-01-05T00:00:00Z') / 1000,
      g: Date.parse('2026-03-01T00:00:00Z') / 1000,
      n: null
    };
    const at = (id: string) => day[id];
    const order = (dir: 'asc' | 'desc') =>
      [few, none, good]
        .sort(bookComparator({ key: 'completed', dir }, at))
        .map((x: { id: string }) => x.id);
    expect(order('desc')).toEqual(['g', 'f', 'n']);
    expect(order('asc')).toEqual(['f', 'g', 'n']);
  });

  it('status and favorite from the local records; no record = unread', () => {
    const states = new Map([['a', state('a', { status: 'reading', favorite: true })]]);
    const other = book('o');
    expect(matchesQuery(b, q('status:reading'), ctx(states))).toBe(true);
    expect(matchesQuery(other, q('status:unread'), ctx(states))).toBe(true);
    expect(matchesQuery(other, q('status:unread,completed'), ctx(states))).toBe(true);
    expect(matchesQuery(b, q('-status:reading'), ctx(states))).toBe(false);
    expect(matchesQuery(b, q('favorite:yes'), ctx(states))).toBe(true);
    expect(matchesQuery(other, q('favorite:no'), ctx(states))).toBe(true);
  });

  it('on:device', () => {
    expect(
      matchesQuery(
        b,
        q('on:device'),
        ctx(undefined, () => true)
      )
    ).toBe(true);
    expect(
      matchesQuery(
        b,
        q('-on:device'),
        ctx(undefined, () => true)
      )
    ).toBe(false);
  });

  it('on:audio (Season 2 Phase 9)', () => {
    const audioOf = (id: string) => id === 'a';
    expect(
      matchesQuery(
        b,
        q('on:audio'),
        ctx(undefined, () => true, audioOf)
      )
    ).toBe(true);
    expect(
      matchesQuery(
        b,
        q('-on:audio'),
        ctx(undefined, () => true, audioOf)
      )
    ).toBe(false);
    const other = book('z', { title: 'other' });
    expect(
      matchesQuery(
        other,
        q('on:audio'),
        ctx(undefined, () => true, audioOf)
      )
    ).toBe(false);
    expect(
      matchesQuery(
        other,
        q('on:device -on:audio'),
        ctx(undefined, () => true, audioOf)
      )
    ).toBe(true);
  });
});

describe('offline sorts', () => {
  it('compares by code point, not UTF-16 unit', () => {
    // U+FF21 (Ａ) is a single unit above the surrogate pair of U+1F600.
    expect(compareCodePoints('Ａ', '\u{1f600}')).toBe(-1);
    expect('Ａ' < '\u{1f600}').toBe(false);
    expect(compareCodePoints('ab', 'a')).toBe(1);
  });

  it('puts books without a value last in both directions; ties by id', () => {
    const x = book('x', { charCount: null, authorSort: null, publishedAt: null });
    const y = book('y', { charCount: 5, authorSort: 'b', publishedAt: 10 });
    const z = book('z', { charCount: 9, authorSort: 'a', publishedAt: 20 });
    const ids = (key: 'chars' | 'author' | 'published', dir: 'asc' | 'desc') =>
      [x, y, z].sort(bookComparator({ key, dir })).map((b) => b.id);
    expect(ids('chars', 'asc')).toEqual(['y', 'z', 'x']);
    expect(ids('chars', 'desc')).toEqual(['z', 'y', 'x']);
    // A count of 0 (a failed count) sorts with the books not counted.
    const w = book('w', { charCount: 0 });
    expect(
      [w, x, y, z].sort(bookComparator({ key: 'chars', dir: 'asc' })).map((b) => b.id)
    ).toEqual(['y', 'z', 'w', 'x']);
    expect(
      [w, x, y, z].sort(bookComparator({ key: 'chars', dir: 'desc' })).map((b) => b.id)
    ).toEqual(['z', 'y', 'w', 'x']);
    expect(ids('author', 'asc')).toEqual(['z', 'y', 'x']);
    expect(ids('author', 'desc')).toEqual(['y', 'z', 'x']);
    expect(ids('published', 'desc')).toEqual(['z', 'y', 'x']);
    const t1 = book('t1', { title: 'B', titleSort: 'A' });
    const t2 = book('t2', { title: 'A', titleSort: 'A' });
    expect([t1, t2].sort(bookComparator({ key: 'title', dir: 'asc' })).map((b) => b.id)).toEqual([
      't1',
      't2'
    ]);
    expect([t1, t2].sort(bookComparator({ key: 'title', dir: 'desc' })).map((b) => b.id)).toEqual([
      't2',
      't1'
    ]);
  });

  it('groups: "No series" last; ties by name', () => {
    const rows = [
      { name: null, bookCount: 9, newestAddedAt: 9 },
      { name: 'b', bookCount: 2, newestAddedAt: 5 },
      { name: 'a', bookCount: 2, newestAddedAt: 5 }
    ];
    expect([...rows].sort(groupComparator()).map((r) => r.name)).toEqual(['a', 'b', null]);
    expect(
      [...rows].sort(groupComparator({ key: 'name', dir: 'desc' })).map((r) => r.name)
    ).toEqual(['b', 'a', null]);
  });
});

describe('collage order', () => {
  it('opened books, then one first volume per series, then the newest', () => {
    const s1 = book('s1v2', { series: { name: 'S1', index: 2 } });
    const s1v1 = book('s1v1', { series: { name: 'S1', index: 1 } });
    const plain = book('plain');
    const s2 = book('s2v1', { series: { name: 'S2', index: null } });
    const opened = openedOrder([position('plain', 5), position('s2v1', 1, 9)]);
    expect(opened).toEqual(['plain']);
    expect(collage([s1, s1v1, plain, s2], opened)).toEqual(['plain', 's2v1', 's1v1', 's1v2']);
  });
});

describe('OfflineCatalog', () => {
  const s3 = book('s3', {
    series: { name: '月と灯台', index: 3 },
    authors: [{ name: 'A', sort: 'a' }]
  });
  const s1 = book('s1', {
    series: { name: '月と灯台', index: 1 },
    authors: [{ name: 'A', sort: 'a' }]
  });
  const s0 = book('s0', {
    series: { name: '月と灯台', index: null },
    authors: [{ name: 'B', sort: 'b' }]
  });
  const other = book('o', { libraryId: 'lib2', tags: ['t'], authors: [{ name: 'A', sort: 'a' }] });
  const gone = book('gone', { missing: true });
  const items = new Map<string, CollectionItem[]>([
    [
      'list1',
      [
        { collectionId: 'list1', bookId: 'o', key: 'a' },
        { collectionId: 'list1', bookId: 's1', key: 'b' },
        { collectionId: 'list1', bookId: 'gone', key: 'c' }
      ]
    ]
  ]);
  const catalog = new OfflineCatalog(async () =>
    data({
      books: [s3, s1, s0, other, gone],
      states: new Map([['s1', state('s1', { status: 'completed' })]]),
      collections: [
        { id: 'list1', name: 'L', type: 'manual', query: null, updatedAt: 1 },
        { id: 'smart1', name: 'S', type: 'smart', query: 'status:completed', updatedAt: 1 },
        { id: 'bad', name: 'B', type: 'smart', query: '/usr/bin', updatedAt: 1 }
      ],
      items
    })
  );

  it('lists newest first without missing books, with paging', async () => {
    const first = await catalog.books({ limit: 2 });
    expect(first.books.map((b) => b.id)).toEqual(['o', 's0']);
    expect(first.books[0]).not.toHaveProperty('description');
    const second = await catalog.books({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.books.map((b) => b.id)).toEqual(['s1', 's3']);
    expect(second.nextCursor).toBeNull();
    expect(await catalog.count({})).toBe(4);
    expect(await catalog.count({ library: 'lib2' })).toBe(1);
  });

  it('a series in series order (no index first), unless sorted', async () => {
    const group = { by: 'series' as const, name: '月と灯台' };
    expect((await catalog.books({ group })).books.map((b) => b.id)).toEqual(['s0', 's1', 's3']);
    const sorted = await catalog.books({ group, sort: { key: 'added', dir: 'asc' } });
    expect(sorted.books.map((b) => b.id)).toEqual(['s3', 's1', 's0']);
    expect(
      (await catalog.books({ group: { by: 'series', name: null } })).books.map((b) => b.id)
    ).toEqual(['o']);
    expect(
      (await catalog.books({ group: { by: 'author', name: 'A' } })).books.map((b) => b.id)
    ).toEqual(['o', 's1', 's3']);
  });

  it('scopes, manual collections and lookups', async () => {
    expect((await catalog.books({ scope: 'status:completed' })).books.map((b) => b.id)).toEqual([
      's1'
    ]);
    expect(
      (await catalog.books({ collection: 'list1', sort: { key: 'title', dir: 'asc' } })).books.map(
        (b) => b.id
      )
    ).toEqual(['o', 's1']);
    expect((await catalog.lookup(['s1', 'gone', 'o', 's1'])).books.map((b) => b.id)).toEqual([
      's1',
      'o'
    ]);
    expect((await catalog.lookup(['s1', 'o'], 'author:A -tag:t')).books.map((b) => b.id)).toEqual([
      's1'
    ]);
    expect((await catalog.lookupIncludingMissing(['gone'])).books[0].missing).toBe(true);
  });

  it('a search that does not parse is invalid_query with its span', async () => {
    await expect(catalog.books({ q: '/usr/bin' })).rejects.toMatchObject({
      code: 'invalid_query',
      status: 422
    });
    const error = await catalog.count({ q: 'chars:>' }).catch((e) => e);
    expect(error).toBeInstanceOf(LibraryApiError);
    expect(error.span).toBeDefined();
  });

  it('groups with whole-group numbers of this device and the name filter', async () => {
    const series = await catalog.groups({ by: 'series' });
    expect(series.groups.map((g) => g.name)).toEqual(['月と灯台', null]);
    expect(series.total).toBe(2);
    expect(series.groups[0]).toMatchObject({
      bookCount: 3,
      bookIds: ['s0', 's1', 's3'],
      cover: { bookId: 's0' },
      chars: { total: 3000, counted: 3, pending: 0, failed: 0 }
    });
    const authors = await catalog.groups({ by: 'author', q: 'author:A' });
    expect(authors.groups.map((g) => g.name)).toEqual(['A']);
    // A matching book lists every group it is in, unless the term names the field.
    expect(
      (await catalog.groups({ by: 'author', q: '月' })).groups.map((g) => g.name).sort()
    ).toEqual(['A', 'B']);
    const byCount = await catalog.groups({ by: 'author', sort: { key: 'count', dir: 'desc' } });
    expect(byCount.groups.map((g) => [g.name, g.bookCount])).toEqual([
      ['A', 3],
      ['B', 1]
    ]);
    expect((await catalog.groups({ by: 'tag' })).groups.map((g) => g.name)).toEqual(['t']);
    const paged = await catalog.groups({ by: 'series', limit: 1 });
    expect(paged.nextCursor).not.toBeNull();
  });

  it("a collection's groups count only its books (2026-11-24)", async () => {
    // Manual: o and s1 (gone is missing).
    const series = await catalog.groups({ by: 'series', collection: 'list1' });
    expect(series.groups.map((g) => [g.name, g.bookCount])).toEqual([
      ['月と灯台', 1],
      [null, 1]
    ]);
    expect(series.groups[0]).toMatchObject({ bookIds: ['s1'], cover: { bookId: 's1' } });
    expect(
      (await catalog.groups({ by: 'author', collection: 'list1' })).groups.map((g) => [
        g.name,
        g.bookCount
      ])
    ).toEqual([['A', 2]]);
    // Smart: status:completed is s1 only.
    const smart = await catalog.groups({ by: 'author', scope: 'status:completed' });
    expect(smart.groups.map((g) => [g.name, g.bookCount])).toEqual([['A', 1]]);
    expect((await catalog.groups({ by: 'tag', scope: 'status:completed' })).total).toBe(0);
  });

  it('collection cards: built-ins, smart and manual, with errors per card', async () => {
    const { cards } = await catalog.collectionCards();
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get('completed')?.bookCount).toBe(1);
    expect(byId.get('unread')?.bookCount).toBe(3);
    expect(byId.get('on-device')?.bookCount).toBe(4);
    expect(byId.get('smart1')).toMatchObject({ bookCount: 1, tiles: [{ bookId: 's1' }] });
    expect(byId.get('list1')).toMatchObject({ bookCount: 2 });
    expect(byId.get('bad')?.error?.code).toBe('invalid_query');
    expect(cards.slice(0, 6).every((c) => c.builtin)).toBe(true);
  });

  it('details of a book on this device; a refusal otherwise', async () => {
    expect((await catalog.book('gone')).missing).toBe(true);
    await expect(catalog.book('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('honours an aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(catalog.books({}, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted'
    });
  });
});

describe('OfflineCatalog reads', () => {
  it("reads the device once for a page's requests, again after invalidate", async () => {
    let titles = ['one'];
    const load = vi.fn(async () => data({ books: titles.map((t) => book(t)) }));
    const catalog = new OfflineCatalog(load);
    await Promise.all([catalog.books({}), catalog.count({})]);
    await catalog.groups({ by: 'author' });
    await catalog.count({ q: 'one' });
    expect(load).toHaveBeenCalledTimes(1);
    titles = ['one', 'two'];
    expect(await catalog.count({})).toBe(1);
    catalog.invalidate();
    expect(await catalog.count({})).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not keep a read that started before invalidate', async () => {
    const answers: ((d: OfflineData) => void)[] = [];
    const load = vi.fn(() => new Promise<OfflineData>((resolve) => answers.push(resolve)));
    const catalog = new OfflineCatalog(load);
    const before = catalog.count({});
    catalog.invalidate();
    const after = catalog.count({});
    expect(load).toHaveBeenCalledTimes(2);
    answers[0](data({ books: [book('old')] }));
    answers[1](data({ books: [book('a'), book('b')] }));
    expect(await before).toBe(1);
    expect(await after).toBe(2);
    expect(await catalog.count({})).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads again after a failed read', async () => {
    const load = vi
      .fn<() => Promise<OfflineData>>()
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValue(data({ books: [book('x')] }));
    const catalog = new OfflineCatalog(load);
    await expect(catalog.count({})).rejects.toThrow('blocked');
    expect(await catalog.count({})).toBe(1);
  });
});

describe('OfflineCatalog.names (search suggestions)', () => {
  it('counts names of the visible books and ranks them like the server', async () => {
    const catalog = new OfflineCatalog(async () =>
      data({
        books: [
          book('a', { tags: ['SF', 'ハードSF'] }),
          book('b', { tags: ['SF'], illustrators: ['しの', 'しの'] }),
          book('c', { tags: ['SF'], libraryId: 'lib2' }),
          book('d', { tags: ['SF'], missing: true })
        ]
      })
    );
    expect(await catalog.names({ field: 'tag', text: 'sf' })).toEqual([
      { name: 'SF', count: 3 },
      { name: 'ハードSF', count: 1 }
    ]);
    expect(await catalog.names({ field: 'tag', text: '', library: 'lib2' })).toEqual([
      { name: 'SF', count: 1 }
    ]);
    expect(await catalog.names({ field: 'illustrator', text: '' })).toEqual([
      { name: 'しの', count: 1 }
    ]);
  });
});
