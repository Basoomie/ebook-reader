/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

export interface LongPressOptions {
  onTap: () => void;
  onLongPress: () => void;
  /** Hold duration in ms after which a press counts as a long press. Read on every press. */
  getDuration: () => number;
}

/** Movement (px) after which a press is treated as a drag and neither tap nor long press fires. */
const MOVE_TOLERANCE_PX = 10;

/** How long after releasing a long press the trailing click is swallowed. */
const CLICK_SUPPRESS_WINDOW_MS = 600;

/**
 * Svelte action: a tap calls `onTap`, holding for `getDuration()` ms calls `onLongPress`.
 *
 * Taps are taken from the `click` event (so mouse, touch, pen and e-ink taps behave the
 * same) and do not propagate. After a long press the trailing click is swallowed in the
 * window capture phase, before `clickOutside` handlers or the reader footer see it. The
 * context menu, touch callout and text selection are disabled on the node.
 */
export function longPressHandler(node: HTMLElement, initialOptions: LongPressOptions) {
  let options = initialOptions;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressTimer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;
  let pressActive = false;
  let longPressFired = false;
  let cancelled = false;
  let suppressClick = false;
  let lastPressEndAt = 0;

  const { style } = node;

  style.userSelect = 'none';
  style.setProperty('-webkit-user-select', 'none');
  style.setProperty('-webkit-touch-callout', 'none');
  style.touchAction = 'manipulation';

  function clearPressTimer() {
    if (pressTimer !== undefined) {
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  }

  function stopSuppressingClicks() {
    suppressClick = false;

    if (suppressTimer !== undefined) {
      clearTimeout(suppressTimer);
      suppressTimer = undefined;
    }

    window.removeEventListener('click', swallowClick, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
  }

  function swallowClick(event: MouseEvent) {
    if (!suppressClick) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopSuppressingClicks();
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    clearPressTimer();
    stopSuppressingClicks();

    pressActive = true;
    longPressFired = false;
    cancelled = false;
    startX = event.clientX;
    startY = event.clientY;

    pressTimer = setTimeout(
      () => {
        pressTimer = undefined;

        if (!pressActive || cancelled) {
          return;
        }

        longPressFired = true;
        suppressClick = true;
        window.addEventListener('click', swallowClick, true);
        // The release may land on whatever onLongPress opened (e.g. a menu overlay)
        // instead of this node, so listen for it on the window as well.
        window.addEventListener('pointerup', onPointerUp, { capture: true, once: true });
        window.addEventListener('pointercancel', onPointerCancel, { capture: true, once: true });
        options.onLongPress();
      },
      Math.max(0, options.getDuration())
    );
  }

  function onPointerMove(event: PointerEvent) {
    if (!pressActive || longPressFired) {
      return;
    }

    if (
      Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX ||
      Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX
    ) {
      cancelled = true;
      clearPressTimer();
    }
  }

  function scheduleStopSuppressing() {
    if (!suppressClick) {
      return;
    }

    if (suppressTimer !== undefined) {
      clearTimeout(suppressTimer);
    }

    suppressTimer = setTimeout(stopSuppressingClicks, CLICK_SUPPRESS_WINDOW_MS);
  }

  function onPointerUp() {
    pressActive = false;
    lastPressEndAt = Date.now();
    clearPressTimer();
    scheduleStopSuppressing();
  }

  function onPointerCancel() {
    pressActive = false;
    lastPressEndAt = Date.now();
    cancelled = true;
    clearPressTimer();
    scheduleStopSuppressing();
  }

  function onClick(event: MouseEvent) {
    event.stopPropagation();

    // Only the click that ends a long or cancelled press is skipped. The trailing click
    // of a long press is usually swallowed before it reaches this node, so the flags can
    // be stale; a later click without a fresh press (keyboard, assistive tech) is a tap.
    const skip =
      (longPressFired || cancelled) && Date.now() - lastPressEndAt < CLICK_SUPPRESS_WINDOW_MS;

    longPressFired = false;
    cancelled = false;

    if (!skip) {
      options.onTap();
    }
  }

  function onContextMenu(event: Event) {
    event.preventDefault();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerCancel);
  node.addEventListener('click', onClick);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(newOptions: LongPressOptions) {
      options = newOptions;
    },
    destroy() {
      clearPressTimer();
      stopSuppressingClicks();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
      node.removeEventListener('click', onClick);
      node.removeEventListener('contextmenu', onContextMenu);
    }
  };
}
