/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * One page of a list (the book page's Audiobook section, 2026-11-20: no list there grows the
 * page without bound; long lists are shown a page at a time).
 */
export interface ListPage<T> {
  items: T[];
  /** 0-based, clamped to the pages there are. */
  page: number;
  /** At least 1, also for an empty list. */
  pages: number;
  /** 1-based position of the first and last item shown (0 and 0 for an empty list). */
  from: number;
  to: number;
  total: number;
}

export function pageOf<T>(all: readonly T[], page: number, size: number): ListPage<T> {
  const per = Math.max(1, Math.floor(size));
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)), pages - 1);
  const start = p * per;
  const items = all.slice(start, start + per);
  return {
    items,
    page: p,
    pages,
    from: items.length ? start + 1 : 0,
    to: start + items.length,
    total
  };
}

/** "1–5 of 23" under a paged list. */
export function pageRangeText(p: Pick<ListPage<unknown>, 'from' | 'to' | 'total'>): string {
  return `${p.from}–${p.to} of ${p.total.toLocaleString('en-US')}`;
}
