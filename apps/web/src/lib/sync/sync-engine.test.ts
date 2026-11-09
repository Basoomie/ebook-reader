/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { LibraryApiError } from '$lib/library/api';
import type {
  ChangeResult,
  PullResponse,
  PushResponse,
  ServerRecord,
  SyncTransport
} from './sync-api';
import { openSyncDb, type Change } from './sync-db';
import { SyncEngine } from './sync-engine';

let run = 0;
const DEVICE = '11111111-1111-4111-8111-111111111111';

async function makeEngine(options: { now?: () => number } = {}) {
  run += 1;
  const name = `sync-engine-test-${run}`;
  const warnings: string[] = [];
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(name),
    newId: () => DEVICE,
    now: options.now,
    warn: (m) => warnings.push(m)
  });
  return { engine, warnings, name };
}

/** A transport whose answers each test scripts. Records every call. */
class FakeTransport implements SyncTransport {
  pushes: Change[][] = [];
  pulls: (string | undefined)[] = [];
  registers: (string | null)[] = [];
  serverTime = 0;
  pushHandler: (changes: Change[]) => ChangeResult[] = (changes) =>
    changes.map((c, i) => ({ kind: c.kind, id: c.id, status: 'applied', rev: i + 1 }));
  pullPages: PullResponse[] = [];
  pullError: unknown = null;
  registerHandler: (id: string | null) => { device: { id: string; name: string } } = (id) => ({
    device: { id: id ?? DEVICE, name: 'Test' }
  });

  async register(deviceId: string | null) {
    this.registers.push(deviceId);
    return { ...this.registerHandler(deviceId), serverTime: this.serverTime };
  }

  async push(changes: Change[]): Promise<PushResponse> {
    this.pushes.push(changes);
    return { results: this.pushHandler(changes), serverTime: this.serverTime };
  }

  async pull(cursor: string | undefined): Promise<PullResponse> {
    this.pulls.push(cursor);
    if (this.pullError) {
      const error = this.pullError;
      this.pullError = null;
      throw error;
    }
    return (
      this.pullPages.shift() ?? {
        records: [],
        cursor: cursor ?? 'c0',
        more: false,
        serverTime: this.serverTime
      }
    );
  }
}

function serverRecord(partial: Partial<ServerRecord> & { kind: string; id: string }): ServerRecord {
  return {
    bookId: null,
    deviceId: '22222222-2222-4222-8222-222222222222',
    updatedAt: 1,
    deletedAt: null,
    rev: 1,
    data: {},
    ...partial
  };
}

describe('local writes', () => {
  it('writes the mirror and the outbox together, one outbox entry per record', async () => {
    const { engine } = await makeEngine({ now: () => 1000 });
    await engine.put('setting', 'global:a', { value: 1 });
    await engine.put('setting', 'global:a', { value: 2 });
    await engine.put('setting', 'global:a', { value: 3 });
    await engine.put('setting', 'global:b', { value: 1 });

    expect(await engine.get('setting', 'global:a')).toMatchObject({
      deviceId: DEVICE,
      data: { value: 3 },
      rev: null
    });
    // Same clock reading: each edit still gets a later timestamp than the one before.
    expect((await engine.get('setting', 'global:a'))?.updatedAt).toBe(1002);
    expect((await engine.status()).pending).toBe(2);

    const transport = new FakeTransport();
    await engine.sync(transport);
    expect(transport.pushes).toHaveLength(1);
    expect(transport.pushes[0].map((c) => [c.id, c.data])).toEqual([
      ['global:a', { value: 3 }],
      ['global:b', { value: 1 }]
    ]);
    expect((await engine.status()).pending).toBe(0);
  });

  it('stamps writes with the clock corrected by the server time', async () => {
    let clock = 10_000;
    const { engine } = await makeEngine({ now: () => clock });
    const transport = new FakeTransport();
    transport.serverTime = 50_000; // the device clock is 40 s behind
    await engine.sync(transport);
    clock = 11_000;
    const record = await engine.write('setting', 'global:a', { value: 1 });
    expect(record.updatedAt).toBe(51_000);
  });

  it('never throws from put or remove, even when storage fails', async () => {
    const { engine, warnings } = await makeEngine();
    engine.close();
    expect(await engine.put('setting', 'global:a', { value: 1 })).toBe(false);
    expect(await engine.remove('setting', 'global:a')).toBe(false);
    expect(warnings.join('\n')).toContain('could not save');
  });

  it('stores deletions as markers with empty data', async () => {
    const { engine } = await makeEngine({ now: () => 5 });
    await engine.put('setting', 'global:a', { value: 1 });
    await engine.remove('setting', 'global:a');
    expect(await engine.get('setting', 'global:a')).toMatchObject({ deletedAt: 6, data: {} });
  });

  it('tells listeners about local writes, and survives a failing listener', async () => {
    const { engine, warnings } = await makeEngine();
    const seen: string[] = [];
    engine.onLocalWrite(() => {
      throw new Error('boom');
    });
    engine.onLocalWrite((r) => seen.push(r.id));
    await engine.put('setting', 'global:a', { value: 1 });
    expect(seen).toEqual(['global:a']);
    expect(warnings.join()).toContain('listener failed');
  });
});

