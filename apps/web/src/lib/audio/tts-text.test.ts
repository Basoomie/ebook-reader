/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  audioLengthText,
  audiobookJobText,
  durationText,
  modelsForDescriptions,
  modelsForVoices,
  ttsJobActive,
  voiceDetails,
  workerJobTitle
} from './tts-text';
import { folderDetails, subtitleDetails } from './audio-link';
import type { AudiobookJob, TtsModel } from './tts-types';
import type { GpuWorkerStatus } from './audio-types';
import {
  deleteVoiceCopy,
  removeTtsModelCopy,
  replaceAudiobookWithMadeCopy,
  stopAudiobookJobCopy
} from '$lib/confirm/confirm-copy';

const NOW = 1_800_000_000_000;

function job(fields: Partial<AudiobookJob> = {}): AudiobookJob {
  return {
    id: 1,
    bookId: 'b1',
    bookTitle: '羊と鋼の森',
    kind: 'generate_audiobook',
    state: 'running',
    stage: 'generating',
    progress: 0.23,
    message: 'Chapter 3 of 12',
    cancelRequested: false,
    attempts: 1,
    outputName: null,
    outputRelPath: null,
    linked: false,
    error: null,
    logTail: null,
    createdAt: NOW - 600_000,
    startedAt: NOW - 300_000,
    finishedAt: null,
    updatedAt: NOW,
    params: {
      mapVersion: 1,
      narrator: { voiceId: 'v', name: 'Calm', kind: 'design', sha256: 'x', description: null },
      model: { id: 1, source: 'A/B', revision: 'c'.repeat(40), label: 'Irodori v4.1 Small' },
      seed: 1,
      pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 2000 }
    },
    version: 1,
    chaptersTotal: 12,
    chaptersDone: 2,
    ...fields
  };
}

const online: GpuWorkerStatus = {
  available: true,
  online: true,
  paused: false,
  lastSeenAt: NOW,
  jobs: []
};

describe('audiobook texts', () => {
  it('says what is going on, in everyday words', () => {
    expect(audiobookJobText(job(), online, NOW)).toBe('Chapter 3 of 12 · 23 %. Started 5 min ago.');
    expect(audiobookJobText(job({ stage: 'assembling' }), online, NOW)).toBe(
      'Putting the audiobook together on the server…'
    );
    expect(audiobookJobText(job({ cancelRequested: true }), online, NOW)).toBe('Stopping…');
    expect(
      audiobookJobText(job({ state: 'queued', stage: null }), { ...online, paused: true }, NOW)
    ).toBe('2 of 12 chapters done. Waiting: the PC is paused (Settings > Audiobooks).');
    expect(
      audiobookJobText(
        job({ state: 'queued', stage: null, chaptersDone: 0 }),
        { ...online, online: false },
        NOW
      )
    ).toBe('Waiting for the PC to be switched on (last seen just now).');
    expect(audiobookJobText(job({ state: 'done', linked: true, version: 2 }), online, NOW)).toBe(
      'Audiobook made (version 2). This book now uses it, with its subtitles.'
    );
    expect(audiobookJobText(job({ state: 'done', linked: false }), online, NOW)).toMatch(
      /was not chosen/
    );
    expect(
      audiobookJobText(job({ state: 'failed', error: 'CUDA out of memory.' }), online, NOW)
    ).toBe(
      'Making the audiobook failed: CUDA out of memory. Nothing was added to the audiobooks folder.'
    );
    expect(audiobookJobText(job({ kind: 'preview_audiobook', state: 'done' }), online, NOW)).toBe(
      'The preview is ready.'
    );
    expect(audiobookJobText(job({ kind: 'voice_sample', state: 'cancelled' }), online, NOW)).toBe(
      'Making the voice sample was stopped.'
    );
    for (const text of [
      audiobookJobText(job(), online, NOW),
      audiobookJobText(job({ state: 'queued' }), online, NOW)
    ]) {
      expect(text).not.toMatch(/\b(TTS|job|voice map)\b/i);
    }
  });

  it('names jobs, lengths and voices', () => {
    expect(workerJobTitle(job())).toBe('羊と鋼の森');
    expect(workerJobTitle(job({ kind: 'preview_audiobook' }))).toBe('羊と鋼の森 (preview)');
    expect(workerJobTitle(job({ kind: 'voice_sample', bookId: null, bookTitle: null }))).toBe(
      'Voice sample “Calm”'
    );
    expect(durationText(20)).toBe('under a minute');
    expect(durationText(1500)).toBe('25 min');
    expect(durationText(34_800)).toBe('9 h 40 min');
    expect(audioLengthText(48_000)).toBe('about 2 h 47 min of audio');
    expect(
      voiceDetails({
        id: 'x',
        name: 'Me',
        kind: 'clip',
        description: null,
        modelSource: null,
        clipSeconds: 23.6,
        createdAt: 0
      })
    ).toBe('Your recording · 24 s');
    expect(ttsJobActive(job())).toBe(true);
    expect(ttsJobActive(job({ state: 'done' }))).toBe(false);
  });

  it('offers only models that can do the step (unknown counts as yes)', () => {
    const m = (id: number, d: boolean | null, c: boolean | null) =>
      ({ id, supportsDescription: d, supportsClip: c }) as TtsModel;
    const list = [m(1, true, true), m(2, false, true), m(3, null, null), m(4, true, false)];
    expect(modelsForVoices(list).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(modelsForDescriptions(list).map((x) => x.id)).toEqual([1, 3, 4]);
  });

  it('labels generated audiobooks and their subtitles', () => {
    const folder = {
      id: 1,
      libraryId: 'l',
      relPath: 'japanese-generated/A/B',
      name: 'B',
      parentName: 'A',
      fileCount: 1,
      totalBytes: 1024,
      durationSeconds: 60,
      volume: null,
      playable: true,
      missing: false
    };
    expect(folderDetails({ ...folder, generated: true })).toMatch(/^Generated · 1 file/);
    expect(folderDetails(folder)).toMatch(/^1 file/);
    expect(
      subtitleDetails({
        id: 1,
        libraryId: 'l',
        relPath: 'x',
        name: 'x.srt',
        parentName: 'B',
        size: 2048,
        missing: false,
        generated: true
      })
    ).toBe('Generated · B · 2 KB');
  });

  it('asks plain questions before stopping, deleting or replacing', () => {
    for (const copy of [
      replaceAudiobookWithMadeCopy('羊と鋼の森 (文春文庫)'),
      stopAudiobookJobCopy('羊と鋼の森', 3),
      deleteVoiceCopy('Calm'),
      removeTtsModelCopy('Irodori v4.1 Small')
    ]) {
      expect(copy.title.endsWith('?')).toBe(true);
      expect(copy.confirmLabel).not.toMatch(/^(OK|Confirm|Yes)$/i);
      expect(copy.message.join(' ')).not.toMatch(/\b(TTS|job)\b/i);
    }
    expect(stopAudiobookJobCopy('本', 1).message[0]).toContain(
      'the chapter read so far is thrown away'
    );
    expect(stopAudiobookJobCopy('本', 3).message[0]).toContain(
      'the 3 chapters read so far are thrown away'
    );
    expect(replaceAudiobookWithMadeCopy('x').danger).toBe(false);
  });
});
