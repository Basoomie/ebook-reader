/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultSort,
  formatSort,
  parseSort,
  pickKey,
  serverSort,
  sortChoices,
  sortLabel
} from './sort';

const remembered = { books: '', groups: '' };

describe('library sorts', () => {
  it('offers book, group, series and list sorts', () => {
    expect(sortChoices('books').map((c) => c.key)).toEqual([
      'added',
      'title',
      'author',
      'chars',
      'published'
    ]);
    expect(sortChoices('groups').map((c) => c.key)).toEqual(['newest', 'name', 'count']);
    expect(sortChoices('series')[0]).toMatchObject({ key: 'series', own: true });
    expect(sortChoices('list')[0]).toMatchObject({ key: 'list', label: 'Collection order' });
  });

  it('starts series and lists in their own order, others in the remembered sort', () => {
    expect(defaultSort('series', { books: 'title-asc', groups: '' })).toEqual({
      key: 'series',
      dir: 'asc'
    });
    expect(defaultSort('list', remembered)).toEqual({ key: 'list', dir: 'asc' });
    expect(defaultSort('books', remembered)).toEqual({ key: 'added', dir: 'desc' });
    expect(defaultSort('books', { books: 'chars-asc', groups: '' })).toEqual({
      key: 'chars',
      dir: 'asc'
    });
    expect(defaultSort('groups', { books: '', groups: 'name-desc' })).toEqual({
      key: 'name',
      dir: 'desc'
    });
    // A remembered value that isn't valid falls back.
    expect(defaultSort('books', { books: 'name-asc', groups: '' })).toEqual({
      key: 'added',
      dir: 'desc'
    });
  });

  it('reads and writes the address form', () => {
    expect(parseSort('title-desc', 'books')).toEqual({ key: 'title', dir: 'desc' });
    expect(parseSort('series', 'series')).toEqual({ key: 'series', dir: 'asc' });
    expect(parseSort('series', 'books')).toBeNull();
    expect(parseSort('list', 'list')).toEqual({ key: 'list', dir: 'asc' });
    expect(parseSort('title-up', 'books')).toBeNull();
    expect(parseSort('count-asc', 'books')).toBeNull();
    expect(parseSort('count-asc', 'groups')).toEqual({ key: 'count', dir: 'asc' });
    expect(formatSort({ key: 'title', dir: 'desc' }, 'books')).toBe('title-desc');
    expect(formatSort({ key: 'list', dir: 'asc' }, 'list')).toBe('list');
  });

  it('asks the server for nothing in the own order', () => {
    expect(serverSort({ key: 'series', dir: 'asc' }, 'series')).toBeUndefined();
    expect(serverSort({ key: 'title', dir: 'asc' }, 'series')).toEqual({
      key: 'title',
      dir: 'asc'
    });
    expect(serverSort({ key: 'added', dir: 'desc' }, 'books')).toEqual({
      key: 'added',
      dir: 'desc'
    });
  });

  it('labels sorts and picks a sensible direction for a new key', () => {
    expect(sortLabel({ key: 'title', dir: 'asc' }, 'books')).toBe('Title · A → Z');
    expect(sortLabel({ key: 'chars', dir: 'desc' }, 'books')).toBe('Length · Longest first');
    expect(sortLabel({ key: 'list', dir: 'asc' }, 'list')).toBe('Collection order');
    expect(pickKey({ key: 'added', dir: 'desc' }, 'title', 'books')).toEqual({
      key: 'title',
      dir: 'asc'
    });
    expect(pickKey({ key: 'title', dir: 'desc' }, 'title', 'books')).toEqual({
      key: 'title',
      dir: 'desc'
    });
    expect(pickKey({ key: 'title', dir: 'desc' }, 'nope', 'books')).toEqual({
      key: 'title',
      dir: 'desc'
    });
  });
});
