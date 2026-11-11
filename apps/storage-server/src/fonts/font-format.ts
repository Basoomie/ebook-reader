/**
 * Custom fonts (WP13): which font files the reader takes, by their first bytes.
 * The browser checks a file again with the FontFace API before uploading it; this
 * is the server's own check, so nothing that isn't a font is ever stored.
 */

export const FONT_FORMATS = ['woff2', 'woff', 'ttf', 'otf'] as const;
export type FontFormat = (typeof FONT_FORMATS)[number];

export const FONT_CONTENT_TYPES: Record<FontFormat, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** The bytes needed to tell the formats apart. */
export const FONT_SNIFF_BYTES = 4;

/**
 * The format of a font file from its first four bytes, or null. Font collections
 * (`ttcf`) are refused: browsers don't load them reliably with FontFace.
 */
export function sniffFontFormat(head: Uint8Array): FontFormat | null {
  if (head.length < FONT_SNIFF_BYTES) return null;
  const tag = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'true' || (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0)) {
    return 'ttf';
  }
  return null;
}

/**
 * Names the reader can't use for a custom font: the bundled fonts and the CSS
 * generic and keyword names (compared case-insensitively). Kept in step with
 * `reservedFontNames` in apps/web/src/lib/data/fonts.ts.
 */
export const RESERVED_FONT_NAMES = [
  'KZ UDGothic',
  'KZ UDMincho',
  'Genei Koburi Mincho v5',
  'Klee One',
  'Klee One SemiBold',
  'Noto Sans JP',
  'Noto Serif JP',
  'Shippori Mincho',
  'Serif',
  'Sans-Serif',
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
  'default',
];

export const MAX_FONT_NAME = 64;
export const MAX_FONT_FILE_NAME = 200;

/**
 * A font name goes unquoted into the reader's CSS (`--font-family-serif`), so it is
 * kept to letters of any script, digits, spaces, `-` and `_`, starting with a letter,
 * with single spaces. Same rule as `checkFontName` in the web app.
 */
const FONT_NAME_RE = /^\p{L}[\p{L}\p{M}\p{N}_-]*(?: [\p{L}\p{M}\p{N}_-]+)*$/u;

/** The problem with a font name, or null when it may be used. */
export function fontNameProblem(name: string): string | null {
  if (!name) return 'Enter a name for the font';
  if (Array.from(name).length > MAX_FONT_NAME) {
    return `The name can be at most ${MAX_FONT_NAME} characters`;
  }
  if (!FONT_NAME_RE.test(name)) {
    return 'Use letters, digits, spaces, - and _ only, starting with a letter';
  }
  const lower = name.toLowerCase();
  if (RESERVED_FONT_NAMES.some((r) => r.toLowerCase() === lower)) {
    return 'That name belongs to a built-in font';
  }
  return null;
}
