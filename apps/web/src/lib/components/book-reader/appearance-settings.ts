/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  darkTheme$,
  enableFontVPAL$,
  enableTextJustification$,
  enableTextWrapPretty$,
  enableVerticalFontKerning$,
  firstDimensionMargin$,
  followSystemTheme$,
  fontFamilyGroupOne$,
  fontFamilyGroupTwo$,
  fontSize$,
  furiganaStyle$,
  hideFurigana$,
  lightTheme$,
  lineHeight$,
  pageColumns$,
  prioritizeReaderStyles$,
  secondDimensionMaxValue$,
  textIndentation$,
  textMarginMode$,
  textMarginValue$,
  theme$,
  verticalTextOrientation$,
  viewMode$,
  writingMode$
} from '$lib/data/store';
import { FuriganaStyle } from '$lib/data/furigana-style';
import { ViewMode } from '$lib/data/view-mode';
import { parseStoredValue, SETTINGS_REGISTRY } from '$lib/sync/settings-registry';
import type { AppearanceKey } from '$lib/sync/copy-device-settings';

interface Setting {
  subject: { next(value: never): void; getValue(): unknown };
  /** The store's default (what a device that never set the key uses). */
  defaultValue: unknown;
}

/**
 * WP10e: the live settings "Copy from another device" writes, with their defaults. A test
 * checks every default against the store and every key against the settings registry.
 */
export const APPEARANCE_SETTINGS: Record<AppearanceKey, Setting> = {
  theme: { subject: theme$, defaultValue: 'light-theme' },
  followSystemTheme: { subject: followSystemTheme$, defaultValue: false },
  lightTheme: { subject: lightTheme$, defaultValue: '' },
  darkTheme: { subject: darkTheme$, defaultValue: '' },
  fontFamilyGroupOne: { subject: fontFamilyGroupOne$, defaultValue: 'Noto Serif JP' },
  fontFamilyGroupTwo: { subject: fontFamilyGroupTwo$, defaultValue: 'Noto Sans JP' },
  fontSize: { subject: fontSize$, defaultValue: 20 },
  lineHeight: { subject: lineHeight$, defaultValue: 1.65 },
  textIndentation: { subject: textIndentation$, defaultValue: 0 },
  textMarginValue: { subject: textMarginValue$, defaultValue: 0 },
  textMarginMode: { subject: textMarginMode$, defaultValue: 'auto' },
  firstDimensionMargin: { subject: firstDimensionMargin$, defaultValue: 0 },
  secondDimensionMaxValue: { subject: secondDimensionMaxValue$, defaultValue: 0 },
  pageColumns: { subject: pageColumns$, defaultValue: 0 },
  writingMode: { subject: writingMode$, defaultValue: 'vertical-rl' },
  viewMode: { subject: viewMode$, defaultValue: ViewMode.Paginated },
  hideFurigana: { subject: hideFurigana$, defaultValue: false },
  furiganaStyle: { subject: furiganaStyle$, defaultValue: FuriganaStyle.Partial },
  enableVerticalFontKerning: { subject: enableVerticalFontKerning$, defaultValue: false },
  enableFontVPAL: { subject: enableFontVPAL$, defaultValue: false },
  verticalTextOrientation: { subject: verticalTextOrientation$, defaultValue: 'mixed' },
  prioritizeReaderStyles: { subject: prioritizeReaderStyles$, defaultValue: false },
  enableTextJustification: { subject: enableTextJustification$, defaultValue: false },
  enableTextWrapPretty: { subject: enableTextWrapPretty$, defaultValue: false }
};

/** Applies copied values (null = the default) to the live settings; returns the keys that changed. */
export function applyAppearanceValues(values: Partial<Record<AppearanceKey, string | null>>) {
  const changed: AppearanceKey[] = [];

  for (const [key, raw] of Object.entries(values) as [AppearanceKey, string | null][]) {
    const setting = APPEARANCE_SETTINGS[key];
    const spec = SETTINGS_REGISTRY[key];

    if (!setting || !spec) continue;

    const value = raw === null ? setting.defaultValue : parseStoredValue(spec.type, raw);

    if (setting.subject.getValue() !== value) {
      setting.subject.next(value as never);
      changed.push(key);
    }
  }

  return changed;
}
