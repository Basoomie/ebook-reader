/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { LocalRecord } from '$lib/sync/sync-db';
import {
  coverageNote,
  recapHidden,
  recapMeta,
  recapProgress,
  recapState,
  sinceText,
  volumeHeading,
  volumeRange
} from './recap-page';
import type { RecapCoverage, RecapResponse } from './summary-api';
import { syncRecaps, type CachedRecap, type RecapCacheLike } from './summary-cache';

const v = (label: string | null, title = `T${label}`) => ({ label, title });
const cov = (o: Partial<RecapCoverage> = {}): RecapCoverage => ({
  volumes: [],
  withSummary: 0,
  enough: false,
  stale: [],
  orderChanged: false,
  ...o
});

describe('the story so far: words', () => {
  it('names volumes by number, else by title; the range; the meta line has no model', () => {
    expect(volumeHeading(v('2', '半分の灯'))).toBe('Vol. 2 · 半分の灯');
    expect(volumeHeading(v(null, '外伝'))).toBe('外伝');
    expect(volumeRange([v('1'), v('2'), v('5')])).toBe('vols. 1–5');
    expect(volumeRange([v(null, '外伝'), v('2')])).toBe('外伝 to vol. 2');
    const line = recapMeta(
      { volumes: [v('1'), v('5')], madeAt: Date.UTC(2026, 10, 22, 12) },
      'en-GB'
    );
    expect(line).toBe('Built from the summaries of vols. 1–5 · updated 22 Nov 2026');
  });

  it('first appearance: "from vol. 2", threads "since", and never claimed past a gap', () => {
    expect(sinceText({ label: '2', title: 'x', gap: false })).toBe('from vol. 2');
    expect(sinceText({ label: '2', title: 'x', gap: false }, 'since')).toBe('since vol. 2');
    expect(sinceText({ label: '2', title: 'x', gap: true })).toBe('in the summaries from vol. 2');
    expect(sinceText({ label: '2', title: 'x', gap: true }, 'since')).toBe(
      'in the summaries since vol. 2'
    );
  });

  it('the coverage note: what it covers, the volumes without a summary, what is not in it yet', () => {
    const recapVols = [
      { bookId: 'a', label: '1', title: 'A', missing: false },
      { bookId: 'b', label: '2', title: 'B', missing: false },
      { bookId: 'c', label: '3', title: 'C', missing: true },
      { bookId: 'd', label: '4', title: 'D', missing: false }
    ];
    const n = coverageNote(
      recapVols,
      cov({
        stale: [
          { bookId: 'b', label: '2', title: 'B', why: 'changed' },
          { bookId: 'e', label: '5', title: 'E', why: 'not_in_recap' }
        ],
        orderChanged: true
      })
    );
    expect(n.covers).toBe('Covers vols. 1–4.');
    expect(n.builtFrom).toBe('Built from the summaries of vols. 1, 2 and 4.');
    expect(n.missing).toEqual([{ bookId: 'c', word: 'vol. 3' }]);
    expect(n.stale).toEqual([
      'vol. 2’s summary changed since',
      'vol. 5 isn’t in it yet',
      'the order of the volumes changed since'
    ]);
    // Without a recap: the series as it is now, nothing "not in it yet".
    const none = coverageNote(
      null,
      cov({ volumes: [{ bookId: 'a', label: '1', title: 'A', hasSummary: true }] })
    );
    expect(none).toMatchObject({
      covers: 'Covers vol. 1.',
      builtFrom: null,
      missing: [],
      stale: []
    });
  });
});

