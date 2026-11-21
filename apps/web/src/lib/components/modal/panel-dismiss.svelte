<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The outside of a reader side panel (Appearance, Pacer, Read aloud, the audiobook menu):
   * a clear layer just under the panel. A tap or click on it closes the panel and goes no
   * further, so it doesn't also turn the page; Esc closes it too (modal-stack.ts). Wheel and
   * touch scrolling over it are held, so the book doesn't move behind the panel.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { isBackdropClick, pushLayer } from './modal-stack';

  /** Just under the panel's own z-index. */
  export let zIndex = 54;
  export let testid = 'panel-outside';

  const dispatch = createEventDispatcher<{ close: void }>();
  const layer = pushLayer(() => dispatch('close'));

  let el: HTMLElement;
  let downTarget: EventTarget | null = null;

  onDestroy(() => layer.remove());

  function onClick(ev: MouseEvent) {
    ev.stopPropagation();
    if (isBackdropClick(downTarget, ev.target, el) && layer.isTop()) dispatch('close');
  }
</script>

<div
  bind:this={el}
  class="fixed inset-0"
  style:z-index={zIndex}
  role="presentation"
  data-testid={testid}
  on:pointerdown|stopPropagation={(ev) => (downTarget = ev.target)}
  on:click={onClick}
  on:wheel|preventDefault|stopPropagation|nonpassive={() => {}}
  on:touchmove|preventDefault|nonpassive={() => {}}
/>
