/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP8a: book state between two devices, against the real storage server
 * (tests/helpers/sync-harness.ts): status, favorite, bulk completion, Start
 * over reaching the other device, and the guarantee that no existing
 * stat-day or position record is changed by a state action.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CalibreLink } from '$lib/library/library-db';
import {
  getBookState,
  markBooksCompleted,
  noteFirstPageTurn,
  noteReaderCompletion,
  pendingStartOver,
  setBookFavorite,
  setBookStatus,
  startBookOver,
  type BookStateDeps
} from '$lib/sync/book-state-service';
import { findPositionPrompt, type PositionPromptDeps } from '$lib/sync/position-prompt-service';
import { recordPosition } from '$lib/sync/record-position';
import type { LocalRecord } from '$lib/sync/sync-db';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const TOTAL = 100_000;
const LOCAL_ID = 7;
const TITLE = '薬屋のひとりごと 1';

function stateDeps(device: Device): BookStateDeps {
  return { getEngine: async () => device.engine, today: () => '2026-11-09', warn: () => {} };
}

function link(bookId: string): CalibreLink {
  return {
    bookId,
    libraryId: 'lib1',
    calibreLibraryUuid: null,
    calibreUuid: 'cal-uuid',
    calibreId: 1,
    localId: LOCAL_ID,
    title: TITLE,
    calibreTitle: TITLE,
    characters: TOTAL,
    fileEtag: null,
    linkedAt: 1,
    how: 'imported'
  };
}

/** The reader's bookmark save, as recordShadowPosition does it. */
function savePosition(device: Device, bookId: string, charPos: number) {
  return recordPosition(
    LOCAL_ID,
    TITLE,
    { exploredCharCount: charPos, progress: charPos / TOTAL },
    {
      getEngine: async () => device.engine,
      linksForLocalId: async () => [link(bookId)],
      warn: () => {}
    }
  );
}

function promptDeps(device: Device, bookId: string): PositionPromptDeps {
  return {
    getEngine: async () => device.engine,
    linksForLocalId: async () => [link(bookId)],
    isActive: async () => true,
    minChars: () => 100,
    warn: () => {}
  };
}

/** Stat-day and position records as stored: what must never change. */
async function untouchable(device: Device, bookId: string) {
  const records = await device.engine.getForBook(bookId);
  return records
    .filter((r) => r.kind === 'stat-day' || r.kind === 'position')
    .map((r: LocalRecord) => ({
      kind: r.kind,
      id: r.id,
      updatedAt: r.updatedAt,
      rev: r.rev,
      data: r.data
    }))
    .sort((x, y) => `${x.kind}${x.id}`.localeCompare(`${y.kind}${y.id}`));
}