describe('push results', () => {
  it('keeps an edit made while the push was in flight', async () => {
    const { engine } = await makeEngine();
    await engine.put('setting', 'global:a', { value: 1 });
    const transport = new FakeTransport();
    const inner = transport.pushHandler;
    let edited = false;
    transport.push = async (changes) => {
      transport.pushes.push(changes);
      if (!edited) {
        edited = true;
        await engine.put('setting', 'global:a', { value: 2 });
      }
      return { results: inner(changes), serverTime: 0 };
    };
    await engine.sync(transport);
    // First push acknowledged value 1; value 2 is still queued.
    expect((await engine.status()).pending).toBe(1);
    await engine.sync(transport);
    expect(transport.pushes.map((p) => p[0].data)).toEqual([{ value: 1 }, { value: 2 }]);
    expect((await engine.status()).pending).toBe(0);
  });

  it('adopts the server copy for a stale write and records the rev of applied ones', async () => {
    const { engine } = await makeEngine();
    await engine.put('setting', 'global:a', { value: 'mine' });
    await engine.put('setting', 'global:b', { value: 'mine' });
    const transport = new FakeTransport();
    transport.pushHandler = (changes) => [
      {
        kind: 'setting',
        id: 'global:a',
        status: 'stale',
        record: serverRecord({ kind: 'setting', id: 'global:a', rev: 7, data: { value: 'theirs' } })
      },
      { kind: changes[1].kind, id: changes[1].id, status: 'applied', rev: 8 }
    ];
    const adopted: string[] = [];
    engine.onRemoteChange((records) => adopted.push(...records.map((r) => r.id)));
    const report = await engine.sync(transport);
    expect(report).toMatchObject({ pushed: 1, stale: 1 });
    expect(await engine.get('setting', 'global:a')).toMatchObject({
      rev: 7,
      data: { value: 'theirs' }
    });
    expect((await engine.get('setting', 'global:b'))?.rev).toBe(8);
    expect(adopted).toEqual(['global:a']);
  });

  it('sets refused changes aside and never retries them', async () => {
    const { engine, warnings } = await makeEngine();
    await engine.put('position', 'x', { charPos: 1 });
    const transport = new FakeTransport();
    transport.pushHandler = (changes) =>
      changes.map((c) => ({
        kind: c.kind,
        id: c.id,
        status: 'rejected',
        error: { code: 'unknown_book', message: 'No book' }
      }));
    const report = await engine.sync(transport);
    expect(report.rejected).toBe(1);
    expect(await engine.status()).toMatchObject({ pending: 0, rejected: 1 });
    await engine.sync(transport);
    expect(transport.pushes).toHaveLength(1);
    expect(warnings.join()).toContain('unknown_book');
  });

  it('pushes in batches', async () => {
    run += 1;
    const name = `sync-engine-batch-${run}`;
    const engine = await SyncEngine.open({
      openDb: () => openSyncDb(name),
      newId: () => DEVICE,
      pushBatchSize: 2
    });
    for (let i = 0; i < 5; i += 1) await engine.put('setting', `global:k${i}`, { value: i });
    const transport = new FakeTransport();
    await engine.sync(transport);
    expect(transport.pushes.map((p) => p.length)).toEqual([2, 2, 1]);
  });
});

