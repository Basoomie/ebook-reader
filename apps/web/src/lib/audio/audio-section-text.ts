/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Texts of the book page's Audiobook section (redesign decided with the user, 2026-11-20:
 * three rows, Audiobook / Subtitles / Text-to-speech, one open at a time; "PC voice" is
 * called "TTS voice" on screen).
 */
import type { LinkView, SubtitleView } from '$lib/audio/audio-link';
import type { BookVoiceChoices } from '$lib/audio/tts-types';

export type SectionRow = 'audio' | 'subs' | 'tts';

/** The row that opens by itself: the next thing to choose. */
export function rowToOpen(view: LinkView, subView: SubtitleView): SectionRow | null {
  if (view === 'choose') return 'audio';
  if (view === 'linked' && subView === 'choose') return 'subs';
  return null;
}

/** The closed Audiobook row's button. */
export function audioRowButton(view: LinkView): string {
  return view === 'choose' ? 'Choose' : 'Change';
}

/** The closed Subtitles row's button. */
export function subtitleRowButton(subView: SubtitleView): string {
  return subView === 'choose' ? 'Choose' : 'Change';
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "TTS voice: <name>…" on the closed Text-to-speech row. */
export function ttsVoiceText(choices: BookVoiceChoices | null): string {
  const e = choices?.effective ?? null;
  if (!e) return 'TTS voice: none chosen';
  const voice = e.voiceName ?? 'a deleted voice';
  const dialogue = e.dialogueVoiceId
    ? `, dialogue ${e.dialogueVoiceName ?? 'a deleted voice'}`
    : '';
  const from = e.from === 'global' ? ' (from Settings > Anki)' : '';
  return `TTS voice: ${voice}${dialogue}${from}`;
}

/** "12 characters · 3 pronunciation fixes" (counts not known yet are left out). */
export function ttsCountsText(characters: number | null, fixes: number | null): string {
  const parts: string[] = [];
  if (characters !== null) parts.push(plural(characters, 'character', 'characters'));
  if (fixes !== null) parts.push(plural(fixes, 'pronunciation fix', 'pronunciation fixes'));
  return parts.join(' · ');
}
