/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { catalogSection, SETTINGS_CATALOG, SETTINGS_SECTIONS } from './settings-catalog';
import { searchSettings } from './settings-search';
import { SETTINGS_TABS } from './settings-tab';

describe('settings catalog', () => {
  it('has unique ids for sections and settings', () => {
    const sections = SETTINGS_SECTIONS.map((s) => s.id);
    const settings = SETTINGS_CATALOG.map((s) => s.id);
    expect(new Set(sections).size).toBe(sections.length);
    expect(new Set(settings).size).toBe(settings.length);
    // A section and a row never share a DOM id (s-… vs setting-…), but keep them apart anyway.
    expect(sections.filter((id) => settings.includes(id))).toEqual([]);
  });

  it('puts every section in a real tab and every setting in a real section', () => {
    for (const s of SETTINGS_SECTIONS) expect(SETTINGS_TABS).toContain(s.tab);
    for (const s of SETTINGS_CATALOG) expect(catalogSection(s.section), s.id).toBeDefined();
  });

  it('gives a dependent setting a parent in the same section', () => {
    for (const s of SETTINGS_CATALOG.filter((x) => x.parent)) {
      const parent = SETTINGS_CATALOG.find((p) => p.id === s.parent);
      expect(parent, s.id).toBeDefined();
      expect(parent?.section, s.id).toBe(s.section);
    }
  });

  it('has sections for every tab', () => {
    for (const tab of SETTINGS_TABS) {
      expect(
        SETTINGS_SECTIONS.some((s) => s.tab === tab),
        tab
      ).toBe(true);
    }
  });
});

describe('searchSettings', () => {
  it('finds a setting by a word of its title, with its tab and section', () => {
    const [first] = searchSettings('swipe');
    expect(first).toMatchObject({ kind: 'setting', id: 'swipe-threshold', tab: 'Reader' });
    expect(first.path).toBe('Reader › Turning pages');
  });

  it('finds settings by their old names and other words', () => {
    expect(searchSettings('blur').map((r) => r.id)).toContain('blur-images');
    expect(searchSettings('disable wheel').map((r) => r.id)).toContain('mouse-wheel');
    expect(searchSettings('webhook').map((r) => r.id)).toContain('notify-discord');
  });

  it('needs every word and ranks title matches first', () => {
    const results = searchSettings('wait lookup');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.title.toLowerCase()).toContain('lookup');
    expect(searchSettings('font')[0].title.toLowerCase()).toContain('font');
    expect(searchSettings('zzzz-nothing')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });
});
