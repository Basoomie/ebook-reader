/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { AiStatus } from './ai-api';
import {
  batchTestText,
  featureSplit,
  keyStateText,
  monthName,
  offeredText,
  priceText,
  providerLine,
  spendText,
  usd
} from './ai-text';

const spend = (o: Partial<AiStatus['spend']> = {}): AiStatus['spend'] => ({
  spentUsd: 12.4,
  reservedUsd: 0,
  limitUsd: 100,
  month: '2026-11',
  resumesOn: 'Dec 1',
  timeZone: 'America/Denver',
  ...o
});

describe('Settings > AI text', () => {
  it('money, months and the month line', () => {
    expect(usd(12.4)).toBe('$12.40');
    expect(usd(0.0031)).toBe('$0.0031');
    expect(usd(0)).toBe('$0.00');
    expect(monthName('2026-11')).toBe('November 2026');
    expect(monthName('2027-01')).toBe('January 2027');
    expect(spendText(spend())).toBe(
      '$12.40 spent this month of the $100.00 limit; $87.60 left until Dec 1.'
    );
    expect(spendText(spend({ reservedUsd: 0.5 }))).toBe(
      '$12.40 spent this month of the $100.00 limit ($0.50 held for batches); $87.10 left until Dec 1.'
    );
    expect(spendText(spend({ spentUsd: 120 }))).toMatch(/\$0\.00 left until Dec 1\.$/);
    expect(spendText(spend({ limitUsd: null }))).toBe(
      '$12.40 spent this month. No limit set yet: nothing is sent to a model.'
    );
  });

  it('prices as read-only text, with the long-prompt tier', () => {
    expect(priceText({ inputPerMTok: 2, outputPerMTok: 10 })).toBe(
      '$2 in · $10 out per million tokens'
    );
    expect(
      priceText({
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
        longAboveTokens: 100_000,
        long: { inputPerMTok: 0.5, outputPerMTok: 2.5 }
      })
    ).toBe(
      '$0.10 in · $0.50 out per million tokens (prompts over 100K tokens: $0.50 in · $2.50 out)'
    );
  });

  it('the split per feature, largest first, with the features’ names', () => {
    expect(
      featureSplit(
        { 'calibre-cleanup': 8.2, 'audiobook-cleanup': 2.66, 'ai-settings': 0, other: 1 },
        { 'calibre-cleanup': 'Calibre cleanup', 'audiobook-cleanup': 'Audiobook cleanup' }
      )
    ).toEqual([
      { name: 'Calibre cleanup', usd: '$8.20' },
      { name: 'Audiobook cleanup', usd: '$2.66' },
      { name: 'other', usd: '$1.00' }
    ]);
  });

  it('keys, providers, models and batch tests', () => {
    expect(keyStateText({ set: false, hint: null, updatedAt: null })).toBe('Not saved yet');
    expect(keyStateText({ set: true, hint: 'AAAA', updatedAt: null })).toBe('Saved · ends in AAAA');
    expect(keyStateText({ set: false, hint: null, updatedAt: null, unreadable: true })).toMatch(
      /enter it again/
    );
    const status = {
      keys: {
        anthropicApiKey: { set: true, hint: 'AAAA', updatedAt: 1 },
        openaiApiKey: { set: false, hint: null, updatedAt: null }
      },
      checks: { anthropic: { checkedAt: 1, error: 'ETIMEDOUT', models: null } },
      batchTests: {
        'claude-haiku-5-5': {
          state: 'answered',
          submittedAt: 1,
          endedAt: 2,
          detail: 'answered in 14 s'
        }
      }
    } as unknown as AiStatus;
    expect(providerLine(status, 'anthropic')).toBe('Anthropic: ETIMEDOUT');
    expect(providerLine(status, 'openai')).toBe('OpenAI: no API key saved');
    expect(offeredText(true, 'openai')).toBe('offered by OpenAI ✓');
    expect(offeredText(null, 'anthropic')).toBe('Anthropic: not checked yet');
    expect(offeredText(false, 'anthropic')).toMatch(/^NOT offered by Anthropic/);
    expect(batchTestText(status, 'claude-haiku-5-5')).toMatch(/answered in 14 s ✓$/);
    expect(batchTestText(status, 'gpt-6-luna')).toBe('Batch not tested yet');
  });
});
