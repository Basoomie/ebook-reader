/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryApiError } from '$lib/library/api';
import type { SyncTransport } from './sync-api';
import { openSyncDb } from './sync-db';
import { SyncEngine } from './sync-engine';
import { SyncRunner, type RunnerEnv } from './sync-runner';

let run = 0;

function okTransport(): SyncTransport & { pushCount: number; pullCount: number } {
  const t = {
    pushCount: 0,
    pullCount: 0,
    async register(id: string | null) {
      return { device: { id: id ?? 'x', name: 'T' }, serverTime: Date.now() };
    },
    async push(changes: { kind: string; id: string }[]) {
      t.pushCount += 1;
      return {
        results: changes.map((c) => ({
          kind: c.kind,
          id: c.id,
          status: 'applied' as const,
          rev: 1
        })),
        serverTime: Date.now()
      };
    },
    async pull(cursor: string | undefined) {
      t.pullCount += 1;
      return { records: [], cursor: cursor ?? 'c', more: false, serverTime: Date.now() };
    }
  };
  return t;
}

async function setup(
  options: {
    transport?: SyncTransport | null;
    enabled?: boolean;
    debounce?: number;
    interval?: number;
    visible?: boolean;
  } = {}
) {
  run += 1;
  const name = `runner-test-${run}`;
  const engine = await SyncEngine.open({
    openDb: () => openSyncDb(name),
    newId: () => '11111111-1111-4111-8111-111111111111',
    warn: () => {}
  });
  const wake: (() => void)[] = [];
  const env: RunnerEnv = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onWake: (l) => {
      wake.push(l);
      return () => {};
    },
    isVisible: () => options.visible ?? true
  };
  const transport = options.transport === undefined ? okTransport() : options.transport;
  const syncSpy = vi.spyOn(engine, 'sync');
  const beforeSync = vi.fn(async () => {});
  const runner = new SyncRunner({
    getEngine: async () => engine,
    getTransport: async () => transport,
    beforeSync,
    settings: {
      enabled: () => options.enabled ?? true,
      debounceSeconds: () => options.debounce ?? 5,
      intervalMinutes: () => options.interval ?? 0
    },
    env,
    warn: () => {}
  });
  return { engine, runner, transport, syncSpy, beforeSync, wake };
}

/** Runs pending work: fake-indexeddb completes on real setImmediate macrotasks. */
async function flush() {
  for (let i = 0; i < 30; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Lets pending work finish, moves the fake clock, and lets the resulting work finish. */
async function settle(ms = 0) {
  await flush();
  if (ms) await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

describe('SyncRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('syncs at start, then after local changes once the debounce has passed', async () => {
    const t = await setup({ debounce: 5 });
    await t.runner.start();
    await settle();
    expect(t.syncSpy).toHaveBeenCalledTimes(1);
    expect(t.beforeSync).toHaveBeenCalledTimes(1);
    expect(t.runner.status$.getValue().state).toBe('idle');

    await t.engine.put('setting', 'global:a', { value: 1 });
    await t.engine.put('setting', 'global:b', { value: 1 });
    await settle(4000);
    expect(t.syncSpy).toHaveBeenCalledTimes(1);
    await settle(1500);
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
    expect(t.runner.status$.getValue().pending).toBe(0);
  });

  it('syncs when the browser comes online or the tab becomes visible', async () => {
    const t = await setup();
    await t.runner.start();
    await settle();
    t.wake.forEach((l) => l());
    await settle();
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
  });

  it('syncs periodically only while visible', async () => {
    const visible = await setup({ interval: 5 });
    await visible.runner.start();
    await settle(5 * 60_000 + 10);
    expect(visible.syncSpy).toHaveBeenCalledTimes(2);
    visible.runner.stop();

    const hidden = await setup({ interval: 5, visible: false });
    await hidden.runner.start();
    await settle(20 * 60_000);
    expect(hidden.syncSpy).toHaveBeenCalledTimes(1);
    hidden.runner.stop();
  });

  it('backs off after network errors and recovers', async () => {
    const transport = okTransport();
    let failing = true;
    const pull = transport.pull.bind(transport);
    transport.pull = async (cursor) => {
      if (failing) throw new LibraryApiError('unreachable', 'offline');
      return pull(cursor);
    };
    const t = await setup({ transport });
    await t.runner.start();
    await settle();
    expect(t.runner.status$.getValue()).toMatchObject({ state: 'error', lastError: 'offline' });
    // Local changes don't hammer the server while backing off.
    await t.engine.put('setting', 'global:a', { value: 1 });
    await settle(10_000);
    expect(t.syncSpy).toHaveBeenCalledTimes(1);
    await settle(20_000); // first retry after 30 s
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
    await settle(59_000); // second retry after another 60 s
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
    failing = false;
    await settle(1_100);
    expect(t.syncSpy).toHaveBeenCalledTimes(3);
    expect(t.runner.status$.getValue()).toMatchObject({ state: 'idle', lastError: null });
  });

  it('stops retrying after an auth error until the connection changes', async () => {
    const transport = okTransport();
    let bad = true;
    const pull = transport.pull.bind(transport);
    transport.pull = async (cursor) => {
      if (bad) throw new LibraryApiError('unauthorized', 'revoked', 401);
      return pull(cursor);
    };
    const t = await setup({ transport });
    await t.runner.start();
    await settle(60 * 60_000);
    expect(t.syncSpy).toHaveBeenCalledTimes(1);
    bad = false;
    t.runner.connectionChanged();
    await settle();
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
  });

  it('reports off and not connected without syncing', async () => {
    const off = await setup({ enabled: false });
    await off.runner.start();
    await settle();
    expect(off.runner.status$.getValue().state).toBe('off');
    expect(off.syncSpy).not.toHaveBeenCalled();

    const none = await setup({ transport: null });
    await none.runner.start();
    await settle();
    expect(none.runner.status$.getValue().state).toBe('disconnected');
  });

  it('"Sync now" runs immediately and never rejects', async () => {
    const transport = okTransport();
    transport.push = async () => {
      throw new LibraryApiError('unreachable', 'offline');
    };
    const t = await setup({ transport });
    await t.engine.put('setting', 'global:a', { value: 1 });
    const result = t.runner.syncNow();
    await settle();
    await expect(result).resolves.toBeNull();
  });

  it('"sync soon" (opening a book) runs at once and reports what it pulled', async () => {
    const t = await setup();
    await t.runner.start();
    await settle();
    const result = t.runner.syncSoon();
    await settle();
    await expect(result).resolves.toMatchObject({ pulled: 0 });
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
  });

  it('"sync soon" respects the backoff and an auth stop', async () => {
    const transport = okTransport();
    let error: LibraryApiError | null = new LibraryApiError('unreachable', 'offline');
    const pull = transport.pull.bind(transport);
    transport.pull = async (cursor) => {
      if (error) throw error;
      return pull(cursor);
    };
    const t = await setup({ transport });
    await t.runner.start();
    await settle();
    await expect(t.runner.syncSoon()).resolves.toBeNull();
    expect(t.syncSpy).toHaveBeenCalledTimes(1);

    error = new LibraryApiError('unauthorized', 'revoked', 401);
    await settle(30_000); // the backoff retry hits the auth error
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
    await expect(t.runner.syncSoon()).resolves.toBeNull();
    expect(t.syncSpy).toHaveBeenCalledTimes(2);
  });
});
