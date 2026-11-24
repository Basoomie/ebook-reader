/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { distinctUntilChanged, skip, type Subscription } from 'rxjs';
import { isCatalogueDark } from './catalogue-look';
import { resolveLibraryTheme, themeCss } from '$lib/library-theme/library-themes';
import type { CustomTheme } from './theme-option';

/** The parts of a settings subject this module uses (a BehaviorSubject fits). */
export interface SettingSubject<T> {
  getValue(): T;
  next(value: T): void;
  subscribe(fn: (value: T) => void): Subscription;
  pipe: import('rxjs').Observable<T>['pipe'];
}

export interface AppearanceSettings {
  theme: SettingSubject<string>;
  customThemes: SettingSubject<Record<string, CustomTheme>>;
  followSystemTheme: SettingSubject<boolean>;
  lightTheme: SettingSubject<string>;
  darkTheme: SettingSubject<string>;
  einkMode: SettingSubject<boolean>;
  fontFamilyGroupOne: SettingSubject<string>;
  fontFamilyGroupTwo: SettingSubject<string>;
  fontSize: SettingSubject<number>;
  /** WP19b: "Library Look" (catalogue-look.ts); absent = no catalogue light/dark class. */
  libraryLook?: SettingSubject<string>;
  /** Library themes (2026-11-24): your own themes and this device's light and dark picks. */
  libraryThemes?: SettingSubject<Record<string, unknown>>;
  libraryLightTheme?: SettingSubject<string>;
  libraryDarkTheme?: SettingSubject<string>;
}

/** The part of `MediaQueryList` used here. */
export interface DarkQuery {
  matches: boolean;
  addEventListener(type: 'change', fn: () => void): void;
  removeEventListener(type: 'change', fn: () => void): void;
}

export const DEFAULT_DARK_THEME = 'dark-theme';

export const DEFAULT_LIGHT_THEME = 'light-theme';

/** The theme to use for the system's current light/dark setting while following it. */
export function followedTheme(
  systemDark: boolean,
  lightTheme: string,
  darkTheme: string,
  current: string
) {
  return systemDark ? darkTheme || DEFAULT_DARK_THEME : lightTheme || current;
}

/**
 * WP10d, app-wide (started once from the root layout):
 * - follow the system light/dark setting: sets `theme` to the light or dark choice; choosing
 *   a theme by hand while following makes it the choice for the current mode;
 * - a custom theme's font and size are applied to the device settings whenever it becomes
 *   the active theme (not on page load, so later changes are kept);
 * - E-ink mode puts the `eink` class on the root element (see app.scss).
 * Every step is guarded: a failure here must never affect reading.
 */
