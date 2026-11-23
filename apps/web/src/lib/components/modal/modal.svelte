<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The one frame every modal uses (2026-11-21):
   * - header: title, an optional subtitle naming the object (the book), and ✕;
   * - an optional `tabs` slot under the header;
   * - the body (default slot), the only part that scrolls;
   * - a footer only when the dialog fills the `footer` slot (Save, Upload, …). There is no
   *   Close/Cancel button: ✕, Esc and a click outside back out. A question
   *   (role="alertdialog", "Delete …?") has no ✕ and keeps Cancel beside its action.
   *
   * Centred card from 640 px, a sheet from the bottom on phones. Esc, ✕ and an outside
   * click all go through `request()`: with unsaved changes (`dirty`) the footer first asks
   * "Discard your changes?". Focus stays inside while it is open and goes back afterwards;
   * the page behind doesn't scroll.
   *
   * On phones a downward swipe from the header, or from the body while it is at its top,
   * drags the sheet down; a long enough swipe closes it like an outside click
   * (`sheet-swipe.ts`).
   *
   * on:close fires when the modal should go away (the dialog closes itself: the modal never
   * unmounts on its own). Its detail says why: 'escape', 'outside', 'close-button', 'swipe'
   * or 'discard'.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { FOCUSABLE_SELECTOR, nextFocusIndex } from '$lib/confirm/confirm-state';
  import { decideDismiss, isBackdropClick, pushLayer, type DismissReason } from './modal-stack';
  import { sheetSwipe } from './sheet-swipe';

  export let title = '';
  export let subtitle = '';
  export let size: 'sm' | 'md' | 'lg' | 'xl' = 'md';
  export let role: 'dialog' | 'alertdialog' = 'dialog';
  /** Unsaved typing: a close request asks before discarding it. */
  export let dirty = false;
  export let testid: string | undefined = undefined;
  /** The ✕ button's test id (default: `<testid>-x`). */
  export let closeTestid: string | undefined = undefined;
  /** 'inherit': the reader theme's own colours (whispersync's dialogs). */
  export let surface: 'app' | 'inherit' = 'app';
  /** Above the dialog host's 50 (whispersync's layers sit at 70-80). */
  export let zIndex: number | undefined = undefined;
  export let describedby: string | undefined = undefined;
  /** Extra classes for the panel (e.g. a min-height so tabs don't make it jump). */
  export let panelClass = '';
  /** A selector inside the modal to focus when it opens; otherwise the modal itself. */
  export let initialFocus = '';
  /**
   * 'side': a side panel along the right edge, full height (the book edit form, the history and
   * the series editor when the device's setting says so); a sheet from the bottom on phones
   * like every modal. Everything else (Esc, ✕, outside click, unsaved changes) is the same.
   */
  export let placement: 'center' | 'side' = 'center';

  const dispatch = createEventDispatcher<{ close: DismissReason | 'discard' }>();
  const id = `modal-${Math.random().toString(36).slice(2, 10)}`;

  let panel: HTMLElement;
  let backdrop: HTMLElement;
  let keepEditingButton: HTMLButtonElement;
  let downTarget: EventTarget | null = null;
  let askingDiscard = false;
  let returnFocusTo: Element | null = null;

  const layer = pushLayer((reason) => request(reason));

  /** Esc, ✕ or an outside click (also callable by the dialog). */
  export function request(reason: DismissReason) {
    const decision = decideDismiss({ dirty, askingDiscard }, reason);
    if (decision === 'close') {
      dispatch('close', reason);
    } else if (decision === 'keep-editing') {
      askingDiscard = false;
    } else if (!askingDiscard) {
      askingDiscard = true;
      tick().then(() => keepEditingButton?.focus());
    }
  }

  function discard() {
    askingDiscard = false;
    dispatch('close', 'discard');
  }

  $: if (!dirty) askingDiscard = false;

  onMount(() => {
    returnFocusTo = document.activeElement;
    // The dialog may already have focused its own field in its onMount.
    if (panel && !panel.contains(document.activeElement)) {
      const target = initialFocus ? panel.querySelector<HTMLElement>(initialFocus) : null;
      (target ?? panel).focus({ preventScroll: true });
    }
  });

  onDestroy(() => {
    layer.remove();
    if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
      returnFocusTo.focus({ preventScroll: true });
    }
  });

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key !== 'Tab' || !panel || !layer.isTop()) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    const next = nextFocusIndex(
      focusable.indexOf(document.activeElement as HTMLElement),
      focusable.length,
      ev.shiftKey
    );
    if (next >= 0) {
      ev.preventDefault();
      focusable[next].focus();
    }
  }

  const swipe = {
    enabled: () => layer.isTop(),
    canClose: () => decideDismiss({ dirty, askingDiscard }, 'swipe') === 'close',
    close: () => dispatch('close', 'swipe'),
    refused: () => request('swipe')
  };

  function onBackdropClick(ev: MouseEvent) {
    if (isBackdropClick(downTarget, ev.target, backdrop) && layer.isTop()) request('outside');
  }
