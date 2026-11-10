/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { JumpHistory } from './jump-history';

const history = (limit = 50) => new JumpHistory(() => limit);

describe('JumpHistory', () => {
  it('starts empty', () => {
    const h = history();
    expect(h.canGoBack).toBe(false);
    expect(h.canGoForward).toBe(false);
    expect(h.back(10)).toBeUndefined();
    expect(h.forward(10)).toBeUndefined();
  });

  it('goes back to where a jump left from, and forward again', () => {
    const h = history();
    h.push(100); // jumped 100 -> 5000
    expect(h.back(5000)).toBe(100);
    expect(h.canGoBack).toBe(false);
    expect(h.canGoForward).toBe(true);
    expect(h.forward(100)).toBe(5000);
    expect(h.canGoBack).toBe(true);
    expect(h.back(5000)).toBe(100);
  });

  it('remembers where you read on to before going back', () => {
    const h = history();
    h.push(100); // jump to 5000, then read on to 5400
    expect(h.back(5400)).toBe(100);
    expect(h.forward(100)).toBe(5400);
  });

  it('walks several jumps in order', () => {
    const h = history();
    h.push(100); // -> 2000
    h.push(2000); // -> 3000
    h.push(3000); // -> 4000
    expect(h.back(4000)).toBe(3000);
    expect(h.back(3000)).toBe(2000);
    expect(h.back(2000)).toBe(100);
    expect(h.back(100)).toBeUndefined();
    expect(h.forward(100)).toBe(2000);
    expect(h.forward(2000)).toBe(3000);
    expect(h.forward(3000)).toBe(4000);
    expect(h.forward(4000)).toBeUndefined();
  });

  it('a new jump clears forward', () => {
    const h = history();
    h.push(100);
    h.back(5000);
    expect(h.canGoForward).toBe(true);
    h.push(100); // jumped again from 100
    expect(h.canGoForward).toBe(false);
    expect(h.back(7000)).toBe(100);
  });

  it('skips places equal to where you are', () => {
    const h = history();
    h.push(100);
    h.push(100);
    h.push(5000);
    expect(h.back(5000)).toBe(100);
    expect(h.canGoBack).toBe(false);
  });

  it('keeps at most the limit, dropping the oldest', () => {
    const h = history(3);
    for (const place of [1, 2, 3, 4, 5]) h.push(place);
    expect(h.back(6)).toBe(5);
    expect(h.back(5)).toBe(4);
    expect(h.back(4)).toBe(3);
    expect(h.back(3)).toBeUndefined();
  });

  it('ignores invalid places and clears', () => {
    const h = history();
    h.push(Number.NaN);
    h.push(-1);
    expect(h.canGoBack).toBe(false);
    h.push(0);
    expect(h.back(10)).toBe(0);
    h.clear();
    expect(h.canGoBack).toBe(false);
    expect(h.canGoForward).toBe(false);
  });
});
