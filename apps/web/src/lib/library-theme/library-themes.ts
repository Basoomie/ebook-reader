/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Library themes (2026-11-24): the colours of the catalogue pages (Home, Library,
 * Collections, Notes, Stats). Built-in Light and Dark are app.scss's `c-tokens-light` and
 * `c-tokens-dark` (a test keeps the copies below equal to them); your own themes are shared
 * with every device (`libraryThemes`), and each device picks one theme as its light one and
 * one as its dark one.
 *
 * A theme has 7 colours you pick (`base`) and every colour slot the pages use (`tokens`).
 * The slots are worked out from the base colours (`deriveToken`); a copy keeps the exact
 * slots of the theme it copies, and changing a base colour works out again only the slots
 * made from it (`changeBase`). Shadows, the Delete button's reds and the border width are
 * not part of a theme: they follow its kind (light or dark) through `html.catalogue-dark`.
 */

export const BASE_KEYS = ['page', 'cards', 'text', 'header', 'accent', 'button', 'seal'] as const;
export type BaseKey = (typeof BASE_KEYS)[number];

export const BASE_LABELS: Record<BaseKey, { title: string; hint: string }> = {
  page: { title: 'Page', hint: 'Behind everything' },
  cards: { title: 'Cards', hint: 'Panels, menus and dialogs' },
  text: { title: 'Text', hint: 'Also lines and soft buttons, made from it and Page' },
  header: { title: 'Header and bars', hint: 'The top bar and the page bars' },
  accent: { title: 'Accent', hint: 'Links, labels, progress and toggles' },
  button: { title: 'Primary button', hint: 'Also picked items' },
  seal: { title: 'Seal', hint: 'The red marks' }
};

export const TOKEN_KEYS = [
  'bg',
  'raised',
  'ink',
  'muted',
  'line',
  'line-strong',
  'link',
  'label',
  'seal',
  'gold',
  'header-bg',
  'header-ink',
  'header-muted',
  'header-border',
  'bar-bg',
  'bar-border',
  'btn-bg',
  'btn-ink',
  'btn-hover',
  'btn-active',
  'sec-bg',
  'sec-ink',
  'sec-border',
  'sec-hover',
  'sec-hover-border',
  'sec-active',
  'soft-bg',
  'soft-hover',
  'soft-active',
  'soft-border',
  'on-bg',
  'on-ink',
  'on-hover',
  'chip-border',
  'sel-bg',
  'sel-ink',
  'tint',
  'track',
  'fill',
  'count-bg',
  'count-ink'
] as const;
export type TokenKey = (typeof TOKEN_KEYS)[number];

export type ThemeKind = 'light' | 'dark';

export interface LibraryTheme {
  base: Record<BaseKey, string>;
  tokens: Record<TokenKey, string>;
}

export const BUILT_IN_LIGHT = 'light';
export const BUILT_IN_DARK = 'dark';

