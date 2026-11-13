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
  ankiFieldMapping$,
  ankiLookBackDays$,
  ankiTagPrefix$
} from '$lib/anki/settings';
import {
  ttsChapterPauseMs$,
  ttsParagraphPauseMs$,
  ttsSentencePauseMs$
} from '$lib/audio/tts-settings';
import { parseStoredValue, SETTINGS_REGISTRY } from '$lib/sync/settings-registry';

/**
 * The live settings a pulled global value is applied to. Setting the subject
 * also writes localStorage, exactly like a change made in the settings page.
 * Only used once global settings sync is switched on (WP5).
 */
export const GLOBAL_SETTING_SUBJECTS: Record<string, { next(value: never): void }> = {
  customThemes: customThemes$,
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
  ttsSentencePauseMs: ttsSentencePauseMs$,
  ttsParagraphPauseMs: ttsParagraphPauseMs$,
  ttsChapterPauseMs: ttsChapterPauseMs$
};

/** Applies one global setting. null (never set on the source device) leaves this device's value. */
export function applyGlobalSettingValue(key: string, raw: string | null): void {
  const subject = GLOBAL_SETTING_SUBJECTS[key];
  const spec = SETTINGS_REGISTRY[key];
  if (!subject || !spec || raw === null) return;
  subject.next(parseStoredValue(spec.type, raw) as never);
}
