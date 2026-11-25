/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { describeQuery } from './describe';

function reads(text: string): string {
  const r = describeQuery(text);
  if (r.kind !== 'reads') throw new Error(`expected a reading, got ${r.kind}`);
  return r.text;
}

describe('describeQuery', () => {
  it('says nothing for empty or plain-word searches', () => {
    expect(describeQuery('')).toEqual({ kind: 'none' });
    expect(describeQuery('薬屋 外伝')).toEqual({ kind: 'none' });
  });

  it('reads the example from the design', () => {
    expect(reads('tag:SF,BL chars:<100k -status:completed')).toBe(
      'tag contains SF or BL, under 100,000 characters and not completed'
    );
  });

  it('tells a comma (either) from a space (both)', () => {
    expect(reads('tag:SF,BL')).toBe('tag contains SF or BL');
    expect(reads('tag:SF tag:BL')).toBe('tag contains SF and tag contains BL');
  });

  it('reads exact, pattern, quoted and negated names', () => {
    expect(reads('tag:=SF')).toBe('tag is exactly SF');
    expect(reads('author:/^日向/')).toBe('author matches /^日向/');
    expect(reads('series:/abc/i')).toBe('series matches /abc/i');
    expect(reads('author:"Jane Doe"')).toBe('author contains "Jane Doe"');
    expect(reads('-illustrator:しの')).toBe('no illustrator contains しの');
  });

  it('reads number ranges as typed', () => {
    expect(reads('chars:<=150000')).toBe('150,000 characters or fewer');
    expect(reads('chars:>50k')).toBe('over 50,000 characters');
    expect(reads('chars:>=50k')).toBe('50,000 characters or more');
    expect(reads('chars:50k-150k')).toBe('50,000 to 150,000 characters');
    expect(reads('chars:1000')).toBe('exactly 1,000 characters');
    expect(reads('level:20-29')).toBe('Natively level 20 to 29');
    expect(reads('level:<25')).toBe('Natively level under 25');
    expect(reads('level:>=30')).toBe('Natively level 30 or higher');
    expect(reads('level:25')).toBe('Natively level 25');
  });

  it('reads status, favorite and device terms', () => {
    expect(reads('status:unread,reading')).toBe('unread or reading');
    expect(reads('favorite:yes')).toBe('a favorite');
    expect(reads('favorite:no')).toBe('not a favorite');
    expect(reads('-favorite:yes')).toBe('not a favorite');
    expect(reads('on:device')).toBe('on this device');
    expect(reads('-on:audio')).toBe('audio not on this device');
  });

  it('includes plain words once a field is used', () => {
    expect(reads('薬屋 -外伝 status:reading')).toBe('with “薬屋”, without “外伝” and reading');
    expect(reads('/^薬屋/ favorite:yes')).toBe('matching /^薬屋/ and a favorite');
  });

  it('shows mistakes, but not a term still being typed at the end', () => {
    expect(describeQuery('status:done').kind).toBe('error');
    expect(describeQuery('tag:', 4)).toEqual({ kind: 'none' });
    expect(describeQuery('tag:').kind).toBe('error');
    expect(describeQuery('tag: ', 5).kind).toBe('error');
    expect(describeQuery('status:x chars:', 15).kind).toBe('error');
  });
});
