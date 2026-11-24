/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LocalRecord } from '$lib/sync/sync-db';
import { skipWhenAutoOff } from './auto-switch';
import { descriptionBookLang, shownDescription } from './description-page';
import type { DescriptionView } from './summary-api';
import {
  syncDescriptions,
  type CachedDescription,
  type DescriptionCacheLike
} from './summary-cache';
import { languageChoices } from './summary-page';

const SOURCE = '<p>港町の灯台守。<br/>第三巻。</p><p>書き下ろし短編を収録。</p>';
const ORIGINAL = ['港町の灯台守。\n第三巻。', '書き下ろし短編を収録。'];
const EN = ['The lighthouse keeper.\nVolume three.', 'With a new short story.'];

const view = (o: Partial<DescriptionView>): DescriptionView => ({
  bookLang: 'ja',
  source: SOURCE,
  lang: 'en',
  state: 'done',
  error: null,
  translation: { paragraphs: EN, model: 'claude-sonnet-5-5', madeAt: 1 },
  ...o
});
const copy = (o: Partial<CachedDescription> = {}): CachedDescription => ({
  bookId: 'b1',
  lang: 'en',
  digest: 'd1',
  source: SOURCE,
  paragraphs: EN,
  savedAt: 1,
  ...o
});
const base = {
  original: ORIGINAL,
  description: SOURCE,
  lang: 'en',
  bookLang: 'ja',
  server: null as DescriptionView | null,
  cached: null as CachedDescription | null,
  offline: false
};

describe('the description in a language (session 4b)', () => {
  it('the buttons are the summary’s: the book’s language first, then the summary languages', () => {
    expect(languageChoices('ja', ['en', 'ja']).map((c) => [c.lang, c.original])).toEqual([
      ['ja', true],
      ['en', false]
    ]);
    // Only the original: one button, which the section doesn't show.
    expect(languageChoices('ja', ['ja'])).toHaveLength(1);
    expect(descriptionBookLang('en', ['jpn'])).toBe('en');
    expect(descriptionBookLang(null, ['eng'])).toBe('en');
    expect(descriptionBookLang(null, undefined)).toBe('ja');
  });

  it('shows the translation of today’s text; the original while it is made, failed or offline', () => {
    expect(shownDescription({ ...base, lang: 'ja' })).toMatchObject({
      paragraphs: ORIGINAL,
      translated: false,
      note: null
    });
    expect(shownDescription({ ...base, server: view({}) })).toMatchObject({
      paragraphs: EN,
      translated: true
    });
    expect(
      shownDescription({ ...base, server: view({ state: 'queued', translation: null }) })
    ).toMatchObject({ paragraphs: ORIGINAL, note: 'translating' });
    expect(
      shownDescription({
        ...base,
        server: view({ state: 'failed', error: 'refused', translation: null })
      })
    ).toMatchObject({ paragraphs: ORIGINAL, note: 'failed', error: 'refused' });
    // Offline: the device's copy, else the original with the note.
    expect(shownDescription({ ...base, offline: true, cached: copy() })).toMatchObject({
      paragraphs: EN,
      translated: true
    });
    expect(shownDescription({ ...base, offline: true })).toMatchObject({
      paragraphs: ORIGINAL,
      note: 'offline'
    });
  });

  it('never shows a translation of an older description', () => {
    const changed = '<p>新しい紹介文。</p>';
    const now = { ...base, description: changed, original: ['新しい紹介文。'] };
    // The device's copy and a server answer made from the old text are both ignored.
    expect(shownDescription({ ...now, offline: true, cached: copy() })).toMatchObject({
      paragraphs: ['新しい紹介文。'],
      translated: false,
      note: 'offline'
    });
    expect(shownDescription({ ...now, server: view({}) })).toMatchObject({
      translated: false,
      note: 'translating'
    });
    // An answer for another language is not this one's.
    expect(shownDescription({ ...base, server: view({ lang: 'fr' }) }).translated).toBe(false);
  });
});

function fakeCache(): DescriptionCacheLike & { map: Map<string, CachedDescription> } {
  const map = new Map<string, CachedDescription>();
  const k = (b: string, l: string) => `${b}|${l}`;
  return {
    map,
    getDescription: async (b, l) => map.get(k(b, l)),
    descriptionsFor: async (b) => [...map.values()].filter((c) => c.bookId === b),
    putDescription: async (e) => void map.set(k(e.bookId, e.lang), e),
    removeDescription: async (b, l) => void map.delete(k(b, l))
  };
}

const record = (descriptions?: Record<string, string>) =>
  ({
    kind: 'book-summary',
    id: 'b1',
    bookId: 'b1',
    deletedAt: null,
    updatedAt: 1,
    data: { summary: null, making: null, outcome: null, note: null, descriptions }
  }) as unknown as LocalRecord;

describe('description translations kept on the device', () => {
  it('fetched once per digest; dropped when the record no longer names them', async () => {
    const cache = fakeCache();
    const asked: string[] = [];
    const api = {
      description: async (b: string, l?: string) => {
        asked.push(`${b}|${l}`);
        return { source: SOURCE, translation: { paragraphs: EN } };
      }
    };
    await syncDescriptions([record({ en: 'd1' })], api, cache);
    expect(asked).toEqual(['b1|en']);
    expect(cache.map.get('b1|en')).toMatchObject({ source: SOURCE, paragraphs: EN, digest: 'd1' });
    await syncDescriptions([record({ en: 'd1' })], api, cache);
    expect(asked).toHaveLength(1);
    // A copy the page kept (digest '') is replaced by the record's.
    cache.map.set('b1|en', copy({ digest: '' }));
    await syncDescriptions([record({ en: 'd1' })], api, cache);
    expect(asked).toHaveLength(2);
    // The description changed: the server's record names nothing; the copy goes.
    const r = await syncDescriptions([record(undefined)], api, cache);
    expect(r.dropped).toBe(1);
    expect(cache.map.size).toBe(0);
  });
});

describe('"Make a summary when a book is first completed" off', () => {
  it('writes a summary-skip per book before the completion; nothing while it is on', async () => {
    const put = vi.fn(async () => true);
    await skipWhenAutoOff({ put }, ['b1', 'b2'], true);
    expect(put).not.toHaveBeenCalled();
    await skipWhenAutoOff({ put }, ['b1', 'b2'], false);
    expect(put.mock.calls).toEqual([
      ['summary-skip', 'b1', {}, { bookId: 'b1' }],
      ['summary-skip', 'b2', {}, { bookId: 'b2' }]
    ]);
    // A failing write never fails the completion.
    const warn = vi.fn();
    await skipWhenAutoOff(
      {
        put: async () => {
          throw new Error('disk');
        }
      },
      ['b3'],
      false,
      warn
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});
