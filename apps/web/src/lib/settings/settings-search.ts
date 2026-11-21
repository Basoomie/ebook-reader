/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { matchesQuery, queryWords, searchKey } from './paged-list';
import {
  catalogSection,
  SETTINGS_CATALOG,
  SETTINGS_SECTIONS,
  type CatalogSection
} from './settings-catalog';
import type { SettingsTab } from './settings-tab';

/** One hit of "Search settings": a setting, or a whole section. */
export interface SettingsSearchResult {
  kind: 'setting' | 'section';
  id: string;
  tab: SettingsTab;
  section: CatalogSection;
  title: string;
  /** "Reader › Turning pages" */
  path: string;
  /** For a row shown only while another is on. */
  parent?: string;
}

interface Entry {
  result: SettingsSearchResult;
  text: string;
  titleKey: string;
}

let index: Entry[] | null = null;

function buildIndex(): Entry[] {
  const entries: Entry[] = [];
  for (const section of SETTINGS_SECTIONS) {
    entries.push({
      result: {
        kind: 'section',
        id: section.id,
        tab: section.tab,
        section,
        title: section.title,
        path: section.tab
      },
      text: [section.title, section.description, section.keywords, section.tab].join(' '),
      titleKey: searchKey(section.title)
    });
  }
  for (const setting of SETTINGS_CATALOG) {
    const section = catalogSection(setting.section);
    if (!section) continue;
    entries.push({
      result: {
        kind: 'setting',
        id: setting.id,
        tab: section.tab,
        section,
        title: setting.title,
        path: `${section.tab} › ${section.title}`,
        parent: setting.parent
      },
      text: [setting.title, setting.description, setting.keywords, section.title, section.tab].join(
        ' '
      ),
      titleKey: searchKey(setting.title)
    });
  }
  return entries;
}

/**
 * The best matches for a query: every word must be somewhere in the setting's words (its
 * title, description, keywords, section or tab); words in the title rank first, then a
 * title that starts with one, then whole sections.
 */
export function searchSettings(query: string, limit = 10): SettingsSearchResult[] {
  const words = queryWords(query);
  if (!words.length) return [];
  index ??= buildIndex();
  const scored: { entry: Entry; score: number; order: number }[] = [];
  index.forEach((entry, order) => {
    if (!matchesQuery(entry.text, words)) return;
    let score = 0;
    for (const w of words) {
      if (entry.titleKey.startsWith(w)) score += 4;
      else if (entry.titleKey.includes(w)) score += 3;
    }
    if (entry.result.kind === 'section') score += 1;
    scored.push({ entry, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.entry.result);
}
