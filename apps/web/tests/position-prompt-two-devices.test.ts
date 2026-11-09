/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP9: "Continue from...?" between two devices, against the real storage
 * server (tests/helpers/sync-harness.ts). Device A ("Phone") reads ahead;
 * device B asks what to offer, online and offline.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CalibreLink } from '$lib/library/library-db';
import {
  findPositionPrompt,
  markPositionPromptHandled,
  onPositionsChanged,
  promptBookId,
  type PositionPromptDeps
} from '$lib/sync/position-prompt-service';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const TOTAL = 100_000;
const LOCAL_ID = 7;
const TITLE = '薬屋のひとりごと 1';

describe('"Continue from...?" between two devices (real server)', () => {
  const server = new TestServer();
  let bookId = '';
  let tokens: string[] = [];
  let a: Device;
  let b: Device;
  let deviceCount = 0;
  let active = true;

  beforeAll(async () => {
    ({ bookId, tokens } = seedServer(server, 12));
    await server.start();
  }, 120_000);

  afterAll(async () => {
    await server.stop();
  });

  // All tests share one book: each pair deletes its positions when done, so
  // the next pair starts clean (deleted records are never offered).
  afterEach(async () => {
    for (const device of [a, b]) {
      if (!device) continue;
      device.online = true;
      await device.engine.remove('position', `${bookId}:${device.engine.deviceId}`);
      await device.sync();
      device.engine.close();
    }
    active = true;
  });

  async function pair() {
    a = new Device('A', tokens[deviceCount++], server);
    b = new Device('B', tokens[deviceCount++], server);
    await a.open();
    await b.open();
    await a.sync();
    await a.engine.write('device', a.engine.deviceId, { name: 'Phone' });
    await a.sync();
    await b.sync();
  }

  function link(): CalibreLink {
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

  /** B's side of the prompt, as the reader wires it in sync-service.ts. */
  function depsFor(device: Device): PositionPromptDeps {
    return {
      getEngine: async () => device.engine,
      linksForLocalId: async (id) => (id === LOCAL_ID ? [link()] : []),
      isActive: async () => active,
      minChars: () => 500,
      warn: () => {}
    };
  }

  async function readTo(device: Device, charPos: number) {
    await device.engine.write(
      'position',
      `${bookId}:${device.engine.deviceId}`,
      { charPos, progress: charPos / TOTAL, readThroughId: null },
      { bookId }
    );
  }

  it('offers the device that is further along, with its name and time', async () => {
    await pair();
    await readTo(a, 40_000);
    await a.sync();
    await readTo(b, 5_000);
    await b.sync();

    const deps = depsFor(b);
    expect(await promptBookId(LOCAL_ID, TITLE, deps)).toBe(bookId);
    const prompt = await findPositionPrompt(bookId, { localPos: 5_000, localTotal: TOTAL }, deps);
    expect(prompt?.rows).toEqual([
      expect.objectContaining({
        deviceId: a.engine.deviceId,
        deviceName: 'Phone',
        isOwn: false,
        target: 40_000,
        approximate: false
      })
    ]);
    const row = prompt!.rows[0];
    // Shown on B's clock: within a few seconds of now.
    expect(Math.abs(row.localAt - Date.now())).toBeLessThan(10_000);
    expect(prompt!.lastSyncAt).not.toBeNull();
    expect(prompt!.lastError).toBeNull();

    // A is behind B: nothing for A.
    expect(
      await findPositionPrompt(bookId, { localPos: 40_000, localTotal: TOTAL }, depsFor(a))
    ).toBeNull();
  });

  it('works offline from the mirror and says the last sync failed', async () => {
    await pair();
    await readTo(a, 40_000);
    await a.sync();
    await b.sync();

    b.online = false;
    await readTo(a, 60_000);
    await a.sync();
    await expect(b.sync()).rejects.toThrow();

    const prompt = await findPositionPrompt(
      bookId,
      { localPos: 1_000, localTotal: TOTAL },
      depsFor(b)
    );
    // The mirror still holds the last position B heard about.
    expect(prompt?.rows.map((r) => r.target)).toEqual([40_000]);
    expect(prompt?.lastError).toMatch(/offline/);
  });

  it('asks once per version: answered positions return only when that device moves', async () => {
    await pair();
    await readTo(a, 40_000);
    await a.sync();
    await b.sync();
    const deps = depsFor(b);
    const place = { localPos: 1_000, localTotal: TOTAL };

    const first = await findPositionPrompt(bookId, place, deps);
    expect(first?.rows).toHaveLength(1);
    await markPositionPromptHandled(
      bookId,
      first!.rows.map((r) => ({ recordId: r.recordId, updatedAt: r.updatedAt })),
      deps
    );
    expect(await findPositionPrompt(bookId, place, deps)).toBeNull();

    // B's sync brings A's newer position and tells the open reader.
    let told = 0;
    const off = await onPositionsChanged(bookId, () => (told += 1), deps);
    await readTo(a, 70_000);
    await a.sync();
    await b.sync();
    off();
    expect(told).toBe(1);
    const again = await findPositionPrompt(bookId, place, deps);
    expect(again?.rows.map((r) => r.target)).toEqual([70_000]);
  });

  it("offers this device's own place on open when the bookmark was moved back", async () => {
    await pair();
    await readTo(b, 30_000);
    await b.sync();
    // The legacy sync replaced B's bookmark with an older place (10,000).
    const prompt = await findPositionPrompt(
      bookId,
      { localPos: 10_000, localTotal: TOTAL, ownBaseline: 10_000 },
      depsFor(b)
    );
    expect(prompt?.rows).toEqual([expect.objectContaining({ isOwn: true, target: 30_000 })]);
    // Mid-session (no baseline) it is never offered.
    expect(
      await findPositionPrompt(bookId, { localPos: 10_000, localTotal: TOTAL }, depsFor(b))
    ).toBeNull();
  });

  it('does nothing for an unlinked book or when switched off', async () => {
    await pair();
    await readTo(a, 40_000);
    await a.sync();
    await b.sync();
    const deps = depsFor(b);
    expect(await promptBookId(LOCAL_ID + 1, TITLE, deps)).toBeNull();
    expect(await promptBookId(LOCAL_ID, 'Renamed title', deps)).toBeNull();
    active = false;
    expect(await promptBookId(LOCAL_ID, TITLE, deps)).toBeNull();
    expect(await findPositionPrompt(bookId, { localPos: 0, localTotal: TOTAL }, deps)).toBeNull();
  });
});
