/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';
import { DEFAULT_KEPT_RULES, type KeptRules } from './series-figures';

/**
 * "Went on to vol 2" (docs/design/series-figures.md): its thresholds, global settings (synced;
 * the server reads them as `global:seriesKept…`, catalog/series-figures.ts KEPT_SETTING_KEYS).
 */
export const seriesKeptMinReaders$ = writableNumberLocalStorageSubject()(
  'seriesKeptMinReaders',
  DEFAULT_KEPT_RULES.minReaders
);
export const seriesKeptNeighbourPercent$ = writableNumberLocalStorageSubject()(
  'seriesKeptNeighbourPercent',
  DEFAULT_KEPT_RULES.neighbourPercent
);
export const seriesKeptMaxPercent$ = writableNumberLocalStorageSubject()(
  'seriesKeptMaxPercent',
  DEFAULT_KEPT_RULES.maxPercent
);
export const seriesKeptMinMonths$ = writableNumberLocalStorageSubject()(
  'seriesKeptMinMonths',
  DEFAULT_KEPT_RULES.minMonths
);

/** Each setting's allowed range (the field puts a bad value back to the default). */
export const KEPT_LIMITS: Record<keyof KeptRules, { min: number; max: number }> = {
  minReaders: { min: 0, max: 100000 },
  neighbourPercent: { min: 0, max: 100 },
  maxPercent: { min: 100, max: 1000 },
  minMonths: { min: 0, max: 120 }
};

function valid(value: number, key: keyof KeptRules): number {
  const { min, max } = KEPT_LIMITS[key];
  return Number.isFinite(value) && value >= min && value <= max ? value : DEFAULT_KEPT_RULES[key];
}

/** The thresholds as they are now (the offline Library's figures). */
export function keptRulesNow(): KeptRules {
  return {
    minReaders: valid(seriesKeptMinReaders$.getValue(), 'minReaders'),
    neighbourPercent: valid(seriesKeptNeighbourPercent$.getValue(), 'neighbourPercent'),
    maxPercent: valid(seriesKeptMaxPercent$.getValue(), 'maxPercent'),
    minMonths: valid(seriesKeptMinMonths$.getValue(), 'minMonths')
  };
}
