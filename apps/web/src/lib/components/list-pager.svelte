<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * ‹ Previous · Page [n] of M · Next › under a long list: the Settings lists
   * (settings/paged-list.svelte) and the Notes page. `page` is 1-based; `go` asks for
   * another page (already clamped), the parent changes `page`.
   */
  import { createEventDispatcher } from 'svelte';

  export let page: number;
  export let pages: number;
  export let label = 'List';
  /** Prefix of the test ids (`<testid>-pager`, `-previous`, `-next`, `-input`). */
  export let testid = '';

  const dispatch = createEventDispatcher<{ go: number }>();

  function go(next: number) {
    const clamped = Math.min(Math.max(1, Math.floor(next) || 1), pages);
    if (clamped !== page) dispatch('go', clamped);
  }
</script>

<nav
  class="s-list-pager"
  aria-label="{label}: pages"
  data-testid={testid ? `${testid}-pager` : undefined}
>
  <button
    type="button"
    class="c-btn c-btn-secondary min-h-[2.75rem] min-w-[2.75rem] px-3"
    disabled={page <= 1}
    on:click={() => go(page - 1)}
    aria-label="Previous page"
    data-testid={testid ? `${testid}-previous` : undefined}
  >
    ‹<span class="hidden sm:inline">&nbsp;Previous</span>
  </button>
  <span class="flex shrink-0 items-center gap-2 text-sm text-c-muted">
    Page
    <input
      class="s-page-input"
      type="number"
      min="1"
      max={pages}
      value={page}
      aria-label="Page"
      data-testid={testid ? `${testid}-input` : undefined}
      on:change={(e) => {
        go(Number(e.currentTarget.value));
        e.currentTarget.value = String(page);
      }}
    />
    of {pages.toLocaleString('en-US')}
  </span>
  <button
    type="button"
    class="c-btn c-btn-secondary min-h-[2.75rem] min-w-[2.75rem] px-3"
    disabled={page >= pages}
    on:click={() => go(page + 1)}
    aria-label="Next page"
    data-testid={testid ? `${testid}-next` : undefined}
  >
    <span class="hidden sm:inline">Next&nbsp;</span>›
  </button>
</nav>

<style>
  /* One row on a phone too: the buttons shrink to ‹ and › (min 44 px) below 640 px. */
  .s-list-pager {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    border-top: 1px solid var(--c-line);
  }

  .s-page-input {
    width: 4.25rem;
    min-height: 2.5rem;
    padding: 0 0.25rem;
    text-align: center;
    border: var(--c-border-width) solid var(--c-line-strong);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    color: var(--c-ink);
    font-variant-numeric: tabular-nums;
  }
</style>
