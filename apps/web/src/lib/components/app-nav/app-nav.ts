/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  faBookAtlas,
  faChartLine,
  faHouse,
  faLayerGroup,
  faNoteSticky,
  type IconDefinition
} from '@fortawesome/free-solid-svg-icons';
import LogReportDialog from '$lib/components/log-report-dialog.svelte';
import { dialogManager } from '$lib/data/dialog-manager';

export interface AppNavEntry {
  routeId: string;
  label: string;
  icon: IconDefinition;
}

/**
 * The app's navigation (WP7b, decided with the user): Home, Library, Collections,
 * Stats; Settings (and Bug report) in a menu. WP11c: Notes between Collections and Stats.
 */
export const APP_NAV: readonly AppNavEntry[] = [
  { routeId: '/home', label: 'Home', icon: faHouse },
  { routeId: '/library', label: 'Library', icon: faBookAtlas },
  { routeId: '/collections', label: 'Collections', icon: faLayerGroup },
  { routeId: '/notes', label: 'Notes', icon: faNoteSticky },
  { routeId: '/statistics', label: 'Stats', icon: faChartLine }
];

export function isCurrentRoute(routeId: string | null | undefined, entry: AppNavEntry): boolean {
  return !!routeId && (routeId === entry.routeId || routeId.startsWith(`${entry.routeId}/`));
}

export function openBugReport(): void {
  dialogManager.dialogs$.next([
    {
      component: LogReportDialog,
      props: {
        title: 'Bug Report',
        message: 'Please include the attached file for your report'
      }
    }
  ]);
}
