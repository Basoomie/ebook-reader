<script lang="ts">
  /**
   * WP10c: search in the open book. Plain for e-ink like the WP9 prompt: no transitions,
   * 48 px bordered controls, inert backdrop, Esc closes. Searches on Enter or the button,
   * never per keystroke. Choosing a result closes the dialog and jumps there.
   */
  import { onMount, tick } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { chapterLabelAt, type SectionLike } from '$lib/sync/position-prompt';
  import type { SearchResult, SearchState } from './book-search';

  export let state: SearchState;
  export let total: number;
  export let sections: SectionLike[] = [];
  export let limit: number;
  export let search: (query: string) => { results: SearchResult[]; more: boolean };
  export let resolver: (answer: { state: SearchState; result: SearchResult | null }) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';

  let query = state.query;
  let results = state.results;
  let more = state.more;
  let searched = state.searched;
  let busy = false;
  let error = '';
  let done = false;
  let inputEl: HTMLInputElement;

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  function close(result: SearchResult | null) {
    if (done) return;
    done = true;
    resolver({ state: { query, results, more, searched }, result });
    dispatch('close');
  }

  async function run() {
    if (busy || !query.trim()) return;
    busy = true;
    error = '';
    // Let "Searching…" show before the (synchronous) search of a long book.
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      ({ results, more } = search(query));
      searched = true;
    } catch (e) {
      error = `Search failed: ${(e as Error)?.message ?? e}`;
    } finally {
      busy = false;
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close(null);
    }
  }

  function place(result: SearchResult) {
    const parts: string[] = [];
    const chapter = chapterLabelAt(sections, result.position);
    if (chapter) parts.push(`「${chapter}」`);
    if (total > 0) parts.push(`${((result.position / total) * 100).toFixed(1)}%`);
    return parts.join(' · ');
  }

  $: status = busy
    ? 'Searching…'
    : error ||
      (!searched
        ? ''
        : results.length === 0
          ? 'Not found in this book.'
          : more
            ? `The first ${limit} results.`
            : results.length === 1
              ? '1 result'
              : `${results.length} results`);
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 flex max-h-[85vh] w-[40rem] max-w-full flex-col rounded bg-white p-6"
  data-testid="book-search"
>
  <h2 class="weight-medium mb-3 text-xl">Search in this book</h2>
  <form class="flex gap-2" on:submit|preventDefault={run}>
    <input
      bind:this={inputEl}
      bind:value={query}
      type="search"
      enterkeyhint="search"
      aria-label="Search in this book"
      class="min-h-[3rem] min-w-0 flex-1 rounded border-2 border-current px-3"
      data-testid="book-search-input"
    />
    <button class={buttonClass} type="submit" disabled={busy}>Search</button>
  </form>
  <p class="mt-3 min-h-[1.5rem] text-sm" role="status" data-testid="book-search-status">
    {status}
  </p>
  {#if results.length}
    <ul class="mt-2 min-h-0 overflow-y-auto" data-testid="book-search-results">
      {#each results as result (result.displayStart)}
        <li class="border-t border-gray-400">
          <button
            class="block min-h-[3rem] w-full py-2 text-left"
            data-testid="book-search-result"
            on:click={() => close(result)}
          >
            <span class="block text-sm">{place(result)}</span>
            <span class="block">
              {result.before}<b class="underline">{result.match}</b>{result.after}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => close(null)}>Close</button>
  </footer>
</section>
