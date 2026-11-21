<script lang="ts" generics="T extends { id: number }">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book page's chooser for an audiobook or a subtitle file (2026-11-20 redesign of the
   * Audiobook section; WP15b's confirmation picker): the suggestions, a search over
   * everything for what isn't suggested, and the other choices ("Or", from the slot), in
   * that order. Both lists are shown a page at a time. Nothing is chosen until "Use this";
   * `choose` fires with the item and the parent links it (and asks first when it replaces).
   */
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Fa from 'svelte-fa';
  import AudioChoiceRow from '$lib/components/audio/audio-choice-row.svelte';
  import PagedList from '$lib/components/paged-list.svelte';
  import { withoutIds } from '$lib/audio/audio-link';

  /** null while the suggestions load. */
  export let suggestions: T[] | null;
  export let suggestionsError = '';
  export let suggestionsTitle: string;
  /** Shown when there are no suggestions. */
  export let noSuggestionsText: string;
  export let searchLabel: string;
  /** "audiobook" / "subtitle file", for "No … matches". */
  export let noun: string;
  export let search: (q: string) => Promise<T[]>;
  export let row: (item: T) => {
    name: string;
    parent?: string | null;
    details: string;
    note?: string;
    current: boolean;
  };
  export let disabled = false;
  /** Prefix of the test ids ("audio", "subtitle"); the old picker's ids are kept. */
  export let testid: string;
  export let pageSize = 5;
  /** Show the "Or" choices from the slot. */
  export let showOr = true;

  const dispatch = createEventDispatcher<{ choose: T; error: string }>();
  /** Search as you type, once typing pauses this long. */
  const SEARCH_SETTLE_MS = 300;

  let query = '';
  let results: T[] = [];
  let searched = '';
  let turn = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let suggestionList: PagedList<Row> | undefined;

  type Row = ReturnType<typeof row> & { item: T };

  // `row` is named here so the rows follow it (e.g. "In use" after a change).
  $: suggestionRows = (suggestions ?? []).map((item): Row => ({ ...row(item), item }));
  $: extraRows = withoutIds(results, suggestions ?? []).map(
    (item): Row => ({ ...row(item), item })
  );
  // The item in use shows on its page when the chooser opens.
  let shownCurrent = false;
  $: if (suggestionList && suggestionRows.length && !shownCurrent) {
    shownCurrent = true;
    suggestionList.showIndex(suggestionRows.findIndex((r) => r.current));
  }

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), SEARCH_SETTLE_MS);
  }

  async function run() {
    clearTimeout(timer);
    const q = query.trim();
    const mine = ++turn;
    if (!q) {
      results = [];
      searched = '';
      return;
    }
    try {
      const found = await search(q);
      if (!destroyed && mine === turn) {
        results = found;
        searched = q;
      }
    } catch (err) {
      if (!destroyed && mine === turn) dispatch('error', (err as Error).message);
    }
  }
</script>

<div data-testid="{testid}-picker">
  <h4 class="mt-3 text-sm font-medium">{suggestionsTitle}</h4>
  {#if suggestionsError}
    <p class="c-notice mt-2" role="alert">{suggestionsError}</p>
  {:else if !suggestions}
    <p class="mt-2 text-sm text-c-muted">Looking for suggestions…</p>
  {:else if suggestions.length === 0}
    <p class="mt-2 text-sm" data-testid="{testid}-no-suggestions">{noSuggestionsText}</p>
  {:else}
    <PagedList
      bind:this={suggestionList}
      items={suggestionRows}
      size={pageSize}
      label={suggestionsTitle}
      testid="{testid}-suggestions-pages"
      let:pageItems
    >
      <ul class="divide-y divide-dashed divide-c-line" data-testid="{testid}-suggestions">
        {#each pageItems as r (r.item.id)}
          <AudioChoiceRow
            name={r.name}
            parent={r.parent ?? null}
            details={r.details}
            note={r.note ?? ''}
            current={r.current}
            {disabled}
            testid="{testid}-suggestion"
            on:choose={() => dispatch('choose', r.item)}
          />
        {/each}
      </ul>
    </PagedList>
  {/if}

  <form class="mt-4 w-full max-w-xl" role="search" on:submit|preventDefault={() => void run()}>
    <label class="block text-sm text-c-muted" for="{testid}-search-input">
      Not in the list? {searchLabel}
    </label>
    <div class="mt-1 flex items-stretch gap-2">
      <span class="c-input flex min-w-0 grow items-center gap-2">
        <span class="text-c-muted" aria-hidden="true"><Fa icon={faMagnifyingGlass} /></span>
        <input
          id="{testid}-search-input"
          class="w-full min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0"
          type="search"
          enterkeyhint="search"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Title, series or folder"
          data-testid="{testid}-search"
          bind:value={query}
          on:input={schedule}
        />
      </span>
      <button class="c-btn c-btn-secondary px-4" type="submit" title="Search">
        <Fa icon={faMagnifyingGlass} />
        <span class="sr-only">Search</span>
      </button>
    </div>
  </form>
  {#if searched}
    {#if extraRows.length}
      <PagedList
        items={extraRows}
        size={pageSize}
        resetKey={searched}
        label="Search results"
        testid="{testid}-results-pages"
        let:pageItems
      >
        <ul class="mt-2 divide-y divide-dashed divide-c-line" data-testid="{testid}-results">
          {#each pageItems as r (r.item.id)}
            <AudioChoiceRow
              name={r.name}
              parent={r.parent ?? null}
              details={r.details}
              note={r.note ?? ''}
              current={r.current}
              {disabled}
              testid="{testid}-result"
              on:choose={() => dispatch('choose', r.item)}
            />
          {/each}
        </ul>
      </PagedList>
    {:else}
      <p class="mt-2 text-sm text-c-muted" data-testid="{testid}-no-results">
        {results.length ? 'Only the suggestions above match.' : `No ${noun} matches “${searched}”.`}
      </p>
    {/if}
  {/if}

  {#if showOr}
    <div class="mt-4 border-t border-dashed pt-3" style="border-color: var(--c-line)">
      <div class="text-sm text-c-muted">Or</div>
      <div class="mt-2 flex flex-wrap gap-2">
        <slot />
      </div>
    </div>
  {/if}
</div>