export const BUILT_IN_LIBRARY_THEMES: Record<string, LibraryTheme> = {
  [BUILT_IN_LIGHT]: {
    base: {
      page: '#f3ede0',
      cards: '#fcf9f2',
      text: '#1a2233',
      header: '#1a2233',
      accent: '#2b4c9b',
      button: '#1a2233',
      seal: '#b8361f'
    },
    tokens: {
      bg: '#f3ede0',
      raised: '#fcf9f2',
      ink: '#1a2233',
      muted: '#545c6b',
      line: '#d6c9ae',
      'line-strong': '#c9ba9a',
      link: '#2b4c9b',
      label: '#2b4c9b',
      seal: '#b8361f',
      gold: '#b89766',
      'header-bg': '#1a2233',
      'header-ink': '#ffffff',
      'header-muted': '#c9cfdb',
      'header-border': 'transparent',
      'bar-bg': '#1a2233',
      'bar-border': 'transparent',
      'btn-bg': '#1a2233',
      'btn-ink': '#f3ede0',
      'btn-hover': '#2e3c59',
      'btn-active': '#0f1624',
      'sec-bg': '#fcf9f2',
      'sec-ink': '#1a2233',
      'sec-border': '#c9ba9a',
      'sec-hover': '#efe5d0',
      'sec-hover-border': '#b89766',
      'sec-active': '#e4d8be',
      'soft-bg': '#ebe3d0',
      'soft-hover': '#e2d6bd',
      'soft-active': '#d8c9aa',
      'soft-border': 'transparent',
      'on-bg': '#dbe2f2',
      'on-ink': '#1f3b7e',
      'on-hover': '#cfd8ee',
      'chip-border': '#d2c4a6',
      'sel-bg': '#1a2233',
      'sel-ink': '#f3ede0',
      tint: '#efe5d0',
      track: '#dcd0b6',
      fill: '#2b4c9b',
      'count-bg': '#e7dec9',
      'count-ink': '#3b4354'
    }
  },
  [BUILT_IN_DARK]: {
    base: {
      page: '#0e1524',
      cards: '#1a2740',
      text: '#ede6d6',
      header: '#0a1020',
      accent: '#d9be8c',
      button: '#d9be8c',
      seal: '#d25a3f'
    },
    tokens: {
      bg: '#0e1524',
      raised: '#1a2740',
      ink: '#ede6d6',
      muted: '#a9b2c4',
      line: '#2e3d5c',
      'line-strong': '#3a4a6b',
      link: '#b9cbf5',
      label: '#d9be8c',
      seal: '#d25a3f',
      gold: '#8c7550',
      'header-bg': '#0a1020',
      'header-ink': '#ede6d6',
      'header-muted': '#a9b2c4',
      'header-border': '#8c7550',
      'bar-bg': '#1c2a46',
      'bar-border': '#8c7550',
      'btn-bg': '#d9be8c',
      'btn-ink': '#0e1524',
      'btn-hover': '#ead6ae',
      'btn-active': '#c9ac76',
      'sec-bg': 'transparent',
      'sec-ink': '#ede6d6',
      'sec-border': '#8c7550',
      'sec-hover': '#22314f',
      'sec-hover-border': '#d9be8c',
      'sec-active': '#2a3b5e',
      'soft-bg': '#213050',
      'soft-hover': '#293a5e',
      'soft-active': '#31456d',
      'soft-border': '#2c3d61',
      'on-bg': '#3a3220',
      'on-ink': '#f0d7a4',
      'on-hover': '#463c26',
      'chip-border': '#3a4a6b',
      'sel-bg': '#d9be8c',
      'sel-ink': '#0e1524',
      tint: '#22314f',
      track: '#2e3d5c',
      fill: '#d9be8c',
      'count-bg': '#1a2740',
      'count-ink': '#d9be8c'
    }
  }
};

export const BUILT_IN_NAMES: Record<string, string> = {
  [BUILT_IN_LIGHT]: 'Light',
  [BUILT_IN_DARK]: 'Dark'
};

export function isBuiltInLibraryTheme(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_LIBRARY_THEMES, id);
}

/** A theme's name on screen: "Light" / "Dark" for the built-ins, else its own name. */
export function libraryThemeName(id: string): string {
  return BUILT_IN_NAMES[id] ?? id;
}

/** A name a theme of your own can't take (the built-ins', in any case), or '' when free. */
export function reservedNameError(name: string): string {
  const n = name.trim().toLowerCase();
  if (!n) return 'Enter a name.';
  if (Object.values(BUILT_IN_NAMES).some((b) => b.toLowerCase() === n) || isBuiltInLibraryTheme(n))
    return 'This name belongs to a built-in theme.';
  return '';
}

// --- Colours ---

type Rgb = [number, number, number];

const HEX = /^#([0-9a-f]{6})$/i;
const SHORT_HEX = /^#([0-9a-f]{3})$/i;

/** Only colours this module can read reach the page's CSS (synced values included). */
export function isSafeColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'transparent' || HEX.test(value.trim()) || SHORT_HEX.test(value.trim()))
  );
}

