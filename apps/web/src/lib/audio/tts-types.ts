/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** WP17: generated audiobooks, previews, voice presets and the model list (server shapes). */

import type { SubtitleJobState } from './audio-types';

export type TtsJobKind = 'generate_audiobook' | 'preview_audiobook' | 'voice_sample';
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

/** What starting an audiobook or a preview sends (the pauses are user settings). */
export interface AudiobookRequest {
  voiceId: string;
  modelId?: number;
  pauses: TtsPauses;
  chapterIndex?: number;
}
