/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Every localStorage-backed setting, classified for sync (WP4, design §5):
 *
 * - global: one value for all devices (lww). On once a device is the settings
 *   source (WP5, settings-source.ts); every other device takes the shared
 *   values over before publishing any. A key added here later is taken over
 *   the same way on devices that adopted before it existed (settings-sync.ts).
 * - device: this device's own value. Published as `device:<id>:<key>` so
 *   another device can copy it ("Copy settings from another device" in
 *   Settings > Data copies every device key); never applied automatically.
 * - local:  never leaves the device (the AnkiConnect keys, bookkeeping,
 *   things that are records of their own).
 *
 * A key missing here is treated as local. A test fails when a settings file
 * gains a key that isn't listed (or one listed here disappears).
 * Whispersync's own settings (lib/whispersync/lib/stores.ts) are listed too:
 * per device, except its AnkiConnect key.
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
  followSystemTheme: d('Boolean'),
  lightTheme: d('String'),
  darkTheme: d('String'),
  einkMode: d('Boolean'),
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
  zenMode: d('Boolean'),
  mouseDragPageTurn: d('Boolean'),
  mouseDragThreshold: d('Number'),
  jumpHistoryLimit: d('Number'),
  highlightLastColor: d('Number'),
  highlightRefindChars: d('Number'),
  highlightBarAnySelection: d('Boolean'),
  showReturnMarker: d('Boolean'),
  confirmClose: d('Boolean'),
  manualBookmark: d('Boolean'),
  autoBookmark: d('Boolean'),
  autoBookmarkTime: d('Number'),
  requestPersistentStorage: d('Boolean'),
  importHTMLFixMode: d('String'),
  restrictImportFixToAnchor: d('Boolean'),
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
  timeLeftRecentMinutes: d('Number'),
  timeLeftMinMinutes: d('Number'),
  bottomBarTimeLeft: d('String'),
  onTrackDot: d('Boolean'),
  onTrackDotRule: d('String'),

  // --- pacer (per device, Season 2 Phase 10) ---
  pacerMode: d('String'),
  pacerSpeed: d('Number'),
  pacerTurnPages: d('Boolean'),
  pacerKeepBehind: d('Number'),
  pacerEinkStep: d('String'),
  pacerLookupResume: d('Number'),
  pacerIdleMinutes: d('Number'),
  pacerTextlessPageSeconds: d('Number'),

  // --- read-aloud with the PC voice (per device, Season 2 Phase 12 session 3) ---
  readAloudSpeed: d('Number'),
  readAloudAheadSeconds: d('Number'),
  readAloudLookupResume: d('Number'),
  readAloudBottomBarButton: d('Boolean'),

  // --- statistics rules that must agree across devices (global) ---
  startDayHoursForTracker: g('Number'),
  statsWeekStart: g('Number'),
  speedGoalMinMinutes: g('Number'),
  keepLocalStatisticsOnDeletion: g('Boolean'),
  overwriteBookCompletion: g('Boolean'),
  addCharactersOnCompletion: g('Boolean'),

  // (WP15e: the old sync's settings and storage sources were removed; unlisted keys,
  // e.g. their values still in localStorage, count as local and never leave the device.)

  // --- local: the current goal (goals sync as records of their own), goal-sync bookkeeping,
  // and ttsu's one-time hint for its old web address ---
  readingGoal: l('Object'),
  lastReadingGoalsModified: l('Number'),
  domainHintSeen: l('Boolean'),

  // --- remembered choices (per device: copied with the device's other settings) ---
  lastBlurredTrackerItems: d('Set'),
  lastReadingDataHeatmapAggregationMode: d('String'),

  // --- lib/library/settings.ts (per device) ---
  libraryRequestTimeoutSeconds: d('Number'),
  libraryServerCheckSeconds: d('Number'),
  libraryFilter: d('String'),
  libraryView: d('String'),
  libraryInfoLine: d('Boolean'),
  librarySort: d('String'),
  libraryGroupSort: d('String'),
  notesBookSort: d('String'),
  notesHighlightSort: d('String'),
  libraryCoverSize: d('Number'),
  libraryAutoLoad: d('Boolean'),
  libraryBulkDownloadMode: d('String'),
  libraryDownloadConfirmGb: d('Number'),
  libraryLook: d('String'),
  bookIllustrationsPosition: d('String'),

  // --- lib/sync/settings.ts (per device) ---
  recordSyncEnabled: d('Boolean'),
  syncDebounceSeconds: d('Number'),
  syncIntervalMinutes: d('Number'),
  positionPromptEnabled: d('Boolean'),
  positionPromptMinChars: d('Number'),
  readingStatusSettleSeconds: d('Number'),

  // --- lib/anki/settings.ts (WP14 "Enrich last card") ---
  ankiConnectUrl: d('String'),
  ankiConnectTimeoutSeconds: d('Number'),
  ankiBottomBarButton: d('Boolean'),
  ankiNoticeSeconds: d('Number'),
  ankiConnectKey: l('String'), // AnkiConnect's key never leaves the device
  ankiFieldMapping: g('Object'),
  ankiLookBackDays: g('Number'),
  ankiTagPrefix: g('String'),
  ankiAudioMatchThreshold: g('Number'),
  ankiAudioMaxSeconds: g('Number'),
  ankiAutoEnrich: g('Boolean'), // Phase 8: enrich a card made with Yomitan by itself
  ankiAutoEnrichSeconds: g('Number'), // how often auto-enrich asks Anki for new cards

  // --- lib/audio/tts-settings.ts (WP17: pauses in audiobooks made on the PC) ---
  ttsSentencePauseMs: g('Number'),
  ttsParagraphPauseMs: g('Number'),
  ttsChapterPauseMs: g('Number'),
  ttsDialoguePauseMs: g('Number'), // Season 2 Phase 12 session 4: between narration and dialogue
  speakerUnsureBelow: g('Number'), // Season 2 Phase 12 session 5: quotes to check (percent)

  // --- lib/home/settings.ts (per device, WP7b) ---
  appOpenTarget: d('String'),
  homeRows: d('Array'),
  homeRowLength: d('Number'),

  // --- lib/whispersync/lib/stores.ts: whispersync's own settings (per device; its AnkiConnect
  // key never leaves the device, like ankiConnectKey). Not the dragged side-menu width
  // (ttu-whispersync-side-menu-width, plain localStorage in AudioBookMenu.svelte): unlisted, local. ---
  'ttu-whispersync-menu-position': d('String'),
  'ttu-whispersync-hide-footer-actions': d('Boolean'),
  'ttu-whispersync-player-playback-rate': d('Number'),
  'ttu-whispersync-reader-line-highlight-color': d('String'),
  'ttu-whispersync-reader-line-text-highlight-color': d('String'),
  'ttu-whispersync-reader-enable-line-highlight': d('Boolean'),
  'ttu-whispersync-reader-enable-line-text-highlight': d('Boolean'),
  'ttu-whispersync-reader-enable-auto-reload': d('Boolean'),
  'ttu-whispersync-reader-enable-filesystem-api': d('Boolean'),
  'ttu-whispersync-reader-enable-auto-scroll': d('Boolean'),
  'ttu-whispersync-reader-enable-tracker-auto-pause': d('Boolean'),
  'ttu-whispersync-reader-prevent-action-on-selection': d('Boolean'),
  'ttu-whispersync-reader-enable-menu-target': d('Boolean'),
  'ttu-whispersync-reader-scroll-mode': d('String'),
  'ttu-whispersync-reader-scroll-behavior': d('String'),
  'ttu-whispersync-reader-click-action': d('String'),
  'ttu-whispersync-reader-menu-open-mode': d('String'),
  'ttu-whispersync-reader-menu-pause-mode': d('String'),
  'ttu-whispersync-reader-menu-open-time': d('Number'),
  'ttu-whispersync-reader-tracker-pause-threshold': d('Number'),
  'ttu-whispersync-subtitles-enable-persist': d('Boolean'),
  'ttu-whispersync-subtitles-enable-auto-scroll': d('Boolean'),
  'ttu-whispersync-subtitles-copy-font-family': d('Boolean'),
  'ttu-whispersync-subtitles-copy-font-size': d('Boolean'),
  'ttu-whispersync-subtitles-copy-line-height': d('Boolean'),
  'ttu-whispersync-subtitles-prevent-action-on-selection': d('Boolean'),
  'ttu-whispersync-subtitles-click-action': d('String'),
  'ttu-whispersync-subtitles-actions-visibility': d('String'),
  'ttu-whispersync-subtitles-actions-visibility-time': d('Number'),
  'ttu-whispersync-subtitles-global-start-padding': d('Number'),
  'ttu-whispersync-subtitles-global-end-padding': d('Number'),
  'ttu-whispersync-subtitles-font-family': d('String'),
  'ttu-whispersync-subtitles-font-size': d('Number'),
  'ttu-whispersync-subtitles-line-height': d('Number'),
  'ttu-whispersync-player-enable-cover': d('Boolean'),
  'ttu-whispersync-player-enable-chapters': d('Boolean'),
  'ttu-whispersync-player-enable-wake-lock': d('Boolean'),
  'ttu-whispersync-player-enable-subtitle-copy': d('Boolean'),
  'ttu-whispersync-player-enable-dictionary-detection': d('Boolean'),
  'ttu-whispersync-player-auto-pause-mode': d('String'),
  'ttu-whispersync-player-rewind-time': d('Number'),
  'ttu-whispersync-player-alt-rewind-time': d('Number'),
  'ttu-whispersync-player-fast-forward-time': d('Number'),
  'ttu-whispersync-player-alt-fast-forward-time': d('Number'),
  'ttu-whispersync-player-playback-rate-decrease-time': d('Number'),
  'ttu-whispersync-player-playback-rate-increase-time': d('Number'),
  'ttu-whispersync-export-field-mode': d('String'),
  'ttu-whispersync-export-audio-processor': d('String'),
  'ttu-whispersync-export-audio-format': d('String'),
  'ttu-whispersync-export-audio-bitrate': d('Number'),
  'ttu-whispersync-export-cover-format': d('String'),
  'ttu-whispersync-export-enable-merge-selection-auto-clear': d('Boolean'),
  'ttu-whispersync-enable-ffmpeg-log': d('Boolean'),
  'ttu-whispersync-anki-add-subtitle-tag': d('Boolean'),
  'ttu-whispersync-anki-add-audio-tag': d('Boolean'),
  'ttu-whispersync-anki-allow-empty-key-field': d('Boolean'),
  'ttu-whispersync-anki-tag-list': d('String'),
  'ttu-whispersync-anki-duplicate-mode': d('String'),
  'ttu-whispersync-anki-url': d('String'),
  'ttu-whispersync-anki-key': l('String'),
  'ttu-whispersync-anki-deck': d('String'),
  'ttu-whispersync-anki-update-deck': d('String'),
  'ttu-whispersync-anki-model': d('String'),
  'ttu-whispersync-anki-update-model': d('String'),
  'ttu-whispersync-anki-sentence-field': d('String'),
  'ttu-whispersync-anki-update-sentence-field': d('String'),
  'ttu-whispersync-anki-sound-field': d('String'),
  'ttu-whispersync-anki-update-sound-field': d('String'),
  'ttu-whispersync-anki-cover-field': d('String'),
  'ttu-whispersync-anki-update-cover-field': d('String'),
  'ttu-whispersync-anki-enable-open-in-browser': d('Boolean'),
  'ttu-whispersync-action-list-of-reader': d('Array'),
  'ttu-whispersync-action-list-of-subtitles': d('Array'),
  'ttu-whispersync-action-list-of-footer': d('Array'),
  'ttu-whispersync-keybindings-enable-time-fallback': d('Boolean'),
  'ttu-whispersync-match-line-ignore-rp': d('Boolean'),
  'ttu-whispersync-match-line-similarity-threshold': d('Number'),
  'ttu-whispersync-match-line-max-attempts': d('Number')
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
