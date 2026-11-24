/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { BOTTOM_IDS, TOP_IDS } from '$lib/reader-toolbar/toolbar-layout';
import { LINK_IDS } from '$lib/book-links/links';
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

describe('Reader › Toolbars (reader toolbars session 2)', () => {
  it('is found as a section, and lists every entry of both bars', () => {
    expect(
      searchSettings('toolbar').some((r) => r.kind === 'section' && r.id === 'reader-toolbars')
    ).toBe(true);
    const rows = SETTINGS_CATALOG.filter((s) => s.section === 'reader-toolbars').map((s) => s.id);
    for (const id of TOP_IDS) expect(rows).toContain(`toolbar-top-${id}`);
    for (const id of BOTTOM_IDS) expect(rows).toContain(`toolbar-bottom-${id}`);
    expect(searchSettings('zen').map((r) => r.id)).toContain('toolbar-top-zen');
  });

  it('the three old bottom-bar switches are gone; their old searches land on the new rows', () => {
    const ids = SETTINGS_CATALOG.map((s) => s.id);
    for (const old of ['anki-bottom-bar', 'read-aloud-button', 'return-marker']) {
      expect(ids).not.toContain(old);
    }
    expect(searchSettings('Anki button in the bottom bar')[0]?.id).toBe('toolbar-bottom-anki');
    expect(searchSettings('read-aloud button')[0]?.id).toBe('toolbar-bottom-readAloud');
    expect(searchSettings('Way back after a jump')[0]?.id).toBe('toolbar-bottom-returnMarker');
    expect(searchSettings('return marker')[0]?.id).toBe('toolbar-bottom-returnMarker');
  });
});

describe('Settings › Library (calibre-metadata-display.md)', () => {
  it('has Theme and display, Book page, Links, Editing and Downloading books, in that order', () => {
    expect(SETTINGS_SECTIONS.filter((s) => s.tab === 'Library').map((s) => s.title)).toEqual([
      'Theme and display', // was Look (library themes, 2026-11-24)
      // Search history (2026-11-24): after Look.
      'Search',
      'Book page',
      // Book summaries session 4: after Book page.
      'Summaries',
      'Links',
      // Calibre metadata editing (design 2026-11-23): a new section after Links.
      'Editing',
      'Downloading books'
    ]);
  });

  it('search finds the moved settings in their new place; Library server stays in Data', () => {
    expect(searchSettings('Library look')[0]).toMatchObject({
      id: 'library-look',
      tab: 'Library',
      path: 'Library › Theme and display'
    });
    expect(searchSettings('Illustrations on the book page')[0]).toMatchObject({
      id: 'illustrations-position',
      tab: 'Library',
      path: 'Library › Book page'
    });
    expect(searchSettings('Several files arrive as')[0]).toMatchObject({
      id: 'bulk-download-mode',
      tab: 'Library'
    });
    expect(searchSettings('Ask before downloads larger than')[0]?.tab).toBe('Library');
    expect(catalogSection('data-server')?.tab).toBe('Data');
  });

  it('lists the three link settings and one row per link', () => {
    for (const id of ['links-placement', 'links-more-as', 'links-search']) {
      expect(SETTINGS_CATALOG.find((s) => s.id === id)?.section, id).toBe('library-book-page');
    }
    const rows = SETTINGS_CATALOG.filter((s) => s.section === 'library-links').map((s) => s.id);
    expect(rows).toEqual(LINK_IDS.map((id) => `book-link-${id}`));
    expect(searchSettings('U-NEXT')[0]?.id).toBe('book-link-unext');
    expect(searchSettings('search links')[0]?.id).toBe('links-search');
  });
});
