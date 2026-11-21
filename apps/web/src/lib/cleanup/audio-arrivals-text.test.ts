/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  designLines,
  phaseLabel,
  reportLines,
  stage7Bar,
  stage7Summary
} from './audio-arrivals-text';
import type { AudioStage7Run, AudioStage7Status } from './cleanup-api';

const NOW = Date.parse('2026-11-21T12:00:00');

function run(over: Partial<AudioStage7Run> = {}): AudioStage7Run {
  return {
    runId: 3,
    trigger: 'schedule',
    mode: 'analyse',
    phase: 'archives',
    startedAt: NOW - 3_600_000,
    finishedAt: null,
    phaseStartedAt: NOW - 600_000,
    phaseStartDone: 0,
    phaseTimes: {},
    archives: {
      total: 93,
      waiting: 0,
      toList: 0,
      listed: 92,
      entries: 400,
      bytes: 80e9,
      extracted: 100,
      extractedBytes: 20e9,
      thisRun: 100,
      problems: { not_archive: 1, password: 2 }
    },
    classify: null,
    plan: null,
    build: {
      total: 0,
      done: 0,
      failed: 0,
      batches: 0,
      startedAt: null,
      lockWaitMs: 0,
      yields: 0,
      firstFailure: null
    },
    walks: {},
    check: null,
    abs: {
      library: null,
      before: null,
      after: null,
      found: 0,
      missing: 0,
      valuesOk: 0,
      valuesDiffer: 0,
      nudged: 0,
      waitingSince: null,
      error: null,
      precedence: null
    },
    waiting: null,
    error: null,
    ...over
  };
}

describe('stage 7 texts', () => {
  it('a bar with time left for unpacking, building and the walks', () => {
    const b = stage7Bar(run(), NOW)!;
    expect(b.label).toContain('18.6 GB of 74.5 GB unpacked (100 of 400 files)');
    expect(b.fraction).toBeCloseTo(0.25);
    expect(b.eta).toBe('about 30 min left');
    const build = stage7Bar(
      run({
        phase: 'build',
        build: { ...run().build, total: 200, done: 50, startedAt: NOW - 60_000 }
      }),
      NOW
    )!;
    expect(build.label).toBe('Adding the new books: 50 of 200 operations');
    expect(build.eta).toBe('about 3 min left');
    expect(stage7Bar(run({ finishedAt: NOW }), NOW)).toBeNull();
    expect(phaseLabel('stages')).toBe('Stages 2-5 run again');
  });

  it('the summary: next run, last run, Preview vs On', () => {
    const s: AudioStage7Status = {
      available: true,
      switched: true,
      running: false,
      nextRunAt: Date.parse('2026-11-22T05:00:00'),
      run: run({ finishedAt: NOW - 1000 }),
      report: {
        mode: 'analyse',
        added: 0,
        planned: 12,
        outcomes: { new: 12, identical: 40, duplicate: 3, waiting: 1 },
        newReview: 2,
        openReview: 5,
        aiCostUsd: 0.4,
        designs: { E: 4898, F: 0, J: 12 },
        times: {},
        lockWaitMs: 0,
        yields: 0,
        changedExisting: { differ: 0, same: 4773, rekeyed: 5 }
      }
    };
    expect(stage7Summary(s, NOW)).toBe(
      'Last run today 11:00 (Preview): 12 would be added, 43 copies recorded, 1 waiting. Next run tomorrow 05:00.'
    );
    expect(stage7Summary({ available: true, switched: false }, NOW)).toBe(
      'Starts after the switch to the new library'
    );
    expect(reportLines(s).some((l) => l.includes('Archives: 93'))).toBe(true);
    expect(reportLines(s).some((l) => l.includes('2 need a password'))).toBe(true);
  });

  it('the E/F/J line says what an upgrade would re-check and leave out', () => {
    const lines = designLines({
      available: true,
      designs: { E: 4898, F: 0, J: 12 },
      upgrade: {
        F: { items: 551, fields: 900, costUsd: 5.5 },
        J: { items: 1200, fields: 3000, costUsd: 12 },
        includeDecided: false,
        models: ['claude-sonnet-5-5', 'gpt-6.1-sol']
      }
    });
    expect(lines[0]).toBe('Recordings by AI setup: E 4,898 · F 0 · J 12');
    expect(lines[1]).toContain('a J upgrade 3,000 fields of 1,200 recordings (about $12.00)');
    expect(lines[2]).toContain('are left out');
  });
});
