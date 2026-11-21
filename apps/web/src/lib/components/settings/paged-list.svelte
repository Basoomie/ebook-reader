<script lang="ts" generics="T">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A list on the Settings page that can grow (linked audiobooks, devices, sent messages,
   * fixes, …): search, filters with counts, a sort, "21–40 of 4,812" and pages, so the
   * page never grows with the list. The rows are the caller's own markup (the slot gets
   * `rows`); the tools show only when they help (search and pages once there is more than
   * one page). No scroll box inside the page: that is awkward on phones and e-readers.
   */
  import { tick } from 'svelte';
  import { pageOf, rangeText, type ListFilter, type ListSort } from '$lib/settings/paged-list';

  type Item = T;

  export let items: readonly Item[] = [];
  export let pageSize = 10;
  /** The searchable words of an item; no search box without it. */
  export let text: ((item: Item) => string) | undefined = undefined;
  export let searchLabel = 'Search';
  export let sorts: ListSort<Item>[] = [];
  export let filters: ListFilter<Item>[] = [];
  /** The filter shown (bindable). */
  export let filter = '';
  /** Draw the slot even when there are no rows (it has its own empty text or form). */
  export let slotWhenEmpty = false;
  export let label = 'List';
  export let testid = '';

  let query = '';
  let sortId = sorts[0]?.id ?? '';
  let page = 1;
  let root: HTMLDivElement;

  $: if (!filter && filters.length) filter = filters[0].id;
  $: activeFilter = filters.find((f) => f.id === filter) ?? null;
  $: activeSort = sorts.find((s) => s.id === sortId) ?? null;
  $: result = pageOf(items, {
    query,
    text,
    filter: activeFilter,
    sort: activeSort,
    page,
    pageSize
  });
  $: filterCounts = filters.map((f) => items.filter(f.test).length);
  $: narrowed = !!query.trim() || (!!filters.length && filter !== filters[0].id);
  $: showSearch = !!text && (items.length > pageSize || !!query);
  $: showSort = sorts.length > 1 && items.length > 1;
  $: showTools = showSearch || showSort || filters.length > 0;
  $: showCount = result.matched > 0 && (result.pages > 1 || narrowed);

  function restart() {
    page = 1;
  }

  async function goTo(next: number) {
    page = Math.min(Math.max(1, next), result.pages);
    await tick();
    // Keep the list's top in view after a page change from the pager under it.
    const top = root?.getBoundingClientRect().top ?? 0;
    if (top < 64) root.scrollIntoView({ block: 'start' });
  }
</script>

