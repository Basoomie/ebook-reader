<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A button with a panel under it (WP19a: Sort and Display; WP19b: a book's ⋮). The
   * panel closes on a tap or click outside it, on Esc (focus goes back to the button), and
   * when the content calls `close`. E-ink plain: no transitions; 48 px controls inside.
   *
   * `floating` (book menus inside scrolling rows) places the panel with fixed positioning
   * at the button, so a scroll container can't clip it: above the button when there is no
   * room below, and closed when the page scrolls.
   */
  import { tick } from 'svelte';

  /** Classes of the button. */
  export let buttonClass = '';
  /** Which edge of the button the panel lines up with. */
  export let align: 'left' | 'right' = 'left';
  export let testid = '';
  /** Accessible name of the panel. */
  export let label = '';
  /** Width class of the panel. */
  export let panelWidth = 'w-72';
  /** True while the panel is open (read-only, for the parent's styling). */
  export let open = false;
  /** Fixed positioning at the button (see above). */
  export let floating = false;

  let root: HTMLElement;
  let button: HTMLButtonElement;
  let panel: HTMLElement | undefined;
  /** The edge actually used: `align`, unless that would push the panel off screen. */
  let side: 'left' | 'right' = align;
  /** Floating: the panel's fixed position. */
  let floatStyle = '';
  /** Sideways shift (px) that keeps an anchored panel on screen. */
  let shift = 0;

  function close() {
    open = false;
  }

  async function toggle() {
    open = !open;
    if (!open) return;
    side = align;
    if (floating) {
      place();
      await tick();
      place();
      return;
    }
    shift = 0;
    await tick();
    // A button that wrapped to the other end of its row: line up with the other edge.
    let rect = panel?.getBoundingClientRect();
    if (!rect) return;
    if (rect.left < 8) side = 'left';
    else if (rect.right > window.innerWidth - 8) side = 'right';
    await tick();
    // Still off screen (a wide panel under a button mid-row on a phone): slide it in.
    rect = panel?.getBoundingClientRect();
    if (!rect) return;
    if (rect.right > window.innerWidth - 8) shift = window.innerWidth - 8 - rect.right;
    if (rect.left + shift < 8) shift = 8 - rect.left;
  }

  /** Floating: under (or above) the button, kept 8 px inside the window. */
  function place() {
    const b = button.getBoundingClientRect();
    const width = panel?.offsetWidth ?? 0;
    const height = panel?.offsetHeight ?? 0;
    let left = align === 'right' ? b.right - width : b.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = b.bottom + 4;
    if (height && top + height > window.innerHeight - 8 && b.top - height - 4 >= 8) {
      top = b.top - height - 4;
    }
    floatStyle = `position: fixed; left: ${left}px; top: ${top}px;`;
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

  function onScroll(ev: Event) {
    // A floating panel would drift away from its button: close it (not for scrolling
    // inside the panel itself).
    if (open && floating && !(panel && ev.target instanceof Node && panel.contains(ev.target))) {
      open = false;
    }
  }
</script>

<svelte:window
  on:pointerdown={onWindowPointerDown}
  on:keydown={onWindowKeydown}
  on:resize={() => floating && (open = false)}
/>
<svelte:document on:scroll|capture={onScroll} />

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
      class="c-panel z-30 max-w-[calc(100vw-2rem)] rounded p-2 {panelWidth} {floating
        ? ''
        : `absolute top-full mt-1 ${side === 'right' ? 'right-0' : 'left-0'}`}"
      style={floating
        ? floatStyle || 'position: fixed; visibility: hidden;'
        : shift
          ? `transform: translateX(${shift}px)`
          : undefined}
      role="dialog"
      aria-label={label || undefined}
      data-testid={testid ? `${testid}-panel` : undefined}
    >
      <slot {close} />
    </div>
  {/if}
</div>
