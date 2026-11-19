/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { CleanupCheck, Stage4Gate, Stage4Status } from './cleanup-api';
import {
  checksSummary,
  stage2GateSummary,
  stage3GateSummary,
  stage4GateSummary,
  stage4SitesNeedingYou
} from './cleanup-card-text';

const field = (below: boolean) => ({
  auto: 600,
  scored: 700,
  right: 590,
  percent: 97.2,
  bar: 95,
  below,
  the600: { auto: 1, right: 1, percent: 97.5, measured: 98.2 },
  checkD: { auto: 1, right: 1, percent: 96.3, measured: 96.9 }
});

describe('the Cleanup tab’s short lines', () => {
  it('sums up each check on the labeled books in one line', () => {
    const row = (label: string, ok: boolean | null) => ({
      label,
      right: '97 %',
      calibre: null,
      bar: '≥ 95 %',
      ok
    });
    expect(stage2GateSummary([])).toBeNull();
    expect(stage2GateSummary([row('Authors (699 books)', true), row('Illustrators', null)])).toBe(
      'Labeled books: ✓ every check passes.'
    );
    expect(stage2GateSummary([row('Authors (699 books)', false)])).toBe(
      'Labeled books: ✗ 1 check fails (Authors).'
    );
    expect(stage3GateSummary({ passed: true, problems: [] } as never)).toBe(
      'Measured pairs and labeled books: ✓ passes.'
    );
    const gate = (below: boolean): Stage4Gate => ({
      books: 790,
      at: 0,
      fields: { title: field(false), illustrators: field(below) },
      kind: { right: 1, all: 1, percent: 100 }
    });
    expect(stage4GateSummary(gate(false))).toBe(
      'Labeled books: ✓ every field at or above its bar (790 checked).'
    );
    expect(stage4GateSummary(gate(true))).toBe(
      'Labeled books: ✗ Illustrators below the bar (790 checked).'
    );
  });

  it('folds the safety checks only while every required one passes', () => {
    const check = (ok: boolean, required = true) =>
      ({
        name: 'x',
        label: 'x',
        ok,
        detail: null,
        source: 'server',
        checkedAt: 0,
        required
      }) as CleanupCheck;
    expect(checksSummary([check(true), check(false, false)], true)).toBe(
      '✓ All 2 checks pass · sidecar running.'
    );
    expect(checksSummary([check(true), check(false)], true)).toBeNull();
  });

  it('keeps a stage-4 site on the card only when it needs you', () => {
    const site = (o: object) => ({
      site: 'amazon-dp',
      enabled: true,
      pausedReason: null,
      failed: 0,
      ...o
    });
    const status = {
      sites: [
        site({}),
        site({ site: 'bookwalker', failed: 3 }),
        site({ site: 'natively', pausedReason: 'x' })
      ]
    } as unknown as Stage4Status;
    expect(stage4SitesNeedingYou(status).map((s) => s.site)).toEqual(['bookwalker', 'natively']);
  });
});