function parse(color: string): Rgb | null {
  const c = color.trim();
  const short = SHORT_HEX.exec(c);
  if (short) {
    const [r, g, b] = short[1].split('').map((x) => parseInt(x + x, 16));
    return [r, g, b];
  }
  const hex = HEX.exec(c);
  if (!hex) return null;
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((x) =>
      Math.round(Math.min(255, Math.max(0, x)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** `a` moved toward `b` by `t` (0-1). */
export function mix(a: string, b: string, t: number): string {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a;
  return toHex([0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * t) as Rgb);
}

function lum(color: string): number {
  const p = parse(color);
  if (!p) return 1;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The first of `choices` that reads on `on` (4.5:1), else black or white, whichever reads better. */
export function readableOn(on: string, choices: string[]): string {
  for (const c of choices) if (contrast(c, on) >= 4.5) return c;
  return contrast('#000000', on) >= contrast('#ffffff', on) ? '#000000' : '#ffffff';
}

/** Dark when the page colour is dark (the same line as "Like the book": luminance < 0.2). */
export function kindOf(base: Pick<Record<BaseKey, string>, 'page'>): ThemeKind {
  return lum(base.page) < 0.2 ? 'dark' : 'light';
}

// --- Working out the slots ---

type Recipe = { from: BaseKey[]; make: (b: Record<BaseKey, string>, kind: ThemeKind) => string };

const shade = (t: number) => (b: Record<BaseKey, string>) => mix(b.page, b.text, t);
const btnInk = (b: Record<BaseKey, string>) => readableOn(b.button, [b.page, b.text]);
// The header's text: the theme's text colour or white, so changing Page never moves it.
const headerInk = (b: Record<BaseKey, string>) => readableOn(b.header, [b.text, '#ffffff']);
const edgeOfHeader = (b: Record<BaseKey, string>) =>
  contrast(b.header, b.page) < 1.5 ? mix(b.page, b.text, 0.35) : 'transparent';

/** Which base colours each slot is made from, and how. */
export const RECIPES: Record<TokenKey, Recipe> = {
  bg: { from: ['page'], make: (b) => b.page },
  raised: { from: ['cards'], make: (b) => b.cards },
  ink: { from: ['text'], make: (b) => b.text },
  muted: { from: ['text', 'page'], make: (b) => mix(b.text, b.page, 0.35) },
  line: { from: ['page', 'text'], make: shade(0.14) },
  'line-strong': { from: ['page', 'text'], make: shade(0.2) },
  link: { from: ['accent'], make: (b) => b.accent },
  label: { from: ['accent'], make: (b) => b.accent },
  seal: { from: ['seal'], make: (b) => b.seal },
  gold: { from: ['page', 'text'], make: shade(0.35) },
  'header-bg': { from: ['header'], make: (b) => b.header },
  'header-ink': { from: ['header', 'text'], make: headerInk },
  'header-muted': {
    from: ['header', 'text'],
    make: (b) => mix(headerInk(b), b.header, 0.25)
  },
  'header-border': { from: ['header', 'page', 'text'], make: edgeOfHeader },
  'bar-bg': { from: ['header'], make: (b) => b.header },
  'bar-border': { from: ['header', 'page', 'text'], make: edgeOfHeader },
  'btn-bg': { from: ['button'], make: (b) => b.button },
  'btn-ink': { from: ['button', 'page', 'text'], make: btnInk },
  'btn-hover': { from: ['button', 'page', 'text'], make: (b) => mix(b.button, btnInk(b), 0.12) },
  'btn-active': { from: ['button'], make: (b) => mix(b.button, '#000000', 0.18) },
  'sec-bg': {
    from: ['cards', 'page'],
    make: (b, kind) => (kind === 'dark' ? 'transparent' : b.cards)
  },
  'sec-ink': { from: ['text'], make: (b) => b.text },
  'sec-border': { from: ['page', 'text'], make: shade(0.2) },
  'sec-hover': { from: ['page', 'text'], make: shade(0.05) },
  'sec-hover-border': { from: ['page', 'text'], make: shade(0.35) },
  'sec-active': { from: ['page', 'text'], make: shade(0.1) },
  'soft-bg': { from: ['page', 'text'], make: shade(0.06) },
  'soft-hover': { from: ['page', 'text'], make: shade(0.1) },
  'soft-active': { from: ['page', 'text'], make: shade(0.15) },
  'soft-border': {
    from: ['page', 'text'],
    make: (b, kind) => (kind === 'dark' ? mix(b.page, b.text, 0.12) : 'transparent')
  },
  'on-bg': { from: ['page', 'accent'], make: (b) => mix(b.page, b.accent, 0.16) },
  'on-ink': {
    from: ['page', 'accent', 'text'],
    make: (b) => readableOn(mix(b.page, b.accent, 0.16), [b.accent, mix(b.accent, b.text, 0.4)])
  },
  'on-hover': { from: ['page', 'accent'], make: (b) => mix(b.page, b.accent, 0.24) },
  'chip-border': { from: ['page', 'text'], make: shade(0.16) },
  'sel-bg': { from: ['button'], make: (b) => b.button },
  'sel-ink': { from: ['button', 'page', 'text'], make: btnInk },
  tint: { from: ['page', 'text'], make: shade(0.05) },
  track: { from: ['page', 'text'], make: shade(0.12) },
  fill: { from: ['accent'], make: (b) => b.accent },
  'count-bg': { from: ['page', 'text'], make: shade(0.07) },
  'count-ink': { from: ['text', 'page'], make: (b) => mix(b.text, b.page, 0.2) }
};

/** Every slot worked out from the base colours (a theme with nothing to copy). */
export function deriveTokens(base: Record<BaseKey, string>): Record<TokenKey, string> {
  const kind = kindOf(base);
  const tokens = {} as Record<TokenKey, string>;
  for (const key of TOKEN_KEYS) tokens[key] = RECIPES[key].make(base, kind);
  return tokens;
}

/**
 * One base colour changed: the slots made from it are worked out again, the others stay
 * as they were (so a copy keeps every shade it copied). When the page colour moves the
 * theme between light and dark, the slots that depend on the kind follow too.
 */
export function changeBase(theme: LibraryTheme, key: BaseKey, color: string): LibraryTheme {
  const base = { ...theme.base, [key]: color };
  const kind = kindOf(base);
  const tokens = { ...theme.tokens };
  for (const t of TOKEN_KEYS) {
    if (RECIPES[t].from.includes(key)) tokens[t] = RECIPES[t].make(base, kind);
  }
  return { base, tokens };
}

/** A copy that shares nothing with the original. */
export function copyTheme(theme: LibraryTheme): LibraryTheme {
  return { base: { ...theme.base }, tokens: { ...theme.tokens } };
}

/**
 * A stored theme made safe to use: unreadable or missing colours fall back (base to the
 * built-in of the same kind, slots worked out again). Synced values reach the page only
 * through here. Null when it isn't a theme at all.
 */
export function normalizeTheme(raw: unknown): LibraryTheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { base?: Record<string, unknown>; tokens?: Record<string, unknown> };
  if (!r.base || typeof r.base !== 'object') return null;
  const page = isSafeColor(r.base.page) && r.base.page !== 'transparent' ? r.base.page : null;
  if (!page) return null;
  const fallback =
    BUILT_IN_LIBRARY_THEMES[kindOf({ page }) === 'dark' ? BUILT_IN_DARK : BUILT_IN_LIGHT];
  const base = {} as Record<BaseKey, string>;
  for (const k of BASE_KEYS) {
    const v = r.base[k];
    base[k] = isSafeColor(v) && v !== 'transparent' ? v : fallback.base[k];
  }
  const derived = deriveTokens(base);
  const tokens = {} as Record<TokenKey, string>;
  for (const k of TOKEN_KEYS) {
    const v = r.tokens?.[k];
    tokens[k] = isSafeColor(v) ? v : derived[k];
  }
  return { base, tokens };
}

export function themeKind(theme: LibraryTheme): ThemeKind {
  return kindOf(theme.base);
}

// --- Which theme the pages use ---

export interface ResolvedLibraryTheme {
  id: string;
  theme: LibraryTheme;
  builtIn: boolean;
  dark: boolean;
}

/** The theme picked for light or dark, or the built-in one when the pick is empty or gone. */
export function pickedTheme(
  pick: string,
  fallbackId: string,
  themes: Record<string, unknown>
): ResolvedLibraryTheme {
  if (pick && !isBuiltInLibraryTheme(pick)) {
    const own = normalizeTheme(themes?.[pick]);
    if (own) return { id: pick, theme: own, builtIn: false, dark: themeKind(own) === 'dark' };
  }
  const id = pick && isBuiltInLibraryTheme(pick) ? pick : fallbackId;
  const theme = BUILT_IN_LIBRARY_THEMES[id];
  return { id, theme, builtIn: true, dark: themeKind(theme) === 'dark' };
}

/**
 * Library look 'light' / 'dark' take this device's light or dark pick; 'auto' ("Like the
 * book") takes the dark pick when the book's theme is dark, else the light pick.
 */
export function resolveLibraryTheme(
  look: string,
  readerDark: boolean,
  lightPick: string,
  darkPick: string,
  themes: Record<string, unknown>
): ResolvedLibraryTheme {
  const wantDark = look === 'dark' || (look !== 'light' && readerDark);
  return wantDark
    ? pickedTheme(darkPick, BUILT_IN_DARK, themes)
    : pickedTheme(lightPick, BUILT_IN_LIGHT, themes);
}

/** The CSS of a theme of your own (built-ins are app.scss's). Only safe colours get in. */
export function themeCss(theme: LibraryTheme): string {
  const lines = TOKEN_KEYS.filter((k) => isSafeColor(theme.tokens[k])).map(
    (k) => `  --c-${k}: ${theme.tokens[k]};`
  );
  return `html.library-theme:not(.eink) {\n${lines.join('\n')}\n}\n`;
}

/** The slots as inline CSS variables (the editor's preview). */
export function themeStyle(theme: LibraryTheme): string {
  return TOKEN_KEYS.filter((k) => isSafeColor(theme.tokens[k]))
    .map((k) => `--c-${k}: ${theme.tokens[k]}`)
    .join('; ');
}
