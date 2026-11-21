/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideDismiss,
  dismissTop,
  isBackdropClick,
  openLayerCount,
  pushLayer,
  resetLayersForTest
} from './modal-stack';

afterEach(() => resetLayersForTest());

describe('the modal stack', () => {
  it('dismisses only the top layer', () => {
    const below = vi.fn();
    const above = vi.fn();
    const a = pushLayer(below);
    const b = pushLayer(above);
    expect(a.isTop()).toBe(false);
    expect(b.isTop()).toBe(true);
    expect(dismissTop('escape')).toBe(true);
    expect(above).toHaveBeenCalledWith('escape');
    expect(below).not.toHaveBeenCalled();
    b.remove();
    expect(a.isTop()).toBe(true);
    dismissTop('outside');
    expect(below).toHaveBeenCalledWith('outside');
    a.remove();
    expect(openLayerCount()).toBe(0);
    expect(dismissTop('escape')).toBe(false);
  });

  it('lets an in-place confirmation take Esc without covering its modal', () => {
    const modal = vi.fn();
    const inline = vi.fn();
    const m = pushLayer(modal);
    const i = pushLayer(inline, { escapeOnly: true });
    // A click outside still belongs to the modal…
    expect(m.isTop()).toBe(true);
    // …while Esc cancels only the confirmation.
    dismissTop('escape');
    expect(inline).toHaveBeenCalledWith('escape');
    expect(modal).not.toHaveBeenCalled();
    i.remove();
    m.remove();
  });

  it('closes on a press that starts and ends on the backdrop only', () => {
    const backdrop = {} as EventTarget;
    const inside = {} as EventTarget;
    expect(isBackdropClick(backdrop, backdrop, backdrop)).toBe(true);
    // A text selection dragged out of the modal and released over the backdrop.
    expect(isBackdropClick(inside, backdrop, backdrop)).toBe(false);
    expect(isBackdropClick(backdrop, inside, backdrop)).toBe(false);
    expect(isBackdropClick(null, backdrop, backdrop)).toBe(false);
    expect(isBackdropClick(backdrop, backdrop, null)).toBe(false);
  });

  it('asks before discarding unsaved changes', () => {
    expect(decideDismiss({ dirty: false, askingDiscard: false }, 'outside')).toBe('close');
    expect(decideDismiss({ dirty: false, askingDiscard: false }, 'escape')).toBe('close');
    expect(decideDismiss({ dirty: true, askingDiscard: false }, 'outside')).toBe('ask');
    expect(decideDismiss({ dirty: true, askingDiscard: false }, 'close-button')).toBe('ask');
    // Esc while the question shows goes back to editing; another outside click keeps asking.
    expect(decideDismiss({ dirty: true, askingDiscard: true }, 'escape')).toBe('keep-editing');
    expect(decideDismiss({ dirty: true, askingDiscard: true }, 'outside')).toBe('ask');
  });
});
