/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { availableThemes, type CustomTheme } from './theme-option';

/**
 * WP19b: light or dark for the catalogue pages (per device "Library Look"). "auto" follows
 * the reader's active theme: dark when its background is dark, so "Follow System
 * Light/Dark" carries over. E-ink always wins (app.scss).
 */
export type CatalogueLook = 'auto' | 'light' | 'dark';

/** The background colour of a reader theme (built-in or custom), or null. */
export function themeBackground(
  themeId: string,
  customThemes: Record<string, CustomTheme>
): string | null {
  return (
    availableThemes.get(themeId)?.backgroundColor ?? customThemes[themeId]?.backgroundColor ?? null
  );
}

/** Relative luminance (0-1) of an `rgba(...)`, `rgb(...)` or `#rrggbb` colour; null if unknown. */
export function luminance(color: string): number | null {
  let r: number;
  let g: number;
  let b: number;
  const rgb = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(color);
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (rgb) {
    [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  } else if (hex) {
    const n = parseInt(hex[1], 16);
    [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    return null;
  }
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function isCatalogueDark(
  look: string,
  themeId: string,
  customThemes: Record<string, CustomTheme>
): boolean {
  if (look === 'dark') return true;
  if (look === 'light') return false;
  const background = themeBackground(themeId, customThemes);
  const l = background ? luminance(background) : null;
  return l !== null && l < 0.2;
}
