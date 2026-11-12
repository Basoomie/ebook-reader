/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Settings page's tabs and their place in the address (`/settings?tab=audiobooks`),
 * so a link can open a tab and a reload keeps it. Reader has no `tab` (the plain address).
 */

export const SETTINGS_TABS = ['Reader', 'Data', 'Statistics', 'Audiobooks'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab named in the address; Reader for none or an unknown name. */
export function tabFromQuery(value: string | null | undefined): SettingsTab {
  const wanted = (value ?? '').trim().toLowerCase();
  return SETTINGS_TABS.find((t) => t.toLowerCase() === wanted) ?? 'Reader';
}

/** The query for a tab: '' for Reader, else `?tab=<name>`. */
export function tabQuery(tab: string): string {
  const known = tabFromQuery(tab);
  return known === 'Reader' ? '' : `?tab=${known.toLowerCase()}`;
}

/** The address of a tab, for links from other pages. */
export function settingsTabHref(pagePath: string, tab: SettingsTab): string {
  return `${pagePath}/settings${tabQuery(tab)}`;
}
