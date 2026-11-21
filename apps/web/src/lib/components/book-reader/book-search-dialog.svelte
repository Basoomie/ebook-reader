<script lang="ts">
  /**
   * WP10c: search in the open book. Searches on Enter or the button, never per keystroke.
   * Choosing a result closes the dialog and jumps there; ✕, Esc or a click outside close it
   * (modal.svelte).
   */
  import { onMount, tick } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import { chapterLabelAt, type SectionLike } from '$lib/sync/position-prompt';
  import type { SearchResult, SearchState } from './book-search';

  export let state: SearchState;
  export let total: number;
  export let sections: SectionLike[] = [];
  export let limit: number;
  export let search: (query: string) => { results: SearchResult[]; more: boolean };
  export let resolver: (answer: { state: SearchState; result: SearchResult | null }) => void;

  const dispatch = createEventDispatcher<{ close: void }>();

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

<Modal title="Search in this book" size="lg" testid="book-search" on:close={() => close(null)}>
  <div class="grid gap-2 pt-4">
    <form class="flex gap-2" on:submit|preventDefault={run}>
      <input
        bind:this={inputEl}
        bind:value={query}
        type="search"
        enterkeyhint="search"
        aria-label="Search in this book"
        class="c-input min-w-0 flex-1"
        data-testid="book-search-input"
      />
      <button class="c-btn c-btn-primary" type="submit" disabled={busy}>Search</button>
    </form>
    <p class="min-h-[1.5rem] text-sm text-c-muted" role="status" data-testid="book-search-status">
      {status}
    </p>
  </div>
  {#if results.length}
    <ul class="pb-1" data-testid="book-search-results">
      {#each results as result (result.displayStart)}
        <li class="c-modal-row">
          <button
            type="button"
            class="c-modal-row-button"
            data-testid="book-search-result"
            on:click={() => close(result)}
          >
            <span class="c-modal-row-meta block">{place(result)}</span>
            <span class="block font-serif">
              {result.before}<b class="underline">{result.match}</b>{result.after}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Modal>
