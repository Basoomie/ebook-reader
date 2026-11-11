<script lang="ts">
  /**
   * A book in the library grid (WP7a; WP19b "Archive" look): cover with the series number
   * as a vermilion ribbon, a progress bar under it while part-read, the title in mincho
   * and an optional info line (author links, series number, characters, progress).
   * Tapping the cover or title opens the book; a hidden cover is revealed by the first
   * tap. The ⋮ in the cover's corner (on hover; always on touch screens and E-ink) has
   * Continue reading / Read, Book status… and Add to collection….
   */
  import type { CatalogBook } from '$lib/library/types';
  import { formatBookCharCount } from '$lib/library/char-counts';
  import { pagePath } from '$lib/data/env';
  import { authorHref, authorNames, formatSeriesIndex, seriesNumber } from '$lib/library/format';
  import { STATUS_LABELS, type BookState } from '$lib/sync/book-state';
  import { faCheck, faStar } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import CoverImage from './cover-image.svelte';
  import LibraryBookMenu from './library-book-menu.svelte';

  export let book: CatalogBook;
  export let thumbnailUrl: string;
  export let state: BookState | undefined = undefined;
  /** "42%", "Finished" or null. */
  export let progress: string | null = null;
  /** WP19b: 0-1 while part-read (the bar under the cover), else null. */
  export let progressFraction: number | null = null;
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
    collect: CatalogBook;
  }>();

  /** WP19a: where an author name leads (default: that author in the Library). */
  export let authorLink: (name: string) => string = (name) => authorHref(pagePath, name);

  let menuOpen = false;

  $: status = state && state.status !== 'unread' ? STATUS_LABELS[state.status] : '';
  // Author names are links (WP19a); the rest of the line is text.
  $: rest = [seriesNumber(book), formatBookCharCount(book), progress ?? status]
    .filter(Boolean)
    .join(' · ');
  $: info = [authorNames(book), rest].filter(Boolean).join(' · ');
  $: ribbon =
    book.series?.index !== null && book.series?.index !== undefined
      ? formatSeriesIndex(book.series.index)
      : '';
  $: readLabel = progressFraction !== null ? 'Continue reading' : 'Read';

  function onClick(ev: MouseEvent) {
    if (selectMode) dispatch('toggle', { book, shift: ev.shiftKey });
    else if (blurred) dispatch('reveal', book);
    else dispatch('open', book);
  }
</script>

<li class="c-card relative min-w-0" data-testid="library-card" data-book-id={book.id}>
  <button
    class="c-focus block w-full rounded-sm text-left"
    aria-pressed={selectMode ? selected : undefined}
    aria-label={blurred && !selectMode ? `Show cover: ${book.title}` : book.title}
    on:click={onClick}
  >
    <div
      class="c-cover relative aspect-[2/3] w-full overflow-hidden rounded-sm"
      class:c-cover-selected={selected}
    >
      <CoverImage src={thumbnailUrl} {blurred} />
      {#if ribbon}
        <span class="c-ribbon" data-testid="series-ribbon">{ribbon}</span>
      {/if}
      {#if selectMode}
        <span
          class="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded border-2 border-gray-800 bg-white text-black"
          aria-hidden="true"
        >
          {#if selected}<Fa icon={faCheck} />{/if}
        </span>
      {/if}
      {#if book.source === 'upload'}
        <span
          class="absolute bottom-2 left-2 rounded-sm border border-gray-800 bg-white px-1 text-xs font-medium text-black"
          class:hidden={selectMode}
          title="Uploaded (not in Calibre)"
          data-testid="uploaded-badge"
        >
          Uploaded
        </span>
      {/if}
      {#if onDevice}
        <span
          class="absolute bottom-2 right-2 rounded-sm bg-white px-1 text-xs text-black"
          title="Saved on this device"
        >
          <Fa icon={faCheck} />
        </span>
      {/if}
    </div>
  </button>
  {#if progressFraction !== null}
    <div
      class="c-progress mt-1.5 h-[5px] overflow-hidden rounded-full bg-c-track"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progressFraction * 100)}
      aria-label="Progress"
      data-testid="card-progress"
    >
      <div class="h-full bg-c-fill" style="width: {Math.round(progressFraction * 100)}%" />
    </div>
  {/if}
  {#if !selectMode}
    <div class="c-card-dots absolute right-2 top-2 z-10" class:c-open={menuOpen}>
      <LibraryBookMenu
        title={book.title}
        {readLabel}
        bind:open={menuOpen}
        on:read={() => dispatch('open', book)}
        on:state={() => dispatch('state', book)}
        on:collect={() => dispatch('collect', book)}
      />
    </div>
  {/if}
  <button
    class="c-focus mt-2 line-clamp-2 block w-full text-left font-mincho text-[15px] font-bold leading-snug hover:underline"
    tabindex="-1"
    on:click={onClick}
  >
    {#if state?.favorite}
      <span
        class="mr-0.5 inline-block align-[-1px] text-c-seal"
        title="Favorite"
        data-testid="favorite-mark"
      >
        <Fa icon={faStar} size="xs" />
      </span>
    {/if}{book.title}
  </button>
  {#if infoLine && info}
    <div class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-c-muted" data-testid="card-info">
      {#each book.authors as author, i (i)}<a
          class="c-link"
          class:pointer-events-none={selectMode}
          href={authorLink(author.name)}
          tabindex={selectMode ? -1 : undefined}
          data-testid="author-link">{author.name}</a
        >{i < book.authors.length - 1 ? ', ' : ''}{/each}{book.authors.length && rest
        ? ' · '
        : ''}{rest}
    </div>
  {/if}
</li>

<style>
  .c-ribbon {
    position: absolute;
    top: 0;
    left: 0.6rem;
    min-width: 1.4rem;
    padding: 0.2rem 0.3rem 0.55rem;
    background-color: var(--c-seal);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    text-align: center;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  }

  .c-cover-selected {
    outline: 3px solid var(--c-link);
    outline-offset: 2px;
  }
</style>
