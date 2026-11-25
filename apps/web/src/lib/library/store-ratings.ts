/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Store ratings on the book page and the Library cards (2026-11-25, docs/design/store-ratings.md):
 * what other readers thought, from the stores the book's links point at. Never shown as stars
 * (stars are only your own rating): a number, how many rated it and the store's name.
 *
 * - The pooled figure (Amazon and BOOK☆WALKER together, weighted by their counts) heads the line;
 *   each store's own figure follows, then 読書メーター's readers (only once the server switches
 *   読書メーター on: its links are being fixed) and Natively's learners.
 * - A Library card shows the figure only while the list is sorted by Rating, Most rated or Most
 *   read.
 *
 * Pure apart from the features store, so it is tested on its own.
 */
import { writable } from 'svelte/store';
import { writableArrayLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';
import type { BookRatingsAnswer, RatingFigure } from './api';
import type { CatalogBook } from './types';

export type RatingPart = 'pooled' | 'amazon_jp' | 'bookwalker' | 'bookmeter' | 'natively';
export const RATING_PARTS: readonly RatingPart[] = [
  'pooled',
  'amazon_jp',
  'bookwalker',
  'bookmeter',
  'natively'
];

/** Per device (Settings › Library › Book page › Ratings): the parts the book page shows. */
export const bookRatingParts$ = writableArrayLocalStorageSubject<RatingPart>()('bookRatingParts', [
  ...RATING_PARTS
]);

export const PART_LABELS: Record<RatingPart, string> = {
  pooled: 'Readers’ rating (the stores together)',
  amazon_jp: 'Amazon',
  bookwalker: 'BOOK☆WALKER',
  bookmeter: '読書メーター readers',
  natively: 'Natively learners'
};

/** What the server shows (GET /ratings/features); 読書メーター off until it says so. */
export const ratingFeatures$ = writable<{ bookmeter: boolean }>({ bookmeter: false });
let featuresAsked: Promise<void> | null = null;

/** Asks the server once per page load (a failure keeps the defaults). */
export function loadRatingFeatures(ask: () => Promise<{ bookmeter: boolean }>): Promise<void> {
  featuresAsked ??= ask()
    .then((f) => ratingFeatures$.set({ bookmeter: f.bookmeter === true }))
    .catch(() => {
      featuresAsked = null;
    });
  return featuresAsked;
}

const NUMBER = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return NUMBER.format(n);
}

/** Stars to one decimal ("4.0"). */
export function formatStars(avg: number): string {
  return (Math.round(avg * 10) / 10).toFixed(1);
}

export interface RatingPiece {
  part: RatingPart;
  /** The store's name ('' for the pooled figure). */
  label: string;
  /** "4.3 · 201 ratings", "12,850 read it · 98 reviews". */
  text: string;
  /** For the hover: "as of 25 Nov 2026". */
  checkedAt: number | null;
}

function siteText(part: RatingPart, f: RatingFigure): string | null {
  if (f.state === 'gone') return null;
  if (part === 'bookmeter') {
    if (f.count === null) return null;
    const reviews = f.reviews
      ? ` · ${formatCount(f.reviews)} ${f.reviews === 1 ? 'review' : 'reviews'}`
      : '';
    return `${formatCount(f.count)} read it${reviews}`;
  }
  if (f.avg === null || !f.count) return null;
  return `${formatStars(f.avg)} · ${formatCount(f.count)} ${f.count === 1 ? 'rating' : 'ratings'}`;
}

/** The book page's pieces in order, for the parts the device shows. Empty: nothing to show. */
export function ratingPieces(
  answer: BookRatingsAnswer,
  shown: readonly RatingPart[],
  features: { bookmeter: boolean }
): RatingPiece[] {
  const out: RatingPiece[] = [];
  const show = new Set(shown);
  const sites = (['amazon_jp', 'bookwalker'] as const).filter((s) => {
    const f = answer.sites[s];
    return f && siteText(s, f) !== null;
  });
  // The pooled figure leads only when it says more than the one store it is made of.
  if (show.has('pooled') && answer.pooled && sites.length !== 1) {
    const { avg, count } = answer.pooled;
    const latest = Math.max(...sites.map((s) => answer.sites[s]?.checkedAt ?? 0));
    out.push({
      part: 'pooled',
      label: '',
      text: `${formatStars(avg)} · ${formatCount(count)} ${count === 1 ? 'rating' : 'ratings'}`,
      checkedAt: latest > 0 ? latest : null
    });
  }
  for (const part of ['amazon_jp', 'bookwalker', 'bookmeter', 'natively'] as const) {
    if (!show.has(part)) continue;
    if (part === 'bookmeter' && !features.bookmeter) continue;
    const f = answer.sites[part];
    if (!f) continue;
    const text = siteText(part, f);
    if (text === null) continue;
    out.push({
      part,
      label: PART_LABELS[part],
      text,
      checkedAt: f.checkedAt > 0 ? f.checkedAt : null
    });
  }
  return out;
}

/** "as of 25 Nov 2026" for a piece's hover. */
export function asOfText(checkedAt: number | null): string {
  if (!checkedAt) return '';
  const d = new Date(checkedAt);
  return `as of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * The series page's line for volume 1 (later volumes rate higher: only the fans remain), e.g.
 * "Volume 1: 4.2 · 310 ratings · 5,120 read it"; null without a figure.
 */
export function volumeOneText(
  tile: { storeRating?: CatalogBook['storeRating']; readers?: number | null } | null | undefined,
  features: { bookmeter: boolean }
): string | null {
  if (!tile) return null;
  const parts: string[] = [];
  if (tile.storeRating) {
    const n = tile.storeRating.count;
    parts.push(
      `${formatStars(tile.storeRating.avg)} · ${formatCount(n)} ${n === 1 ? 'rating' : 'ratings'}`
    );
  }
  if (features.bookmeter && tile.readers !== null && tile.readers !== undefined) {
    parts.push(`${formatCount(tile.readers)} read it`);
  }
  return parts.length ? `Volume 1: ${parts.join(' · ')}` : null;
}

/**
 * A Library card's figure while the list is sorted by a store ratings' sort ('rating', 'ratings',
 * 'readers'); null under any other sort or without a value.
 */
export function cardRatingText(
  book: Pick<CatalogBook, 'storeRating' | 'readers'>,
  sortKey: string | null | undefined
): string | null {
  if (sortKey === 'rating' && book.storeRating) {
    return `${formatStars(book.storeRating.avg)} · ${formatCount(book.storeRating.count)}`;
  }
  if (sortKey === 'ratings' && book.storeRating) {
    const n = book.storeRating.count;
    return `${formatCount(n)} ${n === 1 ? 'rating' : 'ratings'}`;
  }
  if (sortKey === 'readers' && book.readers !== null && book.readers !== undefined) {
    return `${formatCount(book.readers)} read it`;
  }
  return null;
}

/** The refresher's time left: hours and minutes, days from two days on. */
export function refreshLeftText(seconds: number | null): string {
  if (seconds === null) return 'working out the time left';
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.round(minutes / 60);
  if (hours >= 48) return `about ${Math.round(hours / 24)} days left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `about ${h} h ${m} min left` : `about ${h} h left`;
}
