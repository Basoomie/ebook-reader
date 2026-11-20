/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { AudioSwitchStatus, SwitchProgress } from './cleanup-api';
import {
  coversLines,
  phaseLabel,
  switchBar,
  switchLines,
  switchPauseLine,
  switchStateLine
} from './audio-switch-text';
import {
  deleteOldCopy,
  setCoversCopy,
  switchCopy,
  undoSwitchCopy
} from '$lib/confirm/confirm-copy';

const NOW = 1_800_000_000_000;

function progress(more: Partial<SwitchProgress> = {}): SwitchProgress {
  return {
    runId: 'r',
    action: 'switch',
    phase: 'rescan',
    startedAt: NOW - 600_000,
    finishedAt: null,
    phaseTimes: { hold: 1500, late: 90_000, rename: 400 },
    current: {
      step: 'the reader’s scan of the audiobooks',
      done: 1200,
      total: 4778,
      startedAt: NOW - 120_000
    },
    waiting: null,
    lateArrivals: [],
    fromLibrary: [{ rel: 'a', dst: '_from-library/a/a.m4b', link: 'japanese-new/x/a.m4b' }],
    check: { passed: true, items: [] },
    links: {
      moved: 4,
      dropped: 2,
      ai: 0,
      library_only: 0,
      folder: 0,
      outside: 0,
      listed: 0,
      changed: 6
    },
    linksBefore: 6,
    snapshot: 'pre-wp21e2-switch-20261121-010000Z.db',
    renamed: [
      { from: 'japanese', to: 'japanese-old' },
      { from: 'japanese-new', to: 'japanese' }
    ],
    rescan: null,
    verify: null,
    restored: null,
    files: null,
    inventory: null,
    deletion: null,
    history: [],
    error: null,
    ...more
  };
}

const status = (more: Partial<AudioSwitchStatus> = {}): AudioSwitchStatus => ({
  available: true,
  state: 'running',
  pause: null,
  progress: progress(),
  refusals: { switch: [], undo: [], delete: [] },
  cancellable: false,
  phases: [
    'hold',
    'late',
    'from_library',
    'check',
    'links',
    'snapshot',
    'rename',
    'remap',
    'rescan',
    'verify',
    'release'
  ],
  covers: null,
  ...more
});

