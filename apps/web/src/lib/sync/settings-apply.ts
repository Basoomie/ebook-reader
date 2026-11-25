/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  addCharactersOnCompletion$,
  customThemes$,
  keepLocalStatisticsOnDeletion$,
  overwriteBookCompletion$,
  speedGoalMinMinutes$,
  startDayHoursForTracker$,
  statsWeekStart$
} from '$lib/data/store';
import {
  ankiAudioMatchThreshold$,
  ankiAudioMaxSeconds$,
  ankiAutoEnrich$,
  ankiAutoEnrichSeconds$,
  ankiFieldMapping$,
  ankiLookBackDays$,
  ankiTagPrefix$
} from '$lib/anki/settings';
import {
  ttsChapterPauseMs$,
  ttsDialoguePauseMs$,
  speakerUnsureBelow$,
  ttsParagraphPauseMs$,
  ttsSentencePauseMs$
} from '$lib/audio/tts-settings';
import {
  summaryAutoOnFirstCompletion$,
  summaryLanguages$,
  summaryRecapAuto$,
  summarySpoilerBlur$
} from '$lib/summaries/settings';
import {
  bookSearchHistoryLimit$,
  bookSearchHistoryOn$,
  searchHistoryLimit$,
  searchHistoryOn$
} from '$lib/search-history/settings';
import { searchReadsAsOn$, searchSuggestionsOn$ } from '$lib/library/search-settings';
import {
  recentlyViewedDwellSeconds$,
  recentlyViewedKeep$,
  recentlyViewedKeepBooks$,
  recentlyViewedKeepDays$,
  recentlyViewedOn$
} from '$lib/recently-viewed/settings';
import { libraryThemes$ } from '$lib/library/settings';
import { parseStoredValue, SETTINGS_REGISTRY } from '$lib/sync/settings-registry';

/**
 * The live settings a pulled global value is applied to. Setting the subject
 * also writes localStorage, exactly like a change made in the settings page.
 * Only used once global settings sync is switched on (WP5).
 */
export const GLOBAL_SETTING_SUBJECTS: Record<string, { next(value: never): void }> = {
  customThemes: customThemes$,
  libraryThemes: libraryThemes$,
  startDayHoursForTracker: startDayHoursForTracker$,
  statsWeekStart: statsWeekStart$,
  speedGoalMinMinutes: speedGoalMinMinutes$,
  keepLocalStatisticsOnDeletion: keepLocalStatisticsOnDeletion$,
  overwriteBookCompletion: overwriteBookCompletion$,
  addCharactersOnCompletion: addCharactersOnCompletion$,
  ankiFieldMapping: ankiFieldMapping$,
  ankiLookBackDays: ankiLookBackDays$,
  ankiTagPrefix: ankiTagPrefix$,
  ankiAudioMatchThreshold: ankiAudioMatchThreshold$,
  ankiAudioMaxSeconds: ankiAudioMaxSeconds$,
  ankiAutoEnrich: ankiAutoEnrich$,
  ankiAutoEnrichSeconds: ankiAutoEnrichSeconds$,
  ttsSentencePauseMs: ttsSentencePauseMs$,
  ttsParagraphPauseMs: ttsParagraphPauseMs$,
  ttsChapterPauseMs: ttsChapterPauseMs$,
  ttsDialoguePauseMs: ttsDialoguePauseMs$,
  speakerUnsureBelow: speakerUnsureBelow$,
  summaryLanguages: summaryLanguages$,
  summarySpoilerBlur: summarySpoilerBlur$,
  summaryAutoOnFirstCompletion: summaryAutoOnFirstCompletion$,
  summaryRecapAuto: summaryRecapAuto$,
  searchHistoryOn: searchHistoryOn$,
  searchHistoryLimit: searchHistoryLimit$,
  bookSearchHistoryOn: bookSearchHistoryOn$,
  bookSearchHistoryLimit: bookSearchHistoryLimit$,
  searchSuggestionsOn: searchSuggestionsOn$,
  searchReadsAsOn: searchReadsAsOn$,
  recentlyViewedOn: recentlyViewedOn$,
  recentlyViewedDwellSeconds: recentlyViewedDwellSeconds$,
  recentlyViewedKeep: recentlyViewedKeep$,
  recentlyViewedKeepBooks: recentlyViewedKeepBooks$,
  recentlyViewedKeepDays: recentlyViewedKeepDays$
};

/** Applies one global setting. null (never set on the source device) leaves this device's value. */
export function applyGlobalSettingValue(key: string, raw: string | null): void {
  const subject = GLOBAL_SETTING_SUBJECTS[key];
  const spec = SETTINGS_REGISTRY[key];
  if (!subject || !spec || raw === null) return;
  subject.next(parseStoredValue(spec.type, raw) as never);
}
