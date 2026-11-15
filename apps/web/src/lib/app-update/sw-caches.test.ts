/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  cachesToDelete,
  cacheVersion,
  isImmutablePath,
  isOlderVersion,
  isOwnCache,
  previousVersion,
  type BuildCacheState
} from './sw-caches';

const state = (version: string, marks: Partial<BuildCacheState> = {}): BuildCacheState => ({
  version,
  installed: true,
  activated: true,
  empty: false,
  ...marks
});

describe('cache names', () => {
  it('reads versions of the worker’s own kinds only', () => {
    expect(cacheVersion('build:100')).toBe('100');
    expect(cacheVersion('other:100')).toBe('100');
    expect(cacheVersion('ttu-userfonts')).toBeUndefined();
    expect(cacheVersion('covers')).toBeUndefined();
    expect(isOwnCache('ttu-userfonts')).toBe(true);
    expect(isOwnCache('build:1')).toBe(true);
    expect(isOwnCache('covers')).toBe(false);
  });

  it('compares build-time versions as numbers', () => {
    expect(isOlderVersion('99', '100')).toBe(true);
    expect(isOlderVersion('100', '100')).toBe(false);
    expect(isOlderVersion('101', '100')).toBe(false);
    expect(isOlderVersion('abc', '100')).toBe(false);
    expect(isOlderVersion('99', 'dev')).toBe(false);
  });
});

describe('previousVersion', () => {
  it('is the newest older version that took over', () => {
    expect(
      previousVersion('300', [state('100'), state('200'), state('250', { activated: false })])
    ).toBe('200');
  });

  it('never picks a version that waited and never took over', () => {
    expect(previousVersion('300', [state('100'), state('200', { activated: false })])).toBe('100');
  });

  it('ignores newer and non-numeric versions', () => {
    expect(previousVersion('300', [state('400'), state('x')])).toBeUndefined();
  });

  it('falls back to the newest older cache of a worker without marks (today’s, ttsu’s)', () => {
    const legacy = (v: string, empty = false) =>
      state(v, { installed: false, activated: false, empty });
    expect(previousVersion('300', [legacy('100'), legacy('200')])).toBe('200');
    // An empty one is skipped.
    expect(previousVersion('300', [legacy('100'), legacy('200', true)])).toBe('100');
    // A waiting-never-active one of this worker is not "legacy".
    expect(previousVersion('300', [legacy('100'), state('200', { activated: false })])).toBe('100');
  });

  it('never keeps an install that didn’t finish when a marked previous exists', () => {
    expect(
      previousVersion('300', [state('100'), state('200', { installed: false, activated: false })])
    ).toBe('100');
  });

  it('is undefined with nothing older', () => {
    expect(previousVersion('300', [])).toBeUndefined();
  });
});

describe('cachesToDelete', () => {
  const names = [
    'build:100',
    'other:100',
    'build:200',
    'other:200',
    'build:300',
    'other:300',
    'ttu-userfonts',
    'covers'
  ];

  it('keeps the current and previous versions and other names', () => {
    expect(cachesToDelete(names, '300', '200')).toEqual([
      'build:100',
      'other:100',
      'ttu-userfonts'
    ]);
  });

  it('keeps only the current version when there is no previous one', () => {
    expect(cachesToDelete(names, '300', undefined)).toEqual([
      'build:100',
      'other:100',
      'build:200',
      'other:200',
      'ttu-userfonts'
    ]);
  });
});

describe('isImmutablePath', () => {
  it('matches SvelteKit’s hashed files only', () => {
    expect(isImmutablePath('/_app/immutable/assets/font.abc.woff2')).toBe(true);
    expect(isImmutablePath('/_app/version.json')).toBe(false);
    expect(isImmutablePath('/home')).toBe(false);
    expect(isImmutablePath('/reader/_app/immutable/x.js', '/reader')).toBe(true);
    expect(isImmutablePath('/_app/immutable/x.js', '/reader')).toBe(false);
  });
});
