<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Under a 読みたい本 collection (Bookmeter sync, 2026-11-25): the wanted books the library
   * doesn't have, folded by default, newest wanted first, each linked to its 読書メーター page and
   * a store search.
   */
  import { onMount } from 'svelte';
  import { bookmeterApi } from '$lib/sync/sync-service';
  import { bookmeterBookUrl } from '$lib/bookmeter/bookmeter-words';

  const api = bookmeterApi();
  const view = api.view;
  let open = false;

  onMount(() => void api.reload());

  $: missing = $view.entries
    .filter((e) => e.list === 'wish' && e.wish && e.books.length === 0)
    .sort((a, b) => b.rank - a.rank);

  function amazonSearch(title: string, authors: string[]): string {
    const q = [title.replace(/\s*[(（][^)）]*[)）]\s*$/u, ''), authors[0] ?? ''].join(' ').trim();
    return `https://www.amazon.co.jp/s?k=${encodeURIComponent(q)}&i=digital-text`;
  }
</script>

{#if missing.length}
  <div class="pt-2" data-testid="bookmeter-wanted-missing">
    <button
      type="button"
      class="c-btn c-btn-ghost c-btn-sm"
      aria-expanded={open}
      on:click={() => (open = !open)}
    >
      {open ? '▾' : '▸'}
      {missing.length}
      {missing.length === 1 ? 'wanted book isn’t' : 'wanted books aren’t'} in your library
    </button>
    {#if open}
      <ul
        class="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="bookmeter-wanted-missing-list"
      >
        {#each missing as e (e.id)}
          <li class="flex gap-3">
            {#if e.cover}
              <img
                src={e.cover}
                alt=""
                class="h-20 w-14 shrink-0 rounded object-cover"
                loading="lazy"
              />
            {/if}
            <div class="min-w-0">
              <p class="line-clamp-2 text-sm font-medium">{e.title}</p>
              <p class="truncate text-sm text-c-muted">{e.authors.join(', ')}</p>
              <p class="mt-1 flex gap-3 text-sm">
                <a
                  class="c-link"
                  href={bookmeterBookUrl(e.listing, e.title)}
                  target="_blank"
                  rel="noopener noreferrer">読書メーター</a
                >
                <a
                  class="c-link"
                  href={amazonSearch(e.title, e.authors)}
                  target="_blank"
                  rel="noopener noreferrer">Amazon</a
                >
              </p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
