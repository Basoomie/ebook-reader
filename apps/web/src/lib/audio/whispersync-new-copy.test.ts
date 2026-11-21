/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
// Load the store first, like the app does (store.ts and database.service.ts import each other).
import '$lib/data/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooksDb } from '$lib/data/database/books-db/factory';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * A library book just stored on this device gets its whispersync data (match, subtitles,
 * listening position) into the reader's rows before the reader opens: the first open
 * shows the matched text and needs no "Newer audiobook data" reload.
 */

const MATCHED = '<div data-ttu-whispersync-matched-by="a.srt"><span>matched</span></div>';
const ORIGINAL = '<div>original</div>';

const state = vi.hoisted(() => ({
  connection: null as { serverUrl: string; token: string } | null,
  records: new Map<string, unknown>(),
  files: new Map<string, { text: string; sha256: string }>(),
  downloadSignals: [] as (AbortSignal | undefined)[],
  /** What the sync runner's pull brings (null: no runner). */
  onSync: null as (() => void) | null
}));

vi.mock('$lib/library/library-db', async (original) => ({
  ...(await original<typeof import('$lib/library/library-db')>()),
  getLibraryStore: () => ({ getConnection: async () => state.connection })
}));

vi.mock('$lib/sync/sync-service', () => ({
  getSyncEngine: async () => ({
    get: async (kind: string, id: string) => state.records.get(`${kind}|${id}`),
    put: async () => true,
    remove: async () => true
  }),
  getSyncRunner: () =>
    state.onSync
      ? {
          syncNow: async () => {
            await new Promise((r) => setTimeout(r, 20));
            state.onSync?.();
          }
        }
      : null,
  bookIdForLocalBook: async () => null
}));

vi.mock('$lib/library/api', async (original) => {
  const real = await original<typeof import('$lib/library/api')>();
  class FakeApi {
    async downloadAttachment(_bookId: string, name: string, options?: { signal?: AbortSignal }) {
      state.downloadSignals.push(options?.signal);
      return state.files.get(name) ?? null;
    }
    async uploadAttachment() {
      return 'ok' as const;
    }
  }
  return { ...real, LibraryApi: FakeApi };
});

const { syncWhispersyncForNewCopy } = await import('./whispersync-reader');

function record(kind: string, id: string, data: Record<string, unknown>): LocalRecord {
  return { kind, id, bookId: 'b1', deviceId: 'other', updatedAt: 1, deletedAt: null, rev: 1, data };
}

function remote(name: string, payload: unknown, modifiedAt: number) {
  const text = JSON.stringify(payload);
  const sha256 = `sha-${name}`;
  state.files.set(name, { text, sha256 });
  state.records.set(
    `book-attachment|b1:${name}`,
    record('book-attachment', `b1:${name}`, { size: text.length, sha256, modifiedAt })
  );
}

let run = 0;
beforeEach(() => {
  run += 1;
  state.connection = { serverUrl: 'http://library.test', token: 't' };
  state.records.clear();
  state.files.clear();
  state.downloadSignals = [];
  state.onSync = null;
});

async function storedCopy() {
  const db = await createBooksDb(`new-copy-${run}`);
  const localId = (await db.add('data', {
    title: '本',
    elementHtml: ORIGINAL,
    lastBookModified: 50_000
  } as never)) as number;
  return { db, localId };
}

describe('syncWhispersyncForNewCopy', () => {
  it("brings another device's match, subtitles and position into this copy", async () => {
    const { db, localId } = await storedCopy();
    remote('whispersync-match', { elementHtml: MATCHED, htmlBackup: ORIGINAL }, 1_000);
    remote('whispersync-subtitles', { subtitleData: { name: 'a.srt', subtitles: [1] } }, 2_000);
    state.records.set(
      'audiobook-position|b1',
      record('audiobook-position', 'b1', { position: 42.5, modifiedAt: 3_000 })
    );

    const controller = new AbortController();
    await syncWhispersyncForNewCopy(
      { bookId: 'b1', localId, title: '本', fileSha256: null },
      db,
      controller.signal
    );

    const data = await db.get('data', localId);
    expect(data?.elementHtml).toBe(MATCHED);
    expect(data?.htmlBackup).toBe(ORIGINAL);
    expect(data?.lastBookModified).toBe(1_000);
    expect((await db.get('subtitle', '本'))?.subtitleData).toEqual({
      name: 'a.srt',
      subtitles: [1]
    });
    expect((await db.get('audioBook', '本'))?.playbackPosition).toBe(42.5);
    // The downloads can be cancelled with the opening.
    expect(state.downloadSignals).toEqual([controller.signal, controller.signal]);
  });

  it('fetches the latest records first (a device whose records are behind)', async () => {
    const { db, localId } = await storedCopy();
    // The match's record reaches this device only with the next pull.
    state.onSync = () =>
      remote('whispersync-match', { elementHtml: MATCHED, htmlBackup: ORIGINAL }, 1_000);
    await syncWhispersyncForNewCopy({ bookId: 'b1', localId, title: '本', fileSha256: null }, db);
    expect((await db.get('data', localId))?.elementHtml).toBe(MATCHED);
  });

  it('does nothing without a library connection or with nothing saved, and never throws', async () => {
    const { db, localId } = await storedCopy();
    remote('whispersync-match', { elementHtml: MATCHED, htmlBackup: ORIGINAL }, 1_000);
    state.connection = null;
    await syncWhispersyncForNewCopy({ bookId: 'b1', localId, title: '本', fileSha256: null }, db);
    expect((await db.get('data', localId))?.elementHtml).toBe(ORIGINAL);

    state.connection = { serverUrl: 'http://library.test', token: 't' };
    state.records.clear();
    await syncWhispersyncForNewCopy({ bookId: 'b1', localId, title: '本', fileSha256: null }, db);
    expect((await db.get('data', localId))?.elementHtml).toBe(ORIGINAL);
    expect(await db.get('audioBook', '本')).toBeUndefined();
  });

  it('keeps the copy as it is when the match was made from another file', async () => {
    const { db, localId } = await storedCopy();
    remote(
      'whispersync-match',
      { elementHtml: MATCHED, htmlBackup: ORIGINAL, fileSha256: 'sha-other' },
      1_000
    );
    await syncWhispersyncForNewCopy(
      { bookId: 'b1', localId, title: '本', fileSha256: 'sha-this' },
      db
    );
    expect((await db.get('data', localId))?.elementHtml).toBe(ORIGINAL);
  });
});
