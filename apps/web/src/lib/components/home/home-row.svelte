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
   * cards (the Library's cards: blur, status, progress, "Uploaded"). WP19b: a mincho
   * heading with a gold rule; Continue reading shows its first book large ("hero") with a
   * Continue button. E-ink plain: no scroll snapping, animation or transitions; 48 px
   * controls.
   */
  import CoverImage from '$lib/components/library/cover-image.svelte';
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import { pagePath } from '$lib/data/env';
  import { coverSize } from '$lib/library/cover-size';
  import { formatBookCharCount } from '$lib/library/char-counts';
  import { authorHref, bookDetailsHref, seriesNumber } from '$lib/library/format';
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
  /** WP19b: 0-1 while part-read (the bar under a cover). */
  export let fractionOf: (book: CatalogBook) => number | null = () => null;
  export let blurredOf: (book: CatalogBook) => boolean;
  export let onDevice: Set<string>;
  export let infoLine = true;
  /** WP19b: show the first book large (Continue reading). */
  export let hero = false;
  /** The hero's progress (100% included) and time left, or null when nothing is known. */
  export let heroProgressOf: (
    book: CatalogBook
  ) => { fraction: number; timeLeft: string | null } | null = () => null;

  const dispatch = createEventDispatcher<{
    open: CatalogBook;
    reveal: CatalogBook;
    state: CatalogBook;
    collect: CatalogBook;
    retry: void;
    openLocal: number;
  }>();

  $: size = coverSize($libraryCoverSize$);
  $: books = view.status === 'ok' ? view.books : [];
  $: heroBook = hero && books.length ? books[0] : null;
  $: strip = heroBook ? books.slice(1) : books;
  $: heroProgress = heroBook ? heroProgressOf(heroBook) : null;
  $: heroInfo = heroBook
    ? [heroBook.series?.name ?? '', seriesNumber(heroBook), formatBookCharCount(heroBook)]
        .filter(Boolean)
        .join(' · ')
    : '';

  function openHero() {
    if (!heroBook) return;
    if (blurredOf(heroBook)) dispatch('reveal', heroBook);
    else dispatch('open', heroBook);
  }
</script>

<section class="pb-6" data-testid="home-row" data-row-title={title}>
  <div class="flex items-center gap-4 pb-3">
    <h2 class="min-w-0 truncate font-mincho text-xl font-bold sm:text-2xl">{title}</h2>
    <span class="c-section-rule" />
    {#if href}
      <a class="c-link flex min-h-[3rem] shrink-0 items-center text-sm" {href}>See all</a>
    {/if}
  </div>
  {#if view.status === 'loading'}
    <p class="py-4 text-sm text-c-muted">Loading…</p>
  {:else if view.status === 'error'}
    <div class="flex flex-wrap items-center gap-3 py-2 text-sm" role="alert">
      <span>{view.message}</span>
      <button class="c-btn c-btn-secondary" on:click={() => dispatch('retry')}>Retry</button>
    </div>
  {:else if view.status === 'offline'}
    <div class="flex flex-wrap items-center gap-3 py-2 text-sm" role="alert">
      <span>{view.message}</span>
      <button class="c-btn c-btn-secondary" on:click={() => dispatch('retry')}>Retry</button>
    </div>
    {#if view.local.length}
      <ul class="flex flex-col gap-2" data-testid="home-offline-list">
        {#each view.local as b (b.bookId)}
          <li>
            <button
              class="c-btn c-btn-secondary w-full justify-start text-left"
              on:click={() => dispatch('openLocal', b.localId)}
            >
              {b.title}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if view.books.length === 0}
    <p class="py-2 text-sm text-c-muted">{emptyText}</p>
  {:else}
    {#if heroBook}
      <div class="c-hero mb-4 flex max-w-2xl gap-4 rounded p-4" data-testid="home-hero">
        <button
          class="c-cover c-focus aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-sm sm:w-28"
          aria-label={heroBook.title}
          on:click={openHero}
        >
          <CoverImage src={thumbnailUrl(heroBook)} blurred={blurredOf(heroBook)} />
        </button>
        <div class="flex min-w-0 grow flex-col gap-1.5">
          <a
            class="c-focus line-clamp-2 font-mincho text-lg font-bold leading-snug hover:underline"
            href={bookDetailsHref(pagePath, heroBook.id)}
            data-testid="home-hero-title"
          >
            {heroBook.title}
          </a>
          <div class="truncate text-sm">
            {#each heroBook.authors as author, i (i)}<a
                class="c-link"
                href={authorHref(pagePath, author.name)}>{author.name}</a
              >{i < heroBook.authors.length - 1 ? ', ' : ''}{/each}
          </div>
          {#if heroInfo}
            <p class="truncate text-sm text-c-muted" data-testid="home-hero-info">{heroInfo}</p>
          {/if}
          {#if heroProgress}
            <div class="c-progress mt-1 h-1.5 max-w-xs overflow-hidden rounded-full bg-c-track">
              <div
                class="h-full bg-c-fill"
                style="width: {Math.round(heroProgress.fraction * 100)}%"
              />
            </div>
            <p class="text-xs text-c-muted" data-testid="home-hero-progress">
              {Math.floor(heroProgress.fraction * 100)}%{heroProgress.timeLeft
                ? ` · ${heroProgress.timeLeft} left`
                : ''}
            </p>
          {/if}
          <div class="mt-auto pt-1">
            <button
              class="c-btn c-btn-primary"
              data-testid="home-hero-continue"
              on:click={openHero}
            >
              Continue reading
            </button>
          </div>
        </div>
      </div>
    {/if}
    {#if strip.length}
      <!-- WP19a: the Library's cover size, else the automatic widths. -->
      <ul
        class="c-strip grid grid-flow-col gap-4 pb-2 {size
          ? ''
          : 'auto-cols-[7rem] sm:auto-cols-[8.5rem]'}"
        style={size ? `grid-auto-columns: ${size}px` : undefined}
        data-testid="home-row-books"
      >
        {#each strip as book (book.id)}
          <LibraryBookCard
            {book}
            thumbnailUrl={thumbnailUrl(book)}
            state={stateOf(book)}
            progress={progressOf(book)}
            progressFraction={fractionOf(book)}
            blurred={blurredOf(book)}
            onDevice={onDevice.has(book.id)}
            {infoLine}
            on:open={(ev) => dispatch('open', ev.detail)}
            on:reveal={(ev) => dispatch('reveal', ev.detail)}
            on:state={(ev) => dispatch('state', ev.detail)}
            on:collect={(ev) => dispatch('collect', ev.detail)}
          />
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .c-hero {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  /* Room for the covers' hover lift inside the scrolling strip. */
  .c-strip {
    padding-top: 6px;
  }
</style>
