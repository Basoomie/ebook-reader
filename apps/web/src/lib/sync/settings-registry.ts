/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Every localStorage-backed setting, classified for sync (WP4, design §5):
 *
 * - global: one value for all devices (lww). The mechanism ships switched
 *   off; WP5 turns it on after the user picks the device to take values from.
 * - device: this device's own value. Published as `device:<id>:<key>` so
 *   another device can copy it later; never applied automatically.
 * - local:  never leaves the device (connection and legacy sync settings,
 *   remembered UI state, things that become records of their own later).
 *
 * A key missing here is treated as local. A test fails when a settings file
 * gains a key that isn't listed (or one listed here disappears).
 * Whispersync's own settings (lib/whispersync) are not listed: they stay local.
 */

export type SettingScope = 'global' | 'device' | 'local';
/** How the subject stores the value in localStorage (see lib/data/internal). */
export type SettingType = 'String' | 'Number' | 'Boolean' | 'Object' | 'Array' | 'Set';

export interface SettingSpec {
  scope: SettingScope;
  type: SettingType;
}

const g = (type: SettingType): SettingSpec => ({ scope: 'global', type });
const d = (type: SettingType): SettingSpec => ({ scope: 'device', type });
const l = (type: SettingType): SettingSpec => ({ scope: 'local', type });

