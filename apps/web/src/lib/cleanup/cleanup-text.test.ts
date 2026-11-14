/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CleanupBatch, CleanupStage } from './cleanup-api';
import { CleanupApi } from './cleanup-api';
import {
  batchCountsText,
  canUndo,
  precisionLine,
  restoreText,
  applyProgress,
  countsLine,
  etaText,
  stage1Lines,
  stage1Progress,
  tagsMoving
} from './cleanup-text';
import { turnOnIdenticalFilesCopy, undoCleanupBatchCopy } from '$lib/confirm/confirm-copy';

const stage = (
  progress: Record<string, unknown>,
  extra: Partial<CleanupStage> = {}
): CleanupStage => ({
  stage: 1,
  name: 'Identical files',
  built: true,
  mode: 'analyse',
  state: 'analysing',
  pauseReason: null,
  pauseDetail: null,
  pausedAt: null,
  progress,
  precision: {},
  updatedAt: 0,
  ...extra
});

const batch = (extra: Partial<CleanupBatch>): CleanupBatch => ({
  id: 'b',
  stage: 1,
  libraryId: 'l',
  kind: 'apply',
  undoOf: null,
  state: 'applied',
  itemCount: 3,
  snapshotSaved: true,
  createdAt: 0,
  claimedAt: 0,
  finishedAt: 0,
  ingestedAt: 0,
  error: null,
  counts: { removed: 3 },
  ...extra
});

