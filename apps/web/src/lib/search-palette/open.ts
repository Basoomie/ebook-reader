/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import SearchPalette from '$lib/components/search-palette/search-palette.svelte';
import { dialogManager } from '$lib/data/dialog-manager';

let open = false;

/** Opens the search palette (search palette step 2), once: a second call while it's open does nothing. */
export async function openSearchPalette(initialQuery = ''): Promise<void> {
  if (open) return;
  open = true;
  try {
    await dialogManager.open(SearchPalette, { initialQuery });
  } finally {
    open = false;
  }
}

/** The key that opens the palette: "/" (not while typing), or Ctrl+K / ⌘K when that is on. */
export function opensPalette(event: KeyboardEvent, ctrlK: boolean): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (
    ctrlK &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'k'
  ) {
    return true;
  }
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (!target) return true;
  if (target.isContentEditable) return false;
  const tag = target.tagName;
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT';
}
