<script lang="ts">
  /**
   * A book in the library grid (WP7a): cover, title and an optional info line (author,
   * series number, character count, progress). A hidden cover is revealed by the first
   * tap; the next tap opens the book. Plain for e-ink: no transitions or shadows.
   */
  import type { CatalogBook } from '$lib/library/types';
  import { formatBookCharCount } from '$lib/library/char-counts';
  import { authorNames, seriesNumber } from '$lib/library/format';
  import { STATUS_LABELS, type BookState } from '$lib/sync/book-state';
  import { faCheck, faEllipsisVertical, faStar } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import CoverImage from './cover-image.svelte';

  export let book: CatalogBook;
  export let thumbnailUrl: string;
  export let state: BookState | undefined = undefined;
  /** "42%", "Finished" or null. */
  export let progress: string | null = null;
  export let infoLine = true;
  export let blurred = false;
  export let onDevice = false;
  export let selectMode = false;
  export let selected = false;

  const dispatch = createEventDispatcher<{
    open: CatalogBook;
    reveal: CatalogBook;
    toggle: { book: CatalogBook; shift: boolean };
    state: CatalogBook;
  }>();

  $: status = state && state.status !== 'unread' ? STATUS_LABELS[state.status] : '';
  $: info = [authorNames(book), seriesNumber(book), formatBookCharCount(book), progress ?? status]
    .filter(Boolean)
    .join(' · ');

  function onClick(ev: MouseEvent) {
    if (selectMode) dispatch('toggle', { book, shift: ev.shiftKey });
    else if (blurred) dispatch('reveal', book);
    else dispatch('open', book);
  }
</script>

<li class="min-w-0" data-testid="library-card" data-book-id={book.id}>
  <button
    class="block w-full text-left"
    aria-pressed={selectMode ? selected : undefined}
    aria-label={blurred && !selectMode ? `Show cover: ${book.title}` : undefined}
    on:click={onClick}
  >
    <div
      class="relative aspect-[2/3] w-full border-2"
      class:border-transparent={!selected}
      class:border-gray-800={selected}
    >
      <CoverImage src={thumbnailUrl} {blurred} />
      {#if selectMode}
        <span
          class="absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded border-2 border-gray-800 bg-white text-black"
          aria-hidden="true"
        >
          {#if selected}<Fa icon={faCheck} />{/if}
        </span>
      {/if}
      {#if onDevice}
        <span
          class="absolute bottom-1 right-1 rounded bg-white px-1 text-xs text-black"
          title="Saved on this device"
        >
          <Fa icon={faCheck} />
        </span>
      {/if}
    </div>
    <div class="mt-1 line-clamp-2 text-sm font-medium leading-snug">
      {#if state?.favorite}
        <span class="mr-0.5 inline-block align-[-1px]" title="Favorite" data-testid="favorite-mark">
          <Fa icon={faStar} size="xs" />
        </span>
      {/if}{book.title}
    </div>
  </button>
  <div class="flex items-start">
    {#if infoLine && info}
      <div class="line-clamp-2 min-w-0 grow text-xs opacity-75" data-testid="card-info">{info}</div>
    {:else}
      <div class="grow" />
    {/if}
    {#if !selectMode}
      <button
        class="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center"
        title="Book status"
        aria-label="Book status: {book.title}"
        data-testid="row-state"
        on:click={() => dispatch('state', book)}
      >
        <Fa icon={faEllipsisVertical} />
      </button>
    {/if}
  </div>
</li>
