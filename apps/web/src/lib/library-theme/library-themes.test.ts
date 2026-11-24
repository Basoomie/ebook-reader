/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_DARK,
  BUILT_IN_LIBRARY_THEMES,
  BUILT_IN_LIGHT,
  changeBase,
  contrast,
  copyTheme,
  deriveTokens,
  kindOf,
  normalizeTheme,
  RECIPES,
  reservedNameError,
  resolveLibraryTheme,
  themeCss,
  TOKEN_KEYS
} from './library-themes';

const scss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../app.scss'),
  'utf8'
);

/** The `--c-*` values of one app.scss mixin. */
function mixinTokens(name: string): Record<string, string> {
  const start = scss.indexOf(`@mixin ${name} {`);
  const body = scss.slice(start, scss.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--c-([a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = BUILT_IN_LIBRARY_THEMES[BUILT_IN_LIGHT];
const dark = BUILT_IN_LIBRARY_THEMES[BUILT_IN_DARK];

describe('library themes', () => {
  it('built-in Light and Dark are exactly app.scss’s token sets', () => {
    for (const [mixin, theme] of [
      ['c-tokens-light', light],
      ['c-tokens-dark', dark]
    ] as const) {
      const tokens = mixinTokens(mixin);
      for (const key of TOKEN_KEYS) expect([key, theme.tokens[key]]).toEqual([key, tokens[key]]);
      // Every colour slot of the mixin is a theme slot (shadows, danger and width are not).
      const colourKeys = Object.keys(tokens).filter((k) => !/shadow|danger|border-width/.test(k));
      expect(colourKeys.sort()).toEqual([...TOKEN_KEYS].sort());
    }
  });

  it('a copy is identical, and changing a base colour changes only the slots made from it', () => {
    const copy = copyTheme(light);
    expect(copy).toEqual(light);
    const changed = changeBase(copy, 'accent', '#aa3366');
    for (const key of TOKEN_KEYS) {
      if (RECIPES[key].from.includes('accent')) continue;
      expect([key, changed.tokens[key]]).toEqual([key, light.tokens[key]]);
    }
    expect(changed.tokens.link).toBe('#aa3366');
    expect(changed.tokens.fill).toBe('#aa3366');
    expect(changed.tokens['on-bg']).not.toBe(light.tokens['on-bg']);
    expect(light.tokens.link).toBe('#2b4c9b');
  });

  it('changing Page leaves the header text alone', () => {
    const t = changeBase(copyTheme(light), 'page', '#e8f0e4');
    expect(t.tokens['header-ink']).toBe('#ffffff');
    expect(t.tokens['header-muted']).toBe(light.tokens['header-muted']);
  });

  it('a dark page makes a dark theme, and the kind slots follow', () => {
    const t = changeBase(copyTheme(light), 'page', '#101010');
    expect(kindOf(t.base)).toBe('dark');
    expect(t.tokens['sec-bg']).toBe('transparent');
    expect(t.tokens['soft-border']).not.toBe('transparent');
  });

  it('button and header text always read', () => {
    for (const button of ['#ffffff', '#000000', '#777777', '#ffcc00', '#003366']) {
      const tokens = deriveTokens({ ...light.base, button, header: button });
      expect(contrast(tokens['btn-ink'], button)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['header-ink'], button)).toBeGreaterThanOrEqual(4.4);
    }
  });

  it('a header the same as the page gets an edge', () => {
    const tokens = deriveTokens({ ...light.base, header: light.base.page });
    expect(tokens['header-border']).not.toBe('transparent');
    expect(deriveTokens(light.base)['header-border']).toBe('transparent');
  });

  it('resolves the pick for the look, falling back to the built-ins', () => {
    const own = {
      Sepia: copyTheme(light),
      Night: changeBase(copyTheme(dark), 'accent', '#88ccff')
    };
    expect(resolveLibraryTheme('light', true, '', '', own).id).toBe(BUILT_IN_LIGHT);
    expect(resolveLibraryTheme('dark', false, '', '', own).id).toBe(BUILT_IN_DARK);
    expect(resolveLibraryTheme('auto', false, 'Sepia', 'Night', own).id).toBe('Sepia');
    const r = resolveLibraryTheme('auto', true, 'Sepia', 'Night', own);
    expect([r.id, r.builtIn, r.dark]).toEqual(['Night', false, true]);
    // A pick that was deleted on another device.
    expect(resolveLibraryTheme('light', false, 'Gone', '', own).id).toBe(BUILT_IN_LIGHT);
    // A dark theme picked as the light one is still dark.
    expect(resolveLibraryTheme('light', false, 'Night', '', own).dark).toBe(true);
  });

  it('keeps unsafe synced values out of the CSS', () => {
    const t = normalizeTheme({
      base: { ...light.base, accent: 'red;}body{display:none' },
      tokens: { ...light.tokens, link: 'url(x)', bg: '#123456' }
    });
    expect(t).not.toBeNull();
    const css = themeCss(t!);
    expect(css).not.toMatch(/url|display|red/);
    expect(t!.base.accent).toBe(light.base.accent);
    expect(t!.tokens.bg).toBe('#123456');
    expect(normalizeTheme({ tokens: {} })).toBeNull();
    expect(normalizeTheme('x')).toBeNull();
  });

  it('reserves the built-in names', () => {
    expect(reservedNameError('light')).not.toBe('');
    expect(reservedNameError(' DARK ')).not.toBe('');
    expect(reservedNameError('')).not.toBe('');
    expect(reservedNameError('Sepia')).toBe('');
  });
});