describe('book state between two devices (real server)', () => {
  const server = new TestServer();
  const books: string[] = [];
  let tokens: string[] = [];
  let a: Device;
  let b: Device;

  beforeAll(async () => {
    // One book per seed run; all before the server starts (no concurrent DB access).
    for (let i = 0; i < 3; i += 1) {
      const seeded = seedServer(server, 2);
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

  it('bulk mark completed on A reaches B; stat-day and position records stay untouched', async () => {
    const [book1, book2] = books;
    // Existing reading data from before WP8a (as the migration imported it).
    await a.engine.put(
      'stat-day',
      `${book1}:2026-10-01`,
      {
        dateKey: '2026-10-01',
        charactersRead: 3000,
        readingTime: 600,
        minReadingSpeed: 0,
        altMinReadingSpeed: 0,
        lastReadingSpeed: 0,
        maxReadingSpeed: 0,
        lastStatisticModified: 1
      },
      { bookId: book1 }
    );
    await savePosition(a, book1, 4000);
    await a.sync();
    await b.sync();
    const before = await untouchable(b, book1);
    expect(before.map((r) => r.kind)).toEqual(['position', 'stat-day']);
    expect(before[0].data.readThroughId).toBeNull();

    const failed = await markBooksCompleted(
      [
        { bookId: book1, charCount: 90_000 },
        { bookId: book2, charCount: null }
      ],
      '2026-10-02',
      stateDeps(a)
    );
    expect(failed).toEqual([]);
    await setBookFavorite(book1, true, stateDeps(a));
    await a.sync();
    await b.sync();

    const s1 = await getBookState(book1, stateDeps(b));
    expect(s1).toMatchObject({ status: 'completed', favorite: true });
    expect(s1.readThroughs).toEqual([
      expect.objectContaining({
        number: 1,
        origin: 'completion',
        finished: true,
        finishedOn: '2026-10-02',
        manual: true,
        charCount: 90_000
      })
    ]);
    expect((await getBookState(book2, stateDeps(b))).status).toBe('completed');
    expect(await untouchable(b, book1)).toEqual(before);
    expect(await untouchable(a, book1)).toEqual(before);
  });

  it("B's offline automatic Reading doesn't erase A's favorite (separate records)", async () => {
    const book = books[2];
    b.online = false;
    await noteFirstPageTurn(book, stateDeps(b));
    await setBookFavorite(book, true, stateDeps(a));
    await a.sync();
    b.online = true;
    await b.sync();
    await a.sync();
    for (const device of [a, b]) {
      expect(await getBookState(book, stateDeps(device))).toMatchObject({
        status: 'reading',
        statusAuto: true,
        favorite: true
      });
    }
    // A manual status from either device later wins over the automatic one.
    await setBookStatus(book, 'dropped', stateDeps(b));
    await b.sync();
    await a.sync();
    expect((await getBookState(book, stateDeps(a))).status).toBe('dropped');
  });

  it('Start over on A: B moves to the start once and is never offered an old place', async () => {
    const book = books[1]; // completed manually in the first test
    await savePosition(a, book, 5000);
    await savePosition(b, book, 8000);
    await a.sync();
    await b.sync();
    const before = await untouchable(b, book);

    await startBookOver(book, stateDeps(a));
    // A's reader applies it on open: jumps to the start and saves (new read-through).
    expect((await pendingStartOver(book, 5000, stateDeps(a)))?.number).toBe(2);
    await savePosition(a, book, 0);
    expect(await pendingStartOver(book, 0, stateDeps(a))).toBeNull();
    // A reads on; the first page turn sets Reading.
    await noteFirstPageTurn(book, stateDeps(a));
    await savePosition(a, book, 300);
    await a.sync();
    await b.sync();

    // The Start over itself changed no existing record on B (only A's own saves did).
    const afterOnB = await untouchable(b, book);
    expect(afterOnB.find((r) => r.id.endsWith(b.engine.deviceId))).toEqual(
      before.find((r) => r.id.endsWith(b.engine.deviceId))
    );

    // B opens at its old place 8000: the Start over applies once.
    const rt = await pendingStartOver(book, 8000, stateDeps(b));
    expect(rt).toMatchObject({ number: 2, origin: 'start-over', startedOn: '2026-11-09' });
    // Before B's jump is saved, the prompt never offers B's own old place (8000).
    const prompt = await findPositionPrompt(
      book,
      { localPos: 0, localTotal: TOTAL, ownBaseline: 0 },
      promptDeps(b, book)
    );
    expect(prompt?.rows.map((r) => [r.deviceId, r.target])).toEqual([[a.engine.deviceId, 300]]);

    await savePosition(b, book, 0);
    expect(await pendingStartOver(book, 0, stateDeps(b))).toBeNull();
    expect(await pendingStartOver(book, 500, stateDeps(b))).toBeNull();
    await b.sync();
    await a.sync();

    // A's prompt: B's position is in the same read-through now, but behind.
    expect(
      await findPositionPrompt(
        book,
        { localPos: 300, localTotal: TOTAL, ownBaseline: 300 },
        promptDeps(a, book)
      )
    ).toBeNull();

    // Finishing in the reader makes it Read 2x (tracked).
    await noteReaderCompletion(book, stateDeps(a));
    await a.sync();
    await b.sync();
    const state = await getBookState(book, stateDeps(b));
    expect(state.status).toBe('completed');
    expect(state.readThroughs.map((r) => [r.number, r.finished, r.manual])).toEqual([
      [1, true, true],
      [2, true, false]
    ]);
  });

  it('two devices starting over offline end up with one new read-through', async () => {
    const book = books[0];
    a.online = false;
    b.online = false;
    await startBookOver(book, stateDeps(a));
    await startBookOver(book, stateDeps(b));
    a.online = true;
    b.online = true;
    await a.sync();
    await b.sync();
    await a.sync();
    for (const device of [a, b]) {
      const state = await getBookState(book, stateDeps(device));
      expect(state.readThroughs.map((r) => r.number)).toEqual([1, 2]);
      expect(state.status).toBe('unread');
    }
  });
});
