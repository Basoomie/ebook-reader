/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { BookRatingsAnswer } from './api';
import {
  RATING_PARTS,
  cardRatingText,
  ratingPieces,
  refreshLeftText,
  volumeOneText
} from './store-ratings';

const fig = (avg: number | null, count: number | null, reviews: number | null = null) => ({
  avg,
  count,
  reviews,
  state: 'ok' as const,
  checkedAt: 1_700_000_000_000
});

const answer: BookRatingsAnswer = {
  pooled: { avg: 4.3, count: 251 },
  readers: 12850,
  sites: {
    amazon_jp: fig(4.3, 201),
    bookwalker: fig(4.4, 50),
    bookmeter: fig(null, 12850, 98),
    natively: fig(3, 1)
  },
  refreshing: false
};

describe('ratingPieces (the book page line)', () => {
  it('leads with the pooled figure, then each store, never stars', () => {
    const texts = ratingPieces(answer, RATING_PARTS, { bookmeter: true }).map((p) => [
      p.label,
      p.text
    ]);
    expect(texts).toEqual([
      ['', '4.3 · 251 ratings'],
      ['Amazon', '4.3 · 201 ratings'],
      ['BOOK☆WALKER', '4.4 · 50 ratings'],
      ['読書メーター readers', '12,850 read it'],
      ['Natively learners', '3.0 · 1 rating']
    ]);
    expect(texts.join(' ')).not.toMatch(/★/);
  });

  it('hides 読書メーター until the server shows it, and the parts this device turned off', () => {
    const parts = ratingPieces(answer, ['pooled', 'amazon_jp', 'bookmeter'], {
      bookmeter: false
    }).map((p) => p.part);
    expect(parts).toEqual(['pooled', 'amazon_jp']);
  });

  it('drops the pooled figure when one store makes it (it would say the same twice)', () => {
    const one: BookRatingsAnswer = {
      ...answer,
      pooled: { avg: 4.3, count: 201 },
      sites: { amazon_jp: fig(4.3, 201) }
    };
    expect(ratingPieces(one, RATING_PARTS, { bookmeter: true }).map((p) => p.part)).toEqual([
      'amazon_jp'
    ]);
    // Offline: only the pooled figure the book carries.
    expect(
      ratingPieces({ ...answer, sites: {} }, RATING_PARTS, { bookmeter: true }).map((p) => p.part)
    ).toEqual(['pooled']);
  });

  it('shows nothing for a removed page or no ratings', () => {
    const none: BookRatingsAnswer = {
      pooled: null,
      readers: null,
      sites: {
        amazon_jp: { ...fig(null, 0), state: 'none' },
        bookwalker: { ...fig(null, null), state: 'gone' }
      },
      refreshing: false
    };
    expect(ratingPieces(none, RATING_PARTS, { bookmeter: true })).toEqual([]);
  });
});

describe('cardRatingText (only under the store ratings sorts)', () => {
  const book = { storeRating: { avg: 4.25, count: 1204, score: 4200 }, readers: 5100 };
  it('shows the figure of the sort in use', () => {
    expect(cardRatingText(book, 'rating')).toBe('4.3 · 1,204');
    expect(cardRatingText(book, 'ratings')).toBe('1,204 ratings');
    expect(cardRatingText(book, 'readers')).toBe('5,100 read it');
  });
  it('shows nothing under another sort or without a figure', () => {
    expect(cardRatingText(book, 'added')).toBeNull();
    expect(cardRatingText(book, null)).toBeNull();
    expect(cardRatingText({ storeRating: null, readers: null }, 'rating')).toBeNull();
  });
});

describe('volumeOneText (the series page)', () => {
  it("gives volume 1's figures", () => {
    expect(
      volumeOneText(
        { storeRating: { avg: 4.2, count: 310, score: 0 }, readers: 5120 },
        {
          bookmeter: true
        }
      )
    ).toBe('Volume 1: 4.2 · 310 ratings · 5,120 read it');
    expect(
      volumeOneText(
        { storeRating: { avg: 4.2, count: 310, score: 0 }, readers: 5120 },
        {
          bookmeter: false
        }
      )
    ).toBe('Volume 1: 4.2 · 310 ratings');
    expect(volumeOneText(null, { bookmeter: true })).toBeNull();
  });
});

describe('refreshLeftText (the fetch bar)', () => {
  it('says when the pace is still being measured, then minutes, hours or days', () => {
    expect(refreshLeftText(null)).toBe('working out the time left');
    expect(refreshLeftText(0)).toBe('');
    expect(refreshLeftText(30 * 60)).toBe('about 30 min left');
    expect(refreshLeftText(5 * 3600 + 600)).toBe('about 5 h 10 min left');
    expect(refreshLeftText(3 * 86_400)).toBe('about 3 days left');
  });
});