describe('cleanup wording', () => {
  it('shows the analysis as a progress bar with the time left', () => {
    const t0 = Date.UTC(2026, 10, 13, 12, 0, 0);
    // 10 minutes in, 6,000 of 66,000 books: about 100 minutes to go.
    const stat = stage1Progress(
      stage({
        phase: 'stat',
        statDone: 6000,
        statTotal: 66000,
        phaseStartedAt: t0,
        phaseStartDone: 0
      }),
      t0 + 10 * 60_000
    );
    expect(stat).toEqual({
      label: 'Step 1 of 2 · Reading file sizes: 6,000 of 66,000 books',
      fraction: 6000 / 66000,
      eta: 'about 1 h 40 min left'
    });
    // An analysis from before the bar: its start time stands in for the step's.
    expect(
      stage1Progress(
        stage({ phase: 'stat', statDone: 600, statTotal: 1200, startedAt: t0 }),
        t0 + 60_000
      )?.eta
    ).toBe('about 1 min left');
    // Too early for a guess.
    expect(
      stage1Progress(
        stage({ phase: 'stat', statDone: 10, statTotal: 1200, phaseStartedAt: t0 }),
        t0 + 5000
      )?.eta
    ).toBeNull();
    const hash = stage1Progress(
      stage({
        phase: 'hash',
        bytesHashed: 50 * 1024 ** 3,
        hashBytesTotal: 100 * 1024 ** 3,
        phaseStartedAt: t0,
        phaseStartDone: 0
      }),
      t0 + 20 * 60_000
    );
    expect(hash?.label).toBe('Step 2 of 2 · Comparing files of the same size: 50.0 GB of 100.0 GB');
    expect(hash?.eta).toBe('about 20 min left');
    expect(stage1Progress(stage({ phase: 'done' }))).toBeNull();
    expect(
      stage1Progress(stage({ phase: 'stat', statDone: 1, statTotal: 2 }, { mode: 'off' }))
    ).toBeNull();
    expect(stage1Lines(stage({ phase: 'stat', statDone: 1, statTotal: 2 }))).toEqual([]);
  });

  it('says the copies in one line, without the zeros', () => {
    expect(countsLine({ applied: 3699, skipped: 1, proposed: 0, undone: 0 })).toBe(
      'Removed: 3,699 · skipped: 1'
    );
    expect(countsLine({ proposed: 5 })).toBe('To remove: 5');
    expect(countsLine({ applied: 2, proposed: 1, queued: 2, undone: 1 })).toBe(
      'Removed: 2 · to remove: 3 · brought back: 1'
    );
    expect(countsLine({})).toBe('');
  });

  it('shows removing the copies as a progress bar', () => {
    const t0 = Date.UTC(2026, 10, 13, 12, 0, 0);
    // 200 copies in the last 20 minutes (one every 6 s): 3,300 left = 5 h 30 min.
    const pace = { removed: 200, firstAt: t0 };
    expect(applyProgress({ applied: 400, proposed: 3300 }, pace, t0 + 20 * 60_000)).toEqual({
      label: 'Removing copies: 400 of 3,700',
      fraction: 400 / 3700,
      eta: 'about 5 h 30 min left'
    });
    // The live case on the NAS 2026-11-14: 55 removed after a slow start and an old failed
    // batch from the day before; only the recent pace counts (54 in the last 10 min).
    expect(
      applyProgress(
        { applied: 55, proposed: 3500, queued: 144 },
        { removed: 54, firstAt: t0 },
        t0 + 10 * 60_000
      )?.eta
    ).toBe('about 11 h 15 min left');
    // Too little to go on yet: no guess.
    expect(
      applyProgress({ applied: 3, proposed: 10 }, { removed: 3, firstAt: t0 }, t0 + 600_000)?.eta
    ).toBeNull();
    expect(
      applyProgress({ applied: 9, proposed: 10 }, { removed: 9, firstAt: t0 }, t0 + 60_000)?.eta
    ).toBeNull();
    expect(applyProgress({ applied: 3700 }, pace)).toBeNull();
    expect(applyProgress({ proposed: 3700 }, undefined)).toBeNull();
    expect(etaText(30_000)).toBe('less than a minute left');
    expect(etaText(2 * 3600_000)).toBe('about 2 h left');
  });

  it('describes each analysis phase and the result', () => {
    const done = stage1Lines(
      stage({
        phase: 'done',
        duplicateSets: 3200,
        toRemove: 3312,
        keptByTags: 12,
        keptByDate: 3300,
        extraFormat: 4,
        removedWithData: 2,
        bothWithData: 1,
        tagsCopied: 943
      })
    );
    expect(done[0]).toContain('3,200 sets of identical files: 3,312 copies to remove');
    expect(done[1]).toContain('4 also have another format');
    expect(done[1]).toContain('943 have your own tags, which are added to the copy that stays');
    expect(done[1]).toContain('2 have reading data, which goes to the kept copy');
    const copy = {
      id: 1,
      calibre_id: 2,
      calibre_uuid: 'u',
      state: 'proposed',
      evidence: {
        sha256: 'x',
        size: 1,
        setSize: 2,
        rule: 'older' as const,
        kept: {
          calibreId: 1,
          uuid: 'k',
          title: 't',
          tags: ['TMW-collection-11'],
          formats: ['EPUB'],
          addedAt: null,
          readerData: false
        },
        removed: {
          calibreId: 2,
          uuid: 'u',
          title: 't',
          tags: ['TMW-collection-13', 'needs-metadata'],
          customTags: ['TMW-collection-13'],
          formats: ['EPUB'],
          addedAt: null,
          readerData: false
        }
      }
    };
    expect(tagsMoving(copy)).toEqual(['TMW-collection-13']);
    expect(stage1Lines(stage({}, { mode: 'off' }))).toEqual([]);
  });

  it('shows the measured accuracy and the batch counts', () => {
    expect(precisionLine(stage({}, { precision: { checked: 200, identical: 200 } }))).toContain(
      '200 of 200 pairs still identical (100.0 %)'
    );
    expect(precisionLine(stage({}))).toBeNull();
    expect(batchCountsText(batch({ counts: { removed: 2, skipped: 1 } }))).toBe(
      '2 removed · 1 skipped'
    );
    expect(
      batchCountsText(
        batch({ kind: 'undo', finishedAt: null, counts: { restored: 2, pending: 1 } })
      )
    ).toBe('2 brought back · 1 to go');
    // A batch that ended (the live "23 to go" after a failure) says what it left undone.
    expect(
      batchCountsText(batch({ state: 'failed', finishedAt: 1, counts: { pending: 22, tagged: 1 } }))
    ).toBe('23 not finished');
    expect(
      batchCountsText(batch({ state: 'claimed', finishedAt: null, counts: { pending: 2 } }))
    ).toBe('2 to go');
    expect(restoreText('readd:rebound')).toContain('new Calibre id');
    expect(restoreText('trash')).toContain('same Calibre id');
  });

  it('offers Undo only for an applied batch while no batch is open', () => {
    const done = batch({});
    expect(canUndo(done, [done])).toBe(true);
    expect(canUndo(done, [done, batch({ id: 'x', state: 'claimed' })])).toBe(false);
    expect(canUndo(batch({ kind: 'undo' }), [])).toBe(false);
    expect(canUndo(batch({ state: 'undone' }), [])).toBe(false);
    expect(canUndo(batch({ counts: { skipped: 3 } }), [])).toBe(false);
  });

  it('asks before turning stage 1 on and before Undo', () => {
    expect(turnOnIdenticalFilesCopy(3312).title).toBe(
      'Remove the 3,312 identical copies from Calibre?'
    );
    expect(turnOnIdenticalFilesCopy(1).title).toBe('Remove the 1 identical copy from Calibre?');
    expect(turnOnIdenticalFilesCopy(null).title).toBe('Remove identical copies from Calibre?');
    expect(undoCleanupBatchCopy(2).title).toBe('Bring back 2 books removed in this batch?');
    expect(undoCleanupBatchCopy(2).danger).toBe(false);
  });
});

describe('CleanupApi', () => {
  it('sends secrets write-only and never reads them back', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ secrets: { calibrePassword: { set: true, hint: null } } }),
        {
          status: 200
        }
      );
    }) as unknown as typeof fetch;
    const api = new CleanupApi('http://s', 'ttsu_x', 0, fetchImpl);
    await api.saveSecret('calibrePassword', 'pw');
    expect(calls[0].url).toBe('http://s/api/v1/cleanup/secrets/calibrePassword');
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ value: 'pw' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ttsu_x');
  });
});
