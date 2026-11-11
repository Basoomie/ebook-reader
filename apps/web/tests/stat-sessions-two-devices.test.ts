/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP12a: reading sessions between two devices, against the real storage server
 * (tests/helpers/sync-harness.ts). The same situations that lost reading with
 * per-day rows (decisions.md, "Same-day reading on two devices") must now keep
 * every second and character on both devices:
 * - both online, switching devices with syncs in between;
 * - the book open on both, switching back and forth;
 * - one device reading offline first, or later, and reconnecting;
 * - a quick switch before the first device synced;
 * - Complete Book on one device while the other reads the same day;
 * - opening a book on another device writes nothing;
 * - a correction made on one device applies on the other;
 * - devices can no longer write stat-day records (frozen).
 */
import 'fake-indexeddb/auto';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statEntriesFromRecords, totalsOf } from '$lib/stats/aggregate';
import { SessionRecorder } from '$lib/stats/session-recorder';
import { bookStateFrom, positionReadThroughId } from '$lib/sync/book-state';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

describe('reading sessions between two devices (real server)', () => {
  const server = new TestServer();
  let book: string;
  let a: Device;
  let b: Device;
  let t = 1_790_000_000_000;

  function recorder(device: Device) {
    return new SessionRecorder({
      resolveTarget: async () => ({ bookId: book, deviceId: device.engine.deviceId }),
      readThroughId: async () =>
        positionReadThroughId(bookStateFrom(book, await device.engine.getForBook(book))),
      put: (kind, id, data, bookId) => device.engine.put(kind, id, data, { bookId }),
      newId: () => randomUUID(),
      warn: () => {}
    });
  }

  /** `ticks` seconds of reading, `chars` characters each second; returns the truth. */
  function read(r: SessionRecorder, day: string, ticks: number, chars: number) {
    for (let i = 0; i < ticks; i += 1) {
      t += 1000;
      r.add(day, 1, chars, t);
    }
    return { seconds: ticks, chars: ticks * chars };
  }

  async function totalsOn(device: Device, day: string) {
    const entries = statEntriesFromRecords(await device.engine.getForBook(book));
    return totalsOf(entries, (e) => e.day === day);
  }

  async function expectBoth(day: string, truth: { seconds: number; chars: number }) {
    for (const device of [a, b]) {
      const totals = await totalsOn(device, day);
      expect({ device: device.name, seconds: totals.seconds, chars: totals.chars }).toEqual({
        device: device.name,
        ...truth
      });
    }
  }

  const sum = (...parts: { seconds: number; chars: number }[]) => ({
    seconds: parts.reduce((n, p) => n + p.seconds, 0),
    chars: parts.reduce((n, p) => n + p.chars, 0)
  });

  beforeAll(async () => {
    const seeded = seedServer(server, 2, { catalog: true });
    book = seeded.bookId;
    await server.start();
    a = new Device('A', seeded.tokens[0], server);
    b = new Device('B', seeded.tokens[1], server);
    await a.open();
    await b.open();
    await syncAll(a, b);
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('S1: both online, switching with syncs in between', async () => {
    const day = '2026-11-01';
    const ra = recorder(a);
    const rb = recorder(b);
    const p1 = read(ra, day, 5, 100);
    await ra.seal(t);
    await syncAll(a, b);
    const p2 = read(rb, day, 4, 90);
    await rb.seal(t);
    await syncAll(b, a);
    const p3 = read(ra, day, 3, 80);
    await ra.seal(t);
    await syncAll(a, b);
    await expectBoth(day, sum(p1, p2, p3));
  });

  it('S2: the book open on both, switching back and forth (no seal in between)', async () => {
    const day = '2026-11-02';
    const ra = recorder(a);
    const rb = recorder(b);
    const parts = [];
    for (let round = 0; round < 3; round += 1) {
      parts.push(read(ra, day, 4, 50));
      await ra.flush();
      await a.sync();
      await b.sync();
      parts.push(read(rb, day, 4, 60));
      await rb.flush();
      await b.sync();
      await a.sync();
    }
    await syncAll(a, b);
    await expectBoth(day, sum(...parts));
  });

  it('S3a: B reads offline first, A reads later online, B reconnects', async () => {
    const day = '2026-11-03';
    b.online = false;
    const rb = recorder(b);
    const p1 = read(rb, day, 6, 70);
    await rb.seal(t);
    await b.sync().catch(() => {});
    const ra = recorder(a);
    const p2 = read(ra, day, 5, 90);
    await ra.seal(t);
    await a.sync();
    b.online = true;
    await syncAll(b, a);
    await expectBoth(day, sum(p1, p2));
  });

  it('S3b: A reads first, B reads offline later and reconnects with the book still open', async () => {
    const day = '2026-11-04';
    const ra = recorder(a);
    const p1 = read(ra, day, 5, 90);
    await ra.seal(t);
    await a.sync();
    b.online = false;
    const rb = recorder(b);
    const p2 = read(rb, day, 6, 70);
    await rb.flush();
    await b.sync().catch(() => {});
    b.online = true;
    await b.sync();
    const p3 = read(rb, day, 2, 70);
    await rb.flush();
    await syncAll(b, a);
    await expectBoth(day, sum(p1, p2, p3));
  });

  it('S4: a quick switch before the first device synced', async () => {
    const day = '2026-11-05';
    const ra = recorder(a);
    const p1 = read(ra, day, 4, 100);
    await ra.flush();
    a.online = false; // put down before its sync ran
    await a.sync().catch(() => {});
    const rb = recorder(b);
    const p2 = read(rb, day, 5, 100);
    await rb.seal(t);
    await b.sync();
    a.online = true;
    await ra.seal(t);
    await syncAll(a, b);
    await expectBoth(day, sum(p1, p2));
  });

  it('S5: Complete Book on A while B reads the same day (characters only)', async () => {
    const day = '2026-11-06';
    const rb = recorder(b);
    const p1 = read(rb, day, 10, 100);
    await rb.flush();
    const ra = recorder(a);
    const p2 = read(ra, day, 5, 100);
    await ra.addCompletion(day, 2500, t);
    await ra.seal(t);
    const p3 = read(rb, day, 5, 100);
    await rb.seal(t);
    await syncAll(a, b);
    const tracked = sum(p1, p2, p3);
    await expectBoth(day, { seconds: tracked.seconds, chars: tracked.chars + 2500 });
    const onA = await totalsOn(a, day);
    // Speed uses tracked reading only.
    expect(onA.speedChars).toBe(tracked.chars);
    expect(onA.speedSeconds).toBe(tracked.seconds);
  });

  it('opening a book on another device writes nothing', async () => {
    const before = (await b.engine.getForBook(book)).length;
    const rb = recorder(b);
    await rb.flush();
    await rb.seal(t);
    await b.sync();
    expect((await b.engine.getForBook(book)).length).toBe(before);
  });

  it('a correction on B applies on A, and undoing it restores the session', async () => {
    const day = '2026-11-07';
    const ra = recorder(a);
    read(ra, day, 40, 10);
    await ra.seal(t);
    await syncAll(a, b);
    const [session] = statEntriesFromRecords(await b.engine.getForBook(book)).filter(
      (e) => e.day === day
    );
    await b.engine.put('stat-session-fix', session.id, { seconds: 20 }, { bookId: book });
    await syncAll(b, a);
    expect((await totalsOn(a, day)).seconds).toBe(20);
    await b.engine.remove('stat-session-fix', session.id);
    await syncAll(b, a);
    expect((await totalsOn(a, day)).seconds).toBe(40);
  });

  it('no device writes stat-day any more, and nothing was refused otherwise', async () => {
    expect(await a.engine.getAll('stat-day')).toEqual([]);
    expect((await a.engine.status()).rejected).toBe(0);
    expect((await b.engine.status()).rejected).toBe(0);
    await a.engine.put(
      'stat-day',
      `${book}:2026-11-08`,
      {
        dateKey: '2026-11-08',
        charactersRead: 1,
        readingTime: 1,
        minReadingSpeed: 0,
        altMinReadingSpeed: 0,
        lastReadingSpeed: 0,
        maxReadingSpeed: 0,
        lastStatisticModified: 1
      },
      { bookId: book }
    );
    await a.sync();
    const [refused] = await a.engine.rejectedChanges();
    expect(refused).toMatchObject({
      change: { kind: 'stat-day' },
      error: { code: 'stat_day_frozen' }
    });
  });
});
