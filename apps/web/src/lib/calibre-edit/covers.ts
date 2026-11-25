/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Book covers (docs/design/book-covers.md): the words and rules of the edit form's "Earlier
 * covers" and "From the stores" rows. The stores rule mirrors the server's
 * (storage-server/src/cleanup/edits/store-covers.ts): only a saved direct id, never a search.
 */
import type { CoverStore, EarlierCover, StoreCover } from './types';

export const STORE_NAMES: Record<CoverStore, string> = {
  amazon: 'Amazon',
  bookwalker: 'BOOK☆WALKER'
};

/** The stores the book has a saved direct id for (the order the row shows them in). */
export function coverStoresOf(identifiers: Record<string, string>): CoverStore[] {
  const ids = new Map(Object.entries(identifiers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const out: CoverStore[] = [];
  if ([ids.get('amazon_jp'), ids.get('amazon')].some((v) => !!v && /^[A-Z0-9]{10}$/.test(v)))
    out.push('amazon');
  const bw = ids.get('bookwalker');
  if (bw && /^[0-9a-f-]{20,}$/i.test(bw)) out.push('bookwalker');
  return out;
}

/** "1600 × 2400" (pixels), or '' when the size isn't known. */
export function pictureSize(width: number | null, height: number | null): string {
  return width && height ? `${width} × ${height}` : '';
}

/** Whether the earlier covers row has anything to offer (a picture that isn't the cover now). */
export function hasEarlierCovers(covers: EarlierCover[]): boolean {
  return covers.some((c) => !c.current);
}

/**
 * The label under an earlier cover: the first one the server kept is the original; the others
 * say when the server first kept them (the row's heading says they are earlier covers).
 */
export function earlierCoverLabel(covers: EarlierCover[], i: number, locale?: string): string {
  if (i === 0) return 'Original';
  const d = new Date(covers[i].firstAt);
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** What a store's card says while it has no picture. */
export function storeCoverText(s: StoreCover): string {
  const name = STORE_NAMES[s.store];
  if (s.state === 'waiting') return `Asking ${name}…`;
  if (s.state === 'ready') return 'Loading…';
  return s.reason ?? `${name} has no cover for this book`;
}

/** Whether the row should ask the server again soon (a store is still being asked). */
export function storesWaiting(stores: StoreCover[] | null): boolean {
  return !!stores && stores.some((s) => s.state === 'waiting');
}
