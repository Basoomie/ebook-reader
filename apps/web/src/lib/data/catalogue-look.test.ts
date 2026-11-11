/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { isCatalogueDark, luminance, themeBackground } from './catalogue-look';
import type { CustomTheme } from './theme-option';

const custom = (backgroundColor: string) =>
  ({
    fontColor: 'rgba(255,255,255,1)',
    backgroundColor,
    selectionFontColor: '',
    selectionBackgroundColor: '',
    hintFuriganaShadowColor: '',
    hintFuriganaFontColor: '',
    tooltipTextFontColor: ''
  }) as CustomTheme;

describe('catalogue look', () => {
  it('reads colours', () => {
    expect(luminance('rgba(255, 255, 255, 1)')).toBeCloseTo(1);
    expect(luminance('#000000')).toBe(0);
    expect(luminance('rgb(18, 18, 18)')).toBeLessThan(0.02);
    expect(luminance('papayawhip')).toBeNull();
  });

  it('finds built-in and custom theme backgrounds', () => {
    expect(themeBackground('light-theme', {})).toMatch(/^rgba\(255, 255, 255/);
    expect(themeBackground('night', { night: custom('#101820') })).toBe('#101820');
    expect(themeBackground('missing', {})).toBeNull();
  });

  it('follows the reader theme on auto, else the pick', () => {
    expect(isCatalogueDark('auto', 'light-theme', {})).toBe(false);
    expect(isCatalogueDark('auto', 'ecru-theme', {})).toBe(false);
    expect(isCatalogueDark('auto', 'dark-theme', {})).toBe(true);
    expect(isCatalogueDark('auto', 'black-theme', {})).toBe(true);
    expect(isCatalogueDark('auto', 'night', { night: custom('rgba(20, 24, 32, 1)') })).toBe(true);
    expect(isCatalogueDark('auto', 'missing', {})).toBe(false);
    expect(isCatalogueDark('dark', 'light-theme', {})).toBe(true);
    expect(isCatalogueDark('light', 'dark-theme', {})).toBe(false);
  });
});