</script>

<div
  class="c-modal-layer"
  class:c-modal-layer-side={placement === 'side'}
  class:c-modal-surface-inherit={surface === 'inherit'}
  style:z-index={zIndex}
  on:pointerdown|capture={(ev) => (downTarget = ev.target)}
  on:wheel|passive|stopPropagation
>
  <!-- The backdrop: a click outside closes (keyboard users have Esc and ✕). -->
  <div
    bind:this={backdrop}
    class="c-modal-backdrop"
    role="presentation"
    data-testid={testid ? `${testid}-backdrop` : 'modal-backdrop'}
    on:click={onBackdropClick}
    on:wheel|preventDefault|nonpassive={() => {}}
    on:touchmove|preventDefault|nonpassive={() => {}}
  />
  <section
    bind:this={panel}
    class="c-modal c-modal-{size} {panelClass}"
    class:c-modal-side={placement === 'side'}
    {role}
    aria-modal="true"
    aria-labelledby="{id}-title"
    aria-describedby={describedby}
    tabindex="-1"
    data-testid={testid}
    on:keydown={onKeydown}
    use:sheetSwipe={{ ...swipe, backdrop }}
  >
    <header class="c-modal-head">
      <div class="c-modal-titles">
        <h2 id="{id}-title" class="c-modal-title">{title}<slot name="title" /></h2>
        {#if subtitle || $$slots.subtitle}
          <p class="c-modal-sub"><slot name="subtitle">{subtitle}</slot></p>
        {/if}
      </div>
      {#if role !== 'alertdialog'}
        <button
          type="button"
          class="c-modal-x"
          aria-label="Close"
          title="Close (Esc)"
          data-testid={closeTestid ?? (testid ? `${testid}-x` : 'modal-x')}
          on:click={() => request('close-button')}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      {/if}
    </header>
    <slot name="tabs" />
    <div class="c-modal-body" class:c-modal-body-last={!askingDiscard && !$$slots.footer}>
      <slot />
    </div>
    {#if askingDiscard}
      <footer class="c-modal-foot c-modal-foot-discard" role="alert">
        <p class="c-modal-status">Discard your changes?</p>
        <div class="c-modal-btns">
          <button
            bind:this={keepEditingButton}
            type="button"
            class="c-btn c-btn-secondary"
            data-testid="modal-keep-editing"
            on:click={() => (askingDiscard = false)}
          >
            Keep editing
          </button>
          <button
            type="button"
            class="c-btn c-btn-danger"
            data-testid="modal-discard"
            on:click={discard}
          >
            Discard
          </button>
        </div>
      </footer>
    {:else if $$slots.footer}
      <footer class="c-modal-foot">
        <div class="c-modal-status"><slot name="status" /></div>
        <div class="c-modal-btns"><slot name="footer" /></div>
      </footer>
    {/if}
  </section>
</div>