describe('the story so far: blur and states', () => {
  it('"Completed books": blurred unless every covered volume is Completed now', () => {
    expect(recapHidden('completed', ['completed', 'completed'])).toBe(false);
    expect(recapHidden('completed', ['completed', 'reading'])).toBe(true);
    expect(recapHidden('completed', ['completed', undefined])).toBe(true);
    expect(recapHidden('always', ['completed'])).toBe(true);
    expect(recapHidden('never', ['unread'])).toBe(false);
  });

  it('the panel says why there is none, or that one is being made, waited for or failed', () => {
    const s = (o: Partial<Parameters<typeof recapState>[0]>) =>
      recapState({ hasRecap: false, record: null, coverage: cov(), offline: false, ...o });
    expect(s({})).toEqual(['nothing_completed']);
    expect(
      s({ coverage: cov({ volumes: [{ bookId: 'a', label: '1', title: 'A', hasSummary: true }] }) })
    ).toEqual(['too_few']);
    expect(
      s({
        coverage: cov({
          volumes: [{ bookId: 'a', label: '1', title: 'A', hasSummary: true }],
          enough: true
        })
      })
    ).toEqual(['none']);
    expect(s({ record: { making: 'running', outcome: null } })).toEqual(['making']);
    expect(s({ record: { making: 'queued', outcome: null }, hasRecap: true })).toEqual([
      'waiting',
      'shown'
    ]);
    expect(s({ record: { making: null, outcome: 'failed' }, hasRecap: true })).toEqual([
      'failed',
      'shown'
    ]);
    expect(s({ offline: true, coverage: null })).toEqual(['offline_none']);
  });

  it('progress: the quiet wait in minutes, then the two steps', () => {
    const now = 1_000_000;
    expect(
      recapProgress({ making: 'queued', phase: null, since: null, due: now + 7.2 * 60_000 }, now)!
        .text
    ).toBe('Updates in about 8 min');
    expect(recapProgress({ making: 'queued', phase: null, since: null, due: now }, now)!.text).toBe(
      'Waiting to start'
    );
    const p = recapProgress(
      { making: 'running', phase: 'checking', since: now - 3 * 60_000, due: null },
      now
    )!;
    expect(p).toMatchObject({ value: 75, time: '3 min' });
    expect(recapProgress({ making: null, phase: null, since: null, due: null }, now)).toBeNull();
  });
});

describe('the story so far kept on the device', () => {
  function fakeCache(): RecapCacheLike & { map: Map<string, CachedRecap> } {
    const map = new Map<string, CachedRecap>();
    const k = (s: string, l: string) => `${s}|${l}`;
    return {
      map,
      getRecap: async (s, l) => map.get(k(s, l)),
      recapsFor: async (s) => [...map.values()].filter((c) => c.series === s),
      putRecap: async (e) => void map.set(k(e.series, e.lang), e),
      removeRecap: async (s, l) => void map.delete(k(s, l))
    };
  }
  const record = (series: string, recap: { id: number; langs: Record<string, string> } | null) =>
    ({
      kind: 'series-recap',
      id: series,
      bookId: null,
      deletedAt: null,
      updatedAt: 1,
      data: { series, recap, making: null, outcome: recap ? 'made' : null, note: null }
    }) as unknown as LocalRecord;

  it('fetches each saved language when its digest changes and drops a recap that is gone', async () => {
    const cache = fakeCache();
    const asked: string[] = [];
    const api = {
      recap: async (series: string, lang?: string) => {
        asked.push(`${series}|${lang}`);
        return { series, recap: { id: 7, viewLang: lang } } as unknown as RecapResponse;
      }
    };
    await syncRecaps([record('潮騒', { id: 7, langs: { ja: 'd1', en: 'd2' } })], api, cache);
    expect(asked).toEqual(['潮騒|ja', '潮騒|en']);
    await syncRecaps([record('潮騒', { id: 7, langs: { ja: 'd1', en: 'd3' } })], api, cache);
    expect(asked).toEqual(['潮騒|ja', '潮騒|en', '潮騒|en']);
    // Rebuilt (a new id): every language again.
    await syncRecaps([record('潮騒', { id: 8, langs: { ja: 'd4' } })], api, cache);
    expect([...cache.map.keys()]).toEqual(['潮騒|ja']);
    await syncRecaps([record('潮騒', null)], api, cache);
    expect(cache.map.size).toBe(0);
  });
});
