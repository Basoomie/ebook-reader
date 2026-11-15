/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { keysWithScope } from '$lib/sync/settings-registry';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * WP10e: the settings the reader's Aa panel "Copy from another device" copies (the look
 * only): what the panel shows, plus the reader options that go with them. Never E-ink or
 * Zen mode, nor tracker, sync or library settings. The copy of all of a device's own
 * settings (Settings > Data) takes every per-device key instead (allDeviceSettingKeys).
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

export const FONT_KEYS: AppearanceKey[] = ['fontFamilyGroupOne', 'fontFamilyGroupTwo'];
const FONT_KEY_SET = new Set<string>(FONT_KEYS);

/** Every per-device setting: what "Copy settings from another device" (Settings > Data) copies. */
export function allDeviceSettingKeys(): string[] {
  return keysWithScope('device');
}

export interface DeviceSettings<K extends string = string> {
  deviceId: string;
  name: string | undefined;
  /** Newest update of any of its listed settings (that device's clock, server-clamped). */
  updatedAt: number;
  /** Raw stored strings; null = never set on that device (its default). */
  values: Partial<Record<K, string | null>>;
}

export type DeviceAppearance = DeviceSettings<AppearanceKey>;

/**
 * The other devices' settings among `keys` from the local mirror's `setting` records
 * (`device:<deviceId>:<key>`), newest first. Deleted records and this device are left out.
 */
export function otherDevicesSettings<K extends string>(
  records: LocalRecord[],
  ownDeviceId: string,
  deviceNames: Record<string, string | undefined>,
  keys: readonly K[]
): DeviceSettings<K>[] {
  const wanted = new Set<string>(keys);
  const byDevice = new Map<string, DeviceSettings<K>>();

  for (const record of records) {
    if (record.kind !== 'setting' || record.deletedAt !== null) continue;

    const match = /^device:([^:]+):(.+)$/.exec(record.id);

    if (!match) continue;

    const [, deviceId, key] = match;

    if (deviceId === ownDeviceId || !wanted.has(key)) continue;

    const raw = record.data?.value;
    const value = typeof raw === 'string' ? raw : null;
    let entry = byDevice.get(deviceId);

    if (!entry) {
      entry = { deviceId, name: deviceNames[deviceId], updatedAt: 0, values: {} };
      byDevice.set(deviceId, entry);
    }

    entry.values[key as K] = value;
    entry.updatedAt = Math.max(entry.updatedAt, record.updatedAt);
  }

  return [...byDevice.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** WP10e: the other devices' appearance settings (the Aa panel's look-only copy). */
export function otherDevicesAppearance(
  records: LocalRecord[],
  ownDeviceId: string,
  deviceNames: Record<string, string | undefined>
): DeviceAppearance[] {
  return otherDevicesSettings(records, ownDeviceId, deviceNames, APPEARANCE_COPY_KEYS);
}

export interface CopyPlan<K extends string = AppearanceKey> {
  /** Values to apply (null = reset to the default). */
  apply: Partial<Record<K, string | null>>;
  /** Fonts the other device uses that this device doesn't have (kept as they are here). */
  missingFonts: string[];
}

/**
 * What a copy changes. A font the other device uses but this device doesn't have (one
 * no longer on the server, or one installed only on that computer) is not copied; the
 * current font is kept.
 */
export function planAppearanceCopy(
  values: Partial<Record<AppearanceKey, string | null>>,
  availableFonts: string[]
): CopyPlan {
  return planCopy(values, availableFonts, APPEARANCE_COPY_KEYS);
}

/** The same for the copy of all of a device's own settings (the font rule as above). */
export function planSettingsCopy(
  values: Partial<Record<string, string | null>>,
  availableFonts: string[]
): CopyPlan<string> {
  return planCopy(values, availableFonts, allDeviceSettingKeys());
}

function planCopy<K extends string>(
  values: Partial<Record<K, string | null>>,
  availableFonts: string[],
  keys: readonly K[]
): CopyPlan<K> {
  const apply: Partial<Record<K, string | null>> = {};
  const missingFonts: string[] = [];
  const fonts = new Set(availableFonts);

  for (const key of keys) {
    if (!(key in values)) continue;

    const value = values[key] ?? null;

    if (FONT_KEY_SET.has(key) && value !== null && !fonts.has(value)) {
      if (!missingFonts.includes(value)) missingFonts.push(value);
      continue;
    }

    apply[key] = value;
  }

  return { apply, missingFonts };
}
