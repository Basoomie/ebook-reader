/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { keepPlaceForReload, RELOAD_PLACE_KEY, takePlaceAfterReload } from './reload-place';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  };
}

describe('reload place', () => {
  it('comes back once, for the same book', () => {
    const storage = memoryStorage();
    keepPlaceForReload(storage, 40, 12345);
    expect(takePlaceAfterReload(storage, 40)).toBe(12345);
    expect(takePlaceAfterReload(storage, 40)).toBeNull();
  });

  it('is dropped when another book opens', () => {
    const storage = memoryStorage();
    keepPlaceForReload(storage, 40, 500);
    expect(takePlaceAfterReload(storage, 41)).toBeNull();
    expect(storage.map.has(RELOAD_PLACE_KEY)).toBe(false);
    expect(takePlaceAfterReload(storage, 40)).toBeNull();
  });

  it('keeps the start of the book', () => {
    const storage = memoryStorage();
    keepPlaceForReload(storage, 3, 0);
    expect(takePlaceAfterReload(storage, 3)).toBe(0);
  });

  it('ignores blocked, missing or broken storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      }
    };
    expect(() => keepPlaceForReload(blocked, 1, 10)).not.toThrow();
    expect(takePlaceAfterReload(blocked, 1)).toBeNull();
    expect(takePlaceAfterReload(undefined, 1)).toBeNull();

    const storage = memoryStorage();
    storage.setItem(RELOAD_PLACE_KEY, '{not json');
    expect(takePlaceAfterReload(storage, 1)).toBeNull();
    expect(storage.map.has(RELOAD_PLACE_KEY)).toBe(false);
  });
});
