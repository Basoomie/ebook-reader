/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookBlur } from '$lib/sync/book-state';

/**
 * Cover blur (WP7a, decisions "Library UI"): a book's own setting wins; "Follow tag
 * rules" (inherit, also no record) blurs the cover when any of its tags has a rule.
 */
export function isCoverBlurred(
  bookBlur: BookBlur | undefined,
  tags: readonly string[],
  blurredTags: ReadonlySet<string>
): boolean {
  if (bookBlur === 'always') return true;
  if (bookBlur === 'never') return false;
  return tags.some((tag) => blurredTags.has(tag));
}
