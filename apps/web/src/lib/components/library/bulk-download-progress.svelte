<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Select mode's downloads: how far the server is with a ZIP, or which file of several is
   * being saved, with a bar, the time left from the pace so far, and Cancel. No animation
   * (e-ink); the look of the upload progress.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { progressView } from '$lib/library/bulk-download';

  /** The first line ("Preparing the ZIP of 120 books"). */
  export let heading: string;
  /** The second line (a file's name), or ''. */
  export let detail = '';
  /** What the bar counts (files looked up, files saved, bytes). */
  export let done: number;
  export let total: number;
  /** "84 of 120 files". */
  export let countText = '';
  export let startedAt: number;

  const dispatch = createEventDispatcher<{ cancel: void }>();

  // The time left follows the clock too (a slow file keeps the bar still).
  let now = Date.now();
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));

  $: view = progressView(done, total, startedAt, now);
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog">
  <div
    class="c-panel mx-4 w-full max-w-md rounded p-6"
    aria-live="polite"
    data-testid="bulk-download-progress"
  >
    <div class="mb-1 font-medium" data-testid="bulk-download-heading">{heading}</div>
    {#if detail}
      <div class="mb-1 line-clamp-2 break-all text-sm">{detail}</div>
    {/if}
    <div
      class="c-mbar mt-2"
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={view.percent}
      data-testid="bulk-download-bar"
    >
      <div style="width: {view.percent}%" />
    </div>
    <div class="mb-6 mt-2 flex justify-between gap-3 text-sm text-c-muted">
      <span data-testid="bulk-download-count">{countText}</span>
      <span data-testid="bulk-download-time-left">{view.timeLeft}</span>
    </div>
    <div class="flex justify-end">
      <button
        class="flex min-h-[3rem] items-center rounded border-2 border-current px-5 font-medium"
        data-testid="bulk-download-cancel"
        on:click={() => dispatch('cancel')}
      >
        Cancel
      </button>
    </div>
  </div>
</div>

<style>
  /* The bar of the audiobook panels (audio-device-panel.svelte), without the transition. */
  .c-mbar {
    height: 0.75rem;
    border: var(--c-border-width) solid currentColor;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .c-mbar > div {
    height: 100%;
    background-color: currentColor;
  }
</style>
