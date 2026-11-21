/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { Stage5Counts, Stage5Gate, Stage5Progress, Stage5SetScore } from './cleanup-api';
import { batchKindText, writesFields } from './cleanup-text';
import {
  formatCounts,
  removalCounts,
  sourceText,
  stage5Bar,
  stage5CountsLine,
  stage5GateLines,
  stage5GateSummary,
  stage5Line,
  termCounts
} from './stage5-text';
import { turnOnGenresTagsCopy, undoGenresTagsBatchCopy } from '$lib/confirm/confirm-copy';

const score = (o: Partial<Stage5SetScore> = {}): Stage5SetScore => ({
  books: 80,
  core: 103,
  found: 94,
  applied: 147,
  right: 146,
  full: 70,
  foundPercent: 91.3,
  rightPercent: 99.3,
  wrong: [],
  missed: [],
  ...o
});

const gate = (o: Partial<Stage5Gate> = {}): Stage5Gate => {
  const v = {
    genres: score(),
    tags: score({ books: 63, foundPercent: 77.1, rightPercent: 99, full: 42 })
  };
  return {
    at: 1,
    books: { genres: 80, tags: 63 },
    models: v,
    own: v,
    noRanobedb: v,
    final: v,
    test: {
      genres: { found: 91.3, right: 99.3, full: 70, books: 80 },
      tags: { found: 77.1, right: 99, full: 42, books: 63 }
    },
    below: [],
    held: { genres: false, tags: false },
    passed: true,
    notAsked: 0,
    ...o
  };
};

const progress = (o: Partial<Stage5Progress> = {}): Stage5Progress => ({
  phase: 'models',
  bar: { phase: 'models', done: 26060, total: 104240, secondsLeft: 5400 },
  startedAt: 1,
  finishedAt: null,
  total: 52120,
  items: 52120,
  labeledItems: 300,
  decided: 0,
  asked: 0,
  oneModel: 0,
  droppedTerms: 0,
  marks: 53247,
  answers: { queued: 70000, sent: 8180, answered: 26000, failed: 60, blocked: 0, invalid: 0 },
  wait: null,
  costUsd: 6.2,
  gate: null,
  counts: null,
  error: null,
  ...o
});

const counts = (): Stage5Counts => ({
  terms: { fantasy: 20000, isekai: 9000, magic: 12000, anime: 3000 },
  formats: { 'light novel': 27451, novel: 15991 },
  noGenre: 812,
  removals: { 'needs-metadata': 26442, 'Young Adult Fiction': 5341 },
  books: 52500,
  added: 260000,
  removed: 61000,
  outside: 1127,
  outsideChanged: 640,
  inBatch: 0
});

describe('stage 5 on the page', () => {
  it('shows the running phase with its time left, and the run in one line', () => {
    const b = stage5Bar(progress())!;
    expect(b.label).toBe('Asking both models: 26,060 of 104,240 answers in');
    expect(b.fraction).toBe(0.25);
    expect(b.eta).toMatch(/estimate/);
    expect(stage5Bar(progress({ phase: 'done', bar: null }))).toBeNull();
    expect(stage5Line(progress())).toBe(
      'Genres and tags: asking both models · 26,000 of 104,240 answers in · 60 given up · $6.20 spent'
    );
  });

  it('shows the gate beside the genre test, and what is held back', () => {
    expect(stage5GateSummary(gate())).toBe(
      'On the labeled books: genres 99.3 % right, 91.3 % found; tags 99.0 % right, 77.1 % found · passes'
    );
    expect(
      stage5GateSummary(gate({ below: ['tags: 93.0 % right (bar 95 %)'], passed: false }))
    ).toMatch(/held back: tags: 93.0 % right/);
    expect(stage5GateSummary(gate({ books: { genres: 0, tags: 0 } }))).toMatch(/No labeled books/);
    const lines = stage5GateLines(gate());
    expect(lines[0].title).toMatch(/As written/);
    expect(lines[0].lines[0]).toBe(
      'Genres: 91.3 % found (test 91.3 %), 99.3 % right (test 99.3 %), 70 of 80 books fully right (test 70 of 80)'
    );
  });

  it('counts the books per term, the format tags and the tags taken off', () => {
    const status = {
      terms: [
        { id: 'fantasy', ja: 'ファンタジー', en: 'Fantasy', kind: 'genre' },
        { id: 'isekai', ja: '異世界', en: 'Isekai', kind: 'genre' },
        { id: 'sports', ja: 'スポーツ', en: 'Sports', kind: 'genre' },
        { id: 'fmt_light_novel', ja: 'ライトノベル', en: 'Light novel', kind: 'format' },
        { id: 'fmt_novel', ja: '小説', en: 'Novel', kind: 'format' }
      ]
    };
    expect(termCounts(status, counts(), 'genre')).toEqual([
      { id: 'fantasy', label: 'ファンタジー (Fantasy)', n: 20000 },
      { id: 'isekai', label: '異世界 (Isekai)', n: 9000 },
      { id: 'sports', label: 'スポーツ (Sports)', n: 0 }
    ]);
    expect(formatCounts(status, counts())[0]).toEqual({
      label: 'ライトノベル (Light novel)',
      n: 27451
    });
    expect(removalCounts(counts())[0]).toEqual({ tag: 'needs-metadata', n: 26442 });
    expect(stage5CountsLine(counts())).toBe(
      '52,500 books get a change: 260,000 tags added, 61,000 taken off · 812 books with no genre · 1,127 books stage 4 never read (old tags taken off only: 640)'
    );
    expect(sourceText({ from: ['models', 'ranobedb'], books: 3 })).toBe(
      'both models, RanobeDB · 3 volumes'
    );
  });

  it('names its batches and asks before On and before Undo', () => {
    const b = { stage: 5, kind: 'apply' } as never;
    expect(batchKindText(b)).toBe('Genres and tags');
    expect(writesFields(b)).toBe(true);
    const on = turnOnGenresTagsCopy({ books: 52500, added: 260000, removed: 61000 });
    expect(on.title).toBe('Write genres and tags into 52,500 books in Calibre?');
    expect(on.message.join(' ')).toMatch(/Your own tags/);
    expect(turnOnGenresTagsCopy({ books: null, added: null, removed: null }).title).toBe(
      'Write genres and tags into the books in Calibre?'
    );
    expect(undoGenresTagsBatchCopy(1).title).toBe('Put back the old tags of 1 book in this batch?');
  });
});
