/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { GpuWorkerStatus, SubtitleJob } from '$lib/audio/audio-types';
import { jobVoicesText, workerJobTitle } from '$lib/audio/tts-text';
import type { AudiobookJob } from '$lib/audio/tts-types';
import {
  characterLabel,
  olderThan,
  pcProgramNote,
  runText,
  sortedCharacters,
  speakerJobActive,
  speakerJobText,
  sureText
} from './speaker-text';
import type { SpeakerCharacter, SpeakerOverview } from './speaker-types';

const NOW = 1_800_000_000_000;

const job = (o: Partial<SubtitleJob>): SubtitleJob =>
  ({
    id: 4,
    kind: 'attribute_speakers',
    state: 'queued',
    stage: null,
    progress: null,
    message: null,
    cancelRequested: false,
    startedAt: null,
    error: null,
    bookTitle: '狼と香辛料XII',
    ...o
  }) as unknown as SubtitleJob;

const worker = (o: Partial<GpuWorkerStatus> = {}): GpuWorkerStatus =>
  ({
    available: true,
    online: true,
    paused: false,
    problem: null,
    jobs: [],
    ...o
  }) as GpuWorkerStatus;

const ch = (o: Partial<SpeakerCharacter>): SpeakerCharacter => ({
  id: 1,
  no: 1,
  name: 'ホロ',
  aliases: [],
  firstPerson: [],
  gender: '女',
  narrator: false,
  voiceId: null,
  voiceName: null,
  origin: 'model',
  edited: false,
  hidden: false,
  quotes: 0,
  ...o
});

describe('who speaks: what the page says', () => {
  it('says what the job is doing, why it waits, and how it ended', () => {
    expect(speakerJobText(job({}), worker({ paused: true }), NOW)).toBe(
      'Waiting: the PC is paused (Settings > Audiobooks).'
    );
    expect(
      speakerJobText(
        job({ message: 'Paused for read-aloud; it continues afterwards.' }),
        worker(),
        NOW
      )
    ).toBe('Paused for read-aloud; it continues afterwards. Waiting for the PC to start…');
    expect(
      speakerJobText(
        job({
          state: 'running',
          stage: 'preparing' as never,
          message: 'Loading the speaker model (Gemma 4 26B A4B)'
        }),
        worker(),
        NOW
      )
    ).toBe('Loading the speaker model (Gemma 4 26B A4B).');
    expect(
      speakerJobText(
        job({
          state: 'running',
          stage: 'generating' as never,
          progress: 0.42,
          message: 'Working out who speaks (28 of 67)'
        }),
        worker(),
        NOW
      )
    ).toBe('Working out who speaks (28 of 67) · 42 %.');
    expect(speakerJobText(job({ state: 'running', cancelRequested: true }), worker(), NOW)).toBe(
      'Stopping…'
    );
    expect(
      speakerJobText(
        job({ state: 'failed', error: "The speaker model's file is damaged." }),
        worker(),
        NOW
      )
    ).toBe("Finding who speaks failed: The speaker model's file is damaged.");
    expect(speakerJobActive(job({ state: 'running' }))).toBe(true);
    expect(speakerJobActive(job({ state: 'done' }))).toBe(false);
  });

  it('says how sure the PC was', () => {
    expect(sureText(0.97, 0.9)).toBe('Sure (97 %)');
    expect(sureText(0.92, 0.9)).toBe('Fairly sure (92 %)');
    expect(sureText(0.61, 0.9)).toBe('Unsure (61 %)');
    expect(sureText(null, 0.9)).toBe('');
  });

  it('lists characters by their quotes, hidden ones last', () => {
    const list = sortedCharacters([
      ch({ id: 1, no: 1, name: 'A', quotes: 3 }),
      ch({ id: 2, no: 2, name: 'B', quotes: 9, hidden: true }),
      ch({ id: 3, no: 3, name: 'C', quotes: 7 })
    ]);
    expect(list.map((c) => c.name)).toEqual(['C', 'A', 'B']);
    expect(
      characterLabel(
        ch({ name: 'ロレンス', aliases: ['クラフト・ロレンス', '行商人', 'ぬし', '若造'] })
      )
    ).toBe('ロレンス (クラフト・ロレンス, 行商人, ぬし)');
  });

  it('says what a run found, and when the PC program is too old', () => {
    const o = {
      run: {
        finishedAt: NOW - 2 * 3600_000,
        model: 'Gemma 4 26B A4B',
        quotes: 1039,
        renumbered: false
      },
      characters: [ch({ id: 1 }), ch({ id: 2, hidden: true })],
      pcCanRun: false
    } as unknown as SpeakerOverview;
    expect(runText(o, NOW)).toMatch(/^Found 1 character for 1,039 quotes \(Gemma 4 26B A4B, /);
    expect(pcProgramNote(o, worker({ version: '1.3.0' }))).toBe(
      'The program on the PC needs an update to find who speaks (version 1.4.0).'
    );
    expect(pcProgramNote(o, worker({ version: '1.4.0' }))).toMatch(/pull-speakers/);
    expect(olderThan('1.10.0', '1.4.0')).toBe(false);
    expect(olderThan('1.3.9', '1.4.0')).toBe(true);
  });

  it('names a speaker job in Settings, and the character voices of an audiobook', () => {
    expect(workerJobTitle(job({}))).toBe('狼と香辛料XII (finding who speaks)');
    const params = {
      mapVersion: 2,
      voices: {
        narration: { name: 'Narrator' },
        dialogue: { name: 'Speaker' },
        'character:1': { name: 'Wolf' }
      },
      roles: { narration: 'narration', dialogue: 'dialogue' },
      speakers: { characters: 1, quotes: 40, narrator: false }
    } as unknown as AudiobookJob['params'];
    expect(jobVoicesText(params)).toBe(
      'Voice “Narrator”, dialogue “Speaker”, voices for 1 character'
    );
  });
});