export const SETTINGS_REGISTRY: Record<string, SettingSpec> = {
  // --- lib/data/store.ts: appearance (per device) ---
  theme: d('String'),
  customThemes: g('Object'),
  autoScrollMultiplier: d('Number'),
  fontFamilyGroupOne: d('String'),
  fontFamilyGroupTwo: d('String'),
  fontSize: d('Number'),
  lineHeight: d('Number'),
  textIndentation: d('Number'),
  textMarginValue: d('Number'),
  hideSpoilerImage: d('Boolean'),
  hideSpoilerImageMode: d('String'),
  hideFurigana: d('Boolean'),
  furiganaStyle: d('String'),
  writingMode: d('String'),
  enableVerticalFontKerning: d('Boolean'),
  enableFontVPAL: d('Boolean'),
  verticalTextOrientation: d('String'),
  prioritizeReaderStyles: d('Boolean'),
  enableTextJustification: d('Boolean'),
  enableTextWrapPretty: d('Boolean'),
  textMarginMode: d('String'),
  enableReaderWakeLock: d('Boolean'),
  showCharacterCounter: d('Boolean'),
  showPercentage: d('Boolean'),
  showFooterChapterCharacterCounter: d('Boolean'),
  showFooterChapterPercentage: d('Boolean'),
  viewMode: d('String'),
  secondDimensionMaxValue: d('Number'),
  firstDimensionMargin: d('Number'),
  pageColumns: d('Number'),
  verticalCustomReadingPosition: d('Number'),
  horizontalCustomReadingPosition: d('Number'),

  // --- reader behaviour (per device) ---
  swipeThreshold: d('Number'),
  disableWheelNavigation: d('Boolean'),
  autoPositionOnResize: d('Boolean'),
  avoidPageBreak: d('Boolean'),
  pauseTrackerOnCustomPointChange: d('Boolean'),
  customReadingPointEnabled: d('Boolean'),
  selectionToBookmarkEnabled: d('Boolean'),
  enableTapEdgeToFlip: d('Boolean'),
  confirmClose: d('Boolean'),
  manualBookmark: d('Boolean'),
  autoBookmark: d('Boolean'),
  autoBookmarkTime: d('Number'),
  requestPersistentStorage: d('Boolean'),
  importHTMLFixMode: d('String'),
  restrictImportFixToAnchor: d('Boolean'),
  booklistSortOptions: d('Object'),
  confirmStatisticsDeletion: d('Boolean'),

  // --- tracker (per device, decisions.md) ---
  statisticsEnabled: d('Boolean'),
  trackerAutoPause: d('String'),
  openTrackerOnCompletion: d('Boolean'),
  trackerAutoStartTime: d('Number'),
  trackerIdleTime: d('Number'),
  trackerLongPressTime: d('Number'),
  trackerForwardSkipThreshold: d('Number'),
  trackerBackwardSkipThreshold: d('Number'),
  trackerSkipThresholdAction: d('String'),
  trackerPopupDetection: d('Boolean'),
  adjustStatisticsAfterIdleTime: d('Boolean'),

  // --- statistics rules that must agree across devices (global) ---
  startDayHoursForTracker: g('Number'),
  keepLocalStatisticsOnDeletion: g('Boolean'),
  overwriteBookCompletion: g('Boolean'),
  addCharactersOnCompletion: g('Boolean'),

  // --- legacy file sync and storage sources (local; may hold credentials) ---
  cacheStorageData: l('Boolean'),
  autoReplication: l('String'),
  replicationSaveBehavior: l('String'),
  showExternalPlaceholder: l('Boolean'),
  gDriveStorageSource: l('String'),
  oneDriveStorageSource: l('String'),
  selfHostStorageSource: l('String'),
  fsStorageSource: l('String'),
  syncTarget: l('String'),
  statisticsMergeMode: l('String'),
  readingGoalsMergeMode: l('String'),
  lastStorageSource: l('String'),

  // --- become records of their own later (local until then) ---
  readingGoal: l('Object'), // ReadingGoal records (WP5/WP12)
  userfonts: l('Array'), // server-synced fonts (WP13)

  // --- remembered UI state (local) ---
  lastExportedTarget: l('String'),
  lastExportedTypes: l('Array'),
  lastBlurredTrackerItems: l('Set'),
  lastSyncedSettingsSource: l('String'),
  lastSyncedSettingsTarget: l('String'),
  lastReadingGoalsModified: l('Number'),
  lastStatisticsTab: l('String'),
  lastStatisticsRangeTemplate: l('String'),
  lastStatisticsStartDate: l('String'),
  lastStatisticsEndDate: l('String'),
  lastStartDayOfWeek: l('Number'),
  lastReadingTimeDataSource: l('String'),
  lastCharactersDataSource: l('String'),
  lastReadingSpeedDataSource: l('String'),
  lastPrimaryReadingDataAggregationMode: l('String'),
  lastStatisticsFilterDateRangeOnly: l('Boolean'),
  lastStatisticsFilterShowSelectedTitlesOnly: l('Boolean'),
  lastReadingDataHeatmapAggregationMode: l('String'),
  lastReadingGoalsHeatmapAggregationMode: l('String'),
  lastStatisticsSummarySortProperty: l('String'),
  lastStatisticsSummarySortDirection: l('String'),
  domainHintSeen: l('Boolean'),

  // --- lib/library/settings.ts (per device) ---
  libraryRequestTimeoutSeconds: d('Number'),
  libraryFilter: d('String'),

  // --- lib/sync/settings.ts (per device) ---
  recordSyncEnabled: d('Boolean'),
  syncDebounceSeconds: d('Number'),
  syncIntervalMinutes: d('Number'),
  positionPromptEnabled: d('Boolean'),
  positionPromptMinChars: d('Number'),
  readingStatusSettleSeconds: d('Number')
};

export function settingScope(key: string): SettingScope {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key)
    ? SETTINGS_REGISTRY[key].scope
    : 'local';
}

export function keysWithScope(scope: SettingScope): string[] {
  return Object.keys(SETTINGS_REGISTRY).filter((key) => SETTINGS_REGISTRY[key].scope === scope);
}

/** Turns a raw localStorage string into the value its subject holds (same rules as lib/data/internal). */
export function parseStoredValue(type: SettingType, raw: string): unknown {
  switch (type) {
    case 'Number':
      return +raw;
    case 'Boolean':
      return !!+raw;
    case 'Object':
      return JSON.parse(raw || '{}');
    case 'Array':
      return JSON.parse(raw || '[]');
    case 'Set':
      return new Set(JSON.parse(raw || '[]'));
    default:
      return raw;
  }
}
