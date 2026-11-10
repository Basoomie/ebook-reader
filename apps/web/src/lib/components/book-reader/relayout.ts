/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { tick } from 'svelte';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * WP10e: waits until a style change (font, size, line height, indentation) has been laid
 * out: the props are applied, a newly chosen font has loaded (feature-detected) and the
 * browser has drawn a frame, so paragraph positions can be measured again.
 */
export async function layoutSettled() {
  await tick();
  await frame();

  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await document.fonts.ready;
    }
  } catch {
    // No font loading API: measure anyway.
  }

  await frame();
}
