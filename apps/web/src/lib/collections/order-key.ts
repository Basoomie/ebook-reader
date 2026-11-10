/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Order keys of the books in a manual collection (WP8b). Each book's place is a
 * fractional key: a string between its neighbours' keys, so moving a book rewrites only
 * that book's record, and moves made on two devices offline merge book by book (the
 * later move of the same book wins).
 *
 * Keys are base-62 strings ("0-9A-Za-z", which sorts the same as plain string order),
 * never empty and never ending in "0" (so there is always room before a key). New keys
 * are picked at random inside the free range, so two devices adding at the same spot
 * offline rarely make the same key; equal keys are still handled (ordered by book id,
 * and fixed before something is placed between them, see placeAt in collections.ts).
 */
export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
/** Server limit (kinds.ts MAX_ORDER_KEY). */
export const MAX_KEY_LENGTH = 200;
/** Above this length, the whole collection gets fresh, short keys. */
export const REBALANCE_LENGTH = 120;

const KEY_RE = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export function isOrderKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= MAX_KEY_LENGTH && KEY_RE.test(key);
}

export type Random = () => number;

function digit(i: number): string {
  return DIGITS[i];
}

/** A digit index strictly between lo and hi (hi - lo >= 2), at random. */
function pick(lo: number, hi: number, random: Random): number {
  return lo + 1 + Math.floor(random() * (hi - lo - 1));
}

/** A key k with a < k < b. a = '' means the start, b = null the end. */
function midpoint(a: string, b: string | null, random: Random): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), random);
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : BASE;
  if (db - da > 1) return digit(pick(da, db, random));
  // Neighbouring digits: keep a's digit and go one level deeper.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return digit(da) + midpoint(a.slice(1), null, random);
}

/** A key after `a` that stays short when books are added at the end again and again. */
function after(a: string, random: Random): string {
  const last = DIGITS.indexOf(a[a.length - 1]);
  if (last < BASE - 1) {
    const step = 1 + Math.floor(random() * Math.min(2, BASE - 1 - last));
    return a.slice(0, -1) + digit(last + step);
  }
  return a + digit(1 + Math.floor(random() * 3));
}

/**
 * A key strictly between `a` and `b` (null = no neighbour on that side). Throws when
 * a >= b: equal neighbours must be separated first.
 */
export function keyBetween(
  a: string | null,
  b: string | null,
  random: Random = Math.random
): string {
  if (a !== null && b !== null && a >= b) throw new Error(`no key between ${a} and ${b}`);
  if (b === null) return a === null ? digit(pick(0, BASE, random)) : after(a, random);
  return midpoint(a ?? '', b, random);
}

/** n increasing keys of equal length, evenly spread (for a fresh order). */
export function evenKeys(n: number): string[] {
  if (n <= 0) return [];
  let width = 1;
  while (BASE ** width <= n + 1) width++;
  const span = BASE ** width;
  const keys: string[] = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * span) / (n + 1));
    let s = '';
    for (let w = 0; w < width; w++) {
      s = digit(v % BASE) + s;
      v = Math.floor(v / BASE);
    }
    // Never end in "0": "W0" and "W" sort the same way relative to others, so drop it.
    keys.push(s.replace(/0+$/, '') || digit(1));
  }
  return keys;
}
