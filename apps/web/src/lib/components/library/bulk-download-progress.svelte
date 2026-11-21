<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Select mode's downloads: how far the server is with a ZIP, or which file of several is
   * being saved, with a bar, the time left from the pace so far, and Cancel. No animation
   * (e-ink); the modal frame's look, as the upload progress.
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

<!-- The modal frame's look (modal.svelte) without its closing rules, like the upload
     progress: a stray tap outside never cancels a download. -->
<div class="c-modal-layer">
  <div class="c-modal-backdrop" />
  <section
    class="c-modal c-modal-sm"
    role="dialog"
    aria-modal="true"
    aria-label="Downloading"
    data-testid="bulk-download-progress"
  >
    <header class="c-modal-head">
      <div class="c-modal-titles">
        <h2 class="c-modal-title" data-testid="bulk-download-heading">{heading}</h2>
        {#if detail}
          <p class="c-modal-sub line-clamp-2 break-all">{detail}</p>
        {/if}
      </div>
    </header>
    <div class="c-modal-body" aria-live="polite">
      <div
        class="c-mbar"
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.percent}
        data-testid="bulk-download-bar"
      >
        <div style="width: {view.percent}%" />
      </div>
      <div class="mt-2 flex justify-between gap-3 text-sm text-c-muted">
        <span data-testid="bulk-download-count">{countText}</span>
        <span data-testid="bulk-download-time-left">{view.timeLeft}</span>
      </div>
    </div>
    <footer class="c-modal-foot">
      <div class="c-modal-btns">
        <button
          type="button"
          class="c-btn c-btn-secondary"
          data-testid="bulk-download-cancel"
          on:click={() => dispatch('cancel')}
        >
          Cancel
        </button>
      </div>
    </footer>
  </section>
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
