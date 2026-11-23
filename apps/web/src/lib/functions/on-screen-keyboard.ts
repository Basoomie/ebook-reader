/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The on-screen keyboard (phones, tablets, e-readers).
 *
 * When a text box gets focus the keyboard makes the visible area shorter. Two things follow:
 * - the reader would re-lay out the book to the shorter area (other columns, the page moves):
 *   `nextReaderSize` keeps the reader's size while a text box is focused on a touch device;
 * - sheets pinned to the bottom of the page end up under the keyboard: `startKeyboardInset`
 *   sets `--c-kb-inset` / `--c-vv-top` on <html> so the modal layer and the reader's bottom
 *   panels follow the visible area (app.scss).
 *
 * Desktop (a mouse) never gets either: no on-screen keyboard there.
 */

export interface ViewSize {
  width: number;
  height: number;
}

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'number',
  'email',
  'url',
  'tel',
  'password'
]);

/** A focused element that brings up the on-screen keyboard. */
export function isTextEntry(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && !input.readOnly && !input.disabled;
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** A touch device, where a focused text box opens an on-screen keyboard. */
export function touchKeyboardLikely(win: Window): boolean {
  try {
    return !!win.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** A text box has focus on a touch device: the keyboard is (or is about to be) up. */
export function keyboardMayBeOpen(win: Window): boolean {
  return touchKeyboardLikely(win) && isTextEntry(win.document.activeElement);
}

/**
 * The reader's next size. While the keyboard may be open, a shorter area with the same
 * width is the keyboard (or the browser's bar above it) and is ignored; a taller one, or a
 * new width (the device turned), goes through.
 */
export function nextReaderSize(
  prev: ViewSize | undefined,
  current: ViewSize,
  keyboardMayBeUp: boolean
): ViewSize {
  if (!prev || !keyboardMayBeUp) return current;
  if (current.width !== prev.width) return current;
  if (current.height >= prev.height) return current;
  return prev;
}

/**
 * The part of the page the keyboard covers, and how far the browser panned the visible area
 * down (px). `innerHeight` is the page's own (layout) height.
 */
export function keyboardInset(
  innerHeight: number,
  vv: Pick<VisualViewport, 'height' | 'offsetTop'>
): { inset: number; top: number } {
  const top = Math.max(0, Math.round(vv.offsetTop));
  const inset = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
  return { inset, top };
}

/**
 * Keeps `--c-kb-inset` and `--c-vv-top` on <html> while a text box is focused on a touch
 * device; removes them otherwise. Returns a stop function. No-op without visualViewport.
 */
export function startKeyboardInset(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const root = win.document.documentElement;
  let applied = '';

  const update = () => {
    let inset = 0;
    let top = 0;
    if (keyboardMayBeOpen(win)) {
      ({ inset, top } = keyboardInset(win.innerHeight, vv));
    }
    const key = `${inset}/${top}`;
    if (key === applied) return;
    applied = key;
    if (inset || top) {
      root.style.setProperty('--c-kb-inset', `${inset}px`);
      root.style.setProperty('--c-vv-top', `${top}px`);
    } else {
      root.style.removeProperty('--c-kb-inset');
      root.style.removeProperty('--c-vv-top');
    }
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  win.addEventListener('resize', update);
  win.document.addEventListener('focusin', update);
  win.document.addEventListener('focusout', update);
  update();

  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    win.document.removeEventListener('focusin', update);
    win.document.removeEventListener('focusout', update);
    root.style.removeProperty('--c-kb-inset');
    root.style.removeProperty('--c-vv-top');
  };
}
