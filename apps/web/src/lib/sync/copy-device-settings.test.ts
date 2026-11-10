/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_SETTINGS,
  applyAppearanceValues
} from '$lib/components/book-reader/appearance-settings';
import { SETTINGS_REGISTRY } from '$lib/sync/settings-registry';
import {
  APPEARANCE_COPY_KEYS,
  otherDevicesAppearance,
  planAppearanceCopy
} from './copy-device-settings';
import type { LocalRecord } from './sync-db';

function rec(
  id: string,
  value: string | null,
  updatedAt: number,
  deletedAt: number | null = null
): LocalRecord {
  return {
    kind: 'setting',
    id,
    bookId: null,
    deviceId: id.split(':')[1] ?? 'x',
    updatedAt,
    deletedAt,
    rev: 1,
    data: { value }
  };
}

describe('otherDevicesAppearance', () => {
  it('groups appearance settings by other device, newest first, with names', () => {
    const list = otherDevicesAppearance(
      [
        rec('device:me:fontSize', '30', 500),
        rec('device:boox:fontSize', '24', 100),
        rec('device:boox:writingMode', 'vertical-rl', 150),
        rec('device:boox:einkMode', '1', 900),
        rec('device:boox:trackerIdleTime', '60', 900),
        rec('device:phone:theme', 'dark-theme', 300),
        rec('device:phone:lineHeight', null, 200),
        rec('device:gone:fontSize', '40', 999, 1000),
        rec('global:customThemes', '{}', 999)
      ],
      'me',
      { boox: 'Boox', phone: undefined }
    );
    expect(list.map((d) => d.deviceId)).toEqual(['phone', 'boox']);
    expect(list[0]).toEqual({
      deviceId: 'phone',
      name: undefined,
      updatedAt: 300,
      values: { theme: 'dark-theme', lineHeight: null }
    });
    expect(list[1]).toMatchObject({
      name: 'Boox',
      updatedAt: 150,
      values: { fontSize: '24', writingMode: 'vertical-rl' }
    });
    expect(list[1].values).not.toHaveProperty('einkMode');
  });
});

describe('planAppearanceCopy', () => {
  it('keeps the current font when the other device uses one this device lacks', () => {
    const plan = planAppearanceCopy(
      {
        fontFamilyGroupOne: 'My Font',
        fontFamilyGroupTwo: 'Noto Sans JP',
        fontSize: '24',
        lineHeight: null
      },
      ['Noto Serif JP', 'Noto Sans JP']
    );
    expect(plan.apply).toEqual({
      fontFamilyGroupTwo: 'Noto Sans JP',
      fontSize: '24',
      lineHeight: null
    });
    expect(plan.missingFonts).toEqual(['My Font']);
  });
});

describe('APPEARANCE_SETTINGS', () => {
  it('covers every copied key, each a per-device setting with the store default', () => {
    expect(Object.keys(APPEARANCE_SETTINGS).sort()).toEqual([...APPEARANCE_COPY_KEYS].sort());
    for (const key of APPEARANCE_COPY_KEYS) {
      expect(SETTINGS_REGISTRY[key]?.scope, key).toBe('device');
      // Nothing is stored in the test environment, so each subject holds its default.
      expect(APPEARANCE_SETTINGS[key].subject.getValue(), key).toEqual(
        APPEARANCE_SETTINGS[key].defaultValue
      );
    }
    expect(APPEARANCE_COPY_KEYS).not.toContain('einkMode');
    expect(APPEARANCE_COPY_KEYS).not.toContain('zenMode');
  });

  it('applies values by type and resets never-set ones to the default', () => {
    const { fontSize, hideFurigana, writingMode } = APPEARANCE_SETTINGS;
    const changed = applyAppearanceValues({
      fontSize: '26',
      hideFurigana: '1',
      writingMode: 'horizontal-tb'
    });
    expect(changed.sort()).toEqual(['fontSize', 'hideFurigana', 'writingMode']);
    expect(fontSize.subject.getValue()).toBe(26);
    expect(hideFurigana.subject.getValue()).toBe(true);
    expect(applyAppearanceValues({ fontSize: '26' })).toEqual([]);
    applyAppearanceValues({ fontSize: null, hideFurigana: null, writingMode: null });
    expect(fontSize.subject.getValue()).toBe(20);
    expect(hideFurigana.subject.getValue()).toBe(false);
    expect(writingMode.subject.getValue()).toBe('vertical-rl');
  });
});
