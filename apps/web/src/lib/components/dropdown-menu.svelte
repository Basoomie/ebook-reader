<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A button with a panel under it (WP19a: Sort and Display). The panel closes on a tap
   * or click outside it, on Esc (focus goes back to the button), and when the content
   * calls `close`. E-ink plain: no transitions; 48 px controls inside.
   */
  import { tick } from 'svelte';

  /** Classes of the button. */
  export let buttonClass = '';
  /** Which edge of the button the panel lines up with. */
  export let align: 'left' | 'right' = 'left';
  export let testid = '';
  /** Accessible name of the panel. */
  export let label = '';

  let open = false;
  let root: HTMLElement;
  let button: HTMLButtonElement;
  let panel: HTMLElement | undefined;
  /** The edge actually used: `align`, unless that would push the panel off screen. */
  let side: 'left' | 'right' = align;

  function close() {
    open = false;
  }

  async function toggle() {
    open = !open;
    if (!open) return;
    side = align;
    await tick();
    // A button that wrapped to the other end of its row: line up with the other edge.
    const rect = panel?.getBoundingClientRect();
    if (!rect) return;
    if (rect.left < 8) side = 'left';
    else if (rect.right > window.innerWidth - 8) side = 'right';
  }

  function onWindowPointerDown(ev: PointerEvent) {
    if (open && root && !root.contains(ev.target as Node)) open = false;
  }

  function onWindowKeydown(ev: KeyboardEvent) {
    if (open && ev.key === 'Escape') {
      ev.preventDefault();
      open = false;
      button?.focus();
    }
  }
</script>

<svelte:window on:pointerdown={onWindowPointerDown} on:keydown={onWindowKeydown} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    class={buttonClass}
    aria-haspopup="true"
    aria-expanded={open}
    data-testid={testid || undefined}
    bind:this={button}
    on:click={toggle}
  >
    <slot name="button" />
  </button>
  {#if open}
    <div
      bind:this={panel}
      class="absolute top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] border-2 border-gray-800 bg-white p-2 text-gray-900 {side ===
      'right'
        ? 'right-0'
        : 'left-0'}"
      role="dialog"
      aria-label={label || undefined}
      data-testid={testid ? `${testid}-panel` : undefined}
    >
      <slot {close} />
    </div>
  {/if}
</div>
