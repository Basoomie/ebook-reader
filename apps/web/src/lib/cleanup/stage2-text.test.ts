/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { CleanupBatch, CleanupStage, Proposal, Stage2Status } from './cleanup-api';
import {
  batchCountsText,
  batchKindText,
  canUndo,
  copyEvidence,
  itemStateText
} from './cleanup-text';
import {
  fieldPauseResumable,
  fieldPauseTitle,
  fieldStateText,
  gateRows,
  sourceText,
  stage2ApplyProgress,
  stage2CountLines,
  stage2Lines,
  stage2Progress,
  valueText
} from './stage2-text';
import { turnOnFileMetadataCopy, undoFileMetadataBatchCopy } from '$lib/confirm/confirm-copy';

function stage(
  progress: Record<string, unknown>,
  precision: Record<string, unknown> = {},
  mode: CleanupStage['mode'] = 'analyse'
): CleanupStage {
  return {
    stage: 2,
    name: 'Metadata and covers from the files',
    built: true,
    mode,
    state: 'ready',
    pauseReason: null,
    pauseDetail: null,
    pausedAt: null,
    progress,
    precision,
    updatedAt: 0
  };
}

const status = (over: Partial<Stage2Status> = {}): Stage2Status => ({
  waiting: null,
  counts: [],
  skipReasons: [],
  fieldPauses: [],
  pace: { written: 0, firstAt: null },
  booksLeft: 0,
  ...over
});

