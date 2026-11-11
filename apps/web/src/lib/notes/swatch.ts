/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { EINK_UNDERLINES, HIGHLIGHT_SWATCHES } from '$lib/components/book-reader/highlight-colors';
import type { HighlightColor } from './highlights';

/**
 * WP19d: how a highlight color looks outside the book text. A tint (the reader's colors)
 * or, in E-ink mode, a black underline in that color's style.
 */
export function swatchStyle(color: HighlightColor, eink: boolean): string {
  return eink
    ? `text-decoration: underline ${EINK_UNDERLINES[color]} #000; text-decoration-thickness: 2px; text-underline-offset: 4px;`
    : `background-color: ${HIGHLIGHT_SWATCHES[color]};`;
}

/**
 * Solid versions of the five tints, for the edge bar of a highlight card and the filter
 * dots (a bar or dot that thin needs full color to be seen on cream and on navy).
 */
export const HIGHLIGHT_SOLIDS: Record<HighlightColor, string> = {
  1: '#f2c200',
  2: '#3cb86e',
  3: '#3f8cf0',
  4: '#ec5b9e',
  5: '#f08a2c'
};
