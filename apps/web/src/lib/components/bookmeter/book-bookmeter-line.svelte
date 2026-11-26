<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book page's 読書メーター line (Bookmeter sync, 2026-11-25): which of your lists the book is
   * on ("読んだ本 · 2026/10/17", linked to its page there), and "Log on 読書メーター" when you
   * completed it here but it isn't on your 読んだ本. Shown only once an account is set up (there
   * are Bookmeter records on this device).
   */
  import { onMount } from 'svelte';
  import { bookmeterApi } from '$lib/sync/sync-service';
  import { entriesOfBook } from '$lib/bookmeter/plan';
  import { LIST_NAMES, bookmeterBookUrl, slashDate } from '$lib/bookmeter/bookmeter-words';
  import type { BookStatus } from '$lib/sync/book-state';

  export let bookId: string;
  export let title: string;
  export let identifiers: Record<string, string> | undefined;
  export let status: BookStatus | undefined;

  const api = bookmeterApi();
  const view = api.view;

  onMount(() => void api.reload());

  $: setUp = $view.entries.length > 0;
  $: mine = entriesOfBook($view.entries, bookId).sort((a, b) => b.rank - a.rank);
  $: read = mine.find((e) => e.list === 'read');
  $: logListing = mine[0]?.listing ?? identifiers?.bookmeter?.trim() ?? null;
  $: showLog = setUp && status === 'completed' && !read;
</script>

{#if setUp && (mine.length || showLog)}
  <div class="flex flex-wrap items-center gap-2 text-sm" data-testid="details-bookmeter">
    {#each mine as e (e.id)}
      <a
        class="c-chip c-chip-sm"
        href={bookmeterBookUrl(e.listing, title)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="details-bookmeter-list"
      >
        読書メーター · {LIST_NAMES[e.list]}{#if e.date}&nbsp;{slashDate(e.date)}{/if}
      </a>
    {/each}
    {#if showLog}
      <a
        class="c-btn c-btn-secondary c-btn-sm"
        href={bookmeterBookUrl(logListing, title)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="details-bookmeter-log"
      >
        Log on 読書メーター
      </a>
    {/if}
  </div>
{/if}
