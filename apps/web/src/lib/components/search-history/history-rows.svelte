<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Search history (2026-11-24): the rows of a remembered-search list, for the library's
   * drop-down and the "Search in this book" dialog. The text field keeps focus (the rows are
   * driven by its keys through aria-activedescendant), so rows never take focus themselves.
   * A row searches again; ✕ removes it; the library's ↖ puts it in the box to edit first.
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import { faClockRotateLeft, faXmark } from '@fortawesome/free-solid-svg-icons';
  import type { HistoryEntry } from '$lib/search-history/search-history';

  export let entries: HistoryEntry[];
  /** Ids are `${idPrefix}-${index}`, the index counting from `startIndex`. */
  export let idPrefix: string;
  export let startIndex = 0;
  /** The highlighted row's index (-1: none). */
  export let active = -1;
  /** Show the ↖ "put in the box" button (library). */
  export let showEdit = false;
  /** Show the book's title under the search (other books). */
  export let showTitle = false;

  const dispatch = createEventDispatcher<{
    pick: HistoryEntry;
    edit: HistoryEntry;
    remove: HistoryEntry;
    hover: number;
  }>();
</script>

{#each entries as entry, i (entry.id)}
  <li class="sh-row" class:sh-active={startIndex + i === active} role="presentation">
    <button
      type="button"
      tabindex="-1"
      id="{idPrefix}-{startIndex + i}"
      class="sh-pick"
      role="option"
      aria-selected={startIndex + i === active}
      data-testid="search-history-row"
      on:mousedown|preventDefault
      on:mousemove={() => {
        if (startIndex + i !== active) dispatch('hover', startIndex + i);
      }}
      on:click={() => dispatch('pick', entry)}
    >
      <span class="sh-icon" aria-hidden="true"><Fa icon={faClockRotateLeft} /></span>
      <span class="min-w-0 flex-1">
        <span class="sh-query block">{entry.query}</span>
        {#if showTitle && entry.title}
          <span class="sh-title block">{entry.title}</span>
        {/if}
      </span>
    </button>
    {#if showEdit}
      <button
        type="button"
        tabindex="-1"
        class="c-btn c-btn-ghost c-btn-icon"
        title="Put in the search box"
        aria-label="Put “{entry.query}” in the search box"
        data-testid="search-history-edit"
        on:mousedown|preventDefault
        on:click={() => dispatch('edit', entry)}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"><path d="M17 17 7 7M7 15V7h8" /></svg
        >
      </button>
    {/if}
    <button
      type="button"
      tabindex="-1"
      class="c-btn c-btn-ghost c-btn-icon"
      title="Remove from history"
      aria-label="Remove “{entry.query}” from history"
      data-testid="search-history-remove"
      on:mousedown|preventDefault
      on:click={() => dispatch('remove', entry)}
    >
      <Fa icon={faXmark} />
    </button>
  </li>
{/each}

<style>
  .sh-row {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    border-radius: 0.625rem;
  }

  .sh-row.sh-active,
  .sh-row:hover {
    background-color: var(--c-tint);
  }

  :global(html.eink) .sh-row.sh-active {
    outline: 2px solid #000;
    outline-offset: -2px;
  }

  :global(html.eink) .sh-row:hover:not(.sh-active) {
    background-color: transparent;
  }

  .sh-pick {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
    min-height: var(--c-btn-h);
    padding: 0.375rem 0.75rem;
    text-align: left;
    color: var(--c-ink);
  }

  .sh-icon {
    flex: none;
    color: var(--c-muted);
  }

  .sh-query {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sh-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--c-muted);
  }
</style>
