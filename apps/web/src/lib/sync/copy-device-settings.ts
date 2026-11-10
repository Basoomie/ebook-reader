/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * WP10e: the settings "Copy from another device" copies: what the appearance panel shows,
 * plus the reader options that go with them. Never E-ink or Zen mode (they belong to the
 * device), nor tracker, sync or library settings.
 */
export const APPEARANCE_COPY_KEYS = [
  'theme',
  'followSystemTheme',
  'lightTheme',
  'darkTheme',
  'fontFamilyGroupOne',
  'fontFamilyGroupTwo',
  'fontSize',
  'lineHeight',
  'textIndentation',
  'textMarginValue',
  'textMarginMode',
  'firstDimensionMargin',
  'secondDimensionMaxValue',
  'pageColumns',
  'writingMode',
  'viewMode',
  'hideFurigana',
  'furiganaStyle',
  'enableVerticalFontKerning',
  'enableFontVPAL',
  'verticalTextOrientation',
  'prioritizeReaderStyles',
  'enableTextJustification',
  'enableTextWrapPretty'
] as const;

export type AppearanceKey = (typeof APPEARANCE_COPY_KEYS)[number];

const COPY_KEYS = new Set<string>(APPEARANCE_COPY_KEYS);

export const FONT_KEYS: AppearanceKey[] = ['fontFamilyGroupOne', 'fontFamilyGroupTwo'];

export interface DeviceAppearance {
  deviceId: string;
  name: string | undefined;
  /** Newest update of any of its appearance settings (that device's clock, server-clamped). */
  updatedAt: number;
  /** Raw stored strings; null = never set on that device (its default). */
  values: Partial<Record<AppearanceKey, string | null>>;
}

/**
 * The other devices' appearance settings from the local mirror's `setting` records
 * (`device:<deviceId>:<key>`), newest first. Deleted records and this device are left out.
 */
export function otherDevicesAppearance(
  records: LocalRecord[],
  ownDeviceId: string,
  deviceNames: Record<string, string | undefined>
): DeviceAppearance[] {
  const byDevice = new Map<string, DeviceAppearance>();

  for (const record of records) {
    if (record.kind !== 'setting' || record.deletedAt !== null) continue;

    const match = /^device:([^:]+):(.+)$/.exec(record.id);

    if (!match) continue;

    const [, deviceId, key] = match;

    if (deviceId === ownDeviceId || !COPY_KEYS.has(key)) continue;

    const raw = record.data?.value;
    const value = typeof raw === 'string' ? raw : null;
    let entry = byDevice.get(deviceId);

    if (!entry) {
      entry = { deviceId, name: deviceNames[deviceId], updatedAt: 0, values: {} };
      byDevice.set(deviceId, entry);
    }

    entry.values[key as AppearanceKey] = value;
    entry.updatedAt = Math.max(entry.updatedAt, record.updatedAt);
  }

  return [...byDevice.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface CopyPlan {
  /** Values to apply (null = reset to the default). */
  apply: Partial<Record<AppearanceKey, string | null>>;
  /** Fonts the other device uses that this device doesn't have (kept as they are here). */
  missingFonts: string[];
}

/**
 * What a copy changes. A font the other device uses but this device doesn't have (a font
 * added in that browser only, until WP13) is not copied; the current font is kept.
 */
export function planAppearanceCopy(
  values: Partial<Record<AppearanceKey, string | null>>,
  availableFonts: string[]
): CopyPlan {
  const apply: Partial<Record<AppearanceKey, string | null>> = {};
  const missingFonts: string[] = [];
  const fonts = new Set(availableFonts);

  for (const key of APPEARANCE_COPY_KEYS) {
    if (!(key in values)) continue;

    const value = values[key] ?? null;

    if (FONT_KEYS.includes(key) && value !== null && !fonts.has(value)) {
      if (!missingFonts.includes(value)) missingFonts.push(value);
      continue;
    }

    apply[key] = value;
  }

  return { apply, missingFonts };
}
