/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { canLoadWhenVisible, loadWhenVisible } from './load-when-visible';

/** A stand-in IntersectionObserver that reports `visible` once per observe(). */
let visible = true;
const observers: FakeObserver[] = [];
class FakeObserver {
  disconnected = false;
  constructor(
    private callback: (entries: { isIntersecting: boolean }[]) => void,
    public options: { rootMargin?: string }
  ) {
    observers.push(this);
  }
  observe() {
    this.callback([{ isIntersecting: visible }]);
  }
  disconnect() {
    this.disconnected = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  observers.length = 0;
  visible = true;
});

const node = {} as Element;

describe('loadWhenVisible', () => {
  it('does nothing without IntersectionObserver', () => {
    const onVisible = vi.fn();
    expect(canLoadWhenVisible()).toBe(false);
    loadWhenVisible(node, { enabled: true, onVisible }).destroy();
    expect(onVisible).not.toHaveBeenCalled();
  });

  it('loads while the end is near, pauses while disabled and checks again when enabled', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const onVisible = vi.fn();
    const action = loadWhenVisible(node, { enabled: true, onVisible });
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(observers[0].options.rootMargin).toBe('0px 0px 100% 0px');
    // Loading: disabled, nothing is observed.
    action.update({ enabled: false, onVisible });
    expect(observers[0].disconnected).toBe(true);
    // The page loaded and the end is still visible: load again.
    action.update({ enabled: true, onVisible });
    expect(onVisible).toHaveBeenCalledTimes(2);
    // An update that changes nothing doesn't fire again.
    action.update({ enabled: true, onVisible });
    expect(onVisible).toHaveBeenCalledTimes(2);
    action.destroy();
    expect(observers[observers.length - 1].disconnected).toBe(true);
  });

  it('waits while the end is far away', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    visible = false;
    const onVisible = vi.fn();
    loadWhenVisible(node, { enabled: true, onVisible });
    expect(onVisible).not.toHaveBeenCalled();
  });
});
