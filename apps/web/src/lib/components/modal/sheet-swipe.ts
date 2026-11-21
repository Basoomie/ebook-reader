/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Swipe down to close a modal on phones, where it is a sheet from the bottom (2026-11-21).
 *
 * A downward drag that starts on the header, the tabs or the footer, or in the body while it
 * is scrolled to the top, moves the sheet with the finger and fades the backdrop. Let go
 * after a long enough drag (or a quick flick) and it closes; otherwise it slides back. A
 * drag that starts lower in a scrolled body, goes up or sideways, starts on a slider, or
 * follows a long press (selecting text) is left to the browser.
 *
 * Taking the drag over (preventDefault on touchmove) also keeps the browser's own reactions
 * away: the overscroll stretch of the body and pull-to-refresh of the page behind.
 */

/** The width below which a modal is a sheet (app.scss, "Modals"). */
export const SHEET_MEDIA = '(max-width: 639.98px)';

/** Movement (px) before a touch counts as a drag in some direction. */
const SLOP_PX = 3;
/** A touch held this long before it moves is a long press (text selection), not a swipe. */
const LONG_PRESS_MS = 450;
/** Let go this far down (share of the sheet's height, within the px bounds) and it closes. */
const CLOSE_SHARE = 0.3;
const CLOSE_MIN_PX = 72;
const CLOSE_MAX_PX = 200;
/** A flick: this fast (px/ms) downwards at release, and at least this far, also closes. */
const FLICK_SPEED = 0.55;
const FLICK_MIN_PX = 32;
/** Only the last stretch of the drag decides its speed. */
const SPEED_WINDOW_MS = 90;
const ANIMATION_MS = 200;

/** How far down a release closes a sheet of this height. */
export function closeDistance(height: number): number {
  return Math.min(CLOSE_MAX_PX, Math.max(CLOSE_MIN_PX, height * CLOSE_SHARE));
}

/** Whether a drag released `dy` px down, moving at `speed` px/ms (down > 0), closes. */
export function releaseCloses(dy: number, speed: number, height: number): boolean {
  if (dy <= 0) return false;
  // A flick back up at the end means "never mind".
  if (speed < -FLICK_SPEED / 2) return false;
  if (speed >= FLICK_SPEED && dy >= FLICK_MIN_PX) return true;
  return dy >= closeDistance(height);
}

/**
 * The first movement past the slop: 'drag' (the sheet follows), 'native' (the browser
 * scrolls or selects) or 'wait' (not far enough yet to tell).
 */
export function firstMove(dx: number, dy: number, heldMs: number): 'drag' | 'native' | 'wait' {
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return 'wait';
  if (heldMs >= LONG_PRESS_MS) return 'native';
  return dy > 0 && dy >= Math.abs(dx) ? 'drag' : 'native';
}

