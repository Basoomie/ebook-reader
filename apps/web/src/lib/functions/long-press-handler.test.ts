/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { longPressHandler } from './long-press-handler';

function pointer(type: string, init: { x?: number; y?: number; pointerType?: string } = {}) {
  // jsdom has no PointerEvent constructor; a MouseEvent with the extra field is enough here.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: 0
  });

  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'touch' });

  return event;
}

function click(target: EventTarget) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });

  target.dispatchEvent(event);

  return event;
}

describe('longPressHandler', () => {
  let node: HTMLDivElement;
  let outside: HTMLDivElement;
  let onTap: ReturnType<typeof vi.fn>;
  let onLongPress: ReturnType<typeof vi.fn>;
  let action: ReturnType<typeof longPressHandler>;

  beforeEach(() => {
    vi.useFakeTimers();
    node = document.createElement('div');
    outside = document.createElement('div');
    document.body.append(node, outside);
    onTap = vi.fn();
    onLongPress = vi.fn();
    action = longPressHandler(node, { onTap, onLongPress, getDuration: () => 500 });
  });

  afterEach(() => {
    action.destroy();
    node.remove();
    outside.remove();
    vi.useRealTimers();
  });

  it('a tap calls onTap immediately and does not bubble', () => {
    const bubbled = vi.fn();

    document.body.addEventListener('click', bubbled);

    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(100);
    node.dispatchEvent(pointer('pointerup'));
    click(node);

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(bubbled).not.toHaveBeenCalled();

    document.body.removeEventListener('click', bubbled);
  });

  it('a click without a preceding pointerdown (keyboard, assistive tech) is a tap', () => {
    click(node);

    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('holding calls onLongPress once, and the trailing click is swallowed everywhere', () => {
    const outsideCapture = vi.fn();

    document.addEventListener('click', outsideCapture, true);

    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(500);

    expect(onLongPress).toHaveBeenCalledTimes(1);

    // The release lands on whatever opened (e.g. the menu overlay), not on the node.
    outside.dispatchEvent(pointer('pointerup'));
    const trailing = click(outside);

    expect(trailing.defaultPrevented).toBe(true);
    expect(outsideCapture).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();

    // Later clicks are not affected.
    click(outside);
    expect(outsideCapture).toHaveBeenCalledTimes(1);

    document.removeEventListener('click', outsideCapture, true);
  });

  it('a click without a fresh press after a long press is still a tap', () => {
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(500);
    outside.dispatchEvent(pointer('pointerup'));
    click(outside); // trailing click, swallowed before it reaches the node
    vi.advanceTimersByTime(1000);

    click(node); // e.g. keyboard activation

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('a click long after a cancelled press is still a tap', () => {
    node.dispatchEvent(pointer('pointerdown'));
    node.dispatchEvent(pointer('pointercancel'));
    vi.advanceTimersByTime(1000);

    click(node);

    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('stops swallowing clicks shortly after release even if no click follows', () => {
    const outsideCapture = vi.fn();

    document.addEventListener('click', outsideCapture, true);

    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(500);
    node.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(1000);
    click(outside);

    expect(outsideCapture).toHaveBeenCalledTimes(1);

    document.removeEventListener('click', outsideCapture, true);
  });

  it('pointercancel cancels both tap and long press', () => {
    node.dispatchEvent(pointer('pointerdown'));
    node.dispatchEvent(pointer('pointercancel'));
    vi.advanceTimersByTime(100);
    click(node);
    vi.advanceTimersByTime(1000);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it('moving beyond the tolerance cancels the press', () => {
    node.dispatchEvent(pointer('pointerdown', { x: 0, y: 0 }));
    node.dispatchEvent(pointer('pointermove', { x: 30, y: 0 }));
    vi.advanceTimersByTime(1000);
    node.dispatchEvent(pointer('pointerup', { x: 30, y: 0 }));
    click(node);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it('reads the duration on every press', () => {
    action.update({ onTap, onLongPress, getDuration: () => 1200 });

    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(800);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('blocks the context menu', () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    node.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
