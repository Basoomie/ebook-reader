/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { HighlightColor } from '$lib/notes/highlights';

/**
 * WP11a: how the five highlight colors look in lists and the bar. Must match the
 * `::highlight(ttu-hl-N)` rules in app.scss (light tints that work on light and dark
 * themes; in E-ink mode black underlines of five styles).
 */
export const HIGHLIGHT_SWATCHES: Record<HighlightColor, string> = {
  1: 'rgba(255, 214, 0, 0.55)',
  2: 'rgba(60, 200, 110, 0.45)',
  3: 'rgba(70, 150, 255, 0.45)',
  4: 'rgba(255, 100, 170, 0.45)',
  5: 'rgba(255, 140, 40, 0.5)'
};

export const EINK_UNDERLINES: Record<HighlightColor, string> = {
  1: 'solid',
  2: 'double',
  3: 'dotted',
  4: 'dashed',
  5: 'wavy'
};
