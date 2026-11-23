/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SummaryView } from './summary-api';
import { syncSummaries, type CachedSummary, type CacheLike } from './summary-cache';

function fakeCache(): CacheLike & { map: Map<string, CachedSummary> } {
  const map = new Map<string, CachedSummary>();
  const k = (b: string, l: string) => `${b}|${l}`;
  return {
    map,
    get: async (b, l) => map.get(k(b, l)),
    forBook: async (b) => [...map.values()].filter((c) => c.bookId === b),
    put: async (e) => void map.set(k(e.bookId, e.lang), e),
    remove: async (b, l) => void map.delete(k(b, l))
  };
}

const record = (bookId: string, summary: { id: number; langs: Record<string, string> } | null) =>
  ({
    kind: 'book-summary',
    id: bookId,
    bookId,
    deletedAt: null,
    updatedAt: 1,
    data: { summary, making: null, outcome: summary ? 'made' : null, note: null }
  }) as unknown as LocalRecord;

const view = (id: number, lang: string) => ({ id, viewLang: lang }) as unknown as SummaryView;

describe('summaries kept on the device', () => {
  it('fetches each saved language once, again only when its digest changes, and drops what is gone', async () => {
    const cache = fakeCache();
    const asked: string[] = [];
    const api = {
      get: async (b: string, l?: string) => {
        asked.push(`${b}|${l}`);
        return { summary: view(7, l!) };
      }
    };
    await syncSummaries([record('b1', { id: 7, langs: { ja: 'd1', en: 'e1' } })], api, cache);
    expect(asked).toEqual(['b1|ja', 'b1|en']);
    // Nothing changed: nothing asked.
    await syncSummaries([record('b1', { id: 7, langs: { ja: 'd1', en: 'e1' } })], api, cache);
    expect(asked).toHaveLength(2);
    // The English changed (an edit translated again): only it.
    await syncSummaries([record('b1', { id: 7, langs: { ja: 'd1', en: 'e2' } })], api, cache);
    expect(asked).toEqual(['b1|ja', 'b1|en', 'b1|en']);
    // Deleted: the copies go.
    const r = await syncSummaries([record('b1', null)], api, cache);
    expect(r.dropped).toBe(2);
    expect(cache.map.size).toBe(0);
  });

  it('a server error is returned, never thrown', async () => {
    const cache = fakeCache();
    const r = await syncSummaries(
      [record('b1', { id: 1, langs: { ja: 'x' } })],
      { get: async () => Promise.reject(new Error('offline')) },
      cache
    );
    expect(r.errors).toEqual(['b1: offline']);
  });
});
