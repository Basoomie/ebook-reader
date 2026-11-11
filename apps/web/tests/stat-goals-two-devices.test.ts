/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP12c: reading goals between two devices, against the real storage server.
 * - A goal made on A shows on B, with progress from both devices' reading.
 * - Changing an older goal on B ends it before the current period and starts a new
 *   one; A sees both, so past periods keep their target.
 * - Ending a goal made in the current period removes it everywhere.
 */
import 'fake-indexeddb/auto';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import {
  activeGoals,
  goalProgress,
  goalsFromRecords,
  planGoalEnd,
  planGoalSave,
  STAT_GOAL_KIND,
  type GoalWrite
} from '$lib/stats/goals';
import { periodContaining } from '$lib/stats/periods';
import { SessionRecorder } from '$lib/stats/session-recorder';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const T = 1_794_000_000_000;

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

async function apply(device: Device, writes: GoalWrite[]) {
  for (const w of writes) {
    if (w.op === 'remove') await device.engine.remove(STAT_GOAL_KIND, w.id);
    else await device.engine.put(STAT_GOAL_KIND, w.id, { ...w.data }, { bookId: null });
  }
}

const goalsOn = async (d: Device) => goalsFromRecords(await d.engine.getAll(STAT_GOAL_KIND));

describe('reading goals between two devices (real server)', () => {
  const server = new TestServer();
  let book: string;
  let a: Device;
  let b: Device;

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

  function reader(device: Device) {
    return new SessionRecorder({
      resolveTarget: async () => ({ bookId: book, deviceId: device.engine.deviceId }),
      readThroughId: async () => null,
      put: (kind, id, data, bookId) => device.engine.put(kind, id, data, { bookId }),
      newId: () => randomUUID(),
      warn: () => {}
    });
  }

  it("a goal made on A shows on B with both devices' reading", async () => {
    await apply(
      a,
      planGoalSave(
        null,
        { metric: 'time', period: 'day', target: 1800 },
        '2026-11-12',
        1,
        randomUUID,
        1
      )
    );
    const ra = reader(a);
    ra.add('2026-11-12', 900, 9000, T + 900_000);
    await ra.seal(T + 900_000);
    const rb = reader(b);
    rb.add('2026-11-12', 1200, 12000, T + 3_000_000);
    await rb.seal(T + 3_000_000);
    await syncAll(a, b);
    const [goal] = activeGoals(await goalsOn(b), '2026-11-12');
    expect(goal).toMatchObject({ metric: 'time', target: 1800, startedOn: '2026-11-12' });
    const entries = statEntriesFromRecords(await b.engine.getForBook(book));
    const progress = goalProgress(goal, periodContaining('day', '2026-11-12', 1), {
      entries,
      readThroughs: new Map(),
      books: new Map(),
      speedMinSeconds: 0
    });
    expect(progress).toMatchObject({ value: 2100, met: true });
    // Made today, so ending it removes it everywhere.
    await apply(b, planGoalEnd(goal, '2026-11-12', 1));
    await syncAll(b, a);
    expect(await goalsOn(a)).toEqual([]);
  });

  it('changing an older goal on B keeps its past periods on A', async () => {
    await apply(
      a,
      planGoalSave(
        null,
        { metric: 'chars', period: 'week', target: 50_000 },
        '2026-10-20',
        1,
        randomUUID,
        5
      )
    );
    await syncAll(a, b);
    const [old] = await goalsOn(b);
    await apply(
      b,
      planGoalSave(
        old,
        { metric: 'chars', period: 'week', target: 80_000 },
        '2026-11-12',
        1,
        randomUUID,
        6
      )
    );
    await syncAll(b, a);
    const onA = await goalsOn(a);
    expect(onA.map((g) => [g.target, g.startedOn, g.endedOn])).toEqual([
      [50_000, '2026-10-19', '2026-11-08'],
      [80_000, '2026-11-09', null]
    ]);
    expect(activeGoals(onA, '2026-11-12').map((g) => g.target)).toEqual([80_000]);
    expect((await a.engine.status()).rejected).toBe(0);
    expect((await b.engine.status()).rejected).toBe(0);
  });
});
