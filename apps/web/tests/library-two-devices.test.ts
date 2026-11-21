/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP7a: library state between two devices, against the real storage server
 * (tests/helpers/sync-harness.ts): a tag cover rule and bulk changes made on A reach B,
 * B's status:/favorite: searches find them on the server, and no stat-day or position
 * record is written by any of it.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryApi } from '$lib/library/api';
import { isCoverBlurred } from '$lib/library/cover-blur';
import {
  getAllBookStates,
  setBooksBlur,
  setBooksFavorite,
  setBooksStatus,
  type BookStateDeps
} from '$lib/sync/book-state-service';
import { getCoverRules, getTagBlurRules, setCoverRule, setTagBlur } from '$lib/sync/tag-blur';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

function deps(device: Device): BookStateDeps {
  return { getEngine: async () => device.engine, today: () => '2026-11-10', warn: () => {} };
}

describe('library state between two devices (real server)', () => {
  const server = new TestServer();
  const books: string[] = [];
  let tokens: string[] = [];
  let a: Device;
  let b: Device;

  beforeAll(async () => {
    for (let i = 0; i < 3; i += 1) {
      const seeded = seedServer(server, 2, { catalog: true });
      books.push(seeded.bookId);
      tokens = tokens.concat(seeded.tokens);
    }
    await server.start();
    a = new Device('A', tokens[0], server);
    b = new Device('B', tokens[1], server);
    await a.open();
    await b.open();
    await a.sync();
    await b.sync();
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('a tag rule and bulk changes on A reach B and its searches', async () => {
    const [book1, book2, book3] = books;
    await setTagBlur(a.engine, 'ホラー', true);
    // 2026-11-21: an author rule reaches the other device the same way.
    await setCoverRule(a.engine, 'author', '著者 二', true);
    expect(await setBooksFavorite([book1, book2], true, deps(a))).toEqual([]);
    expect(await setBooksStatus([book2, book3], 'reading', deps(a))).toEqual([]);
    expect(await setBooksBlur([book3], 'never', deps(a))).toEqual([]);
    await a.sync();
    await b.sync();

    const rules = await getCoverRules(b.engine);
    expect([...rules.tags]).toEqual(['ホラー']);
    expect([...rules.authors]).toEqual(['著者 二']);
    const ctx = { rules, fallback: 'rules' as const };
    const states = await getAllBookStates(deps(b));
    expect(isCoverBlurred(states.get(book1)?.blur, { id: book1, tags: ['ホラー'] }, ctx)).toBe(
      true
    );
    expect(isCoverBlurred(states.get(book3)?.blur, { id: book3, tags: ['ホラー'] }, ctx)).toBe(
      false
    );
    const byAuthor = { id: book2, tags: [], authors: [{ name: '著者 二' }] };
    expect(isCoverBlurred(states.get(book2)?.blur, byAuthor, ctx)).toBe(true);

    const api = new LibraryApi(server.url, tokens[1]);
    const ids = async (q: string) => (await api.books({ q })).books.map((x) => x.id).sort();
    expect(await ids('favorite:yes')).toEqual([book1, book2].sort());
    expect(await ids('status:reading')).toEqual([book2, book3].sort());
    expect(await ids('status:reading favorite:yes')).toEqual([book2]);
    expect(await ids('-status:reading')).toEqual([book1]);
    expect(await ids('status:unread')).toEqual([book1]);

    // Nothing here writes reading data.
    for (const device of [a, b]) {
      const kinds = new Set(
        (await Promise.all(books.map((id) => device.engine.getForBook(id))))
          .flat()
          .map((r) => r.kind)
      );
      expect(kinds.has('stat-day')).toBe(false);
      expect(kinds.has('position')).toBe(false);
    }
  });

  it('removing the rule on B reaches A', async () => {
    await setTagBlur(b.engine, 'ホラー', false);
    await b.sync();
    await a.sync();
    expect((await getTagBlurRules(a.engine)).size).toBe(0);
  });
});
