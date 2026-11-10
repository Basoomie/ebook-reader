<script lang="ts">
  import type { CatalogBook } from '$lib/library/types';
  import { formatBookCharCount } from '$lib/library/char-counts';
  import { STATUS_LABELS, finishedReadThroughs, type BookState } from '$lib/sync/book-state';
  import { faCheck, faEllipsisVertical, faStar } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';

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

  const dispatch = createEventDispatcher<{
    open: CatalogBook;
    toggle: CatalogBook;
    state: CatalogBook;
  }>();

  let thumbFailed = false;

  $: authors = book.authors.map((a) => a.name).join(', ');
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
  $: details = [stateLabel, series, formatBookCharCount(book), libraryName]
    .filter(Boolean)
    .join(' · ');

  function formatIndex(index: number) {
    return Number.isInteger(index) ? String(index) : index.toFixed(1);
  }
</script>

<li class="flex items-center border-b border-gray-400/40" data-testid="library-row">
  <button
    class="flex min-w-0 grow items-center gap-4 py-3 text-left"
    aria-pressed={selectMode ? selected : undefined}
    on:click={() => dispatch(selectMode ? 'toggle' : 'open', book)}
  >
    {#if selectMode}
      <input
        type="checkbox"
        class="h-6 w-6 shrink-0"
        checked={selected}
        tabindex="-1"
        aria-hidden="true"
      />
    {/if}
    <div class="flex h-[72px] w-12 shrink-0 items-center justify-center bg-gray-400/20">
      {#if thumbnailUrl && !thumbFailed}
        <img
          class="h-[72px] w-12 object-cover"
          src={thumbnailUrl}
          alt=""
          width="48"
          height="72"
          loading="lazy"
          decoding="async"
          on:error={() => (thumbFailed = true)}
        />
      {/if}
    </div>
    <div class="min-w-0 grow">
      <div class="line-clamp-2 font-medium">
        {#if state?.favorite}
          <span class="mr-1 inline-block align-[-2px]" title="Favorite" data-testid="favorite-mark">
            <Fa icon={faStar} />
          </span>
        {/if}{book.title}
      </div>
      {#if authors}
        <div class="truncate text-sm">{authors}</div>
      {/if}
      {#if details}
        <div class="truncate text-sm opacity-75" data-testid="row-details">{details}</div>
      {/if}
    </div>
    {#if onDevice}
      <div class="flex shrink-0 items-center gap-1 text-sm" title="Saved on this device">
        <Fa icon={faCheck} />
        <span class="hidden sm:inline">On this device</span>
      </div>
    {/if}
  </button>
  {#if !selectMode}
    <button
      class="flex h-12 w-12 shrink-0 items-center justify-center"
      title="Book status"
      aria-label="Book status: {book.title}"
      data-testid="row-state"
      on:click={() => dispatch('state', book)}
    >
      <Fa icon={faEllipsisVertical} />
    </button>
  {/if}
</li>
