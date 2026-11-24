<script lang="ts">
  /**
   * WP10c: search in the open book. Searches on Enter or the button, never per keystroke.
   * Choosing a result closes the dialog and jumps there; ✕, Esc or a click outside close it
   * (modal.svelte).
   *
   * Search history (2026-11-24): before a search, or once the box is changed or emptied, the
   * space under the box lists remembered searches: this book's first, then other books'
   * (newest 5, then "Show all"). A row searches this book at once; ✕ removes it. ↑/↓ move
   * through the rows from the box, Enter searches the highlighted one, Shift+Delete removes it.
   */
  import { onMount, tick } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import { faXmark } from '@fortawesome/free-solid-svg-icons';
  import Modal from '$lib/components/modal/modal.svelte';
  import HistoryRows from '$lib/components/search-history/history-rows.svelte';
  import {
    bookSearchKey,
    filterEntries,
    groupForBook,
    type HistoryEntry
  } from '$lib/search-history/search-history';
  import { bookSearchHistoryOn$ } from '$lib/search-history/settings';
  import { searchHistoryApi } from '$lib/sync/sync-service';
  import { chapterLabelAt, type SectionLike } from '$lib/sync/position-prompt';
  import type { SearchResult, SearchState } from './book-search';

  export let state: SearchState;
  export let total: number;
  export let sections: SectionLike[] = [];
  export let limit: number;
  export let search: (query: string) => { results: SearchResult[]; more: boolean };
  /** The open book, for its search history (null: no history). */
  export let historyBook: { serverBookId: string | null; localId: number; title: string } | null =
    null;
  export let resolver: (answer: { state: SearchState; result: SearchResult | null }) => void;

  /** How many of other books' searches show before "Show all". */
  const OTHER_BOOKS_SHOWN = 5;
  const LIST_ID = 'book-search-history';

  const dispatch = createEventDispatcher<{ close: void }>();
  const history = searchHistoryApi();
  const entriesStore = history.entries;

  let query = state.query;
  let results = state.results;
  let more = state.more;
  let searched = state.searched;
  let busy = false;
  let error = '';
  let done = false;
  let inputEl: HTMLInputElement;
  /** The box was changed since the last search (its results are then hidden). */
  let edited = false;
  let bookKey = '';
  let showAllOthers = false;
  let active = -1;

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
    if (historyBook) {
      const book = historyBook;
      void history.bookKey(book.serverBookId, book.localId).then((key) => (bookKey = key));
    }
  });

  $: historyOn = $bookSearchHistoryOn$ && !!bookKey;
  $: showHistory = historyOn && !busy && (!searched || edited || !query.trim());
  $: groups = groupForBook($entriesStore, bookKey);
  $: thisBook = showHistory ? filterEntries(groups.thisBook, query, bookSearchKey) : [];
  $: otherAll = showHistory ? filterEntries(groups.otherBooks, query, bookSearchKey) : [];
  $: others = showAllOthers ? otherAll : otherAll.slice(0, OTHER_BOOKS_SHOWN);
  $: rows = [...thisBook, ...others];
  $: if (active >= rows.length) active = rows.length - 1;
  $: activeId = showHistory && active >= 0 ? `${LIST_ID}-${active}` : undefined;
  $: showResults = !showHistory || (!thisBook.length && !otherAll.length && !edited);

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
    active = -1;
    // Let "Searching…" show before the (synchronous) search of a long book.
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      ({ results, more } = search(query));
      searched = true;
      edited = false;
      if (historyOn && historyBook) {
        void history.recordBook(query, { key: bookKey, title: historyBook.title });
      }
    } catch (e) {
      error = `Search failed: ${(e as Error)?.message ?? e}`;
    } finally {
      busy = false;
    }
  }

  function pick(entry: HistoryEntry) {
    query = entry.query;
    void run();
  }

  function remove(entry: HistoryEntry) {
    void history.remove(entry.id);
  }

  function clearBox() {
    query = '';
    edited = true;
    active = -1;
    inputEl?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (!showHistory || !rows.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const n = rows.length;
      if (event.key === 'ArrowDown') active = active + 1 >= n ? -1 : active + 1;
      else active = active <= -1 ? n - 1 : active - 1;
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      pick(rows[active]);
    } else if (event.key === 'Delete' && event.shiftKey && active >= 0) {
      event.preventDefault();
      remove(rows[active]);
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
      (!searched || !showResults
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
      <div class="relative flex min-w-0 flex-1">
        <input
          bind:this={inputEl}
          bind:value={query}
          type="search"
          enterkeyhint="search"
          aria-label="Search in this book"
          class="bs-input c-input min-w-0 flex-1"
          class:bs-input-clear={!!query}
          data-testid="book-search-input"
          autocomplete="off"
          role={historyOn ? 'combobox' : undefined}
          aria-autocomplete={historyOn ? 'list' : undefined}
          aria-expanded={historyOn ? showHistory && rows.length > 0 : undefined}
          aria-controls={historyOn ? LIST_ID : undefined}
          aria-activedescendant={activeId}
          on:input={() => {
            edited = true;
            active = -1;
          }}
          on:keydown={onKeydown}
        />
        {#if query}
          <button
            type="button"
            class="bs-clear c-btn c-btn-ghost c-btn-icon c-btn-sm"
            title="Clear"
            aria-label="Clear the search box"
            data-testid="book-search-clear"
            on:click={clearBox}
          >
            <Fa icon={faXmark} />
          </button>
        {/if}
      </div>
      <button class="c-btn c-btn-primary" type="submit" disabled={busy}>Search</button>
    </form>
    <p class="min-h-[1.5rem] text-sm text-c-muted" role="status" data-testid="book-search-status">
      {status}
    </p>
  </div>
  {#if showHistory && rows.length}
    <div
      id={LIST_ID}
      class="pb-1"
      role="listbox"
      aria-label="Recent searches"
      data-testid="book-search-history"
    >
      {#if thisBook.length}
        <p class="bs-head" aria-hidden="true">In this book</p>
        <ul role="group" aria-label="In this book">
          <HistoryRows
            entries={thisBook}
            idPrefix={LIST_ID}
            {active}
            on:pick={(e) => pick(e.detail)}
            on:remove={(e) => remove(e.detail)}
            on:hover={(e) => (active = e.detail)}
          />
        </ul>
      {/if}
      {#if others.length}
        <p class="bs-head" aria-hidden="true">Other books</p>
        <ul role="group" aria-label="Other books" data-testid="book-search-history-others">
          <HistoryRows
            entries={others}
            idPrefix={LIST_ID}
            startIndex={thisBook.length}
            {active}
            showTitle
            on:pick={(e) => pick(e.detail)}
            on:remove={(e) => remove(e.detail)}
            on:hover={(e) => (active = e.detail)}
          />
        </ul>
        {#if !showAllOthers && otherAll.length > others.length}
          <button
            type="button"
            class="c-btn c-btn-ghost c-btn-sm mt-1"
            data-testid="book-search-history-all"
            on:click={() => (showAllOthers = true)}
          >
            Show all ({otherAll.length})
          </button>
        {/if}
      {/if}
    </div>
  {:else if showResults && results.length}
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

<style>
  .bs-input::-webkit-search-cancel-button {
    display: none;
  }

  .bs-input-clear {
    padding-right: calc(var(--c-btn-h-sm) + 0.25rem);
  }

  .bs-clear {
    position: absolute;
    top: 50%;
    right: 0.125rem;
    transform: translateY(-50%);
  }

  .bs-head {
    padding: 0.5rem 0.75rem 0.25rem;
    font-size: 0.75rem;
    color: var(--c-muted);
  }
</style>
