/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  coverStoresOf,
  earlierCoverLabel,
  hasEarlierCovers,
  pictureSize,
  storeCoverText,
  storesWaiting
} from './covers';
import type { EarlierCover, StoreCover } from './types';

const earlier = (current: boolean, firstAt = Date.UTC(2026, 10, 12, 12)): EarlierCover => ({
  sha256: 'a'.repeat(64),
  width: 600,
  height: 900,
  bytes: 1000,
  firstAt,
  lastAt: firstAt,
  current
});

const store = (s: Partial<StoreCover>): StoreCover => ({
  store: 'amazon',
  id: 'B000000001',
  state: 'waiting',
  reason: null,
  width: null,
  height: null,
  bytes: null,
  same: false,
  ...s
});

describe('book covers in the edit form', () => {
  it('offers only stores with a saved direct id (as the server does)', () => {
    expect(
      coverStoresOf({ amazon_jp: 'B07DXV5BP2', bookwalker: '5b1a695e-9481-4a89-8bc2-c924090c6114' })
    ).toEqual(['amazon', 'bookwalker']);
    expect(coverStoresOf({ amazon: '4047273686' })).toEqual(['amazon']);
    expect(coverStoresOf({ amazon_jp: 'not an asin', isbn: '9784040000000' })).toEqual([]);
  });

  it('shows the earlier covers row only when a picture other than the cover now is kept', () => {
    expect(hasEarlierCovers([])).toBe(false);
    expect(hasEarlierCovers([earlier(true)])).toBe(false);
    expect(hasEarlierCovers([earlier(false), earlier(true)])).toBe(true);
  });

  it('names the first kept picture the original, the others by date', () => {
    const list = [earlier(false), earlier(false, Date.UTC(2026, 10, 20, 12))];
    expect(earlierCoverLabel(list, 0, 'en-GB')).toBe('Original');
    expect(earlierCoverLabel(list, 1, 'en-GB')).toBe('20 Nov 2026');
  });

  it('says what each store is doing in plain words', () => {
    expect(storeCoverText(store({}))).toBe('Asking Amazon…');
    // Ready, its picture still loading (the size is shown under the card anyway).
    expect(storeCoverText(store({ state: 'ready', width: 1050, height: 1500 }))).toBe('Loading…');
    expect(pictureSize(1050, 1500)).toBe('1050 × 1500');
    expect(storeCoverText(store({ store: 'bookwalker', state: 'none', reason: null }))).toBe(
      'BOOK☆WALKER has no cover for this book'
    );
    expect(pictureSize(null, 10)).toBe('');
    expect(storesWaiting([store({ state: 'ready' }), store({})])).toBe(true);
    expect(storesWaiting([store({ state: 'failed' })])).toBe(false);
    expect(storesWaiting(null)).toBe(false);
  });
});
