<script lang="ts" context="module">
  import type { CatalogBook } from '$lib/library/types';

  /** What a Home row shows. */
  export type HomeRowView =
    | { status: 'loading' }
    | { status: 'ok'; books: CatalogBook[] }
    | { status: 'error'; message: string }
    /** Offline Continue Reading: books on this device, by title only. */
    | {
        status: 'offline';
        message: string;
        local: { bookId: string; title: string; localId: number }[];
      };
</script>

<script lang="ts">
  /**
   * One Home row (WP7b): a title, "See all" and a horizontally scrolling strip of book
   * cards (the Library's cards: blur, status, progress, "Uploaded"). E-ink plain: no
   * scroll snapping, animation or transitions; 48 px controls.
   */
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import { coverSize } from '$lib/library/cover-size';
  import { libraryCoverSize$ } from '$lib/library/settings';
  import type { BookState } from '$lib/sync/book-state';
  import { createEventDispatcher } from 'svelte';

  export let title: string;
  export let href: string | null = null;
  export let view: HomeRowView;
  export let emptyText = 'Nothing here yet.';
  export let thumbnailUrl: (book: CatalogBook) => string;
  export let stateOf: (book: CatalogBook) => BookState | undefined;
  export let progressOf: (book: CatalogBook) => string | null;
  export let blurredOf: (book: CatalogBook) => boolean;
  export let onDevice: Set<string>;
  export let infoLine = true;

  const dispatch = createEventDispatcher<{
    open: CatalogBook;
    reveal: CatalogBook;
    state: CatalogBook;
    retry: void;
    openLocal: number;
  }>();

  $: size = coverSize($libraryCoverSize$);
</script>

<section class="pb-4" data-testid="home-row" data-row-title={title}>
  <div class="flex items-center justify-between gap-2 pb-2">
    <h2 class="truncate text-lg font-medium">{title}</h2>
    {#if href}
      <a class="flex min-h-[3rem] shrink-0 items-center underline" {href}>See all</a>
    {/if}
  </div>
  {#if view.status === 'loading'}
    <p class="py-4 text-sm">Loading…</p>
  {:else if view.status === 'error'}
    <div class="flex flex-wrap items-center gap-3 py-2 text-sm" role="alert">
      <span>{view.message}</span>
      <button
        class="min-h-[3rem] rounded border-2 border-current px-4 font-medium"
        on:click={() => dispatch('retry')}
      >
        Retry
      </button>
    </div>
  {:else if view.status === 'offline'}
    <div class="flex flex-wrap items-center gap-3 py-2 text-sm" role="alert">
      <span>{view.message}</span>
      <button
        class="min-h-[3rem] rounded border-2 border-current px-4 font-medium"
        on:click={() => dispatch('retry')}
      >
        Retry
      </button>
    </div>
    {#if view.local.length}
      <ul class="flex flex-col gap-2" data-testid="home-offline-list">
        {#each view.local as b (b.bookId)}
          <li>
            <button
              class="min-h-[3rem] w-full rounded border-2 border-current px-4 text-left font-medium"
              on:click={() => dispatch('openLocal', b.localId)}
            >
              {b.title}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if view.books.length === 0}
    <p class="py-2 text-sm">{emptyText}</p>
  {:else}
    <!-- WP19a: the Library's cover size, else the automatic widths. -->
    <ul
      class="grid grid-flow-col gap-3 overflow-x-auto pb-2 {size
        ? ''
        : 'auto-cols-[7rem] sm:auto-cols-[8.5rem]'}"
      style={size ? `grid-auto-columns: ${size}px` : undefined}
      data-testid="home-row-books"
    >
      {#each view.books as book (book.id)}
        <LibraryBookCard
          {book}
          thumbnailUrl={thumbnailUrl(book)}
          state={stateOf(book)}
          progress={progressOf(book)}
          blurred={blurredOf(book)}
          onDevice={onDevice.has(book.id)}
          {infoLine}
          on:open={(ev) => dispatch('open', ev.detail)}
          on:reveal={(ev) => dispatch('reveal', ev.detail)}
          on:state={(ev) => dispatch('state', ev.detail)}
        />
      {/each}
    </ul>
  {/if}
</section>
