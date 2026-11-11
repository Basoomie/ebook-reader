<script lang="ts">
  import type { CatalogBook } from '$lib/library/types';
  import { pagePath } from '$lib/data/env';
  import { formatBookCharCount } from '$lib/library/char-counts';
  import { authorHref } from '$lib/library/format';
  import { STATUS_LABELS, finishedReadThroughs, type BookState } from '$lib/sync/book-state';
  import { faCheck, faStar } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import CoverImage from './cover-image.svelte';
  import LibraryBookMenu from './library-book-menu.svelte';

  export let book: CatalogBook;
  /** Absolute thumbnail URL, or '' for none. */
  export let thumbnailUrl: string;
  export let onDevice = false;
  export let libraryName = '';
  /** WP8a: the book's state from the sync mirror (undefined = Unread, defaults). */
  export let state: BookState | undefined = undefined;
  /** Multi-select: a tap selects instead of opening. */
  export let selectMode = false;
  export let selected = false;
  /** WP7a: the cover is hidden (blur rules) and not revealed yet. */
  export let blurred = false;
  /** WP7a: "42%", "Finished" or null. */
  export let progress: string | null = null;
  /** WP19b: 0-1 while part-read, else null ("Continue reading" in the ⋮ menu). */
  export let progressFraction: number | null = null;
  /** WP7a: show the details lines (per-device setting). */
  export let infoLine = true;

  const dispatch = createEventDispatcher<{
    open: CatalogBook;
    reveal: CatalogBook;
    toggle: { book: CatalogBook; shift: boolean };
    state: CatalogBook;
    collect: CatalogBook;
  }>();

  function onClick(ev: MouseEvent) {
    if (selectMode) dispatch('toggle', { book, shift: ev.shiftKey });
    else if (blurred) dispatch('reveal', book);
    else dispatch('open', book);
  }

  /** WP19a: where an author name leads (default: that author in the Library). */
  export let authorLink: (name: string) => string = (name) => authorHref(pagePath, name);

  $: series = book.series
    ? `${book.series.name}${book.series.index !== null ? ` ${formatIndex(book.series.index)}` : ''}`
    : '';
  $: readCount = state ? finishedReadThroughs(state) : 0;
  $: stateLabel = [
    state && state.status !== 'unread' ? STATUS_LABELS[state.status] : '',
    readCount > 1 ? `Read ${readCount}x` : ''
  ]
    .filter(Boolean)
    .join(' · ');
  // Status first and the count before the library name, so both survive truncation on a phone.
  $: details = [stateLabel, series, formatBookCharCount(book), progress ?? '', libraryName]
    .filter(Boolean)
    .join(' · ');

  function formatIndex(index: number) {
    return Number.isInteger(index) ? String(index) : index.toFixed(1);
  }
</script>

<!-- WP19a: the row's button covers the whole row ("stretched"), so the author links can sit
     above it (a link can't be inside a button). WP19b: a tinted row on hover. -->
<li
  class="c-row relative flex items-center border-b"
  class:c-row-selected={selected}
  style="border-color: var(--c-line)"
  data-testid="library-row"
  data-book-id={book.id}
>
  <button
    class="c-focus absolute inset-0 h-full w-full text-left"
    aria-pressed={selectMode ? selected : undefined}
    aria-label={blurred && !selectMode ? `Show cover: ${book.title}` : book.title}
    data-testid="row-open"
    on:click={onClick}
  />
  <div class="flex min-w-0 grow items-center gap-4 px-1 py-3 text-left">
    {#if selectMode}
      <input
        type="checkbox"
        class="h-6 w-6 shrink-0 rounded"
        checked={selected}
        tabindex="-1"
        aria-hidden="true"
      />
    {/if}
    <div class="c-cover h-[72px] w-12 shrink-0 overflow-hidden rounded-sm">
      <CoverImage src={thumbnailUrl} {blurred} compact />
    </div>
    <div class="min-w-0 grow">
      <div class="line-clamp-2 font-mincho font-bold">
        {#if state?.favorite}
          <span
            class="mr-1 inline-block align-[-2px] text-c-seal"
            title="Favorite"
            data-testid="favorite-mark"
          >
            <Fa icon={faStar} />
          </span>
        {/if}{book.title}
      </div>
      {#if book.authors.length && infoLine}
        <div class="truncate text-sm">
          {#each book.authors as author, i (i)}<a
              class="c-link relative z-10"
              class:pointer-events-none={selectMode}
              href={authorLink(author.name)}
              tabindex={selectMode ? -1 : undefined}
              data-testid="author-link">{author.name}</a
            >{i < book.authors.length - 1 ? ', ' : ''}{/each}
        </div>
      {/if}
      {#if details && infoLine}
        <div class="truncate text-sm text-c-muted" data-testid="row-details">{details}</div>
      {/if}
      {#if progressFraction !== null}
        <div class="c-progress mt-1.5 h-1 max-w-[12rem] overflow-hidden rounded-full bg-c-track">
          <div class="h-full bg-c-fill" style="width: {Math.round(progressFraction * 100)}%" />
        </div>
      {/if}
    </div>
    {#if book.source === 'upload'}
      <div
        class="shrink-0 rounded-sm border border-current px-1 text-xs font-medium"
        title="Uploaded (not in Calibre)"
        data-testid="uploaded-badge"
      >
        Uploaded
      </div>
    {/if}
    {#if onDevice}
      <div class="flex shrink-0 items-center gap-1 text-sm" title="Saved on this device">
        <Fa icon={faCheck} />
        <span class="hidden sm:inline">On this device</span>
      </div>
    {/if}
  </div>
  {#if !selectMode}
    <div class="relative z-10 shrink-0">
      <LibraryBookMenu
        title={book.title}
        readLabel={progressFraction !== null ? 'Continue reading' : 'Read'}
        variant="row"
        on:read={() => dispatch('open', book)}
        on:state={() => dispatch('state', book)}
        on:collect={() => dispatch('collect', book)}
      />
    </div>
  {/if}
</li>

<style>
  @media (hover: hover) {
    .c-row:hover {
      background-color: var(--c-tint);
    }
  }

  .c-row-selected {
    background-color: var(--c-tint);
    box-shadow: inset 4px 0 0 var(--c-link);
  }
</style>
