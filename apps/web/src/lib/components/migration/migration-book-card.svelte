<script lang="ts">
  import type { CatalogBook } from '$lib/library/types';
  import type { LegacyBookView } from '$lib/migration/api';
  import { dataText, fingerprintText, reasonText } from '$lib/migration/describe';
  import { createEventDispatcher } from 'svelte';

  /**
   * One old-sync book that couldn't be verified (WP5 "Needs you"): why, what
   * data it carries, the candidates with their fingerprint result, a library
   * search, and "decide later". E-ink friendly: bordered buttons at least
   * 48 px tall, no transitions, search only on Enter or the button.
   */

  export let book: LegacyBookView;
  export let busy = false;
  /** Absolute thumbnail URL for a relative one ('' for none). */
  export let thumb: (relative: string | null) => string;
  /** Catalog search for "Search the library". */
  export let search: (q: string) => Promise<CatalogBook[]>;

  const dispatch = createEventDispatcher<{
    link: { folder: string; bookId: string };
    defer: { folder: string };
  }>();

  const bigButton =
    'min-h-[48px] rounded border-2 border-current px-4 py-2 font-medium disabled:opacity-50';

  let searchOpen = false;
  let query = book.title;
  let results: CatalogBook[] | null = null;
  let searchError = '';
  let searching = false;

  function authors(b: { authors: { name: string }[] } | null) {
    return b ? b.authors.map((a) => a.name).join(', ') : '';
  }

  async function runSearch() {
    if (!query.trim()) return;
    searching = true;
    searchError = '';
    try {
      results = await search(query.trim());
    } catch (error) {
      searchError = (error as Error)?.message ?? String(error);
    } finally {
      searching = false;
    }
  }
</script>

<li class="border-2 border-current p-3">
  <div class="font-medium">{book.title}</div>
  <p class="mt-1 text-sm"><span class="font-medium">Why:</span> {reasonText(book)}</p>
  <p class="text-sm"><span class="font-medium">Your data:</span> {dataText(book.details)}</p>
  {#if book.details.error}
    <p class="text-sm opacity-75">{book.details.error}</p>
  {/if}

  {#if book.candidates.length}
    <ul class="mt-2">
      {#each book.candidates as c (c.bookId)}
        <li class="flex items-center gap-3 border-t border-gray-400/40 py-2">
          <div class="flex h-[72px] w-12 shrink-0 items-center justify-center bg-gray-400/20">
            {#if c.book?.thumbnail}
              <img
                class="h-[72px] w-12 object-cover"
                src={thumb(c.book.thumbnail)}
                alt=""
                width="48"
                height="72"
                loading="lazy"
              />
            {/if}
          </div>
          <div class="min-w-0 grow text-sm">
            <div class="font-medium">{c.book?.title ?? 'Unknown book'}</div>
            {#if c.book}
              <div class="truncate">{authors(c.book)}</div>
            {/if}
            <div class="opacity-75">{fingerprintText(c)}</div>
          </div>
          <button
            class={bigButton}
            disabled={busy}
            on:click={() => dispatch('link', { folder: book.folder, bookId: c.bookId })}
          >
            Link to this
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if searchOpen}
    <form class="mt-3 flex items-end gap-2" on:submit|preventDefault={runSearch}>
      <label class="grow text-sm">
        Search the library
        <input class="mt-1 block w-full border-b-2 bg-transparent" bind:value={query} />
      </label>
      <button class={bigButton} type="submit" disabled={searching}>Search</button>
    </form>
    {#if searchError}
      <p class="text-sm" role="alert">{searchError}</p>
    {/if}
    {#if results}
      {#if !results.length}
        <p class="py-2 text-sm">Nothing found.</p>
      {/if}
      <ul>
        {#each results as r (r.id)}
          <li class="flex items-center gap-3 border-t border-gray-400/40 py-2">
            <div class="min-w-0 grow text-sm">
              <div class="font-medium">{r.title}</div>
              <div class="truncate">{authors(r)}</div>
            </div>
            <button
              class={bigButton}
              disabled={busy}
              on:click={() => dispatch('link', { folder: book.folder, bookId: r.id })}
            >
              Link to this
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <div class="mt-3 flex flex-wrap gap-2">
    {#if !searchOpen}
      <button class={bigButton} on:click={() => (searchOpen = true)}>Search the library…</button>
    {/if}
    {#if book.state !== 'deferred'}
      <button
        class={bigButton}
        disabled={busy}
        on:click={() => dispatch('defer', { folder: book.folder })}
      >
        Not in Calibre yet: decide later
      </button>
    {/if}
  </div>
</li>
