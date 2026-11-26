/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Bookmeter sync's words and links on screen (2026-11-25). Pure. */

export const LIST_NAMES = {
  read: '読んだ本',
  reading: '読んでる本',
  stacked: '積読本',
  wish: '読みたい本'
} as const;

/** The book's 読書メーター page, or a search for its title when there is no listing. */
export function bookmeterBookUrl(listingId: string | null, title: string): string {
  if (listingId && /^\d{1,12}$/.test(listingId)) return `https://bookmeter.com/books/${listingId}`;
  return `https://bookmeter.com/search?keyword=${encodeURIComponent(title)}`;
}

/** "Reading 読書メーター: 5 of 15 pages, about 1 min left" (the time once two pages are in). */
export function checkingText(
  c: { kind: 'quick' | 'full'; done: number; total: number; startedAt: number },
  now: number
): string {
  const what = c.kind === 'full' ? 'Reading every page' : 'Reading the newest books';
  const pages = `${c.done} of ${c.total} ${c.total === 1 ? 'page' : 'pages'}`;
  if (c.done < 2 || c.total <= c.done) return `${what}: ${pages}`;
  const perPage = (now - c.startedAt) / c.done;
  const left = Math.max(1, Math.round((perPage * (c.total - c.done)) / 60_000));
  return `${what}: ${pages}, about ${left} min left`;
}

/** "2026/10/17" from "2026-10-17". */
export function slashDate(date: string): string {
  return date.replaceAll('-', '/');
}
