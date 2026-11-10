/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { activeChips, toggleChip } from './chips';

describe('filter chips', () => {
  it('adds a status term, then extends it', () => {
    const one = toggleChip('薬屋', 'reading');
    expect(one).toBe('薬屋 status:reading');
    expect(toggleChip(one!, 'completed')).toBe('薬屋 status:reading,completed');
  });

  it('removes a status and drops the term when it is empty', () => {
    expect(toggleChip('a status:reading,completed b', 'reading')).toBe('a status:completed b');
    expect(toggleChip('a status:reading b', 'reading')).toBe('a b');
    expect(toggleChip('status:reading', 'reading')).toBe('');
  });

  it('switches favorites on and off', () => {
    expect(toggleChip('', 'favorite')).toBe('favorite:yes');
    expect(toggleChip('x favorite:yes', 'favorite')).toBe('x');
  });

  it('keeps the rest of the query as typed', () => {
    expect(toggleChip('author:"Jane  Doe"   tag：SF', 'dropped')).toBe(
      'author:"Jane  Doe"   tag：SF status:dropped'
    );
  });

  it('shows the chips that the query turns on, ignoring negated terms', () => {
    expect([...activeChips('status:reading,dropped favorite:yes')].sort()).toEqual([
      'dropped',
      'favorite',
      'reading'
    ]);
    expect(activeChips('-status:reading favorite:no').size).toBe(0);
  });

  it('removes a status from every term that has it', () => {
    expect(toggleChip('status:reading x status:reading,dropped', 'reading')).toBe(
      'x status:dropped'
    );
  });

  it('is disabled while the query has an error', () => {
    expect(toggleChip('status:foo', 'reading')).toBeNull();
    expect(activeChips('status:foo').size).toBe(0);
  });
});
