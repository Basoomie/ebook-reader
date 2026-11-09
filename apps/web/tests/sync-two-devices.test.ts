/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP4: two devices diverging offline, against the real storage server.
 *
 * The server runs as a separate process from apps/storage-server (exactly as
 * in the container); each "device" is a SyncEngine with its own IndexedDB
 * (fake-indexeddb), its own token, a network switch and its own clock
 * (tests/helpers/sync-harness.ts).
 */
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Device, TestServer, seedServer, tempDir } from './helpers/sync-harness';

const DAY = 24 * 3600 * 1000;

describe('two devices diverging offline (real server)', () => {
  const server = new TestServer();
  let bookId = '';
  let tokens: string[] = [];
  let a: Device;
  let b: Device;
  let deviceCount = 0;

  beforeAll(async () => {
    const seeded = seedServer(server, 24);
    bookId = seeded.bookId;
    tokens = seeded.tokens;
    await server.start();
  }, 120_000);

  afterAll(async () => {
    await server.stop();
  });

  /** A fresh pair of devices per test (tokens are single-device). */
  async function pair() {
    a = new Device('A', tokens[deviceCount++], server);
    b = new Device('B', tokens[deviceCount++], server);
    await a.open();
    await b.open();
    await a.sync();
    await b.sync();
  }

  afterEach(() => {
    a?.engine.close();
    b?.engine.close();
  });

  it('1. both edit the same global setting offline: the later edit wins on both, in either sync order', async () => {
    await pair();
    for (const order of [
      ['A', 'B'],
      ['B', 'A']
    ]) {
      const id = `global:scenario1${order.join('')}`;
      a.online = false;
      b.online = false;
      await a.engine.write('setting', id, { value: 'from A' });
      await new Promise((r) => setTimeout(r, 50));
      await b.engine.write('setting', id, { value: 'from B' });
      a.online = true;
      b.online = true;
      const first = order[0] === 'A' ? a : b;
      const second = order[0] === 'A' ? b : a;
      await first.sync();
      await second.sync();
      await first.sync();
      expect(await a.setting(id)).toBe('from B');
      expect(await b.setting(id)).toBe('from B');
    }
  });

  it('2. delete vs. later edit revives the record; a later delete keeps it deleted', async () => {
    await pair();
    const id = 'global:scenario2';
    await a.engine.write('setting', id, { value: 1 });
    await a.sync();
    await b.sync();

    a.online = false;
    b.online = false;
    await a.engine.write('setting', id, {}, { deleted: true });
    await new Promise((r) => setTimeout(r, 50));
    await b.engine.write('setting', id, { value: 2 });
    a.online = true;
    b.online = true;
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await a.setting(id)).toBe(2);
    expect(await b.setting(id)).toBe(2);

    a.online = false;
    b.online = false;
    await b.engine.write('setting', id, { value: 3 });
    await new Promise((r) => setTimeout(r, 50));
    await a.engine.write('setting', id, {}, { deleted: true });
    a.online = true;
    b.online = true;
    await b.sync();
    await a.sync();
    await b.sync();
    expect(await a.setting(id)).toBeUndefined();
    expect(await b.setting(id)).toBeUndefined();
    expect((await b.engine.get('setting', id))?.deletedAt).not.toBeNull();
  });

  it('3. both read the same book offline: each keeps its own position, both see both', async () => {
    await pair();
    a.online = false;
    b.online = false;
    const posA = `${bookId}:${a.engine.deviceId}`;
    const posB = `${bookId}:${b.engine.deviceId}`;
    for (let i = 1; i <= 3; i += 1) {
      await a.engine.write(
        'position',
        posA,
        { charPos: i * 100, progress: i / 10, readThroughId: null },
        { bookId }
      );
      await b.engine.write(
        'position',
        posB,
        { charPos: i * 70, progress: i / 20, readThroughId: null },
        { bookId }
      );
    }
    a.online = true;
    b.online = true;
    await a.sync();
    await b.sync();
    await a.sync();
    for (const device of [a, b]) {
      const positions = (await device.engine.getForBook(bookId)).filter(
        (r) => r.kind === 'position'
      );
      expect(positions.map((p) => [p.id, p.data.charPos]).sort()).toEqual(
        [
          [posA, 300],
          [posB, 210]
        ].sort()
      );
    }
    expect(
      server.cli('sync', 'dump', '--kind', 'position', '--book', bookId).trim().split('\n')
    ).toHaveLength(2);
  });

  it('4. many edits offline become one change per record and one push', async () => {
    await pair();
    a.online = false;
    for (let i = 0; i < 50; i += 1) {
      await a.engine.write('setting', `global:scenario4-${i % 5}`, { value: i });
    }
    expect((await a.engine.status()).pending).toBe(5);
    a.online = true;
    const report = await a.sync();
    expect(report.pushed).toBe(5);
    await b.sync();
    expect(await b.setting('global:scenario4-4')).toBe(49);
  });

  it('5. a lost push response: the retry is a duplicate, nothing is applied twice', async () => {
    await pair();
    const id = 'global:scenario5';
    await a.engine.write('setting', id, { value: 'once' });
    a.dropNextPushResponse = true;
    await expect(a.sync()).rejects.toThrow(/connection reset/);
    expect((await a.engine.status()).pending).toBe(1);
    const before = server.cli('sync', 'status');
    await a.sync();
    expect((await a.engine.status()).pending).toBe(0);
    expect(server.cli('sync', 'status').match(/last_rev=(\d+)/)?.[1]).toBe(
      before.match(/last_rev=(\d+)/)?.[1]
    );
    expect((await a.engine.get('setting', id))?.rev).not.toBeNull();
  });

  it('6. a clock two days ahead is clamped; a genuinely later edit still wins', async () => {
    await pair();
    const id = 'global:scenario6';
    // B synced with a correct clock, then its clock jumps two days ahead offline.
    b.online = false;
    b.clockSkewMs = 2 * DAY;
    await b.engine.write('setting', id, { value: 'B, wrong clock' });
    b.online = true;
    await b.sync();
    const stored = await b.engine.get('setting', id);
    expect(stored!.updatedAt).toBeLessThan(Date.now() + 2 * DAY - 60_000);

    await new Promise((r) => setTimeout(r, 50));
    await a.engine.write('setting', id, { value: 'A, later' });
    await a.sync();
    await b.sync();
    expect(await b.setting(id)).toBe('A, later');

    // B has learned the offset from the server: its next write is stamped correctly.
    const next = await b.engine.write('setting', 'global:scenario6-next', { value: 1 });
    expect(Math.abs(next.updatedAt - Date.now())).toBeLessThan(10_000);
  });

  it('7. the server is restored to an older snapshot: devices re-send what they have', async () => {
    await pair();
    await a.engine.write('setting', 'global:scenario7-old', { value: 'before snapshot' });
    await a.sync();

    // Take the "nightly snapshot".
    await server.stop();
    const backup = tempDir('backup');
    for (const file of server.dbFiles()) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, path.basename(file)));
    }
    await server.start();

    // Work after the snapshot, synced everywhere.
    await a.engine.write('setting', 'global:scenario7-a', { value: 'after, from A' });
    await b.engine.write(
      'position',
      `${bookId}:${b.engine.deviceId}`,
      { charPos: 777, progress: 0.7, readThroughId: null },
      { bookId }
    );
    await a.sync();
    await b.sync();
    await a.sync();

    // Disaster: restore the snapshot, then the documented restore step.
    await server.stop();
    for (const file of server.dbFiles()) {
      const saved = path.join(backup, path.basename(file));
      if (fs.existsSync(saved)) fs.copyFileSync(saved, file);
      else if (fs.existsSync(file)) fs.rmSync(file);
    }
    server.cli('sync', 'new-epoch');
    await server.start();
    // Match the field, not the bare number: the dump also prints random UUIDs.
    expect(server.cli('sync', 'dump', '--kind', 'position', '--book', bookId)).not.toContain(
      '"charPos":777'
    );

    const reportA = await a.sync();
    const reportB = await b.sync();
    expect(reportA.reconciled).toBe(true);
    expect(reportB.reconciled).toBe(true);
    await a.sync();

    expect(server.cli('sync', 'dump', '--kind', 'position', '--book', bookId)).toContain(
      '"charPos":777'
    );
    expect(await b.setting('global:scenario7-a')).toBe('after, from A');
    expect(await a.setting('global:scenario7-old')).toBe('before snapshot');
    const posOnA = await a.engine.get('position', `${bookId}:${b.engine.deviceId}`);
    expect(posOnA?.data.charPos).toBe(777);
  });

  it('8. an edit made while a push is in flight stays queued and syncs next time', async () => {
    await pair();
    const id = 'global:scenario8';
    await a.engine.write('setting', id, { value: 'first' });
    const realPush = a.api.push.bind(a.api);
    let edited = false;
    a.api.push = async (changes) => {
      const response = await realPush(changes);
      if (!edited) {
        edited = true;
        await a.engine.write('setting', id, { value: 'second' });
      }
      return response;
    };
    await a.sync();
    expect((await a.engine.status()).pending).toBe(1);
    await a.sync();
    await b.sync();
    expect(await b.setting(id)).toBe('second');
    expect((await a.engine.status()).pending).toBe(0);
  });

  it('owner records can only be written by their device, even when another device tries', async () => {
    await pair();
    await b.engine.write(
      'position',
      `${bookId}:${a.engine.deviceId}`,
      { charPos: 1, progress: 0, readThroughId: null },
      { bookId }
    );
    const report = await b.sync();
    expect(report.rejected).toBe(1);
    expect((await b.engine.status()).rejected).toBe(1);
  });
});
