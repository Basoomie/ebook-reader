/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  ONLINE_LISTS,
  audioStage4Bar,
  checkLine,
  foldersFromText,
  onlineFoundLines,
  onlineGateLines,
  siteLine
} from './audio-online-text';
import type { AudioSiteLine, AudioStage4Status } from './cleanup-api';

const site = (over: Partial<AudioSiteLine>): AudioSiteLine => ({
  site: 'audible',
  enabled: true,
  intervalSeconds: 3,
  queued: 0,
  leased: 0,
  done: 0,
  gone: 0,
  failed: 0,
  attempts: 0,
  refused: 0,
  errors: 0,
  busy: 0,
  recent: null,
  secondsPerRequest: 3,
  expected: 0,
  secondsLeft: 0,
  pausedReason: null,
  backoffUntil: null,
  backoffReason: null,
  ...over
});

describe('audiobook stage 4 words', () => {
  it('a site line: answered, waiting, pace, time left, why it waits', () => {
    expect(siteLine(site({ done: 10, gone: 2, queued: 3, secondsLeft: 600 }))).toBe(
      'Audible: 12 answered, 3 waiting · one request every 3.0 s · about 10 min left'
    );
    expect(siteLine(site({ site: 'kikubon', enabled: false }))).toBe('kikubon: switched off');
    expect(
      siteLine(site({ backoffUntil: 120_000, backoffReason: 'busy (HTTP 503): waiting 60 s' }), 0)
    ).toContain('waiting 2 min: busy (HTTP 503)');
    expect(siteLine(site({ pausedReason: '8 refusals in a row' }))).toContain('paused: 8 refusals');
  });

  it('what was found, per source and per review reason', () => {
    expect(
      onlineFoundLines({
        auto: 5,
        'auto:audible': 3,
        'auto:kikubon': 1,
        'auto:audiobookjp': 1,
        review: 3,
        'review:narrator': 2,
        'review:runtime': 1,
        unknown: 1,
        none_expected: 2
      })
    ).toEqual([
      'Matched: 5 (Audible 3, kikubon 1, audiobook.jp 1).',
      'To review: 3 (the narrator differs from the file’s tags: 2; the length differs (another edition?): 1).',
      'Not found: 1.',
      'No store record expected: 2.'
    ]);
  });

  it('the progress bar uses the server’s time left; the gate per labeled source', () => {
    const s = {
      progress: { phase: 'lookups', units: 200, decided: 50 },
      secondsLeft: 3600
    } as unknown as AudioStage4Status;
    expect(audioStage4Bar(s)).toMatchObject({
      label: 'Looking up: 50 of 200 recordings decided',
      fraction: 0.25,
      eta: 'about 1 h left (estimate)'
    });
    expect(
      onlineGateLines({
        passed: true,
        checked: 3,
        misses: [],
        error: null,
        bySource: { audible: { auto_agrees: 2, review: 1 } }
      })
    ).toEqual(['Labeled Audible: 2 matched as labeled, 1 to review']);
  });

  it('a check line shows both sides; the lists include every review reason', () => {
    expect(
      checkLine('runtime', { ok: false, file: 35173, store: 35100, detail: 'store -1.2 min' })
    ).toBe('Length: file 9:46:13, store 9:45:00 (store -1.2 min) ✗');
    expect(checkLine('author', { ok: true, unknown: true, file: [], store: ['岬'] })).toBe(
      'Author: file –, store 岬 (not known on one side)'
    );
    expect(ONLINE_LISTS.map((l) => l.id)).toContain('review:fraction');
    expect(foldersFromText(' a/b \n\n c ')).toEqual(['a/b', 'c']);
  });
});
