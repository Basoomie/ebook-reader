/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { SessionRecorder, type SessionRecorderDeps } from '$lib/stats/session-recorder';

const BOOK = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

interface Put {
  kind: string;
  id: string;
  data: Record<string, any>;
}

function setup(overrides: Partial<SessionRecorderDeps> = {}) {
  const puts: Put[] = [];
  const warnings: string[] = [];
  let n = 0;
  const deps: SessionRecorderDeps = {
    resolveTarget: async () => ({ bookId: BOOK, deviceId: DEVICE }),
    readThroughId: async () => null,
    put: async (kind, id, data) => {
      puts.push({ kind, id, data: structuredClone(data) });
      return true;
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    warn: (m) => warnings.push(m),
    ...overrides
  };
  const recorder = new SessionRecorder(deps);
  /** The newest written version of every record. */
  const latest = () => {
    const map = new Map<string, Put>();
    for (const p of puts) map.set(`${p.kind}|${p.id}`, p);
    return [...map.values()];
  };
  return { recorder, puts, warnings, latest };
}

const T = 1_790_000_000_000;

describe('SessionRecorder', () => {
  it('collects ticks into one open session and writes the newest numbers', async () => {
    const { recorder, puts } = setup();
    recorder.add('2026-11-12', 1, 30, T + 1000);
    recorder.add('2026-11-12', 1, 0, T + 2000);
    expect(await recorder.flush()).toBe(true);
    recorder.add('2026-11-12', 1, 25, T + 3000);
    await recorder.flush();
    expect(puts).toHaveLength(2);
    expect(puts[0].id).toBe(`${BOOK}:${DEVICE}:00000000-0000-4000-8000-000000000001`);
    expect(puts[1].data).toEqual({
      day: '2026-11-12',
      startedAt: T,
      endedAt: T + 3000,
      seconds: 3,
      chars: 55,
      lookups: 0,
      readThroughId: null,
      source: 'tracker',
      closed: false
    });
    // Nothing changed: nothing written.
    await recorder.flush();
    expect(puts).toHaveLength(2);
  });

  it('seals and starts a new session on the next reading, and on a new day', async () => {
    const { recorder, latest } = setup();
    recorder.add('2026-11-12', 10, 100, T + 10_000);
    await recorder.seal(T + 20_000);
    recorder.add('2026-11-12', 5, 50, T + 60_000);
    recorder.add('2026-11-13', 5, 70, T + 90_000);
    await recorder.flush();
    const sessions = latest();
    expect(sessions.map((p) => [p.data.day, p.data.seconds, p.data.chars, p.data.closed])).toEqual([
      ['2026-11-12', 10, 100, true],
      ['2026-11-12', 5, 50, true],
      ['2026-11-13', 5, 70, false]
    ]);
  });

  it('never writes a sealed session twice', async () => {
    const { recorder, puts } = setup();
    recorder.add('2026-11-12', 10, 100, T);
    await recorder.seal(T);
    await recorder.seal(T);
    await recorder.flush();
    expect(puts.filter((p) => p.data.closed)).toHaveLength(1);
  });

  it('keeps going back as a debt that later reading pays off (net progress)', async () => {
    const { recorder, latest } = setup();
    recorder.add('2026-11-12', 10, 1000, T);
    await recorder.seal(T);
    // Back 800 characters after the seal, then forward again over the same text.
    recorder.add('2026-11-12', 1, -800, T + 1000);
    recorder.add('2026-11-12', 1, 900, T + 2000);
    await recorder.flush();
    expect(latest().map((p) => p.data.chars)).toEqual([1000, 100]);
    // The debt is per day.
    recorder.add('2026-11-12', 0, -50, T + 3000);
    recorder.add('2026-11-13', 1, 40, T + 4000);
    await recorder.flush();
    expect(latest().map((p) => p.data.chars)).toEqual([1000, 50, 40]);
  });

  it('applies the idle rollback (negative seconds) to the open session', async () => {
    const { recorder, latest } = setup();
    recorder.add('2026-11-12', 200, 300, T);
    recorder.add('2026-11-12', -180, 0, T + 1000);
    await recorder.seal(T + 1000);
    expect(latest()[0].data).toMatchObject({ seconds: 20, chars: 300, closed: true });
  });

  it('reverts on the open session, and with a fix record on a sealed one', async () => {
    const { recorder, latest } = setup();
    recorder.add('2026-11-12', 60, 600, T);
    recorder.revert('2026-11-12', -30, -200, T + 1000);
    await recorder.seal(T + 1000);
    recorder.revert('2026-11-12', -10, -100, T + 2000);
    await recorder.flush();
    const [session, fix] = latest();
    expect(session).toMatchObject({ kind: 'stat-session', data: { seconds: 30, chars: 400 } });
    expect(fix).toMatchObject({
      kind: 'stat-session-fix',
      id: session.id,
      data: { seconds: 20, chars: 300 }
    });
  });

  it('counts lookups on the open session only', async () => {
    const { recorder, latest } = setup();
    recorder.addLookup();
    recorder.add('2026-11-12', 1, 10, T);
    recorder.addLookup();
    recorder.addLookup();
    await recorder.flush();
    expect(latest()[0].data.lookups).toBe(2);
  });

  it('writes a completion session with characters only', async () => {
    const { recorder, latest } = setup();
    await recorder.addCompletion('2026-11-12', 1234, T);
    expect(latest()[0].data).toMatchObject({
      source: 'completion',
      seconds: 0,
      chars: 1234,
      lookups: 0,
      closed: true
    });
  });

  it('stamps the current read-through once per session', async () => {
    let rt: string | null = null;
    const { recorder, latest } = setup({ readThroughId: async () => rt });
    recorder.add('2026-11-12', 1, 1, T);
    await recorder.seal(T);
    rt = `${BOOK}:2`;
    recorder.add('2026-11-12', 1, 1, T + 1000);
    await recorder.flush();
    expect(latest().map((p) => p.data.readThroughId)).toEqual([null, `${BOOK}:2`]);
  });

  it('writes in order: a slow write never overwrites newer numbers', async () => {
    const order: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { recorder } = setup({
      put: async (_k, _id, data) => {
        if (first) {
          first = false;
          await gate;
        }
        order.push(data.chars as number);
        return true;
      }
    });
    recorder.add('2026-11-12', 1, 10, T);
    const a = recorder.flush();
    recorder.add('2026-11-12', 1, 10, T + 1000);
    const b = recorder.flush();
    release();
    await Promise.all([a, b]);
    expect(order[order.length - 1]).toBe(20);
  });

  it('retries a failed write and never throws', async () => {
    let fail = true;
    const { recorder, puts } = setup({
      put: async (kind, id, data) => {
        if (fail) return false;
        puts.push({ kind, id, data });
        return true;
      }
    });
    recorder.add('2026-11-12', 1, 10, T);
    expect(await recorder.flush()).toBe(false);
    fail = false;
    expect(await recorder.flush()).toBe(true);
    expect(puts).toHaveLength(1);

    const broken = setup({
      put: async () => {
        throw new Error('disk full');
      }
    });
    broken.recorder.add('2026-11-12', 1, 10, T);
    expect(await broken.recorder.flush()).toBe(false);
    expect(broken.warnings[0]).toContain('disk full');
  });

  it('records nothing for a book without a library id, and says so once', async () => {
    const { recorder, puts, warnings } = setup({ resolveTarget: async () => null });
    recorder.add('2026-11-12', 1, 10, T);
    await recorder.flush();
    recorder.add('2026-11-12', 1, 10, T + 1000);
    await recorder.seal(T + 1000);
    expect(puts).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(await recorder.available()).toBe(false);
  });
});
