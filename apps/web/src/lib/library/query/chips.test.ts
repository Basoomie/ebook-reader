/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { activeChips, chipOnlyQuery, toggleChip } from './chips';

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

describe('the query a chip counts (chipOnlyQuery)', () => {
  it('adds the chip to an empty or plain search', () => {
    expect(chipOnlyQuery('', 'reading')).toBe('status:reading');
    expect(chipOnlyQuery('', 'favorite')).toBe('favorite:yes');
    expect(chipOnlyQuery('', 'device')).toBe('on:device');
    expect(chipOnlyQuery('gj', 'unread')).toBe('gj status:unread');
  });

  it('takes out every other chip, so the number does not depend on them', () => {
    expect(chipOnlyQuery('gj status:reading', 'unread')).toBe('gj status:unread');
    expect(chipOnlyQuery('gj status:reading', 'reading')).toBe('gj status:reading');
    expect(chipOnlyQuery('status:reading,completed x favorite:yes on:device', 'dropped')).toBe(
      'x status:dropped'
    );
    expect(chipOnlyQuery('a status:reading b status:completed c', 'favorite')).toBe(
      'a b c favorite:yes'
    );
  });

  it('keeps negated terms, favorite:no and everything else as typed', () => {
    expect(chipOnlyQuery('-status:completed 薬屋', 'reading')).toBe(
      '-status:completed 薬屋 status:reading'
    );
    expect(chipOnlyQuery('favorite:no x', 'favorite')).toBe('favorite:no x favorite:yes');
    expect(chipOnlyQuery('author:"Jane  Doe"   tag：SF status:dropped', 'reading')).toBe(
      'author:"Jane  Doe"   tag：SF status:reading'
    );
    expect(chipOnlyQuery('/a b/ status:unread chars:<100k', 'completed')).toBe(
      '/a b/ chars:<100k status:completed'
    );
  });

  it('gives null while the query has an error', () => {
    expect(chipOnlyQuery('status:foo', 'reading')).toBeNull();
  });
});
