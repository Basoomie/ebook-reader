/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS, settingsTabHref, tabFromQuery, tabQuery } from './settings-tab';

describe('settings tabs in the address', () => {
  it('reads the tab, ignoring case, and falls back to Reader', () => {
    expect(tabFromQuery('audiobooks')).toBe('Audiobooks');
    expect(tabFromQuery(' Data ')).toBe('Data');
    expect(tabFromQuery('statistics')).toBe('Statistics');
    expect(tabFromQuery(null)).toBe('Reader');
    expect(tabFromQuery('')).toBe('Reader');
    expect(tabFromQuery('nonsense')).toBe('Reader');
  });

  it('writes the tab back, Reader as the plain address', () => {
    expect(tabQuery('Reader')).toBe('');
    expect(tabQuery('Audiobooks')).toBe('?tab=audiobooks');
    expect(tabQuery('nonsense')).toBe('');
    for (const t of SETTINGS_TABS) expect(tabFromQuery(tabQuery(t).slice(5) || null)).toBe(t);
    expect(settingsTabHref('/app', 'Audiobooks')).toBe('/app/settings?tab=audiobooks');
  });
});