export function startAppearanceEffects(
  s: AppearanceSettings,
  darkQuery: DarkQuery | undefined,
  root: { classList: DOMTokenList } | undefined,
  warn: (message: string) => void = () => {},
  /** Puts a library theme of your own on the page (its CSS), or takes it off (null). */
  setLibraryCss: (css: string | null) => void = () => {}
) {
  const subscriptions: Subscription[] = [];
  let applying = false;

  const guard = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      warn(`Appearance (${what}): ${(error as Error)?.message ?? error}`);
    }
  };

  // Theme fonts: only on a change of the active theme.
  subscriptions.push(
    s.theme.pipe(distinctUntilChanged(), skip(1)).subscribe((themeId) =>
      guard('theme font', () => {
        const theme = s.customThemes.getValue()[themeId];

        if (!theme) {
          return;
        }

        if (theme.fontFamilyGroupOne) {
          s.fontFamilyGroupOne.next(theme.fontFamilyGroupOne);
        }

        if (theme.fontFamilyGroupTwo) {
          s.fontFamilyGroupTwo.next(theme.fontFamilyGroupTwo);
        }

        if (typeof theme.fontSize === 'number' && theme.fontSize > 0) {
          s.fontSize.next(theme.fontSize);
        }
      })
    )
  );

  const apply = () =>
    guard('follow system', () => {
      if (!darkQuery || !s.followSystemTheme.getValue()) {
        return;
      }

      const want = followedTheme(
        darkQuery.matches,
        s.lightTheme.getValue(),
        s.darkTheme.getValue(),
        s.theme.getValue()
      );

      if (s.theme.getValue() !== want) {
        applying = true;

        try {
          s.theme.next(want);
        } finally {
          applying = false;
        }
      }
    });

  if (darkQuery) {
    // Turning following on remembers the theme in use as the light choice (unless it is
    // the dark choice itself, then the built-in light theme).
    subscriptions.push(
      s.followSystemTheme.pipe(distinctUntilChanged(), skip(1)).subscribe((follow) =>
        guard('follow on', () => {
          if (!follow) {
            return;
          }

          const dark = s.darkTheme.getValue() || DEFAULT_DARK_THEME;

          if (!s.lightTheme.getValue()) {
            const current = s.theme.getValue();
            s.lightTheme.next(current === dark ? DEFAULT_LIGHT_THEME : current);
          }

          if (!s.darkTheme.getValue()) {
            s.darkTheme.next(dark);
          }
        })
      )
    );

    // A theme picked by hand while following becomes the choice for the current mode.
    subscriptions.push(
      s.theme.pipe(distinctUntilChanged(), skip(1)).subscribe((themeId) =>
        guard('theme choice', () => {
          if (applying || !s.followSystemTheme.getValue()) {
            return;
          }

          (darkQuery.matches ? s.darkTheme : s.lightTheme).next(themeId);
        })
      )
    );

    subscriptions.push(s.followSystemTheme.subscribe(apply));
    subscriptions.push(s.lightTheme.subscribe(apply));
    subscriptions.push(s.darkTheme.subscribe(apply));
    darkQuery.addEventListener('change', apply);
  }

  if (root) {
    subscriptions.push(
      s.einkMode.subscribe((on) => guard('e-ink', () => root.classList.toggle('eink', !!on)))
    );

    // Modals over the reader follow the reader theme's own brightness (app.scss, Modals),
    // whatever the Library Look.
    const applyReaderDark = () =>
      guard('reader look', () =>
        root.classList.toggle(
          'reader-dark',
          isCatalogueDark('auto', s.theme.getValue(), s.customThemes.getValue())
        )
      );
    subscriptions.push(s.theme.subscribe(applyReaderDark));
    subscriptions.push(s.customThemes.subscribe(applyReaderDark));

    // WP19b: the catalogue pages' dark look, from "Library Look" or the reader theme; since
    // 2026-11-24 the look is this device's light or dark library theme. A theme of your own
    // adds its colours (html.library-theme); its kind still sets catalogue-dark.
    const look = s.libraryLook;
    if (look) {
      let lastCss: string | null = null;
      const applyLook = () =>
        guard('library look', () => {
          const resolved = resolveLibraryTheme(
            look.getValue(),
            isCatalogueDark('auto', s.theme.getValue(), s.customThemes.getValue()),
            s.libraryLightTheme?.getValue() ?? '',
            s.libraryDarkTheme?.getValue() ?? '',
            s.libraryThemes?.getValue() ?? {}
          );
          root.classList.toggle('catalogue-dark', resolved.dark);
          root.classList.toggle('library-theme', !resolved.builtIn);
          const css = resolved.builtIn ? null : themeCss(resolved.theme);
          if (css !== lastCss) {
            lastCss = css;
            setLibraryCss(css);
          }
        });
      subscriptions.push(look.subscribe(applyLook));
      subscriptions.push(s.theme.subscribe(applyLook));
      subscriptions.push(s.customThemes.subscribe(applyLook));
      for (const subject of [s.libraryThemes, s.libraryLightTheme, s.libraryDarkTheme]) {
        if (subject) subscriptions.push((subject as SettingSubject<unknown>).subscribe(applyLook));
      }
    }
  }

  return () => {
    darkQuery?.removeEventListener('change', apply);
    subscriptions.forEach((sub) => sub.unsubscribe());
  };
}