describe('stage 2 wording', () => {
  it('values in plain words', () => {
    expect(valueText('authors', ['山田太郎', '佐藤'])).toBe('山田太郎 & 佐藤');
    expect(valueText('identifiers', { isbn: '978', amazon_jp: 'B0A' })).toBe(
      'isbn:978, amazon_jp:B0A'
    );
    expect(valueText('cover', { width: 800, height: 1200 })).toBe('a picture of 800 × 1200');
    expect(valueText('cover', null)).toBe('(none)');
    expect(valueText('publisher', '')).toBe('(none)');
    expect(sourceText('file-unconfirmed')).toBe('From the book’s file (not confirmed yet)');
    expect(sourceText('normalize')).toBe('Calibre’s own value, tidied');
    expect(fieldStateText('proposed', 'review')).toBe('Waiting for your review');
    expect(fieldStateText('applied')).toBe('Written');
  });

  it('progress: labeled books first, then every book, then working out the changes', () => {
    expect(stage2Progress(stage({ phase: 'read', pass: 'labeled', readTotal: 100 }))?.label).toBe(
      'Step 1 of 2 · Reading the labeled books first'
    );
    expect(
      stage2Progress(stage({ phase: 'read', pass: 'all', readTotal: 100, readDone: 25 }))
    ).toMatchObject({
      label: 'Step 1 of 2 · Reading each book’s file: 25 of 100 books',
      fraction: 0.25
    });
    expect(
      stage2Progress(stage({ phase: 'propose', readTotal: 100, proposeDone: 50 }))?.label
    ).toContain('Working out the changes');
    expect(stage2Progress(stage({ phase: 'done' }))).toBeNull();
  });

  it('writing progress from the books left and the recent pace', () => {
    const s = stage({ phase: 'done', booksWithChanges: 1000 }, {}, 'on');
    const now = Date.now();
    const bar = stage2ApplyProgress(
      s,
      status({ booksLeft: 600, pace: { written: 60, firstAt: now - 10 * 60_000 } }),
      now
    );
    expect(bar).toMatchObject({ label: 'Writing into Calibre: 400 of 1,000 books', fraction: 0.4 });
    expect(bar?.eta).toBe('about 1 h 40 min left');
    expect(stage2ApplyProgress(s, status({ booksLeft: 0 }), now)).toBeNull();
  });

  it('what the analysis found, in lines', () => {
    const lines = stage2Lines(
      stage({
        phase: 'done',
        books: 62000,
        booksWithChanges: 45000,
        folderMoves: 30000,
        fields: { title: { auto: 30000, review: 1200 }, cover: { auto: 32000 } },
        readErrors: 3,
        calibreUnknownJa: 5
      })
    );
    expect(lines[0]).toBe('Read 62,000 books: 45,000 get changes written automatically.');
    expect(lines).toContain('Changes by field: title 30,000 · cover 32,000.');
    expect(lines.some((l) => l.includes('1,200 wait for your review'))).toBe(true);
    expect(lines.some((l) => l.includes('30,000 books get a new title or first author'))).toBe(
      true
    );
    expect(lines.some((l) => l.includes('不明'))).toBe(true);
  });

  it('the check on the labeled books as rows', () => {
    const rows = gateRows(
      stage(
        { phase: 'done' },
        {
          gate: {
            fields: { title: { ok: true }, authors: { ok: false } },
            score: {
              title: {
                unknown: { n: 393, applied: 350, calibre: 48 },
                processed: { n: 222, applied: 213, calibre: 131 },
                agree: { n: 0 }
              },
              authors: {
                unknown: { n: 390, applied: 378 },
                processed: { n: 222, applied: 216 },
                agree: { n: 132, applied: 129 }
              },
              illustrator: { n: 20, applied: 19 }
            }
          }
        }
      ),
      { title: 85, margin: 20, authors: 95 }
    );
    expect(rows[0]).toMatchObject({ right: '89.1 %', calibre: '12.2 %', ok: true });
    expect(rows[0].bar).toBe('≥ 85 %, 20 points above Calibre');
    expect(rows.find((r) => r.label.startsWith('Authors'))).toMatchObject({
      right: '97.2 %',
      ok: false
    });
    expect(rows.find((r) => r.label.startsWith('Illustrators'))?.ok).toBeNull();
  });

  it('field pauses: the gate resumes by itself, the others by hand', () => {
    const gate = { field: 'title', reason: 'gate', detail: null, pausedAt: 0 };
    expect(fieldPauseTitle(gate)).toBe('Title paused: below its bar on the labeled books');
    expect(fieldPauseResumable(gate)).toBe(false);
    expect(fieldPauseResumable({ ...gate, reason: 'review_alarm' })).toBe(true);
  });

  it('counts per field', () => {
    const lines = stage2CountLines(
      status({
        counts: [
          { field: 'title', class: 'auto', state: 'proposed', n: 300 },
          { field: 'title', class: 'auto', state: 'applied', n: 1200 },
          { field: 'title', class: 'review', state: 'proposed', n: 52 },
          { field: 'cover', class: 'auto', state: 'skipped', n: 3 }
        ]
      })
    );
    expect(lines).toEqual([
      'Title: 300 to write · 1,200 written · 52 in review',
      'Cover: 3 skipped'
    ]);
  });

  it('stage-2 batches: their own name, counts and Undo', () => {
    const batch = {
      id: 'b',
      stage: 2,
      kind: 'apply',
      state: 'applied',
      itemCount: 10,
      counts: { written: 9, skipped: 1 },
      finishedAt: 1
    } as unknown as CleanupBatch;
    expect(batchKindText(batch)).toBe('Metadata from the files');
    expect(batchCountsText(batch)).toBe('9 changes written · 1 skipped');
    expect(canUndo(batch, [batch])).toBe(true);
    expect(itemStateText('written')).toBe('Written in Calibre');
    const undo = { ...batch, kind: 'undo', counts: { restored: 9 } } as unknown as CleanupBatch;
    expect(batchCountsText(undo)).toBe('9 changes put back');
    // Stage 1 evidence is told apart from stage 2's.
    expect(
      copyEvidence({
        evidence: { title: 'x', group: 'unknown', reason: null }
      } as unknown as Proposal)
    ).toBeNull();
  });

  it('asks before turning on and before Undo, in plain words', () => {
    const on = turnOnFileMetadataCopy({ books: 45000, folderMoves: 30000 });
    expect(on.title).toBe('Write the files’ metadata into Calibre for 45,000 books?');
    expect(on.message.join(' ')).toContain('Calibre moves the folders of 30,000 books');
    expect(on.message.join(' ')).toContain('a cover added where Calibre had none stays');
    const undo = undoFileMetadataBatchCopy(12);
    expect(undo.title).toBe('Put back the old values of 12 changes in this batch?');
    expect(undo.danger).toBe(false);
  });
});
