/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { isPinned, normalizeRows, pinRow, unpinRow, type PinTarget } from './rows';
import { homeRows$ } from './settings';

/** "Pin to Home" / "Unpin from Home" (WP7b): this device's Home rows. */

export function isPinnedToHome(rows: unknown, target: PinTarget): boolean {
  return isPinned(normalizeRows(rows), target);
}

export function setPinnedToHome(target: PinTarget, pinned: boolean): void {
  const rows = normalizeRows(homeRows$.getValue());
  homeRows$.next(pinned ? pinRow(rows, target) : unpinRow(rows, target));
}
