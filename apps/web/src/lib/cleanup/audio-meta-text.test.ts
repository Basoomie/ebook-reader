/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  audioStage5Bar,
  audioStage5Lines,
  fieldLine,
  metaCountLines,
  metaGateLines,
  metaMissLine,
  spendLine,
  valueText
} from './audio-meta-text';
import { metaGateSummary, stageSummary } from './audio-card-text';
import type { AudioMetaGate, AudioStage5Status, AudioStatus } from './cleanup-api';

const s5 = (
  over: Partial<AudioStage5Status['progress']> = {},
  rest: Partial<AudioStage5Status> = {}
) =>
  ({
    available: true,
    waiting: null,
    secondsLeft: 600,
    spend: { spentUsd: 0.1234, reservedUsd: 0.05, limitUsd: 1 },
    batches: {
      open: 1,
      collected: 2,
      failed: 0,
      stalled: 1,
      turnaroundMs: { median: 20 * 60_000, max: 30 * 60_000 }
    },
    modes: { primary: 'batch', secondary: 'direct' },
    models: { primary: 'claude-haiku-5-5', secondary: 'gpt-6-luna' },
    batchStallMinutes: 30,
    labeledOnly: false,
    progress: {
      analysisId: 'a',
      phase: 'models',
      startedAt: 0,
      finishedAt: null,
      units: 4898,
      labeledUnits: 200,
      decided: 0,
      phaseStartedAt: 0,
      phaseStartDone: 0,
      ai: { queued: 5000, sent: 1000, answered: 3796, blocked: 2, invalid: 1, failed: 0 },
      wait: null,
      invented: 3,
      counts: null,
      cost: { costUsd: 2.5, items: 1900, perItemUsd: 0.0013, byModel: {} },
      gate: null,
      error: null,
      ...over
    },
    ...rest
  }) as AudioStage5Status;

