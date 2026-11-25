<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The search palette (search palette step 2, 2026-11-24; design docs/design/search-palette.md):
   * the library search from any catalogue page. The same box as the Library bar (suggestions,
   * "Reads as"); empty, it shows your recent searches (5, then See all), Recently viewed as
   * book cards and your smart collections. A search always runs on the Library page
   * (`/library?q=…`) and is remembered like one typed in the bar. Opened with
   * `openSearchPalette()` (the header's search button, `/`, Ctrl+K when on, the Library
   * history's "More…").
   */
  import { goto } from '$app/navigation';
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import Fa from 'svelte-fa';
  import {
    faClockRotateLeft,
    faFilter,
    faLayerGroup,
    faUser,
    faMagnifyingGlass,
    faXmark
  } from '@fortawesome/free-solid-svg-icons';
  import Modal from '$lib/components/modal/modal.svelte';
  import SearchSuggestions from '$lib/components/library/search-suggestions.svelte';
  import { pagePath } from '$lib/data/env';
  import { LibraryApi, type NameListQuery } from '$lib/library/api';
  import { getLibraryStore } from '$lib/library/library-db';
  import type { OfflineCatalog } from '$lib/library/offline/offline-catalog';
  import {
    isUnreachable,
    offlineCatalog,
    startsOffline
  } from '$lib/library/offline/offline-source';
  import { describeQuery } from '$lib/library/query/describe';
  import type { NameCount } from '$lib/library/query/suggest';
  import { authorHref } from '$lib/library/format';
  import { parseQuery, QUERY_FIELDS } from '$lib/library/query/parse';
  import { searchReadsAsOn$, searchSuggestionsOn$ } from '$lib/library/search-settings';
  import { libraryFilter$, libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { CatalogBook } from '$lib/library/types';
  import { lookupInOrder } from '$lib/recently-viewed/lookup';
  import { recentlyViewedOn$ } from '$lib/recently-viewed/settings';
  import { filterEntries, type HistoryEntry } from '$lib/search-history/search-history';
  import { searchHistoryOn$ } from '$lib/search-history/settings';
  import { collectionsApi, recentlyViewedApi, searchHistoryApi } from '$lib/sync/sync-service';

  export let resolver: (value: void) => void;
  /** Text to start with (the Library box's, from "More…"). */
  export let initialQuery = '';

  /** Recent searches shown before "See all" (decided with the user, 2026-11-24). */
  const HISTORY_SHOWN = 5;
  const VIEWED_SHOWN = 8;
  const COLLECTIONS_SHOWN = 6;

  let query = initialQuery;
  let cursor = initialQuery.length;
  let input: HTMLInputElement | undefined;
  let body: HTMLElement | undefined;
  let suggestions: SearchSuggestions | undefined;
  let suggestOpen = false;
  let suggestActiveId: string | undefined;
  let seeAll = false;
  let active = -1;
  let error = '';
  let destroyed = false;

  let api: LibraryApi | undefined;
  let offline = startsOffline();
  let viewed: CatalogBook[] = [];
  let smart: { id: string; name: string; query: string; count: number | null }[] = [];
  let matchCount: number | null = null;
  let countAsked = 0;
  let countTimer: ReturnType<typeof setTimeout> | undefined;

  const dispatch = createEventDispatcher<{ close: void }>();
  const history = searchHistoryApi();
  const historyEntries = history.entries;
  const viewedEntries = recentlyViewedApi().entries;

  function source(): LibraryApi | OfflineCatalog | undefined {
    if (!api) return undefined;
    return offline ? offlineCatalog() : api;
  }

  /** A server that stops answering: this device's copies from then on. */
  async function ask<T>(fn: (s: LibraryApi | OfflineCatalog) => Promise<T>): Promise<T> {
    const s = source();
    if (!s) throw new Error('Not connected');
    try {
      return await fn(s);
    } catch (e) {
      if (!offline && isUnreachable(e)) {
        offline = true;
        return fn(offlineCatalog());
      }
      throw e;
    }
  }

  $: trimmed = query.trim();
  $: libEntries = $searchHistoryOn$ ? $historyEntries.filter((e) => e.scope === 'lib') : [];
  /** Newest first, narrowed by what is typed (the same as the Library bar's list). */
  $: matching = filterEntries(libEntries, query);
  $: shownHistory = seeAll ? matching : matching.slice(0, HISTORY_SHOWN);
  $: reading = $searchReadsAsOn$ ? describeQuery(query, cursor) : { kind: 'none' as const };
  $: parsed = parseQuery(trimmed);
  $: hasField = parsed.ok && parsed.query.terms.some((t) => t.type !== 'any');
  $: usedFields = new Set(
    [...query.matchAll(/(?:^|\s)-?([a-z]+)[:：]/gi)].map((m) => m[1].toLowerCase())
  );
  $: addMore = QUERY_FIELDS.filter((f) => !usedFields.has(f));
  /** Rows ↑/↓ move through: the remembered searches, then "Search the library". */
  /**
   * Step 3: plain words show what they match at once (series, authors, books, 3 each),
   * between the recent searches and "Search the library".
   */
  $: plainWords = parsed.ok && parsed.query.terms.length > 0 && !hasField;
  $: void findMatches(plainWords ? trimmed : '');
  $: matchRows = matches
    ? [
        ...matches.series.map((n) => ({
          kind: 'series' as const,
          key: `s:${n.name}`,
          label: n.name,
          detail: `${n.count.toLocaleString('en-US')} ${n.count === 1 ? 'book' : 'books'}`,
          href: `${pagePath}/library?${new URLSearchParams({ tab: 'series', group: n.name })}`,
          book: null as CatalogBook | null
        })),
        ...matches.authors.map((n) => ({
          kind: 'author' as const,
          key: `a:${n.name}`,
          label: n.name,
          detail: `${n.count.toLocaleString('en-US')} ${n.count === 1 ? 'book' : 'books'}`,
          href: authorHref(pagePath, n.name),
          book: null as CatalogBook | null
        })),
        ...matches.books.map((b) => ({
          kind: 'book' as const,
          key: `b:${b.id}`,
          label: b.title,
          detail: b.authors.map((a) => a.name).join(', '),
          href: `${pagePath}/library/book?id=${encodeURIComponent(b.id)}`,
          book: b as CatalogBook | null
        }))
      ]
    : [];
  /** Where each kind's heading goes (the first row of that kind). */
  $: firstOfKind = new Set(
    ['series', 'author', 'book']
      .map((k) => matchRows.find((r) => r.kind === k)?.key)
      .filter((k): k is string => !!k)
  );
  $: matchStart = shownHistory.length;
  $: runIndex = matchStart + matchRows.length;
  $: rowCount = runIndex + (trimmed ? 1 : 0);
  $: if (active >= rowCount) active = rowCount - 1;
  $: void countMatches(trimmed);

  function countMatches(q: string) {
    clearTimeout(countTimer);
    matchCount = null;
    if (!q || !parseQuery(q).ok) return;
    const asked = ++countAsked;
    countTimer = setTimeout(async () => {
      try {
        const n = await ask((s) => s.count({ q, library: $libraryFilter$ || undefined }));
        if (asked === countAsked && !destroyed) matchCount = n;
      } catch {
        // The row still searches; it just shows no number.
      }
    }, 250);
  }

  const MATCHES_SHOWN = 3;
  let matches: { series: NameCount[]; authors: NameCount[]; books: CatalogBook[] } | null = null;
  let matchAsked = 0;
  let matchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Asked after a short pause in typing; only the newest answer is shown. */
  function findMatches(text: string) {
    clearTimeout(matchTimer);
    const asked = ++matchAsked;
    if (!text) {
      matches = null;
      return;
    }
    matchTimer = setTimeout(async () => {
      const library = $libraryFilter$ || undefined;
      const quiet = <T,>(p: Promise<T>, empty: T) => p.catch(() => empty);
      const [series, authors, page] = await Promise.all([
        quiet(
          ask((s) => s.names({ field: 'series', text, library, limit: MATCHES_SHOWN })),
          []
        ),
        quiet(
          ask((s) => s.names({ field: 'author', text, library, limit: MATCHES_SHOWN })),
          []
        ),
        quiet(
          ask((s) => s.books({ q: text, library, limit: MATCHES_SHOWN })),
          null as { books: CatalogBook[] } | null
        )
      ]);
      if (asked !== matchAsked || destroyed) return;
      matches = { series, authors, books: page?.books.slice(0, MATCHES_SHOWN) ?? [] };
    }, 200);
  }

  function names(q: NameListQuery) {
    return ask((s) => s.names(q));
  }

  function thumb(book: CatalogBook): string {
    if (!book.thumbnail) return '';
    return offline || !api ? book.thumbnail : api.absolute(book.thumbnail);
  }

  async function loadViewed(ids: string[]) {
    if (!$recentlyViewedOn$ || !ids.length) {
      viewed = [];
      return;
    }
    try {
      const books = await ask((s) => lookupInOrder(s, ids.slice(0, VIEWED_SHOWN)));
      if (!destroyed) viewed = books;
    } catch {
      viewed = [];
    }
  }

  async function loadCollections() {
    const { collections } = await collectionsApi().view();
    const list = collections
      .filter((c) => c.type === 'smart' && c.query)
      .slice(0, COLLECTIONS_SHOWN)
      .map((c) => ({ id: c.id, name: c.name, query: c.query ?? '', count: null as number | null }));
    smart = list;
    for (const c of list) {
      try {
        const n = await ask((s) => s.count({ q: c.query }));
        if (destroyed) return;
        c.count = n;
        smart = [...list];
      } catch {
        // No number for this one.
      }
    }
  }

  let viewedIdsKey = '';
  $: viewedIds = ($viewedEntries ?? []).map((e) => e.bookId).slice(0, VIEWED_SHOWN);
  $: if (api && viewedIds.join() !== viewedIdsKey) {
    viewedIdsKey = viewedIds.join();
    void loadViewed(viewedIds);
  }

  onMount(async () => {
    await tick();
    input?.focus();
    input?.setSelectionRange(cursor, cursor);
    const connection = await getLibraryStore().getConnection();
    if (!connection || destroyed) return;
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new LibraryApi(connection.serverUrl, connection.token, timeout);
    void loadCollections();
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(countTimer);
    clearTimeout(matchTimer);
  });

  function close() {
    resolver();
    dispatch('close');
  }

  async function run(q: string) {
    const text = q.trim();
    if (!text) return;
    const result = parseQuery(text);
    if (!result.ok) {
      error = result.error.message;
      return;
    }
    if ($searchHistoryOn$) void history.recordLibrary(text);
    close();
    await goto(`${pagePath}/library?q=${encodeURIComponent(text)}`);
  }

  async function go(href: string) {
    close();
    await goto(href);
  }

  async function fill(text: string) {
    query = text;
    error = '';
    await tick();
    input?.focus();
    cursor = text.length;
    input?.setSelectionRange(cursor, cursor);
  }

  async function addField(field: string) {
    const sep = query === '' || /\s$/.test(query) ? '' : ' ';
    await fill(`${query}${sep}${field}:`);
  }

  async function pickSuggestion(next: { text: string; cursor: number }) {
    query = next.text;
    await tick();
    input?.focus();
    input?.setSelectionRange(next.cursor, next.cursor);
    cursor = next.cursor;
  }

  function track() {
    cursor = input?.selectionStart ?? query.length;
  }

  function onInput() {
    track();
    error = '';
    active = -1;
  }

  function onKeydown(event: KeyboardEvent) {
    if (suggestions?.onKeydown(event)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rowCount) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') active = active + 1 >= rowCount ? -1 : active + 1;
      else active = active <= -1 ? rowCount - 1 : active - 1;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0 && active < shownHistory.length) void run(shownHistory[active].query);
      else if (active >= matchStart && active < runIndex)
        void go(matchRows[active - matchStart].href);
      else void run(query);
      return;
    }
    if (event.key === 'Delete' && event.shiftKey && active >= 0 && active < shownHistory.length) {
      event.preventDefault();
      void history.remove(shownHistory[active].id);
    }
  }

  function removeEntry(entry: HistoryEntry) {
    void history.remove(entry.id);
  }

  const rowId = (i: number) => `search-palette-row-${i}`;
