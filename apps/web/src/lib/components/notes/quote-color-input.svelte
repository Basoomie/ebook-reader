<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: one colour of the quote image: the browser's colour picker (works over plain
   * http too), showing the automatic colour until one is picked; "Auto" goes back to it.
   */
  import { createEventDispatcher } from 'svelte';

  export let label: string;
  /** The picked colour (#rrggbb), or null for automatic. */
  export let value: string | null;
  /** The colour "automatic" currently gives (#rrggbb), shown in the picker. */
  export let auto: string;
  export let testid: string;

  const dispatch = createEventDispatcher<{ change: string | null }>();
</script>

<div class="flex min-h-[2.75rem] items-center gap-3">
  <label class="flex flex-1 items-center gap-3">
    <input
      type="color"
      class="c-quote-color h-10 w-12 shrink-0 cursor-pointer rounded"
      value={value ?? auto}
      data-testid={testid}
      on:input={(ev) => dispatch('change', ev.currentTarget.value)}
    />
    <span>{label}</span>
  </label>
  {#if value}
    <button
      type="button"
      class="c-link min-h-[2.75rem] px-2 text-sm"
      data-testid="{testid}-auto"
      on:click={() => dispatch('change', null)}
    >
      Auto
    </button>
  {:else}
    <span class="px-2 text-sm text-c-muted">Auto</span>
  {/if}
</div>

<style>
  .c-quote-color {
    border: var(--c-border-width) solid var(--c-line-strong);
    background-color: transparent;
    padding: 2px;
  }
</style>
