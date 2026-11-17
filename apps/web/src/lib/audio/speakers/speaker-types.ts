/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 Phase 12 session 5: per-character voices as the server sends them
 * (storage-server src/audio/speakers/).
 */
import type { SubtitleJob } from '$lib/audio/audio-types';

export interface SpeakerModel {
  id: number;
  repo: string;
  file: string;
  revision: string;
  size: number | null;
  label: string;
  isDefault: boolean;
}

export interface SpeakerCharacter {
  id: number;
  /** Its number in the book (C<no> in the model's prompts). */
  no: number;
  name: string;
  aliases: string[];
  firstPerson: string[];
  gender: '男' | '女' | '不明';
  narrator: boolean;
  voiceId: string | null;
  voiceName: string | null;
  origin: 'model' | 'user';
  edited: boolean;
  hidden: boolean;
  quotes: number;
}

export interface SpeakerOverview {
  /** The book's latest speaker job (any state), or null. */
  job: SubtitleJob | null;
  /** The PC's program runs speaker jobs (null: no PC seen yet). */
  pcCanRun: boolean | null;
  models: SpeakerModel[];
  run: { finishedAt: number; model: string | null; quotes: number; renumbered: boolean } | null;
  narrationBy: 'narration' | 'narrator';
  characters: SpeakerCharacter[];
  counts: {
    quotes: number;
    check: number;
    unsure: number;
    none: number;
    corrected: number;
    lost: number;
  };
}

export type QuoteFilter = 'check' | 'unsure' | 'character' | 'none' | 'corrected' | 'lost' | 'all';

export interface SpeakerQuoteItem {
  quote: number;
  text: string;
  character: number | null;
  modelCharacter: number | null;
  p: number | null;
  unknown: boolean;
  corrected: boolean;
  lost: boolean;
  nameNearby: boolean;
  paragraph: { text: string; start: number; end: number } | null;
  before: string | null;
  after: string | null;
}
