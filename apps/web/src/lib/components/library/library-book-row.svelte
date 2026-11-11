<script lang="ts">
  import type { CatalogBook } from '$lib/library/types';
  import { pagePath } from '$lib/data/env';
  import { formatBookCharCount } from '$lib/library/char-counts';
  import { authorHref } from '$lib/library/format';
  import { STATUS_LABELS, finishedReadThroughs, type BookState } from '$lib/sync/book-state';
  import { faCheck, faEllipsisVertical, faStar } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import CoverImage from './cover-image.svelte';

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
  /** WP7a: show the details lines (per-device setting). */
  export let infoLine = true;

  const dispatch = createEventDispatcher<{
    open: CatalogBook;
    reveal: CatalogBook;
    toggle: { book: CatalogBook; shift: boolean };
    state: CatalogBook;
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
     above it (a link can't be inside a button). -->
<li
  class="relative flex items-center border-b border-gray-400/40"
  data-testid="library-row"
  data-book-id={book.id}
>
  <button
    class="absolute inset-0 h-full w-full text-left"
    aria-pressed={selectMode ? selected : undefined}
    aria-label={blurred && !selectMode ? `Show cover: ${book.title}` : book.title}
    data-testid="row-open"
    on:click={onClick}
  />
  <div class="flex min-w-0 grow items-center gap-4 py-3 text-left">
    {#if selectMode}
      <input
        type="checkbox"
        class="h-6 w-6 shrink-0"
        checked={selected}
        tabindex="-1"
        aria-hidden="true"
      />
    {/if}
    <div class="h-[72px] w-12 shrink-0">
      <CoverImage src={thumbnailUrl} {blurred} compact />
    </div>
    <div class="min-w-0 grow">
      <div class="line-clamp-2 font-medium">
        {#if state?.favorite}
          <span class="mr-1 inline-block align-[-2px]" title="Favorite" data-testid="favorite-mark">
            <Fa icon={faStar} />
          </span>
        {/if}{book.title}
      </div>
      {#if book.authors.length && infoLine}
        <div class="truncate text-sm">
          {#each book.authors as author, i (i)}<a
              class="relative z-10 underline-offset-2 hover:underline"
              class:pointer-events-none={selectMode}
              href={authorLink(author.name)}
              tabindex={selectMode ? -1 : undefined}
              data-testid="author-link">{author.name}</a
            >{i < book.authors.length - 1 ? ', ' : ''}{/each}
        </div>
      {/if}
      {#if details && infoLine}
        <div class="truncate text-sm opacity-75" data-testid="row-details">{details}</div>
      {/if}
    </div>
    {#if book.source === 'upload'}
      <div
        class="shrink-0 rounded border border-current px-1 text-xs font-medium"
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
    <button
      class="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center"
      title="Book status"
      aria-label="Book status: {book.title}"
      data-testid="row-state"
      on:click={() => dispatch('state', book)}
    >
      <Fa icon={faEllipsisVertical} />
    </button>
  {/if}
</li>