describe('stage 5 text', () => {
  it('shows the step with its answers and time left', () => {
    expect(audioStage5Bar(s5())).toEqual({
      label: 'Asking the models: 3,799 of 9,799 answers in (1,000 at the providers)',
      fraction: 3799 / 9799,
      eta: 'about 10 min left (estimate)'
    });
    expect(audioStage5Bar(s5({ phase: 'decide', decided: 1000 }))?.label).toBe(
      'Deciding: 1,000 of 4,898 recordings'
    );
    expect(audioStage5Bar(s5({ phase: 'done' }))).toBeNull();
  });

  it('says what is spent against the limit, and when no limit is set', () => {
    expect(spendLine(s5())).toBe('AI: $0.12 spent of the $1.00 limit ($0.05 held for batches).');
    expect(spendLine(s5({}, { spend: { spentUsd: 0, reservedUsd: 0, limitUsd: null } }))).toBe(
      'AI: no spending limit set yet (Settings > AI): the models are not asked.'
    );
  });

  it('lists answers, cost and batch turnaround', () => {
    expect(audioStage5Lines(s5())).toEqual([
      '4,898 recordings (200 labeled); claude-haiku-5-5 by batch, gpt-6-luna one call each.',
      'Answers: 3,796 in, 5,000 to ask, 1,000 at the providers, 2 blocked by a provider (final), 1 unusable.',
      '3 answers not in the evidence (dropped).',
      'This run: $2.50 for 1,900 recordings ($0.0013 each).',
      '1 batch answered nothing in 30 min: cancelled, its questions asked directly.',
      'Batches: 2 answered, typically within 20 min; 1 at the providers.'
    ]);
  });

  it('writes values as text: unknown is never "none"', () => {
    expect(valueText('series', null)).toBe('unknown');
    expect(valueText('series', [])).toBe('no series');
    expect(
      valueText('series', [
        { name: '本好きの下剋上 ドラマCD', position: 6 },
        { name: '本好きの下剋上', position: null }
      ])
    ).toBe('本好きの下剋上 ドラマCD #6 · 本好きの下剋上');
    expect(valueText('authors', [])).toBe('none credited');
    expect(valueText('drama', true)).toBe('yes');
    expect(
      fieldLine({
        field: 'authors',
        value: ['紫式部'],
        source: 'secondary_guess',
        flagged: true,
        reason: null,
        rules: null,
        primary: null,
        secondary: null
      })
    ).toBe('Authors: 紫式部 (Luna’s guess, unconfirmed)');
  });

  it('counts per field and source, the gate per field and its misses', () => {
    expect(
      metaCountLines({ title: { rules: 4600, both_models: 120, secondary_guess: 70, flagged: 70 } })
    ).toEqual(['Title: 4,600 rules, 120 both models, 70 unconfirmed.']);
    const gate: AudioMetaGate = {
      passed: false,
      books: 200,
      notFound: [],
      fields: {
        title: {
          auto: 183,
          autoRight: 183,
          flagged: 15,
          flaggedRight: 12,
          percent: 100,
          passed: true
        },
        narrators: {
          auto: 189,
          autoRight: 175,
          flagged: 4,
          flaggedRight: 3,
          percent: 92.6,
          passed: false
        }
      },
      misses: [
        {
          id: 'A123',
          field: 'narrators',
          expected: ['楠木華子'],
          got: ['斉藤範子'],
          source: 'rules',
          unitKey: 'u',
          name: '金五十両',
          record: null
        }
      ],
      flaggedWrong: 3,
      error: null
    };
    expect(metaGateLines(gate)).toEqual([
      'Title: ✓ 100.0 % of 183 automatic right; 12 of 15 unconfirmed right.',
      'Narrators: ✗ 92.6 % of 189 automatic right; 3 of 4 unconfirmed right.'
    ]);
    expect(metaMissLine(gate.misses[0])).toBe(
      'A123 金五十両: Narrators is 斉藤範子 (rules); the label says 楠木華子.'
    );
    expect(metaGateSummary(gate)).toBe(
      'Labeled books: ✗ narrators below the bar; 1 value differs from the labels.'
    );
    expect(metaGateSummary({ ...gate, passed: true, fields: { title: gate.fields.title } })).toBe(
      'Labeled books: ✓ every field passes (183 automatic values checked).'
    );
  });

  it('summarises a finished stage 5 on its card', () => {
    const status = {
      stage5: s5({ phase: 'done', counts: { title: { rules: 10, flagged: 2 } } })
    } as unknown as AudioStatus;
    expect(stageSummary(5, status)).toBe(
      '4,898 recordings decided; 2 titles unconfirmed. AI cost $2.50.'
    );
  });

  it('after a run again: the answers in use and their cost, not "0 in, $0.00" (2026-11-20)', () => {
    const p = {
      phase: 'done' as const,
      counts: { title: { rules: 10, flagged: 2 } },
      ai: { queued: 0, sent: 0, answered: 0, blocked: 0, invalid: 0, failed: 0 },
      cost: { costUsd: 0, items: 0, perItemUsd: null, byModel: {} },
      inUse: { answered: 9796, failed: 0, blocked: 0, invalid: 0, costUsd: 2.66 }
    };
    const lines = audioStage5Lines(s5(p));
    expect(lines).toContain('Answers in use: 9,796. AI cost of these answers: $2.66.');
    expect(lines.join('\n')).not.toMatch(/Answers: 0 in|This run: \$0\.00/);
    expect(stageSummary(5, { stage5: s5(p) } as unknown as AudioStatus)).toBe(
      '4,898 recordings decided; 2 titles unconfirmed. AI cost $2.66.'
    );
    const partly = audioStage5Lines(
      s5({ ...p, ai: { ...p.ai, answered: 6 }, inUse: { ...p.inUse, failed: 0 } })
    );
    expect(partly[1]).toBe(
      'Answers in use: 9,796 (6 asked in this run, the rest from earlier runs). AI cost of these answers: $2.66.'
    );
  });

  it("writes a label's series like a decided one (it said undefined #undefined)", () => {
    expect(valueText('series', [['探偵・沢崎シリーズ', '2', '2']])).toBe('探偵・沢崎シリーズ #2');
    expect(valueText('series', [['本好きの下剋上', null, 'drama']])).toBe('本好きの下剋上');
  });
});