describe('pull', () => {
  it('pages with the cursor and stores records, skipping ones with queued edits', async () => {
    const { engine } = await makeEngine();
    await engine.put('setting', 'global:mine', { value: 'local edit' });
    const transport = new FakeTransport();
    // The push fails (network): the local edit stays queued.
    transport.push = async () => {
      throw new LibraryApiError('unreachable', 'offline');
    };
    await expect(engine.sync(transport)).rejects.toThrow('offline');
    expect((await engine.status()).lastError).toBe('offline');

    // Pull directly through a working transport but keep the push failing first.
    const t2 = new FakeTransport();
    t2.pushHandler = (changes) =>
      changes.map((c) => ({ kind: c.kind, id: c.id, status: 'applied', rev: 50 }));
    t2.pullPages = [
      {
        records: [
          serverRecord({ kind: 'setting', id: 'global:x', rev: 1, data: { value: 1 } }),
          serverRecord({ kind: 'setting', id: 'global:y', rev: 2, data: { value: 2 } })
        ],
        cursor: 'c2',
        more: true,
        serverTime: 0
      },
      {
        records: [serverRecord({ kind: 'setting', id: 'global:z', rev: 3, deletedAt: 9 })],
        cursor: 'c3',
        more: false,
        serverTime: 0
      }
    ];
    const report = await engine.sync(t2);
    expect(report.pulled).toBe(3);
    expect(t2.pulls).toEqual([undefined, 'c2']);
    expect((await engine.getMeta()).cursor).toBe('c3');
    expect((await engine.get('setting', 'global:z'))?.deletedAt).toBe(9);
    expect((await engine.status()).lastError).toBeNull();

    // Next cycle starts from the stored cursor.
    await engine.sync(t2);
    expect(t2.pulls[2]).toBe('c3');
  });

  it('does not overwrite a queued local edit with a pulled copy', async () => {
    const { engine } = await makeEngine();
    await engine.put('setting', 'global:a', { value: 'local' });
    const transport = new FakeTransport();
    // Push "fails" by answering nothing for the entry; it stays queued.
    transport.pushHandler = () => [];
    transport.pullPages = [
      {
        records: [serverRecord({ kind: 'setting', id: 'global:a', data: { value: 'remote' } })],
        cursor: 'c1',
        more: false,
        serverTime: 0
      }
    ];
    await engine.sync(transport);
    expect((await engine.get('setting', 'global:a'))?.data).toEqual({ value: 'local' });
  });

  it('reconciles after cursor_reset: re-sends own records and pulls from the start', async () => {
    const { engine } = await makeEngine();
    const transport = new FakeTransport();
    await engine.put('setting', 'global:mine', { value: 1 });
    transport.pullPages = [
      {
        records: [serverRecord({ kind: 'setting', id: 'global:theirs', rev: 2 })],
        cursor: 'c2',
        more: false,
        serverTime: 0
      }
    ];
    await engine.sync(transport);
    expect(transport.pushes).toHaveLength(1);

    transport.pullError = new LibraryApiError('server', 'reset', 409, 'cursor_reset');
    const report = await engine.sync(transport);
    expect(report.reconciled).toBe(true);
    // Only this device's own record is re-sent, and the pull restarts without a cursor.
    expect(transport.pushes[1].map((c) => c.id)).toEqual(['global:mine']);
    expect(transport.pulls.slice(-2)).toEqual(['c2', undefined]);
  });
});

describe('registration', () => {
  it('registers once per transport and again when the server forgets the device', async () => {
    const { engine } = await makeEngine();
    const transport = new FakeTransport();
    await engine.sync(transport);
    await engine.sync(transport);
    expect(transport.registers).toEqual([DEVICE]);

    let failNext = true;
    const realPull = transport.pull.bind(transport);
    transport.pull = async (cursor) => {
      if (failNext) {
        failNext = false;
        throw new LibraryApiError('server', 'register', 409, 'device_not_registered');
      }
      return realPull(cursor);
    };
    await engine.sync(transport);
    expect(transport.registers).toEqual([DEVICE, DEVICE]);
  });

  it('adopts the id the server already bound to this token', async () => {
    const { engine, warnings } = await makeEngine();
    const bound = '33333333-3333-4333-8333-333333333333';
    const transport = new FakeTransport();
    transport.registerHandler = (id) => {
      if (id) throw new LibraryApiError('server', 'bound', 409, 'token_bound_to_other_device');
      return { device: { id: bound, name: 'Old' } };
    };
    await engine.sync(transport);
    expect(engine.deviceId).toBe(bound);
    expect((await engine.getMeta()).deviceId).toBe(bound);
    expect(warnings.join()).toContain('adopting');
  });

  it('shares one running cycle between concurrent calls', async () => {
    const { engine } = await makeEngine();
    const transport = new FakeTransport();
    const spy = vi.spyOn(transport, 'pull');
    await Promise.all([engine.sync(transport), engine.sync(transport)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
