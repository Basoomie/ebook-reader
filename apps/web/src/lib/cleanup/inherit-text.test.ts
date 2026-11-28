/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  inheritBar,
  inheritItemLine,
  inheritLines,
  inheritState,
  type InheritStatus
} from './inherit-text';

const status = (p: Partial<InheritStatus> = {}): InheritStatus => ({
  mode: 'analyse',
  waiting: null,
  counts: {},
  bar: null,
  books: {},
  fields: [],
  items: [],
  total: 0,
  ...p
});

describe('replaced books card', () => {
  it('sums up the books looked at and each field by state', () => {
    expect(
      inheritLines(
        status({
          books: { proposed: 3, nothing: 2 },
          fields: [
            { field: 'identifiers', state: 'applied', n: 2 },
            { field: 'identifiers', state: 'proposed', n: 1 },
            { field: 'series', state: 'proposed', n: 3 }
          ]
        })
      )
    ).toEqual([
      '5 replaced books looked at: 3 with values to take over, 2 with nothing missing.',
      'Store ids: 2 written, 1 to write',
      'Series: 3 to write'
    ]);
  });

  it('shows what each copy gets', () => {
    const item = {
      id: 1,
      calibreId: 80072,
      title: '薬屋のひとりごと',
      state: 'proposed',
      reason: null
    };
    expect(
      inheritItemLine({
        ...item,
        field: 'series',
        before: { name: null, index: null },
        value: { name: '薬屋のひとりごと', index: 1 }
      })
    ).toBe('Series: — → 薬屋のひとりごと #1');
    expect(
      inheritItemLine({
        ...item,
        field: 'identifiers',
        before: { bookmeter: '1' },
        value: { bookmeter: '1', amazon_jp: 'B0', isbn: '9' }
      })
    ).toBe('Store ids: + amazon_jp, isbn');
    expect(
      inheritItemLine({
        ...item,
        field: 'tags',
        before: [],
        value: { add: ['22ARead'], remove: [] }
      })
    ).toBe('Your tags: — → + 22ARead');
    expect(inheritState({ ...item, field: 'series', before: null, value: null })).toBe('to write');
  });

  it('has a bar only while writing', () => {
    expect(inheritBar(status())).toBeNull();
    expect(
      inheritBar(
        status({
          mode: 'on',
          bar: { label: 'values', done: 50, total: 200, startedAt: 1, base: 0, leftMs: 60_000 }
        })
      )
    ).toMatchObject({ label: 'Writing the values: 50 of 200', fraction: 0.25 });
  });
});
