/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

export enum LocalFont {
  KZUDGOTHIC = 'KZ UDGothic',
  KZUDMINCHO = 'KZ UDMincho',
  GENEI = 'Genei Koburi Mincho v5',
  KLEEONE = 'Klee One',
  KLEEONESEMIBOLD = 'Klee One SemiBold',
  NOTOSANSJP = 'Noto Sans JP',
  NOTOSERIFJP = 'Noto Serif JP',
  SHIPPORIMINCHO = 'Shippori Mincho',
  SERIF = 'Serif',
  SANSSERIF = 'Sans-Serif'
}

export const reservedFontNames = new Set([
  'KZ UDGothic',
  'KZ UDMincho',
  'Genei Koburi Mincho v5',
  'Klee One',
  'Klee One SemiBold',
  'Noto Sans JP',
  'Noto Serif JP',
  'Shippori Mincho',
  'Serif',
  'Sans-Serif'
]);

/**
 * Every font name a font setting can use on this device: the bundled fonts plus the
 * custom (server) fonts. "Copy from another device" keeps the current font when the other
 * device's font isn't one of these.
 */
export function availableFontNames(customFonts: readonly string[]): string[] {
  return [...new Set<string>([...Object.values(LocalFont), ...customFonts])];
}