describe('the switch on /cleanup', () => {
  it('says where it is: the step, its count and the time left', () => {
    expect(switchStateLine(status())).toBe(
      'The switch: The reader’s scan of the new folders (step 9 of 11)'
    );
    const bar = switchBar(status(), NOW)!;
    expect(bar.label).toBe(
      'The reader’s scan of the new folders: the reader’s scan of the audiobooks: 1,200 of 4,778'
    );
    expect(bar.fraction).toBeCloseTo(1200 / 4778);
    expect(bar.eta).toMatch(/min left/);
    expect(switchBar(status({ state: 'switched' }), NOW)).toBeNull();
  });

  it('names every phase of the three actions in plain words', () => {
    for (const ph of [
      'hold',
      'late',
      'from_library',
      'check',
      'links',
      'snapshot',
      'rename',
      'remap',
      'rescan',
      'verify',
      'release'
    ])
      expect(phaseLabel('switch', ph)).not.toBe(ph);
    for (const ph of ['hold', 'rename', 'restore', 'rescan', 'verify', 'release'])
      expect(phaseLabel('undo', ph)).not.toBe(ph);
    for (const ph of ['check', 'files', 'inventory', 'list', 'delete', 'report'])
      expect(phaseLabel('delete', ph)).not.toBe(ph);
  });

  it('states: not switched, switched, deleted, undone', () => {
    expect(switchStateLine(status({ state: 'none', progress: null }))).toMatch(
      /^Not switched: japanese is still the old library/
    );
    expect(switchStateLine(status({ state: 'switched' }))).toMatch(/Undo renames everything back/);
    expect(switchStateLine(status({ state: 'deleted' }))).toMatch(/can no longer be undone/);
    expect(
      switchStateLine(
        status({
          state: 'none',
          progress: progress({
            history: [{ action: 'undo', startedAt: 1, finishedAt: 2, result: 'done' }]
          })
        })
      )
    ).toMatch(/undone/);
  });

  it('the pause says why', () => {
    expect(
      switchPauseLine(
        status({
          pause: {
            reason: 'late_arrivals',
            detail: '2 audio files arrived in japanese after stage 1'
          }
        })
      )
    ).toBe('Paused: 2 audio files arrived in japanese after stage 1');
    expect(switchPauseLine(status())).toBeNull();
  });

  it('the report: links, the copy of ttsu.db, renames, the check, devices to download again, the deletion', () => {
    const lines = switchLines(
      progress({
        verify: {
          links: 6,
          resolved: 6,
          notResolved: 0,
          playableLost: 0,
          countBefore: 6,
          countAfter: 6,
          passed: true
        },
        rescan: { folders: 4778, ms: 150_000 }
      })
    );
    expect(lines).toContain(
      'Reader links: 6 in all, 6 change (4 moved, 2 duplicates now the kept copy, 0 AI books, 0 library-only, 0 folder links), 0 outside the library, 0 can’t be mapped.'
    );
    expect(lines.some((l) => /download them again/.test(l))).toBe(true);
    expect(lines).toContain(
      'ttsu.db copied first: snapshots/pre-wp21e2-switch-20261121-010000Z.db.'
    );
    expect(lines).toContain('Renamed: japanese → japanese-old, japanese-new → japanese.');
    expect(lines).toContain('Every link: ✓ 6 of 6 resolve, 0 no longer play; links 6 → 6.');
    expect(lines.some((l) => l.startsWith('Time per step: hold 2 s, late 2 min'))).toBe(true);
    const del = switchLines(
      progress({
        action: 'delete',
        finishedAt: NOW,
        files: { total: 341, same: 341, different: 0, noTwin: 0, unreadable: 0, bytes: 60e9 },
        inventory: { copied: ['needs_review.csv'] },
        deletion: {
          entries: 30000,
          files: 20000,
          dirs: 10000,
          bytes: 2.6e12,
          freed: 2.47e12,
          freeBefore: 1e12,
          freeAfter: 3.47e12,
          unknown: []
        }
      })
    );
    expect(del.some((l) => /341 of 341 the same bytes/.test(l))).toBe(true);
    expect(del.some((l) => /^Freed: /.test(l) && /→/.test(l))).toBe(true);
    expect(del).toContain(
      'Kept in media/audiobooks/_inventory/old-copy-script/: needs_review.csv.'
    );
  });

  it('the covers: counts by source and the old cover.png files', () => {
    const c = coversLines(
      status({
        state: 'switched',
        covers: {
          state: 'done',
          pause: null,
          refusals: [],
          progress: {
            runId: 'c',
            phase: 'done',
            startedAt: NOW,
            finishedAt: NOW,
            libraries: { main: 'Japanese Audiobooks', ai: null },
            current: null,
            counts: { 'set:url': 9, 'set:file': 12, 'no_source:none': 8, 'has_cover:url': 1 },
            coverPng: { total: 137, ofTheseBooks: 4, used: 3 },
            error: null
          }
        }
      }),
      NOW
    );
    expect(c.bar).toBeNull();
    expect(c.lines).toContain(
      'Books without embedded art: 21 covers set (9 store covers, 12 from the old library), 0 waiting, 0 failed, 1 already had one, 8 without a cover anywhere, 0 not in Audiobookshelf.'
    );
    expect(c.lines).toContain(
      'The old library’s cover.png files: 137; 4 belong to these books, 3 used.'
    );
  });

  it('asks first, and says what can’t be undone', () => {
    expect(switchCopy().irreversible).toBe(false);
    expect(switchCopy().message.join(' ')).toMatch(/Undo renames everything back/);
    expect(undoSwitchCopy().message.join(' ')).toMatch(/Audiobookshelf must have no library/);
    const d = deleteOldCopy('2.6 TB');
    expect(d).toMatchObject({
      irreversible: true,
      danger: true,
      confirmLabel: 'Delete japanese-old'
    });
    expect(d.message[0]).toContain('(2.6 TB)');
    expect(setCoversCopy().message[0]).toMatch(/books that have a cover are left alone/);
  });
});
