/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP18 against the real storage server (tests/helpers/sync-harness.ts):
 * - "Export my data" on B holds A's highlight, place and statistics day and the settings
 *   of both devices, each with its kind, id, writer, owner and times, and writes nothing;
 * - B's bug report includes the server's recent lines (A's pairing) and no token or
 *   pairing code.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBugReport } from '$lib/data/bug-report';
import { LibraryApi, pairDevice } from '$lib/library/api';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const statDay = {
  dateKey: '2026-10-02',
  charactersRead: 1200,
  readingTime: 600,
  minReadingSpeed: 100,
  altMinReadingSpeed: 100,
  lastReadingSpeed: 120,
  maxReadingSpeed: 150,
  lastStatisticModified: 1_790_000_000_000
};

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

describe('export and bug report (real server)', () => {
  const server = new TestServer();
  let book: string;
  let a: Device;
  let b: Device;
  let tokenA: string;
  let tokenB: string;
  let code: string;
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    const seeded = seedServer(server, 1, { catalog: true });
    book = seeded.bookId;
    tokenA = seeded.tokens[0];
    await server.start();
    // B pairs with a code, as a real device does.
    const lines = server.cli('token', 'pair', 'Boox').trim().split(/\r?\n/);
    code = lines.find((l) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(l.trim()))!.trim();
    tokenB = (await pairDevice(server.url, code)).token;
    a = new Device('A', tokenA, server);
    b = new Device('B', tokenB, server);
    await a.open();
    await b.open();
    await syncAll(a, b);
    aId = (await a.engine.status()).deviceId!;
    bId = (await b.engine.status()).deviceId!;
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it("exports A's records and both devices' settings from B, writing nothing", async () => {
    const highlightId = `${book}:${crypto.randomUUID()}`;
    await a.engine.put(
      'highlight',
      highlightId,
      {
        start: 0,
        end: 4,
        text: 'Book',
        before: '',
        after: '',
        color: 3,
        chapter: '一',
        createdAt: 1_790_000_000_000
      },
      { bookId: book }
    );
    await a.engine.put(
      'position',
      `${book}:${aId}`,
      { charPos: 4, progress: 0.5, readThroughId: null },
      { bookId: book }
    );
    await a.engine.put('stat-day', `${book}:2026-10-02`, statDay, { bookId: book });
    await a.engine.put('setting', 'global:theme', { value: 'dark-theme' });
    await a.engine.put('setting', `device:${aId}:fontSize`, { value: 22 });
    await b.engine.put('setting', `device:${bId}:fontSize`, { value: 30 });
    await syncAll(a, b);

    const api = new LibraryApi(server.url, tokenB, 20);
    const first = JSON.parse(await api.exportMyData());
    expect(first).toMatchObject({ format: 'ttsu-reader-export', formatVersion: 1 });
    // A, B and the server's own pseudo-device (it writes "Planned").
    expect(first.devices.map((d: { id: string }) => d.id)).toEqual(
      expect.arrayContaining([aId, bId])
    );
    expect(first.devices.find((d: { id: string }) => d.id === bId).name).toBe('Boox');
    expect(first.records.highlight).toEqual([
      expect.objectContaining({
        kind: 'highlight',
        id: highlightId,
        bookId: book,
        deviceId: aId,
        ownerDeviceId: null,
        deletedAt: null,
        data: expect.objectContaining({ color: 3, text: 'Book' })
      })
    ]);
    expect(first.records.position[0]).toMatchObject({ deviceId: aId, ownerDeviceId: aId });
    expect(first.records['stat-day'][0]).toMatchObject({ id: `${book}:2026-10-02`, data: statDay });
    const settings = Object.fromEntries(
      first.records.setting.map((r: { id: string; data: { value: unknown } }) => [
        r.id,
        r.data.value
      ])
    );
    expect(settings).toMatchObject({
      'global:theme': 'dark-theme',
      [`device:${aId}:fontSize`]: 22,
      [`device:${bId}:fontSize`]: 30
    });
    expect(first.books[book].title).toMatch(/^Book /);

    // Nothing was written: a second export has the same records, and B has nothing to pull.
    const second = JSON.parse(await api.exportMyData());
    expect(second.records).toEqual(first.records);
    expect((await b.sync()).pulled).toBe(0);
    const text = JSON.stringify(first);
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain(tokenB);
  });

  it("puts the server's recent lines into B's bug report, without tokens or codes", async () => {
    const api = new LibraryApi(server.url, tokenB, 20);
    const report = await buildBugReport({
      title: 'Bug Report',
      message: 'test',
      device: () => ({ userAgent: 'test' }),
      log: () => [{ level: 'warn', args: [`Sync: Bearer ${tokenB} failed; paired with ${code}`] }],
      sync: async () => b.engine.status(),
      serverLogs: (signal) => api.recentServerLogs({ signal }),
      secrets: async () => [tokenB],
      serverTimeoutSeconds: 20
    });
    const server_ = report.server as { included: boolean; lines: { text: string }[] };
    expect(server_.included).toBe(true);
    const texts = server_.lines.map((l) => l.text);
    expect(texts.some((t) => t.includes('running on port'))).toBe(true);
    expect(texts).toContain('Pairing: a device paired as "Boox"');
    const text = JSON.stringify(report);
    for (const secret of [tokenA, tokenB, code, code.replace('-', ''), 'legacy']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
