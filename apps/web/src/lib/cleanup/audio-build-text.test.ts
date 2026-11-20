/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  audioStage6Bar,
  audioStage6Lines,
  bookLine,
  checkLines,
  labelDiffLines,
  metadataLine,
  stage6Summary
} from './audio-build-text';
import type { AudioStage6Status, Stage6Progress } from './cleanup-api';

const counts = {
  units: 4898,
  books: { main: 4773, ai: 122, pending: 5 },
  shapes: { seriesVol: 3616, seriesNoVol: 59, standalone: 1225 },
  unknownAuthor: 127,
  links: 4975,
  pdfLinks: 247,
  pdfs: { placed: 227, unplaced: 76, otherCopy: 70, noBook: 6, total: 303 },
  folders: 6687,
  metadata: 4895,
  ops: 16804,
  collisions: { narrator: 163, number: 51 },
  namesCut: 0,
  namesReplaced: 568,
  noCover: 151,
  noValues: 0,
  droppedCopies: 1090,
  keptReview: 116,
  moves: {
    moved: 5248,
    ai: 122,
    dropped: 211,
    library_only_pending: 5,
    reader_written: 0,
    unaccounted: 0
  }
};

const p6 = (over: Partial<Stage6Progress> = {}): Stage6Progress => ({
  analysisId: 'a',
  phase: 'planned',
  startedAt: 0,
  finishedAt: null,
  counts,
  archives: { count: 93, bytes: 85_858_285_205 },
  libraryOther: [],
  phaseTimes: { plan: { ms: 1400, items: 4898 } },
  preflight: { total: 5222, done: 5222, problems: 0, byProblem: {} },
  build: {
    startedAt: null,
    finishedAt: null,
    total: 16804,
    done: 0,
    failed: 0,
    batches: 0,
    lockWaits: 0,
    lockWaitMs: 0,
    yields: 0,
    firstFailure: null
  },
  walk: { before: null, after: null, current: null },
  check: null,
  error: null,
  ...over
});

const s6 = (p: Stage6Progress, over: Partial<AudioStage6Status> = {}): AudioStage6Status => ({
  available: true,
  waiting: null,
  progress: p,
  secondsLeft: 120,
  sidecar: { online: true, lastSeenAt: 1, version: '1.0.0', problem: null, info: null },
  handing: false,
  onRefusals: [],
  ...over
});

describe('stage 6 on the page', () => {
  it('shows the step running now with its time left', () => {
    expect(audioStage6Bar(s6(p6()))).toBeNull();
    const pre = audioStage6Bar(
      s6(
        p6({ phase: 'preflight', preflight: { total: 200, done: 50, problems: 0, byProblem: {} } })
      )
    );
    expect(pre).toEqual({
      label: 'The sidecar checks the planned torrent files: 50 of 200',
      fraction: 0.25,
      eta: expect.stringMatching(/estimate/)
    });
    const b = audioStage6Bar(
      s6(p6({ phase: 'build', build: { ...p6().build, startedAt: 1, done: 8402 } }))
    );
    expect(b?.label).toBe('Building: 8,402 of 16,804 folders, links and metadata files');
    expect(b?.fraction).toBe(0.5);
  });

  it('summarizes the plan, the build and the check', () => {
    expect(stage6Summary(s6(p6()))).toBe(
      'Plan: 4,773 books in japanese-new, 122 AI books in japanese-generated-new, 5,222 hard links; 5 library-only files wait for the switch.'
    );
    const done = p6({
      phase: 'done',
      build: { ...p6().build, startedAt: 1, done: 16804 },
      check: {
        passed: false,
        at: 1,
        items: [
          { key: 'ops', name: 'Every planned operation done', ok: true, detail: '1 of 1' },
          { key: 'abs', name: 'Audiobookshelf unchanged', ok: null, detail: 'Not compared' },
          { key: 'library', name: 'The live library unchanged', ok: false, detail: '1 added' }
        ],
        labels: {
          books: 200,
          notFound: [],
          folderRight: 187,
          folderWrong: [
            { id: 'A052', expected: 'x/Vol 2 - T', got: 'x/Vol 1 - T', why: 'a stage-5 gate miss' }
          ],
          valuesWrong: [
            {
              id: 'A002',
              field: 'authors',
              expected: ['日向夏'],
              got: [],
              why: 'unconfirmed (stage 5’s best guess)'
            }
          ],
          valuesChecked: 1180,
          unexplained: 0
        }
      }
    });
    expect(stage6Summary(s6(done))).toMatch(/^Built: .*Check: ✗ 1 item failed\.$/);
    expect(checkLines(done)).toEqual([
      '✓ Every planned operation done: 1 of 1',
      '– Audiobookshelf unchanged: Not compared',
      '✗ The live library unchanged: 1 added'
    ]);
    expect(labelDiffLines(done)).toEqual([
      'A052: folder x/Vol 1 - T (label: x/Vol 2 - T) — a stage-5 gate miss',
      'A002: authors [] (label: ["日向夏"]) — unconfirmed (stage 5’s best guess)'
    ]);
  });

  it('lists the plan’s counts, the preflight, the sidecar and the build', () => {
    const lines = audioStage6Lines(
      s6(
        p6({
          phase: 'build',
          preflight: { total: 10, done: 10, problems: 2, byProblem: { 'changed (mtime)': 2 } },
          build: {
            ...p6().build,
            startedAt: 1,
            done: 5,
            batches: 2,
            lockWaits: 1,
            lockWaitMs: 90_000,
            yields: 3
          }
        }),
        { sidecar: { online: false, lastSeenAt: null, version: null, problem: null, info: null } }
      )
    );
    expect(lines).toContain(
      'Move list: 5,248 moved, 122 to the AI library, 211 dropped as proven duplicates (pointing to the kept copy), 5 library-only, 0 written by the reader, 0 unaccounted.'
    );
    expect(lines).toContain(
      'Sources checked by the sidecar: 10 of 10; 2 can’t be linked (changed (mtime) 2).'
    );
    expect(lines).toContain('Linking sidecar offline (start ttsu-cleanup-link).');
    expect(lines).toContain(
      'Build: 5 of 16,804 done in 2 batches; waited for the disk 1 time (2 min), gave it to Calibre 3 times.'
    );
    expect(lines.some((l) => l.startsWith('93 archives in the torrents'))).toBe(true);
  });

  it('describes a sample book and its metadata', () => {
    expect(
      bookLine({
        id: 1,
        area: 'main',
        state: 'build',
        folder: 'japanese-new/A/S/Vol 1 - T',
        baseFolder: 'japanese-new/A/S/Vol 1 - T',
        author: 'A',
        series: 'S',
        title: 'T',
        notes: ['narrator'],
        files: [],
        fileCount: 3,
        pdfs: 1,
        cover: true,
        metadata: {}
      })
    ).toBe('japanese-new/A/S/Vol 1 - T (3 files, 1 PDF, narrator)');
    expect(
      metadataLine({
        title: 'T',
        authors: ['A', 'B'],
        narrators: [],
        series: ['S #1.5'],
        tags: ['ドラマCD'],
        asin: 'B0AAAAAAA1',
        publishedYear: '2021'
      })
    ).toBe(
      'Title T · authors A、B · narrators — · series S #1.5 · tags ドラマCD · ASIN B0AAAAAAA1 · 2021'
    );
  });
});
