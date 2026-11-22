<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Stats page's Books (2026-11-22 redesign): the books read in the period with their
   * cover, time, characters (with a bar for each book's share), speed and lookups. Columns
   * sort by a click on their heading; a search box and pages of 10 appear once there are
   * more than 10 books. Tapping a title shows only that book (the page's Book filter).
   * Speed and lookups fold away on a phone.
   */
  import { createEventDispatcher } from 'svelte';
  import ListPager from '$lib/components/list-pager.svelte';
  import { compareText, pageOf, rangeText, type ListSort } from '$lib/settings/paged-list';
  import { formatDuration, formatNumber } from '$lib/stats/stats-format';
  import type { StatsBookInfo, StatsBookRow } from '$lib/stats/stats-view';

  export let rows: StatsBookRow[];
  export let books: Map<string, StatsBookInfo>;

  const PAGE_SIZE = 10;
  const dispatch = createEventDispatcher<{ pick: string }>();

  type Key = 'title' | 'seconds' | 'chars' | 'speed' | 'lookups';
  const COLUMNS: { key: Key; label: string; wide?: boolean }[] = [
    { key: 'title', label: 'Book' },
    { key: 'seconds', label: 'Time' },
    { key: 'chars', label: 'Characters' },
    { key: 'speed', label: 'Speed', wide: true },
    { key: 'lookups', label: 'Lookups', wide: true }
  ];

  let sortKey: Key = 'seconds';
  let descending = true;
  let query = '';
  let page = 1;
  let failed = new Set<string>();

  $: sort = {
    id: sortKey,
    label: sortKey,
    compare: (a, b) => {
      const order = sortKey === 'title' ? compareText(a.title, b.title) : a[sortKey] - b[sortKey];
      return (descending ? -order : order) || compareText(a.title, b.title);
    }
  } as ListSort<StatsBookRow>;
  $: result = pageOf(rows, { query, text: (r) => r.title, sort, page, pageSize: PAGE_SIZE });
  $: maxChars = Math.max(1, ...rows.map((r) => r.chars));
  $: showSearch = rows.length > PAGE_SIZE || !!query;

  function sortBy(key: Key) {
    if (sortKey === key) descending = !descending;
    else {
      sortKey = key;
      descending = key !== 'title';
    }
    page = 1;
  }

  // Passing `failed` keeps the cell redrawn when a cover fails (then the placeholder shows).
  function thumbnail(bookId: string, gone: Set<string>): string | null {
    return gone.has(bookId) ? null : (books.get(bookId)?.thumbnail ?? null);
  }

  function coverFailed(bookId: string) {
    failed = new Set([...failed, bookId]);
  }
</script>

<div class="c-stats-card" data-testid="stats-books-card">
  {#if showSearch}
    <div class="flex flex-wrap items-center gap-2 border-b border-c-line px-4 py-3 sm:px-5">
      <label class="c-input flex min-h-[2.75rem] min-w-0 flex-1 basis-56 items-center gap-2">
        <span class="sr-only">Search books</span>
        <input
          class="w-full min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0"
          type="search"
          placeholder="Search books"
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          on:input={() => (page = 1)}
          data-testid="stats-books-search"
        />
      </label>
      {#if result.matched}
        <span class="text-sm tabular-nums text-c-muted">{rangeText(result)}</span>
      {/if}
    </div>
  {/if}
  <div class="overflow-x-auto">
    <table class="c-books w-full text-sm">
      <thead>
        <tr>
          {#each COLUMNS as col (col.key)}
            <th
              class:c-wide={col.wide}
              aria-sort={sortKey === col.key ? (descending ? 'descending' : 'ascending') : 'none'}
            >
              <button
                type="button"
                class="c-sort"
                data-testid="stats-books-sort-{col.key}"
                on:click={() => sortBy(col.key)}
              >
                {col.label}<span aria-hidden="true" class="c-sort-mark"
                  >{sortKey === col.key ? (descending ? '↓' : '↑') : ''}</span
                >
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each result.rows as row (row.bookId)}
          <tr data-testid="stats-book-row">
            <td>
              <div class="flex items-center gap-3">
                {#if thumbnail(row.bookId, failed)}
                  <img
                    class="c-thumb"
                    src={thumbnail(row.bookId, failed)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    on:error={() => coverFailed(row.bookId)}
                  />
                {:else}
                  <span class="c-thumb c-thumb-empty" aria-hidden="true" />
                {/if}
                <div class="min-w-0">
                  <button
                    type="button"
                    class="c-link c-title text-left font-semibold"
                    title="Show only this book"
                    on:click={() => dispatch('pick', row.bookId)}
                  >
                    {row.title}
                  </button>
                  {#if row.missing || row.completed}
                    <div class="flex flex-wrap gap-1 pt-1">
                      {#if row.completed}
                        <span class="c-tag" data-testid="stats-book-completed">
                          {row.manual ? 'Marked completed' : 'Completed'}
                        </span>
                      {/if}
                      {#if row.missing}
                        <span class="c-tag">No longer in the library</span>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            </td>
            <td class="c-num">{formatDuration(row.seconds)}</td>
            <td class="c-num">
              <span class="inline-flex items-center justify-end gap-2">
                {formatNumber(row.chars)}
                <span
                  class="c-share hidden sm:inline-block"
                  style:width="{Math.round((row.chars / maxChars) * 48)}px"
                  aria-hidden="true"
                />
              </span>
            </td>
            <td class="c-num c-wide">{row.speed ? formatNumber(row.speed) : '–'}</td>
            <td class="c-num c-wide">{formatNumber(row.lookups)}</td>
          </tr>
        {:else}
          <tr>
            <td colspan="5" class="py-6 text-center text-sm text-c-muted">
              Nothing matches “{query.trim()}”.
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if result.pages > 1}
    <ListPager
      page={result.page}
      pages={result.pages}
      label="Books"
      testid="stats-books"
      on:go={(e) => (page = e.detail)}
    />
  {/if}
</div>

<style>
  .c-books th {
    padding: 0.625rem 0.75rem;
    text-align: right;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--c-muted);
    white-space: nowrap;
  }

  .c-books th:first-child,
  .c-books td:first-child {
    text-align: left;
    padding-left: 1rem;
  }

  .c-books th:last-child,
  .c-books td:last-child {
    padding-right: 1rem;
  }

  @media (min-width: 640px) {
    .c-books th:first-child,
    .c-books td:first-child {
      padding-left: 1.25rem;
    }

    .c-books th:last-child,
    .c-books td:last-child {
      padding-right: 1.25rem;
    }
  }

  .c-books td {
    padding: 0.625rem 0.75rem;
    border-top: 1px solid var(--c-line);
    vertical-align: middle;
  }

  .c-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Speed and lookups only from 640 px: a phone keeps title, time and characters. */
  .c-wide {
    display: none;
  }

  @media (min-width: 640px) {
    .c-wide {
      display: table-cell;
    }
  }

  .c-sort {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 2.25rem;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
  }

  [aria-sort='ascending'] .c-sort,
  [aria-sort='descending'] .c-sort {
    color: var(--c-ink);
  }

  .c-sort:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }

  .c-sort-mark {
    display: inline-block;
    min-width: 0.75em;
  }

  .c-thumb {
    flex: none;
    width: 2rem;
    height: 2.875rem;
    object-fit: cover;
    border-radius: 0.1875rem;
    border: 1px solid var(--c-line);
  }

  .c-thumb-empty {
    display: block;
    background: linear-gradient(160deg, var(--c-tint), var(--c-line));
  }

  .c-title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    min-height: 1.5rem;
  }

  .c-tag {
    display: inline-flex;
    padding: 0.0625rem 0.5rem;
    border-radius: 999px;
    border: var(--c-border-width) solid var(--c-line-strong);
    color: var(--c-muted);
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .c-share {
    height: 0.375rem;
    min-width: 2px;
    border-radius: 999px;
    background-color: var(--c-fill);
    opacity: 0.85;
  }

  :global(html.eink) .c-share {
    opacity: 1;
  }
</style>
