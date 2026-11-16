/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { heldMediaName } from '../enrich';
import { APPEND_SEPARATOR, isEmptyField, mergeField, type FieldMode } from '../field-merge';

/**
 * Season 2 §3 "Enrich while offline": a sentence-audio clip that Enrich couldn't add at the
 * tap (the library server couldn't be reached) and adds to the card later by itself. Kept on
 * the device that made the tap (its own AnkiConnect and Anki collection), until it is added,
 * cancelled, or dismissed after it turned out impossible (decided with the user, 2026-11-15).
 *
 * Two steps: 'waiting' (the clip isn't made yet) → 'ready' (the clip's bytes are kept here)
 * → added to the card, then the record is deleted. Where the clip comes from is `source`:
 * 'library', cut from the book's audiobook on the server; 'pc' (Season 2 Phase 12), read
 * by the PC for a book without an audiobook. The step that writes it into the card is the
 * same for both.
 */

export type PendingState = 'waiting' | 'ready' | 'failed';

export interface LibraryClipSource {
  kind: 'library';
  /** The sentence as shown (plain text). */
  text: string;
  /** Absolute reader position of the sentence's first character. */
  position: number;
  /** whispersync line ids inside the sentence (a matched book). */
  cueIds: string[];
  /** The book's length in characters (for the expected time of a repeated line). */
  bookCharacters: number;
}

/**
 * Season 2 Phase 12: the PC reads the sentence (a book without an audiobook). The server
 * finds the text in the book (its furigana) and keeps the clip until this device has it.
 */
export interface PcClipSource {
  kind: 'pc';
  /** The sentence as shown (plain text): what Enrich put in the card. */
  text: string;
  position: number;
  bookCharacters: number;
  /** "Longest sentence audio" at the tap (seconds): a longer clip is left out. */
  maxSeconds: number;
  /** The pauses between sentences at the tap (Settings > Audiobooks). */
  pauses: { sentenceMs: number; paragraphMs: number; chapterMs: number };
  /** The server's clip, once it was asked for. */
  clipId?: string;
}

export type ClipSource = LibraryClipSource | PcClipSource;

export interface PendingClip {
  id: string;
  createdAt: number;
  state: PendingState;
  // The card, as mapped at the tap (decided with the user, 2026-11-15).
  noteId: number;
  noteType: string;
  /** The note's first field as text, to say which card. */
  word: string;
  field: string;
  mode: FieldMode;
  /** The field's value after the tap's own write. */
  fieldAtTap: string;
  /**
   * Overwrite of a field other roles fill too: their values before and after the sentence
   * audio, in role order, so the field ends up exactly as an online tap would have left it.
   */
  shared?: { before: string[]; after: string[] };
  // The book.
  bookId: string;
  localId: number;
  /** The book's own title (the key of whispersync's saved lines). */
  localTitle: string;
  /** The title to show. */
  bookTitle: string;
  source: ClipSource;
  /** Once made ('ready'): kept until Anki has it. */
  clip?: { fileName: string; data: ArrayBuffer };
  lastTriedAt?: number;
  /** Why it is still waiting (the last attempt's problem). */
  problem?: string;
  /** What it waits for, as the last attempt found it (default: by its source). */
  waitingFor?: string;
  /** 'failed': why it can't be added; shown until dismissed. */
  failedReason?: string;
  /** The tab working on it, so two tabs never add it twice. */
  claim?: { by: string; until: number };
}

/** What the clip does to the field it waits for, worked out when it is added. */
export type ClipDecision =
  | { kind: 'write'; value: (storedName: string) => string }
  | { kind: 'already' }
  | { kind: 'fail'; reason: string };

export const FIELD_CHANGED = 'the field was changed after Enrich';
export const FIELD_FILLED = 'the field has something now';

function soundValue(fileName: string): string {
  return `[sound:${fileName}]`;
}

/**
 * The field's mode applied when the clip arrives. `fieldNow` is the field's value then;
 * `fileName` the name the clip will be stored under (AnkiConnect Android's renamed copy of
 * it counts as the same file).
 *
 * - Fill if empty: only into an empty field.
 * - Add to the end: after what the field has, unless it already plays this clip.
 * - Overwrite: only while the field still holds what the tap left in it (decided with the
 *   user, 2026-11-15); a later edit or Enrich wins.
 */
export function decideClip(
  target: Pick<PendingClip, 'mode' | 'fieldAtTap' | 'shared'>,
  fieldNow: string,
  fileName: string
): ClipDecision {
  if (heldMediaName(fieldNow, 'sound', fileName) !== null) {
    return { kind: 'already' };
  }

  if (target.mode === 'fill-if-empty') {
    return isEmptyField(fieldNow)
      ? { kind: 'write', value: soundValue }
      : { kind: 'fail', reason: FIELD_FILLED };
  }

  if (target.mode === 'append') {
    return {
      kind: 'write',
      value: (stored) => mergeField(fieldNow, soundValue(stored), 'append') ?? fieldNow
    };
  }

  if (fieldNow !== target.fieldAtTap) {
    return { kind: 'fail', reason: FIELD_CHANGED };
  }

  const before = target.shared?.before ?? [];
  const after = target.shared?.after ?? [];

  return {
    kind: 'write',
    value: (stored) => [...before, soundValue(stored), ...after].join(APPEND_SEPARATOR)
  };
}

/**
 * Waiting clips a newer Enrich of the same card drops: under Overwrite the newest tap
 * decides the field, so older clips for it would put another sentence's audio back. Under
 * fill if empty and add to the end they all stay and are added oldest first.
 */
export function supersededBy(
  clips: readonly PendingClip[],
  noteId: number,
  field: string,
  keepId?: string
): PendingClip[] {
  return clips.filter(
    (c) =>
      c.id !== keepId &&
      c.noteId === noteId &&
      c.field === field &&
      c.mode === 'overwrite' &&
      c.state !== 'failed'
  );
}

/** Oldest first; failed ones are only shown. */
export function workOrder(clips: readonly PendingClip[]): PendingClip[] {
  return clips.filter((c) => c.state !== 'failed').sort((a, b) => a.createdAt - b.createdAt);
}

/** An id without crypto.randomUUID (secure contexts only; the PC uses plain http). */
export function newPendingId(now: number, random = Math.random): string {
  return `${now.toString(36)}-${Math.floor(random() * 0xffffffff).toString(36)}`;
}

/** The status line in Settings > Anki. */
export function pendingStatus(clip: PendingClip): string {
  if (clip.state === 'failed') return `Couldn't add: ${clip.failedReason ?? 'unknown problem'}.`;
  if (clip.state === 'ready') return 'Waiting for Anki';
  if (clip.waitingFor) return clip.waitingFor;
  return clip.source.kind === 'pc' ? 'Waiting for the PC' : 'Waiting for the library server';
}
