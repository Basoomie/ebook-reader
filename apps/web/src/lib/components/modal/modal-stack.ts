/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Every open layer that can be dismissed (a modal, a reader side panel, an in-place
 * confirmation inside a modal, whispersync's dialogs) registers here while it is open. Only
 * the topmost one reacts to Esc or to a click outside it, so a confirmation inside the
 * whispersync menu closes alone, and Esc on an in-place "Delete …?" cancels only that.
 */

/** 'swipe': swiped down on a phone (sheet-swipe.ts); it closes like an outside click. */
export type DismissReason = 'escape' | 'outside' | 'close-button' | 'swipe';

export interface ModalLayer {
  readonly id: number;
  /** Takes the layer off the stack (call when it closes). */
  remove(): void;
  /** True while no layer opened after this one is still open. */
  isTop(): boolean;
}

interface Entry {
  id: number;
  onDismiss: (reason: DismissReason) => void;
  /** Takes Esc only (an in-place confirmation): an outside click still closes the modal. */
  escapeOnly: boolean;
}

const layers: Entry[] = [];
let nextId = 1;
let listening = false;

export function pushLayer(
  onDismiss: (reason: DismissReason) => void,
  options: { escapeOnly?: boolean } = {}
): ModalLayer {
  const entry: Entry = { id: nextId++, onDismiss, escapeOnly: !!options.escapeOnly };
  layers.push(entry);
  listen();
  return {
    id: entry.id,
    remove() {
      const index = layers.indexOf(entry);
      if (index >= 0) layers.splice(index, 1);
    },
    isTop() {
      // Esc-only entries (an in-place confirmation) don't cover the layer they sit in.
      for (let i = layers.length - 1; i >= 0; i--) {
        if (!layers[i].escapeOnly) return layers[i] === entry;
      }
      return false;
    }
  };
}

export function openLayerCount(): number {
  return layers.length;
}

/** Dismisses the top layer; false when nothing is open. */
export function dismissTop(reason: DismissReason): boolean {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.onDismiss(reason);
  return true;
}

/**
 * Popovers and pickers that handle Esc themselves (a dropdown open inside a modal) mark
 * their root with `data-own-escape`; Esc from inside one is left to it.
 */
export function escapeBelongsToPopover(target: EventTarget | null): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    !!target.closest('[data-own-escape]')
  );
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape' || ev.defaultPrevented || !layers.length) return;
  if (escapeBelongsToPopover(ev.target)) return;
  ev.preventDefault();
  // Reader shortcuts and the page's own Esc handling never see it.
  ev.stopImmediatePropagation();
  dismissTop('escape');
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // Capture: before the reader's and the pages' own key handlers.
  window.addEventListener('keydown', onKeydown, true);
}

/**
 * A press that starts and ends on the backdrop closes; a text selection dragged from inside
 * the modal and released over the backdrop doesn't.
 */
export function isBackdropClick(
  pointerDownTarget: EventTarget | null,
  clickTarget: EventTarget | null,
  backdrop: EventTarget | null
): boolean {
  return !!backdrop && pointerDownTarget === backdrop && clickTarget === backdrop;
}

/**
 * What a close request does to a modal: closes it, asks "Discard your changes?" (unsaved
 * typing), or goes back to editing (Esc while that question shows).
 */
export function decideDismiss(
  state: { dirty: boolean; askingDiscard: boolean },
  reason: DismissReason
): 'close' | 'ask' | 'keep-editing' {
  if (state.askingDiscard) return reason === 'escape' ? 'keep-editing' : 'ask';
  return state.dirty ? 'ask' : 'close';
}

/** Test only: forget every layer. */
export function resetLayersForTest() {
  layers.splice(0, layers.length);
}
