/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP8a open point (fixed 2026-11-10), against the real storage server
 * (tests/helpers/sync-harness.ts): a device whose mirror is behind (long
 * offline, or just paired before its first pull) presses Start over and plans
 * read-through #n, which another device has already finished. The server
 * refuses the open #n, the device re-plans it as #n+1, and the finished #n
 * keeps its finish date and flag. No stat-day or position record is rewritten.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CalibreLink } from '$lib/library/library-db';
import { bookProgressLabel } from '$lib/library/progress';
import {
  getBookState,
  markBooksCompleted,
  noteFirstPageTurn,
  noteReaderCompletion,
  pendingStartOver,
  registerBookStateSync,
  startBookOver,
  type BookStateDeps
} from '$lib/sync/book-state-service';
import { positionRecordId, recordPosition } from '$lib/sync/record-position';
import type { LocalRecord } from '$lib/sync/sync-db';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const TOTAL = 100_000;
const LOCAL_ID = 7;
const TITLE = '薬屋のひとりごと 1';

function stateDeps(device: Device, today: string): BookStateDeps {
  return { getEngine: async () => device.engine, today: () => today, warn: () => {} };
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

/** Stat-day and position records as stored (rev aside: the server sets it on push). */
async function untouchable(device: Device, bookId: string, skip: (r: LocalRecord) => boolean) {
  const records = await device.engine.getForBook(bookId);
  return records
    .filter((r) => (r.kind === 'stat-day' || r.kind === 'position') && !skip(r))
    .map((r) => ({
      kind: r.kind,
      id: r.id,
      deviceId: r.deviceId,
      updatedAt: r.updatedAt,
      data: r.data
    }))
    .sort((x, y) => `${x.kind}${x.id}`.localeCompare(`${y.kind}${y.id}`));
}

const readThroughs = async (device: Device, bookId: string) =>
  (await getBookState(bookId, stateDeps(device, '2026-11-13'))).readThroughs.map((r) => ({
    number: r.number,
    origin: r.origin,
    startedOn: r.startedOn,
    finished: r.finished,
    finishedOn: r.finishedOn
  }));

describe('Start over on a device whose mirror is behind (real server)', () => {
  const server = new TestServer();
  const books: string[] = [];
  let tokens: string[] = [];
  let a: Device;
  let b: Device;

  beforeAll(async () => {
    // One book per seed run; all before the server starts (no concurrent DB access).
    for (let i = 0; i < 2; i += 1) {
      const seeded = seedServer(server, 3);
      books.push(seeded.bookId);
      if (i === 0) tokens = seeded.tokens;
    }
    await server.start();
    a = new Device('A', tokens[0], server);
    b = new Device('B', tokens[1], server);
    await a.open();
    await b.open();
    registerBookStateSync(a.engine);
    registerBookStateSync(b.engine);
    await a.sync();
    await b.sync();
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('a long-offline device re-plans as #n+1; the finished #n and its offline reading survive', async () => {
    const book = books[0];
    await savePosition(a, book, 5000);
    await savePosition(b, book, 3000);
    await a.sync();
    await b.sync();

    // A goes offline. Meanwhile B starts over (#2), reads and finishes it in the reader.
    a.online = false;
    await startBookOver(book, stateDeps(b, '2026-11-10'));
    expect((await pendingStartOver(book, 3000, stateDeps(b, '2026-11-10')))?.number).toBe(2);
    await savePosition(b, book, 0);
    await noteFirstPageTurn(book, stateDeps(b, '2026-11-10'));
    await savePosition(b, book, 99_000);
    await noteReaderCompletion(book, stateDeps(b, '2026-11-12'));
    await b.sync();
    const finishedOnServer = await b.engine.get('read-through', `${book}:2`);
    expect(finishedOnServer?.data).toMatchObject({ finished: true, finishedOn: '2026-11-12' });

    // A, still offline and knowing nothing of #2, starts over: it plans #2 too.
    await startBookOver(book, stateDeps(a, '2026-11-13'));
    expect(
      (await getBookState(book, stateDeps(a, '2026-11-13'))).readThroughs.map((r) => r.id)
    ).toEqual([`${book}:2`]);
    // A's reader applies it on open and A reads on offline.
    expect((await pendingStartOver(book, 5000, stateDeps(a, '2026-11-13')))?.number).toBe(2);
    await savePosition(a, book, 0);
    await noteFirstPageTurn(book, stateDeps(a, '2026-11-13'));
    await savePosition(a, book, 6000);
    const ownId = positionRecordId(book, a.engine.deviceId);
    const ownBefore = await a.engine.get('position', ownId);
    expect(ownBefore?.data.readThroughId).toBe(`${book}:2`);
    const othersOnB = await untouchable(b, book, (r) => r.deviceId === a.engine.deviceId);

    // A comes back: the open #2 is refused, the server's finished #2 adopted, #3 planned.
    a.online = true;
    const report = await a.sync();
    expect(report.rejected).toBe(1);
    expect(await a.engine.status()).toMatchObject({ rejected: 0, pending: 1 });
    expect((await a.engine.getMeta()).startOverMoves?.[book]).toEqual({
      from: [`${book}:2`],
      to: `${book}:3`
    });
    await a.sync();
    await b.sync();
    expect(await a.engine.status()).toMatchObject({ rejected: 0, pending: 0 });

    const expected = [
      {
        number: 2,
        origin: 'start-over',
        startedOn: '2026-11-10',
        finished: true,
        finishedOn: '2026-11-12'
      },
      {
        number: 3,
        origin: 'start-over',
        startedOn: '2026-11-13',
        finished: false,
        finishedOn: null
      }
    ];
    for (const device of [a, b]) {
      expect(await readThroughs(device, book)).toEqual(expected);
      // A's Start over and first page turn came last.
      expect((await getBookState(book, stateDeps(device, '2026-11-13'))).status).toBe('reading');
    }
    // B's finished #2 is the very record B wrote.
    expect(await b.engine.get('read-through', `${book}:2`)).toMatchObject({
      deviceId: b.engine.deviceId,
      updatedAt: finishedOnServer?.updatedAt,
      data: finishedOnServer?.data
    });

    // No position or stat-day record was rewritten: A's own record is as A saved it,
    // and everything not written by A is unchanged on B.
    const ownAfter = await a.engine.get('position', ownId);
    expect({ ...ownAfter, rev: null }).toEqual({ ...ownBefore, rev: null });
    expect(await b.engine.get('position', ownId)).toMatchObject({
      updatedAt: ownBefore?.updatedAt,
      data: ownBefore?.data
    });
    expect(await untouchable(b, book, (r) => r.deviceId === a.engine.deviceId)).toEqual(othersOnB);

    // A keeps its offline reading: no jump to the start, and its library progress counts it.
    expect(await pendingStartOver(book, 6000, stateDeps(a, '2026-11-13'))).toBeNull();
    const stateOnA = await getBookState(book, stateDeps(a, '2026-11-13'));
    const positionsOnA = (await a.engine.getForBook(book)).filter((r) => r.kind === 'position');
    expect(bookProgressLabel(book, stateOnA, positionsOnA, TOTAL)).toBe('6%');
    // B started over by A: B moves to the start once (its place belongs to #2).
    expect((await pendingStartOver(book, 99_000, stateDeps(b, '2026-11-13')))?.number).toBe(3);

    // A's next save carries #3 on its own.
    await savePosition(a, book, 6100);
    expect((await a.engine.get('position', ownId))?.data.readThroughId).toBe(`${book}:3`);
  });

  it('a just-paired device starting over before its first pull re-plans as #n+1', async () => {
    const book = books[1];
    // A starts over (#2) and marks it completed with a date.
    await startBookOver(book, stateDeps(a, '2026-11-08'));
    expect(
      await markBooksCompleted(
        [{ bookId: book, charCount: TOTAL }],
        '2026-11-09',
        stateDeps(a, '2026-11-09')
      )
    ).toEqual([]);
    await a.sync();

    // C is paired now and starts over before it ever pulled.
    const c = new Device('C', tokens[2], server);
    await c.open();
    registerBookStateSync(c.engine);
    try {
      await startBookOver(book, stateDeps(c, '2026-11-13'));
      const report = await c.sync();
      expect(report.rejected).toBe(1);
      await c.sync();
      await a.sync();
      await b.sync();
      const expected = [
        {
          number: 2,
          origin: 'start-over',
          startedOn: '2026-11-08',
          finished: true,
          finishedOn: '2026-11-09'
        },
        {
          number: 3,
          origin: 'start-over',
          startedOn: '2026-11-13',
          finished: false,
          finishedOn: null
        }
      ];
      for (const device of [a, b, c]) {
        expect(await readThroughs(device, book)).toEqual(expected);
        expect((await getBookState(book, stateDeps(device, '2026-11-13'))).status).toBe('unread');
      }
      expect(await c.engine.status()).toMatchObject({ rejected: 0, pending: 0 });
      // C wrote no position, so nothing to keep: on open it moves to the start.
      expect((await pendingStartOver(book, 4000, stateDeps(c, '2026-11-13')))?.number).toBe(3);
    } finally {
      c.engine.close();
    }
  });

  it('two devices starting over offline still merge into one read-through', async () => {
    const book = books[1];
    a.online = false;
    b.online = false;
    await startBookOver(book, stateDeps(a, '2026-11-14'));
    await startBookOver(book, stateDeps(b, '2026-11-14'));
    a.online = true;
    b.online = true;
    await a.sync();
    await b.sync();
    await a.sync();
    for (const device of [a, b]) {
      const numbers = (await readThroughs(device, book)).map((r) => [r.number, r.finished]);
      expect(numbers).toEqual([
        [2, true],
        [3, false],
        [4, false]
      ]);
      expect(await device.engine.status()).toMatchObject({ rejected: 0, pending: 0 });
    }
  });
});
