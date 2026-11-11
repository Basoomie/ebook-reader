/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BehaviorSubject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  startAppearanceEffects,
  type AppearanceSettings,
  type DarkQuery
} from './appearance-effects';
import type { CustomTheme } from './theme-option';

const colors = {
  fontColor: 'rgba(0,0,0,1)',
  backgroundColor: 'rgba(255,255,255,1)',
  selectionFontColor: 'rgba(0,0,0,1)',
  selectionBackgroundColor: 'rgba(0,0,0,1)',
  hintFuriganaShadowColor: 'rgba(0,0,0,1)',
  hintFuriganaFontColor: 'rgba(0,0,0,1)',
  tooltipTextFontColor: 'rgba(0,0,0,1)'
};

function settings(overrides: Partial<Record<keyof AppearanceSettings, unknown>> = {}) {
  const customThemes: Record<string, CustomTheme> = {
    night: { ...colors, fontFamilyGroupOne: 'Klee One', fontSize: 24 },
    sepia: { ...colors }
  };
  const s = {
    theme: new BehaviorSubject('light-theme'),
    customThemes: new BehaviorSubject(customThemes),
    followSystemTheme: new BehaviorSubject(false),
    lightTheme: new BehaviorSubject(''),
    darkTheme: new BehaviorSubject(''),
    einkMode: new BehaviorSubject(false),
    fontFamilyGroupOne: new BehaviorSubject('Noto Serif JP'),
    fontFamilyGroupTwo: new BehaviorSubject('Noto Sans JP'),
    fontSize: new BehaviorSubject(20)
  };
  for (const [key, value] of Object.entries(overrides)) {
    (s as Record<string, BehaviorSubject<unknown>>)[key].next(value);
  }
  return s;
}

function darkQuery(dark: boolean) {
  const listeners = new Set<() => void>();
  const q: DarkQuery & { set(d: boolean): void } = {
    matches: dark,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    set(d: boolean) {
      q.matches = d;
      listeners.forEach((fn) => fn());
    }
  };
  return q;
}

function root() {
  const classes = new Set<string>();
  return {
    classList: {
      toggle: (c: string, on?: boolean) => {
        if (on) classes.add(c);
        else classes.delete(c);
        return !!on;
      }
    } as unknown as DOMTokenList,
    classes
  };
}

describe('startAppearanceEffects', () => {
  it('does nothing to the theme while not following', () => {
    const s = settings({ theme: 'ecru-theme' });
    const q = darkQuery(true);
    startAppearanceEffects(s, q, undefined);
    q.set(false);
    q.set(true);
    expect(s.theme.getValue()).toBe('ecru-theme');
  });

  it('follows the system: light and dark choice', () => {
    const s = settings({ theme: 'ecru-theme', lightTheme: 'ecru-theme', darkTheme: 'black-theme' });
    const q = darkQuery(false);
    startAppearanceEffects(s, q, undefined);
    s.followSystemTheme.next(true);
    expect(s.theme.getValue()).toBe('ecru-theme');
    q.set(true);
    expect(s.theme.getValue()).toBe('black-theme');
    q.set(false);
    expect(s.theme.getValue()).toBe('ecru-theme');
  });

  it('turning following on keeps the current theme as the light choice', () => {
    const s = settings({ theme: 'water-theme' });
    const q = darkQuery(false);
    startAppearanceEffects(s, q, undefined);
    s.followSystemTheme.next(true);
    expect(s.lightTheme.getValue()).toBe('water-theme');
    expect(s.darkTheme.getValue()).toBe('dark-theme');
    q.set(true);
    expect(s.theme.getValue()).toBe('dark-theme');
    q.set(false);
    expect(s.theme.getValue()).toBe('water-theme');
  });

  it('turning following on at night with the dark theme picks the built-in light theme', () => {
    const s = settings({ theme: 'dark-theme' });
    const q = darkQuery(true);
    startAppearanceEffects(s, q, undefined);
    s.followSystemTheme.next(true);
    expect(s.lightTheme.getValue()).toBe('light-theme');
    q.set(false);
    expect(s.theme.getValue()).toBe('light-theme');
  });

  it('a theme picked by hand while following becomes the choice for the current mode', () => {
    const s = settings({
      followSystemTheme: true,
      lightTheme: 'light-theme',
      darkTheme: 'dark-theme'
    });
    const q = darkQuery(true);
    startAppearanceEffects(s, q, undefined);
    expect(s.theme.getValue()).toBe('dark-theme');
    s.theme.next('black-theme');
    expect(s.darkTheme.getValue()).toBe('black-theme');
    expect(s.lightTheme.getValue()).toBe('light-theme');
    q.set(false);
    expect(s.theme.getValue()).toBe('light-theme');
    q.set(true);
    expect(s.theme.getValue()).toBe('black-theme');
  });

  it('applies a custom theme font and size when it becomes active, not on start', () => {
    const s = settings({ theme: 'night', fontSize: 18 });
    startAppearanceEffects(s, undefined, undefined);
    expect(s.fontSize.getValue()).toBe(18); // not re-applied on page load
    s.theme.next('light-theme');
    s.fontSize.next(19);
    s.theme.next('night');
    expect(s.fontFamilyGroupOne.getValue()).toBe('Klee One');
    expect(s.fontFamilyGroupTwo.getValue()).toBe('Noto Sans JP'); // not in the theme
    expect(s.fontSize.getValue()).toBe(24);
    s.fontSize.next(26); // changed afterwards: kept
    s.theme.next('sepia'); // no font in the theme: nothing changes
    expect(s.fontSize.getValue()).toBe(26);
  });

  it('applies the font of the theme the system switches to', () => {
    const s = settings({ followSystemTheme: true, lightTheme: 'light-theme', darkTheme: 'night' });
    const q = darkQuery(false);
    startAppearanceEffects(s, q, undefined);
    q.set(true);
    expect(s.theme.getValue()).toBe('night');
    expect(s.fontSize.getValue()).toBe(24);
    expect(s.darkTheme.getValue()).toBe('night');
  });

  it('sets the eink class on the root element', () => {
    const s = settings();
    const r = root();
    const stop = startAppearanceEffects(s, undefined, r);
    expect(r.classes.has('eink')).toBe(false);
    s.einkMode.next(true);
    expect(r.classes.has('eink')).toBe(true);
    s.einkMode.next(false);
    expect(r.classes.has('eink')).toBe(false);
    stop();
    s.einkMode.next(true);
    expect(r.classes.has('eink')).toBe(false);
  });

  it('sets the catalogue dark class from Library Look or the reader theme (WP19b)', () => {
    const s = { ...settings(), libraryLook: new BehaviorSubject('auto') };
    const r = root();
    const stop = startAppearanceEffects(s, undefined, r);
    expect(r.classes.has('catalogue-dark')).toBe(false);
    s.theme.next('dark-theme');
    expect(r.classes.has('catalogue-dark')).toBe(true);
    s.libraryLook.next('light');
    expect(r.classes.has('catalogue-dark')).toBe(false);
    s.theme.next('light-theme');
    s.libraryLook.next('dark');
    expect(r.classes.has('catalogue-dark')).toBe(true);
    stop();
  });

  it('never throws into the app', () => {
    const s = settings({ followSystemTheme: true });
    const bad = {
      get matches(): boolean {
        throw new Error('boom');
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    const warnings: string[] = [];
    expect(() => startAppearanceEffects(s, bad, undefined, (m) => warnings.push(m))).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
