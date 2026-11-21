<script lang="ts" generics="T">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A list shown a page at a time (decided with the user, 2026-11-20: no list grows the page
   * without bound). The slot gets `pageItems` and draws the list itself; "‹ 1–5 of 23 ›"
   * shows under it only when there is more than one page. The page goes back to the first
   * when `resetKey` changes (a new search); otherwise a list that changes (an edit, a
   * refresh) stays on its page, clamped when it shrank.
   */
  import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { pageOf, pageRangeText } from '$lib/functions/paginate';

  export let items: T[];
  export let size: number;
  export let resetKey: unknown = undefined;
  export let label = 'List';
  export let testid = 'paged-list';

  let page = 0;
  let lastKey = resetKey;

  $: if (resetKey !== lastKey) {
    lastKey = resetKey;
    page = 0;
  }
  $: view = pageOf(items, page, size);
  $: pageItems = view.items;

  /** Shows the page that holds `index` (e.g. the item in use). */
  export function showIndex(index: number) {
    if (index >= 0) page = Math.floor(index / Math.max(1, size));
  }
</script>

<slot {pageItems} />
{#if view.pages > 1}
  <nav
    class="mt-1 flex items-center gap-2 text-sm text-c-muted"
    aria-label="{label}: pages"
    data-testid={testid}
  >
    <button
      class="c-btn c-btn-secondary h-11 w-11 shrink-0 p-0"
      title="Previous page"
      aria-label="Previous page"
      disabled={view.page === 0}
      data-testid="paged-list-prev"
      on:click={() => (page = view.page - 1)}
    >
      <Fa icon={faChevronLeft} />
    </button>
    <span aria-live="polite" data-testid="paged-list-range">{pageRangeText(view)}</span>
    <button
      class="c-btn c-btn-secondary h-11 w-11 shrink-0 p-0"
      title="Next page"
      aria-label="Next page"
      disabled={view.page >= view.pages - 1}
      data-testid="paged-list-next"
      on:click={() => (page = view.page + 1)}
    >
      <Fa icon={faChevronRight} />
    </button>
  </nav>
{/if}