</script>

<Modal
  title="Search the library"
  size="lg"
  testid="search-palette"
  panelClass="c-search-palette"
  initialFocus="[data-testid=search-palette-input]"
  on:close={close}
>
  <div class="sp-body" bind:this={body}>
    <div class="sp-box">
      <form role="search" class="sp-form" on:submit|preventDefault={() => run(query)}>
        <label class="c-input flex min-w-0 grow items-center gap-2">
          <span class="text-c-seal" aria-hidden="true"><Fa icon={faMagnifyingGlass} /></span>
          <span class="sr-only">Search the library</span>
          <input
            class="w-full min-w-0 border-0 bg-transparent p-0 text-base focus:ring-0"
            type="text"
            enterkeyhint="search"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            placeholder="Title, author or series — or tag: chars: …"
            data-testid="search-palette-input"
            data-own-escape={suggestOpen ? '' : undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestOpen || rowCount > 0}
            aria-controls={suggestOpen ? 'search-palette-suggestions' : 'search-palette-rows'}
            aria-activedescendant={suggestOpen
              ? suggestActiveId
              : active >= 0
                ? rowId(active)
                : undefined}
            bind:value={query}
            bind:this={input}
            on:input={onInput}
            on:click={track}
            on:keyup={track}
            on:select={track}
            on:keydown={onKeydown}
          />
        </label>
      </form>
      {#if error}
        <p class="sp-line text-c-seal" role="alert" data-testid="search-palette-error">{error}</p>
      {:else if reading.kind === 'reads'}
        <p class="sp-line text-c-muted" data-testid="search-palette-reads-as">
          Reads as: {reading.text}
        </p>
      {:else if reading.kind === 'error'}
        <p class="sp-line text-c-seal" data-testid="search-palette-reads-as-error">
          {reading.error.message}
        </p>
      {/if}
    </div>

    <SearchSuggestions
      bind:this={suggestions}
      bind:open={suggestOpen}
      bind:activeId={suggestActiveId}
      inline
      listId="search-palette-suggestions"
      {query}
      {cursor}
      enabled={$searchSuggestionsOn$}
      names={api ? names : undefined}
      library={$libraryFilter$ || undefined}
      container={body}
      on:pick={(event) => pickSuggestion(event.detail)}
    />

    {#if !suggestOpen}
      <ul id="search-palette-rows" role="listbox" aria-label="Searches">
        {#if shownHistory.length}
          <li class="sp-head" role="presentation">
            <span>{trimmed ? 'Matching recent searches' : 'Recent searches'}</span>
            {#if matching.length > HISTORY_SHOWN}
              <button
                type="button"
                class="c-link"
                data-testid="search-palette-see-all-history"
                on:click={() => (seeAll = !seeAll)}
              >
                {seeAll ? 'Show fewer' : `See all ${matching.length}`}
              </button>
            {/if}
          </li>
          {#each shownHistory as entry, i (entry.id)}
            <li
              id={rowId(i)}
              class="sp-row"
              class:sp-active={i === active}
              role="option"
              aria-selected={i === active}
            >
              <button
                type="button"
                class="sp-pick"
                tabindex="-1"
                data-testid="search-palette-history-row"
                on:click={() => run(entry.query)}
                on:pointermove={() => (active = i)}
              >
                <span class="sp-icon" aria-hidden="true"><Fa icon={faClockRotateLeft} /></span>
                <span class="sp-text sp-mono">{entry.query}</span>
              </button>
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-icon"
                title="Put in the box"
                aria-label="Put {entry.query} in the box"
                data-testid="search-palette-history-edit"
                on:click={() => fill(entry.query)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"><path d="M17 17 7 7M7 15V7h8" /></svg
                >
              </button>
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-icon"
                title="Remove from recent searches"
                aria-label="Remove {entry.query} from recent searches"
                data-testid="search-palette-history-remove"
                on:click={() => removeEntry(entry)}
              >
                <Fa icon={faXmark} />
              </button>
            </li>
          {/each}
        {/if}
        {#each matchRows as row, j (row.key)}
          {#if firstOfKind.has(row.key)}
            <li class="sp-head" role="presentation">
              <span
                >{row.kind === 'series'
                  ? 'Series'
                  : row.kind === 'author'
                    ? 'Authors'
                    : 'Books'}</span
              >
            </li>
          {/if}
          <li
            id={rowId(matchStart + j)}
            class="sp-row"
            class:sp-active={active === matchStart + j}
            role="option"
            aria-selected={active === matchStart + j}
          >
            <a
              class="sp-pick"
              tabindex="-1"
              href={row.href}
              data-testid="search-palette-match"
              data-kind={row.kind}
              on:click|preventDefault={() => go(row.href)}
              on:pointermove={() => (active = matchStart + j)}
            >
              {#if row.book}
                {#if thumb(row.book)}
                  <img class="sp-mini" src={thumb(row.book)} alt="" loading="lazy" />
                {:else}
                  <span class="sp-mini" aria-hidden="true"></span>
                {/if}
              {:else}
                <span class="sp-icon" aria-hidden="true"
                  ><Fa icon={row.kind === 'series' ? faLayerGroup : faUser} /></span
                >
              {/if}
              <span class="sp-text">{row.label}</span>
              {#if row.detail}
                <span class="sp-count sp-detail">{row.detail}</span>
              {/if}
            </a>
          </li>
        {/each}
        {#if trimmed}
          <li
            id={rowId(runIndex)}
            class="sp-row sp-run"
            class:sp-active={active === runIndex}
            role="option"
            aria-selected={active === runIndex}
          >
            <button
              type="button"
              class="sp-pick"
              tabindex="-1"
              data-testid="search-palette-run"
              on:click={() => run(query)}
              on:pointermove={() => (active = runIndex)}
            >
              <span class="sp-icon text-c-seal" aria-hidden="true"
                ><Fa icon={faMagnifyingGlass} /></span
              >
              <span class="sp-text">
                {hasField ? 'Search the library' : `Search the library for “${trimmed}”`}
              </span>
              {#if matchCount !== null}
                <span class="sp-count" data-testid="search-palette-count"
                  >{matchCount.toLocaleString('en-US')}
                  {matchCount === 1 ? 'book' : 'books'}</span
                >
              {/if}
            </button>
          </li>
        {/if}
      </ul>
    {/if}

    {#if trimmed && hasField && addMore.length && !suggestOpen}
      <div class="sp-section" data-testid="search-palette-add-more">
        <p class="sp-head"><span>Add more</span></p>
        <div class="flex flex-wrap gap-2 px-3">
          {#each addMore as field}
            <button
              type="button"
              class="c-chip c-chip-sm font-mono"
              on:click={() => addField(field)}>{field}:</button
            >
          {/each}
        </div>
      </div>
    {/if}

    {#if !trimmed}
      {#if viewed.length}
        <div class="sp-section" data-testid="search-palette-viewed">
          <p class="sp-head">
            <span>Recently viewed</span>
            <a
              class="c-link"
              href="{pagePath}/recently-viewed"
              on:click|preventDefault={() => go(`${pagePath}/recently-viewed`)}>See all</a
            >
          </p>
          <div class="sp-cards">
            {#each viewed as book (book.id)}
              <a
                class="sp-card c-focus"
                href="{pagePath}/library/book?id={encodeURIComponent(book.id)}"
                title={book.title}
                data-testid="search-palette-viewed-card"
                on:click|preventDefault={() =>
                  go(`${pagePath}/library/book?id=${encodeURIComponent(book.id)}`)}
              >
                {#if thumb(book)}
                  <img class="sp-cover" src={thumb(book)} alt="" loading="lazy" />
                {:else}
                  <span class="sp-cover sp-cover-empty" aria-hidden="true"></span>
                {/if}
                <span class="sp-card-title">{book.title}</span>
                {#if book.authors[0]}
                  <span class="sp-card-author">{book.authors[0].name}</span>
                {/if}
              </a>
            {/each}
          </div>
        </div>
      {/if}
      {#if smart.length}
        <div class="sp-section" data-testid="search-palette-collections">
          <p class="sp-head"><span>Smart collections</span></p>
          <ul>
            {#each smart as c (c.id)}
              <li class="sp-row">
                <a
                  class="sp-pick"
                  href="{pagePath}/library?collection={encodeURIComponent(c.id)}"
                  data-testid="search-palette-collection"
                  on:click|preventDefault={() =>
                    go(`${pagePath}/library?collection=${encodeURIComponent(c.id)}`)}
                >
                  <span class="sp-icon" aria-hidden="true"><Fa icon={faFilter} /></span>
                  <span class="sp-text">{c.name}</span>
                  {#if c.count !== null}
                    <span class="sp-count">{c.count.toLocaleString('en-US')} books</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if !shownHistory.length && !viewed.length && !smart.length}
        <p class="sp-empty" data-testid="search-palette-empty">
          Search by title, author or series, or use tag:, chars:, status: and more.
        </p>
      {/if}
    {/if}
  </div>
  <p class="sp-keys" aria-hidden="true">↑↓ move · Tab completes · ↵ search · Esc close</p>
</Modal>

<style>
  .sp-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .sp-box {
    position: sticky;
    top: 0;
    z-index: 1;
    padding-bottom: 0.5rem;
    background: inherit;
  }

  .sp-line {
    padding: 0.375rem 0.25rem 0;
    font-size: 0.875rem;
  }

  .sp-section {
    padding-top: 0.25rem;
  }

  .sp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.625rem 0.75rem 0.25rem;
    font-size: 0.75rem;
    color: var(--c-muted);
  }

  .sp-row {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    border-radius: 0.625rem;
  }

  .sp-row.sp-active,
  .sp-row:hover {
    background-color: var(--c-tint);
  }

  :global(html.eink) .sp-row.sp-active {
    outline: 2px solid #000;
    outline-offset: -2px;
  }

  :global(html.eink) .sp-row:hover:not(.sp-active) {
    background-color: transparent;
  }

  .sp-pick {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
    min-height: var(--c-btn-h);
    padding: 0.375rem 0.75rem;
    text-align: left;
    color: var(--c-ink);
  }

  .sp-icon {
    flex: none;
    color: var(--c-muted);
  }

  .sp-text {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sp-mono {
    font-family: var(--c-font-mono, ui-monospace, monospace);
    font-size: 0.875rem;
  }

  .sp-count {
    flex: none;
    font-size: 0.75rem;
    color: var(--c-muted);
    font-variant-numeric: tabular-nums;
  }

  .sp-mini {
    width: 1.5rem;
    height: 2.25rem;
    flex: none;
    border-radius: 0.25rem;
    object-fit: cover;
    background-color: var(--c-tint);
  }

  .sp-detail {
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sp-cards {
    display: flex;
    gap: 0.75rem;
    overflow-x: auto;
    padding: 0.25rem 0.75rem 0.5rem;
  }

  .sp-card {
    display: flex;
    width: 5.5rem;
    flex: none;
    flex-direction: column;
    gap: 0.25rem;
    border-radius: 0.625rem;
    color: var(--c-ink);
  }

  .sp-cover {
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 0.375rem;
    object-fit: cover;
    background-color: var(--c-tint);
  }

  .sp-card-title,
  .sp-card-author {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    font-size: 0.75rem;
    line-height: 1.3;
  }

  .sp-card-title {
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .sp-card-author {
    -webkit-line-clamp: 1;
    line-clamp: 1;
    color: var(--c-muted);
  }

  .sp-empty {
    padding: 1.5rem 0.75rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--c-muted);
  }

  .sp-keys {
    display: none;
    padding: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--c-muted);
  }

  @media (pointer: fine) {
    .sp-keys {
      display: block;
    }
  }

  /* Phones: nearly the whole screen, so the list has room above the keyboard. */
  @media (max-width: 639px) {
    :global(.c-search-palette) {
      height: min(92dvh, 92%);
    }
  }
</style>
