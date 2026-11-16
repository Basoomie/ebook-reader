/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** WP17: generated audiobooks, previews, voice presets and the model list (server shapes). */

import type { SubtitleJobState } from './audio-types';
import type { FixSummary } from './pronunciation/fix-types';

export type TtsJobKind =
  | 'generate_audiobook'
  | 'preview_audiobook'
  | 'voice_sample'
  /** Season 2 Phase 12: Enrich's sentence audio for Anki (each clip one chapter). */
  | 'sentence_audio';
export type TtsJobStage = 'preparing' | 'generating' | 'assembling' | 'saving';

export interface TtsPauses {
  sentenceMs: number;
  paragraphMs: number;
  chapterMs: number;
}

/** The voice map, v1: one narrator. */
export interface VoiceMapV1 {
  mapVersion: 1;
  narrator: {
    voiceId: string | null;
    name: string;
    kind: 'clip' | 'design' | 'description';
    sha256: string | null;
    description: string | null;
  };
  model: { id: number; source: string; revision: string; label: string };
  seed: number;
  pauses: TtsPauses;
  chapterIndex?: number;
  chapterTitle?: string;
  /** Season 2 Phase 12: the pronunciation fixes the job used (absent: none, or older). */
  fixes?: FixSummary;
}

export interface AudiobookJob {
  id: number;
  /** null for a voice sample. */
  bookId: string | null;
  bookTitle: string | null;
  kind: TtsJobKind;
  state: SubtitleJobState;
  stage: TtsJobStage | null;
  /** 0..1 of the whole job. */
  progress: number | null;
  /** The PC's own line, e.g. "Chapter 3 of 12". */
  message: string | null;
  cancelRequested: boolean;
  attempts: number;
  outputName: string | null;
  outputRelPath: string | null;
  linked: boolean;
  error: string | null;
  logTail: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  params: VoiceMapV1 | null;
  version: number | null;
  chaptersTotal: number | null;
  chaptersDone: number;
}

export interface TtsModel {
  id: number;
  /** Hugging Face `owner/name[/subfolder]`. */
  source: string;
  revision: string;
  label: string;
  note: string | null;
  supportsDescription: boolean | null;
  supportsClip: boolean | null;
  isDefault: boolean;
  addedAt: number;
}

export interface VoicePreset {
  id: string;
  name: string;
  /** 'clip': the user's own recording; 'design': made from a description. */
  kind: 'clip' | 'design';
  description: string | null;
  modelSource: string | null;
  clipSeconds: number;
  createdAt: number;
}

export interface VoiceList {
  available: boolean;
  voices: VoicePreset[];
  limits: { maxMb: number; minSeconds: number; maxSeconds: number } | null;
}

export interface BookChapters {
  characters: number;
  chapters: { index: number; title: string; characters: number; sentences: number }[];
}

/**
 * Season 2 Phase 12: the voice and model the PC reads with, for every book (Settings > Anki)
 * or for one book (its page), as the server shows it.
 */
export interface VoiceChoice {
  voiceId: string;
  modelId: number;
  updatedAt: number;
  voiceName: string | null;
  modelLabel: string | null;
  /** Why it can't be used now (the voice deleted, the model removed). */
  problem: string | null;
}

export interface BookVoiceChoices {
  book: VoiceChoice | null;
  global: VoiceChoice | null;
  /** The one used for this book (the book's, else the global one); null = off. */
  effective: (VoiceChoice & { from: 'book' | 'global' }) | null;
}

/** Season 2 Phase 12: a sentence clip the PC reads for Enrich. */
export interface SentenceClip {
  id: string;
  bookId: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  durationMs: number | null;
  bytes: number | null;
  error: string | null;
  /** Whether the sentence was found in the book (false: read without its furigana). */
  found: boolean;
  createdAt: number;
  doneAt: number | null;
}

/** The PC, as a waiting sentence clip's status needs it. */
export interface SentencePc {
  online: boolean;
  lastSeenAt: number | null;
  paused: boolean;
  problem: string | null;
  /** Whether the PC's program reads sentence audio (null: it hasn't asked for work yet). */
  readsClips: boolean | null;
  ahead: { kind: string; bookTitle: string | null; makesWay: boolean } | null;
}

/** Season 2 Phase 12 session 3: a sentence as read-aloud sends it (book-script.ts). */
export interface ReadAloudSentence {
  text: string;
  reading: string;
  ruby: { start: number; end: number; rt: string }[];
  position: number;
  paragraphEnd: boolean;
}

/** A batch of sentences the PC reads for read-aloud. */
export interface ReadAloudBatch {
  seq: number;
  state: 'waiting' | 'reading' | 'done' | 'failed';
  durationMs: number | null;
  /** [start, end] ms of each sentence in the batch's audio. */
  cues: number[][] | null;
  error: string | null;
}

/** The PC as read-aloud's status needs it. */
export interface ReadAloudPc {
  online: boolean;
  lastSeenAt: number | null;
  paused: boolean;
  problem: string | null;
  version: string | null;
  /** The PC's program can read aloud (1.2.0+). */
  supportsLive: boolean;
  /** The PC asked for read-aloud work in the last seconds. */
  answering: boolean;
  lastAskedAt: number | null;
  engine: { state: 'loading' | 'ready'; source: string; revision: string; since: number } | null;
  busy: { kind: string; bookTitle: string | null; yielding: boolean } | null;
}

export interface ReadAloudSession {
  id: string;
  bookId: string | null;
  state: 'open' | 'ended';
  ended: string | null;
  voice: { name: string; model: string; from: 'book' | 'global' };
  batches: ReadAloudBatch[];
  pc: ReadAloudPc;
}

/** What starting an audiobook or a preview sends (the pauses are user settings). */
export interface AudiobookRequest {
  voiceId: string;
  modelId?: number;
  pauses: TtsPauses;
  chapterIndex?: number;
}
