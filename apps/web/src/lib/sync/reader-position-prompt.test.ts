/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PositionPrompt, PromptPlace, PromptRow } from './position-prompt-service';
import { ReaderPositionPrompt, type PromptApi, type ReaderHooks } from './reader-position-prompt';

const BOOK = 'book-1';

function row(recordId: string, target: number, updatedAt = 1): PromptRow {
  return {
    recordId,
    updatedAt,
    localAt: updatedAt,
    deviceId: recordId.split(':')[1] ?? 'd',
    deviceName: 'Phone',
    isOwn: false,
    target,
    approximate: false
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(options: { bookId?: string | null } = {}) {
  const prompts: (PositionPrompt | null)[] = [];
  const finds: PromptPlace[] = [];
  const handled: { recordId: string; updatedAt: number }[][] = [];
  const sync = deferred<unknown>();
  const changed: (() => void)[] = [];
  const visible: (() => void)[] = [];
  const closed: (() => void)[] = [];
  const asks: { prompt: PositionPrompt; answer: (row: PromptRow | null) => void }[] = [];
  const jumps: PromptRow[] = [];
  const state = { live: 1000, total: 100_000, dialog: false };

  const api: PromptApi = {
    bookId: vi.fn(async () => (options.bookId === undefined ? BOOK : options.bookId)),
    find: vi.fn(async (_bookId: string, place: PromptPlace) => {
      finds.push(place);
      return prompts.shift() ?? null;
    }),
    markHandled: vi.fn(async (_bookId, answered) => {
      handled.push(answered);
    }),
    onChanged: vi.fn(async (_bookId, cb) => {
      changed.push(cb);
      return () => changed.splice(changed.indexOf(cb), 1);
    }),
    syncSoon: vi.fn(() => sync.promise)
  };
  const hooks: ReaderHooks = {
    livePos: () => state.live,
    total: () => state.total,
    otherDialogOpen: () => state.dialog,
    onDialogsClosed: (cb) => {
      closed.push(cb);
      return () => closed.splice(closed.indexOf(cb), 1);
    },
    onVisible: (cb) => {
      visible.push(cb);
      return () => visible.splice(visible.indexOf(cb), 1);
    },
    ask: (prompt) =>
      new Promise((resolve) => {
        state.dialog = true;
        asks.push({
          prompt,
          answer: (r) => {
            state.dialog = false;
            resolve(r);
            closed.forEach((cb) => cb());
          }
        });
      }),
    jump: (r) => jumps.push(r),
    warn: () => {}
  };
  const controller = new ReaderPositionPrompt(api, hooks);
  return {
    api,
    controller,
    prompts,
    finds,
    handled,
    sync,
    changed,
    visible,
    closed,
    asks,
    jumps,
    state
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function prompt(...rows: PromptRow[]): PositionPrompt {
  return { bookId: BOOK, rows, lastSyncAt: null, lastError: null };
}

describe('ReaderPositionPrompt', () => {
  it('does nothing for a book without a Calibre link', async () => {
    const h = harness({ bookId: null });
    await h.controller.start(1, 'Title', 500);
    expect(h.api.find).not.toHaveBeenCalled();
    expect(h.api.syncSoon).not.toHaveBeenCalled();
  });

  it('checks the mirror on open, then again after the opening sync, with the own record', async () => {
    const h = harness();
    h.state.live = 4980; // the page start, a little before the saved place
    const started = h.controller.start(1, 'Title', 5000);
    await tick();
    expect(h.finds).toEqual([{ localPos: 5000, localTotal: 100_000, ownBaseline: 5000 }]);
    h.sync.resolve(null);
    await started;
    expect(h.finds).toHaveLength(2);
    expect(h.finds[1].ownBaseline).toBe(5000);
  });

  it('jumps on Continue and marks every shown version as answered', async () => {
    const h = harness();
    const a = row(`${BOOK}:a`, 40_000, 5);
    const b = row(`${BOOK}:b`, 30_000, 4);
    h.prompts.push(prompt(a, b));
    const started = h.controller.start(1, 'Title', 1000);
    await tick();
    expect(h.asks).toHaveLength(1);
    h.asks[0].answer(a);
    h.sync.resolve(null);
    await started;
    expect(h.jumps).toEqual([a]);
    expect(h.handled).toEqual([
      [
        { recordId: a.recordId, updatedAt: 5 },
        { recordId: b.recordId, updatedAt: 4 }
      ]
    ]);
  });

  it('stays on "Stay here" and still marks the versions as answered', async () => {
    const h = harness();
    h.prompts.push(prompt(row(`${BOOK}:a`, 40_000)));
    const started = h.controller.start(1, 'Title', 1000);
    await tick();
    h.asks[0].answer(null);
    h.sync.resolve(null);
    await started;
    expect(h.jumps).toEqual([]);
    expect(h.handled).toHaveLength(1);
  });

  it('runs the opening sync while the first prompt is open and checks again after the answer', async () => {
    const h = harness();
    h.prompts.push(prompt(row(`${BOOK}:a`, 40_000)));
    const started = h.controller.start(1, 'Title', 1000);
    await tick();
    expect(h.api.syncSoon).toHaveBeenCalled();
    h.sync.resolve(null);
    await tick();
    expect(h.finds).toHaveLength(1); // queued behind the open prompt
    h.asks[0].answer(null);
    await started;
    await tick();
    expect(h.finds).toHaveLength(2);
    expect(h.finds[1].ownBaseline).toBe(1000); // still an open check
  });

  it('checks again mid-session, for other devices only, against the live place', async () => {
    const h = harness();
    h.sync.resolve(null);
    await h.controller.start(1, 'Title', 1000);
    h.state.live = 7000;
    h.visible.forEach((cb) => cb());
    await tick();
    expect(h.finds.at(-1)).toEqual({ localPos: 7000, localTotal: 100_000, ownBaseline: null });
    h.changed.forEach((cb) => cb());
    await tick();
    expect(h.finds).toHaveLength(4);
  });

  it('never prompts over another dialog; checks again once it closes', async () => {
    const h = harness();
    h.sync.resolve(null);
    await h.controller.start(1, 'Title', 1000);
    const before = h.finds.length;
    h.state.dialog = true;
    h.visible.forEach((cb) => cb());
    await tick();
    expect(h.finds).toHaveLength(before);
    h.state.dialog = false;
    h.prompts.push(prompt(row(`${BOOK}:a`, 40_000)));
    // The other dialog closes.
    h.closed.forEach((cb) => cb());
    await tick();
    expect(h.asks).toHaveLength(1);
  });

  it('leaving the reader while asking answers nothing and stops listening', async () => {
    const h = harness();
    h.prompts.push(prompt(row(`${BOOK}:a`, 40_000)));
    h.sync.resolve(null);
    const started = h.controller.start(1, 'Title', 1000);
    await tick();
    h.controller.destroy();
    await started;
    expect(h.handled).toEqual([]);
    expect(h.jumps).toEqual([]);
    expect(h.visible).toHaveLength(0);
    expect(h.changed).toHaveLength(0);
  });

  it('swallows failures', async () => {
    const h = harness();
    h.api.find = vi.fn(async () => {
      throw new Error('boom');
    });
    h.sync.resolve(null);
    await expect(h.controller.start(1, 'Title', 1000)).resolves.toBeUndefined();
  });
});
