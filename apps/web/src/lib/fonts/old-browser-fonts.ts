/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Clean-up for the removed per-browser fonts (WP18). They were kept in the Cache API
 * (`ttu-userfonts`, deleted by the next service worker) with their list in localStorage
 * `userfonts`. Browsers offer the Cache API only in a secure context, so over plain http
 * no device ever had one; this only matters on localhost or https.
 */

export const OLD_USER_FONTS_KEY = 'userfonts';

export interface OldFontCleanupPlan {
  /** New values for Group 1 / Group 2, only for those that used a removed font. */
  groupOne?: string;
  groupTwo?: string;
  /** The removed font names (for the log). */
  removed: string[];
}

/** Names from the old `userfonts` list ([{name, path, fileName}]); [] when unreadable. */
export function oldFontNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map((f) => (f && typeof f.name === 'string' ? f.name : ''))
      .filter((name) => !!name);
  } catch {
    return [];
  }
}

/**
 * What to change: a font group that used a removed font goes back to the bundled default,
 * as the old dialog did when a font was deleted, unless a server font has the same name.
 */
export function planOldFontCleanup(
  raw: string | null,
  current: { groupOne: string; groupTwo: string },
  defaults: { groupOne: string; groupTwo: string },
  serverNames: readonly string[]
): OldFontCleanupPlan {
  const removed = oldFontNames(raw).filter((name) => !serverNames.includes(name));
  const plan: OldFontCleanupPlan = { removed };
  if (removed.includes(current.groupOne)) plan.groupOne = defaults.groupOne;
  if (removed.includes(current.groupTwo)) plan.groupTwo = defaults.groupTwo;
  return plan;
}