/** Speed (px/ms) over the last samples of a drag. */
export function releaseSpeed(samples: readonly { t: number; y: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const sample of samples) {
    if (last.t - sample.t <= SPEED_WINDOW_MS) {
      first = sample;
      break;
    }
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/**
 * Whether a touch on `target` may move the sheet: not on a slider or a `data-no-swipe`
 * element, and nothing between it and the sheet is scrolled away from its top.
 */
export function swipeMayStart(target: EventTarget | null, panel: HTMLElement): boolean {
  if (!(target instanceof Element) || !panel.contains(target)) return false;
  for (let el: Element | null = target; el && el !== panel; el = el.parentElement) {
    if (el instanceof HTMLInputElement && el.type === 'range') return false;
    if (el.hasAttribute('data-no-swipe')) return false;
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return false;
  }
  return true;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface SheetSwipeOptions {
  /** The backdrop to fade with the drag. */
  backdrop?: HTMLElement;
  /** False while this modal shouldn't react (another one is above it). */
  enabled: () => boolean;
  /** True when a release would close it now; false when it asks first (unsaved typing). */
  canClose: () => boolean;
  /** After the sheet has slid off: close it. */
  close: () => void;
  /** A long enough drag that may not close yet (it asks "Discard your changes?"). */
  refused: () => void;
}

interface Drag {
  startX: number;
  startY: number;
  startTime: number;
  dragging: boolean;
  dy: number;
  samples: { t: number; y: number }[];
}

/** Svelte action on the modal panel. */
export function sheetSwipe(panel: HTMLElement, initial: SheetSwipeOptions) {
  let options = initial;
  let drag: Drag | null = null;
  let settling = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const isSheet = () => typeof matchMedia === 'function' && matchMedia(SHEET_MEDIA).matches;

  function place(dy: number) {
    panel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    if (options.backdrop) {
      const height = panel.offsetHeight || 1;
      options.backdrop.style.opacity = dy > 0 ? `${Math.max(0, 1 - dy / height)}` : '';
    }
  }

  function setTransition(on: boolean) {
    const value = on ? `transform ${ANIMATION_MS}ms ease-out` : 'none';
    panel.style.transition = value;
    if (options.backdrop) {
      options.backdrop.style.transition = on ? `opacity ${ANIMATION_MS}ms ease-out` : 'none';
    }
  }

  function clearStyles() {
    panel.style.transform = '';
    panel.style.transition = '';
    if (options.backdrop) {
      options.backdrop.style.opacity = '';
      options.backdrop.style.transition = '';
    }
  }

  /** Slides to `dy` and calls `done` once there. */
  function settle(dy: number, done: () => void) {
    if (prefersReducedMotion()) {
      place(dy);
      done();
      return;
    }
    settling = true;
    setTransition(true);
    place(dy);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settling = false;
      done();
    }, ANIMATION_MS + 20);
  }

  function onTouchStart(ev: TouchEvent) {
    drag = null;
    if (settling || ev.touches.length !== 1 || !isSheet() || !options.enabled()) return;
    if (!swipeMayStart(ev.target, panel)) return;
    const touch = ev.touches[0];
    drag = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: ev.timeStamp,
      dragging: false,
      dy: 0,
      samples: []
    };
  }

  function onTouchMove(ev: TouchEvent) {
    if (!drag) return;
    if (ev.touches.length !== 1) {
      cancel();
      return;
    }
    const touch = ev.touches[0];
    const dx = touch.clientX - drag.startX;
    const dy = touch.clientY - drag.startY;
    if (!drag.dragging) {
      const decision = firstMove(dx, dy, ev.timeStamp - drag.startTime);
      if (decision === 'wait') return;
      if (decision === 'native') {
        drag = null;
        return;
      }
      drag.dragging = true;
      setTransition(false);
    }
    if (ev.cancelable) ev.preventDefault();
    drag.dy = Math.max(0, dy);
    drag.samples.push({ t: ev.timeStamp, y: touch.clientY });
    if (drag.samples.length > 12) drag.samples.shift();
    place(drag.dy);
  }

  function onTouchEnd(ev: TouchEvent) {
    const ended = drag;
    drag = null;
    if (!ended?.dragging) return;
    const height = panel.offsetHeight;
    const closes =
      ev.type === 'touchend' && releaseCloses(ended.dy, releaseSpeed(ended.samples), height);
    if (closes && options.canClose()) {
      settle(height + 16, () => {
        options.close();
        // A dialog that stays open after all comes back into view.
        requestAnimationFrame(() => {
          if (panel.isConnected) settle(0, clearStyles);
        });
      });
      return;
    }
    settle(0, clearStyles);
    if (closes) options.refused();
  }

  function cancel() {
    const ended = drag;
    drag = null;
    if (ended?.dragging) settle(0, clearStyles);
  }

  panel.addEventListener('touchstart', onTouchStart, { passive: true });
  // Not passive: a drag that moves the sheet keeps the browser from scrolling or refreshing.
  panel.addEventListener('touchmove', onTouchMove, { passive: false });
  panel.addEventListener('touchend', onTouchEnd);
  panel.addEventListener('touchcancel', onTouchEnd);

  return {
    update(next: SheetSwipeOptions) {
      options = next;
    },
    destroy() {
      clearTimeout(settleTimer);
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('touchend', onTouchEnd);
      panel.removeEventListener('touchcancel', onTouchEnd);
    }
  };
}
