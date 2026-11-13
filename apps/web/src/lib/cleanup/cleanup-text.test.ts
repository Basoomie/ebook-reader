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
  stage1Lines,
  tagsMoving
} from './cleanup-text';
import {
  turnOnIdenticalFilesCopy,
  undoCleanupBatchCopy,
  replaceCleanupSecretCopy
} from '$lib/confirm/confirm-copy';

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
  it('describes each analysis phase and the result', () => {
    expect(stage1Lines(stage({ phase: 'stat', statDone: 1200, statTotal: 65925 }))[0]).toBe(
      'Reading file sizes: 1,200 of 65,925 books.'
    );
    expect(
      stage1Lines(
        stage({ phase: 'hash', hashDone: 10, hashTotal: 6600, bytesHashed: 3 * 1024 ** 3 })
      )[0]
    ).toBe('Comparing files of the same size: 10 of 6,600 files (3.0 GB read).');
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
    expect(batchCountsText(batch({ kind: 'undo', counts: { restored: 2, pending: 1 } }))).toBe(
      '2 brought back · 1 to go'
    );
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
    expect(replaceCleanupSecretCopy('Calibre password').irreversible).toBe(true);
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
