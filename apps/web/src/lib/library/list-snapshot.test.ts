/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { saveListSnapshot, SNAPSHOT_MAX_AGE_MS, takeListSnapshot } from './list-snapshot';

describe('list snapshot', () => {
  it('gives the last list back once, for the same address', () => {
    saveListSnapshot('/library?tab=all', 1200, { books: [1, 2, 3] }, 1000);
    expect(takeListSnapshot('/library?tab=series', 1001)).toBeNull();
    // Taking forgets it, even for another address.
    expect(takeListSnapshot('/library?tab=all', 1002)).toBeNull();
    saveListSnapshot('/library?tab=all', 1200, { books: [1, 2, 3] }, 1000);
    expect(takeListSnapshot('/library?tab=all', 2000)).toMatchObject({
      scrollY: 1200,
      data: { books: [1, 2, 3] }
    });
    expect(takeListSnapshot('/library?tab=all', 2001)).toBeNull();
  });

  it('ignores an old snapshot', () => {
    saveListSnapshot('/library', 10, {}, 0);
    expect(takeListSnapshot('/library', SNAPSHOT_MAX_AGE_MS + 1)).toBeNull();
  });
});
