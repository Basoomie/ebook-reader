/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { distinctUntilChanged, skip, type Subscription } from 'rxjs';
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
  warn: (message: string) => void = () => {}
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
  }

  return () => {
    darkQuery?.removeEventListener('change', apply);
    subscriptions.forEach((sub) => sub.unsubscribe());
  };
}
