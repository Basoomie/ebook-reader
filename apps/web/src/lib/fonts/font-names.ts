/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { reservedFontNames } from '$lib/data/fonts';

/**
 * Names a custom font can't take: the bundled fonts plus the CSS generic and keyword
 * names. Kept in step with RESERVED_FONT_NAMES in the storage server's font-format.ts.
 */
const GENERIC_NAMES = [
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'math',
  'emoji',
  'fangsong',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default'
];

export const MAX_FONT_NAME = 64;

/**
 * A font name goes unquoted into the reader's CSS (`--font-family-serif`), so it is kept
 * to letters of any script, digits, spaces, `-` and `_`, starting with a letter, with
 * single spaces. Same rule as the server.
 */
const FONT_NAME_RE = /^\p{L}[\p{L}\p{M}\p{N}_-]*(?: [\p{L}\p{M}\p{N}_-]+)*$/u;

/**
 * What is wrong with a name for a new font, or null. `taken` are the names already in
 * used by the server fonts, compared without case.
 */
export function fontNameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!name) return 'Enter a name for the font';
  if (Array.from(name).length > MAX_FONT_NAME) {
    return `The name can be at most ${MAX_FONT_NAME} characters`;
  }
  if (!FONT_NAME_RE.test(name)) {
    return 'Use letters, digits, spaces, - and _ only, starting with a letter';
  }
  const lower = name.toLowerCase();
  if ([...reservedFontNames, ...GENERIC_NAMES].some((r) => r.toLowerCase() === lower)) {
    return 'That name belongs to a built-in font';
  }
  if (taken.some((t) => t.toLowerCase() === lower)) {
    return `There is already a font called "${name}"`;
  }
  return null;
}

/** The font file types the reader takes, by file name. */
export function isFontFileName(fileName: string): boolean {
  return /\.(woff2|woff|ttf|otf)$/i.test(fileName);
}

/** The custom fonts for the pickers: the server fonts in order, no duplicates. */
export function customFontNames(serverNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of serverNames) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** "1.2 MB" / "850 KB". */
export function formatFontSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