<div class="s-list" bind:this={root} data-testid={testid || undefined}>
  {#if showTools}
    <div class="s-list-tools">
      {#if showSearch}
        <label class="s-list-search">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            ><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" stroke-linecap="round" /></svg
          >
          <input
            type="search"
            placeholder={searchLabel}
            aria-label={searchLabel}
            autocomplete="off"
            spellcheck="false"
            bind:value={query}
            on:input={restart}
            data-testid={testid ? `${testid}-search` : undefined}
          />
        </label>
      {/if}
      {#if showSort}
        <label class="s-list-sort">
          <span>Sort</span>
          <select
            bind:value={sortId}
            on:change={restart}
            data-testid={testid ? `${testid}-sort` : undefined}
          >
            {#each sorts as sort (sort.id)}
              <option value={sort.id}>{sort.label}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if filters.length}
        <div class="s-list-filters" role="group" aria-label="Show">
          {#each filters as f, i (f.id)}
            <button
              type="button"
              class="s-chip"
              aria-pressed={filter === f.id}
              data-testid={f.testid}
              on:click={() => {
                filter = f.id;
                restart();
              }}
            >
              {f.label}
              <span class="s-chip-count">{filterCounts[i].toLocaleString('en-US')}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if showCount}
    <p class="s-list-count" aria-live="polite">
      {rangeText(result)}
      {#if narrowed}
        <span class="text-c-muted">{`· ${items.length.toLocaleString('en-US')} in all`}</span>
      {/if}
    </p>
  {/if}

  {#if result.matched || slotWhenEmpty}
    <slot rows={result.rows} start={result.start} query={query.trim()} />
  {/if}
  {#if !result.matched && items.length && !slotWhenEmpty}
    <p class="s-list-empty">
      {query.trim() ? `Nothing matches “${query.trim()}”.` : `No ${label.toLowerCase()} here.`}
    </p>
  {/if}

  {#if result.pages > 1}
    <nav class="s-list-pager" aria-label="{label}: pages">
      <button
        type="button"
        class="c-btn c-btn-secondary min-h-[2.75rem] px-3"
        disabled={result.page <= 1}
        on:click={() => goTo(result.page - 1)}
        data-testid={testid ? `${testid}-previous` : undefined}
      >
        ‹ Previous
      </button>
      <span class="flex items-center gap-2 text-sm text-c-muted">
        Page
        <input
          class="s-page-input"
          type="number"
          min="1"
          max={result.pages}
          value={result.page}
          aria-label="Page"
          on:change={(e) => goTo(Number(e.currentTarget.value) || 1)}
        />
        of {result.pages.toLocaleString('en-US')}
      </span>
      <button
        type="button"
        class="c-btn c-btn-secondary min-h-[2.75rem] px-3"
        disabled={result.page >= result.pages}
        on:click={() => goTo(result.page + 1)}
        data-testid={testid ? `${testid}-next` : undefined}
      >
        Next ›
      </button>
    </nav>
  {/if}
</div>

<style>
  .s-list {
    scroll-margin-top: 9.5rem;
  }

  @media (min-width: 1024px) {
    .s-list {
      scroll-margin-top: 4.5rem;
    }
  }

  .s-list-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.625rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--c-line);
  }

  @media (min-width: 640px) {
    .s-list-tools {
      padding: 0.75rem 1.25rem;
    }
  }

  .s-list-search {
    flex: 1 1 14rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0 0.625rem;
    background-color: var(--c-bg);
    border: var(--c-border-width) solid var(--c-line-strong);
    border-radius: 0.375rem;
  }

  :global(html.eink) .s-list-search {
    background-color: #fff;
  }

  .s-list-search:focus-within {
    outline: 2px solid var(--c-link);
  }

  .s-list-search svg {
    flex: none;
    width: 1rem;
    height: 1rem;
    color: var(--c-muted);
  }

  .s-list-search input {
    flex: 1;
    min-width: 0;
    min-height: 2.625rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--c-ink);
    outline: none;
    box-shadow: none;
  }

  .s-list-search input::placeholder {
    color: var(--c-muted);
  }

  .s-list-sort {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--c-muted);
  }

  .s-list-sort select {
    min-height: 2.75rem;
    padding: 0 2rem 0 0.625rem;
    border: var(--c-border-width) solid var(--c-line-strong);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    color: var(--c-ink);
    font-size: 0.875rem;
  }

  .s-list-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    flex-basis: 100%;
  }

  .s-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 2.75rem;
    padding: 0 0.875rem;
    border-radius: 999px;
    border: var(--c-border-width) solid var(--c-line-strong);
    background-color: var(--c-raised);
    color: var(--c-ink);
    font-size: 0.8125rem;
  }

  .s-chip[aria-pressed='true'] {
    background-color: var(--c-sel-bg);
    border-color: var(--c-sel-bg);
    color: var(--c-sel-ink);
  }

  .s-chip:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }

  .s-chip-count {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }

  .s-list-count {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    color: var(--c-ink);
    font-variant-numeric: tabular-nums;
    border-bottom: 1px solid var(--c-line);
  }

  @media (min-width: 640px) {
    .s-list-count {
      padding: 0.5rem 1.25rem;
    }
  }

  .s-list-empty {
    padding: 1.5rem 1rem;
    text-align: center;
    color: var(--c-muted);
    font-size: 0.875rem;
  }

  .s-list-pager {
    display: flex;
    flex-wrap: wrap;
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
