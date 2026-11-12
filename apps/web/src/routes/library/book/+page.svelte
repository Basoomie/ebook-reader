<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A catalog book's details (WP19c; the "Archive" look of WP19b): cover, title, authors,
   * series, progress, Continue reading / Read, Book status…, Add to collection…,
   * Highlights; the description (as text, collapsed after a few lines); "About this book"
   * (publisher, dates, length, file size, library) with the tags; the other volumes of
   * the series and other books by each author. The address is /library/book?id=<id>.
   * WP15b: the "Audiobook" section (the confirmation picker) between About and Series.
   */
  import { afterNavigate, goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import AudioLinkSection from '$lib/components/audio/audio-link-section.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import CoverImage from '$lib/components/library/cover-image.svelte';
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { detailRows } from '$lib/library/book-details';
  import { isCoverBlurred } from '$lib/library/cover-blur';
  import { coverGrid } from '$lib/library/cover-size';
  import { descriptionParagraphs } from '$lib/library/description';
  import { authorHref, formatSeriesIndex } from '$lib/library/format';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import { bookProgressFraction, bookProgressLabel, positionsByBook } from '$lib/library/progress';
  import { libraryCoverSize$, libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { CatalogBook, CatalogBookDetail, CatalogLibrary } from '$lib/library/types';
  import { STATUS_LABELS, type BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import { bookStateApi, collectionsApi, libraryViewApi, notesApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount } from 'svelte';

  /** Books per "Series" / "Also by" row. */
  const ROW_BOOKS = 12;
  /** Authors that get their own "Also by" row. */
  const AUTHOR_ROWS = 2;

  const store = getLibraryStore();
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();
  const notes = notesApi();

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let libraries: CatalogLibrary[] = [];
  let bookId = '';
  let book: CatalogBookDetail | null = null;
  let loading = true;
  let error = '';
  let notFound = false;
  let series: CatalogBook[] = [];
  let alsoBy: { author: string; books: CatalogBook[] }[] = [];
  let highlights = 0;
  let states = new Map<string, BookState>();
  let tagRules = new Set<string>();
  let positions = new Map<string, LocalRecord[]>();
  let revealed = new Set<string>();
  let descriptionOpen = false;
  /** Where Back goes: the previous page (history) when the app came from one. */
  let cameFromApp = false;
  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  let loadController: AbortController | undefined;

  $: state = book ? states.get(book.id) : undefined;
  $: paragraphs = descriptionParagraphs(book?.description);
  $: longDescription = paragraphs.join('').length > 220 || paragraphs.length > 3;
  $: rows = book
    ? detailRows(book, libraries.find((l) => l.id === book?.libraryId)?.name ?? '')
    : [];
  $: progressLabel = book
    ? bookProgressLabel(book.id, state, positions.get(book.id) ?? [], book.charCount)
    : null;
  $: fraction = book
    ? bookProgressFraction(book.id, state, positions.get(book.id) ?? [], book.charCount)
    : null;
  $: statusText = [
    state && state.status !== 'unread' ? STATUS_LABELS[state.status] : '',
    progressLabel && progressLabel !== 'Finished' ? progressLabel : ''
  ]
    .filter(Boolean)
    .join(' · ');
  $: readLabel = fraction !== null ? 'Continue reading' : 'Read';
  $: coverBlurred = book
    ? !revealed.has(book.id) && isCoverBlurred(state?.blur, book.tags, tagRules)
    : false;
  $: gridLayout = coverGrid($libraryCoverSize$);
  $: seriesLabel = book?.series
    ? `${book.series.name}${book.series.index !== null ? ` · 第${formatSeriesIndex(book.series.index)}巻` : ''}`
    : '';

  onMount(async () => {
    const subscriptions = [
      bookState.onChanged(() => void loadStates()),
      view.onChanged(() => void loadViewData()),
      notes.onChanged(() => void loadHighlights())
    ];
    for (const sub of subscriptions) {
      void sub.then((off) => {
        if (destroyed) off();
        else stopListeners.push(off);
      });
    }
    void loadStates();
    void loadViewData();
    connection = (await store.getConnection()) ?? null;
    if (!connection) {
      loading = false;
      return;
    }
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new LibraryApi(connection.serverUrl, connection.token, timeout);
    try {
      libraries = (await api.libraries()).libraries;
    } catch {
      // The book request reports connection problems.
    }
    await load();
  });

  onDestroy(() => {
    destroyed = true;
    stopListeners.forEach((off) => off());
    loadController?.abort();
    opening?.controller.abort();
  });

  // Another book's details (a volume in the series row) is a navigation to this same page.
  afterNavigate((nav) => {
    cameFromApp = !!nav.from;
    if (api) void load();
  });

  async function loadStates() {
    try {
      states = await bookState.getAll();
    } catch (err) {
      logger.warn(`Details: could not read book states: ${(err as Error).message}`);
    }
  }

  async function loadViewData() {
    const [rules, records] = await Promise.all([view.tagBlurRules(), view.positions()]);
    tagRules = rules;
    positions = positionsByBook(records);
  }

  async function loadHighlights() {
    if (!bookId) return;
    highlights = (await notes.ofBook(bookId)).highlights.length;
  }

  async function load() {
    const id = browser ? ($page.url.searchParams.get('id') ?? '') : '';
    if (!api || !id) {
      loading = false;
      notFound = !id;
      return;
    }
    if (id === bookId && book) return;
    bookId = id;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    loading = true;
    error = '';
    notFound = false;
    descriptionOpen = false;
    series = [];
    alsoBy = [];
    try {
      book = await api.book(id, { signal: controller.signal });
    } catch (err) {
      if (err instanceof LibraryApiError && err.kind === 'aborted') return;
      book = null;
      if (err instanceof LibraryApiError && err.status === 404) notFound = true;
      else error = describe(err);
      loading = false;
      return;
    }
    loading = false;
    void loadHighlights();
    void loadRelated(book, controller.signal);
  }

  /** The other volumes of the series and other books by each author. */
  async function loadRelated(current: CatalogBookDetail, signal: AbortSignal) {
    if (!api) return;
    const a = api;
    try {
      if (current.series) {
        const page = await a.books(
          { group: { by: 'series', name: current.series.name }, limit: 50 },
          { signal }
        );
        series = page.books;
      }
      const seen = new Set([current.id, ...series.map((b) => b.id)]);
      const rowsOut: { author: string; books: CatalogBook[] }[] = [];
      for (const author of current.authors.slice(0, AUTHOR_ROWS)) {
        const page = await a.books(
          { group: { by: 'author', name: author.name }, limit: ROW_BOOKS + 8 },
          { signal }
        );
        const books = page.books.filter((b) => !seen.has(b.id)).slice(0, ROW_BOOKS);
        books.forEach((b) => seen.add(b.id));
        if (books.length) rowsOut.push({ author: author.name, books });
      }
      alsoBy = rowsOut;
    } catch (err) {
      if (err instanceof LibraryApiError && err.kind === 'aborted') return;
      logger.warn(`Details: related books: ${(err as Error).message}`);
    }
  }

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  function back() {
    if (cameFromApp) history.back();
    else void goto(`${pagePath}/library`);
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  async function open(target: CatalogBook) {
    if (!api || opening) return;
    const controller = new AbortController();
    opening = { book: target, stage: null, controller };
    try {
      const outcome = await openCatalogBook(
        target,
        api,
        store,
        libraries,
        controller.signal,
        (stage) => {
          if (opening) opening = { ...opening, stage };
        }
      );
      if (outcome.status === 'opened') {
        await goto(`${pagePath}/b?id=${outcome.localId}`);
        return;
      }
      if (outcome.status === 'refused') showMessage('Not opened', outcome.message);
    } catch (err) {
      logger.warn(`Details: opening "${target.title}" failed: ${(err as Error).message}`);
      showMessage('Could not open the book', describe(err));
    } finally {
      opening = null;
    }
  }

  function openBookState(target: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: BookStateDialog,
        disableCloseOnClick: true,
        props: {
          bookId: target.id,
          title: target.title,
          charCount: target.charCount,
          api: bookState,
          collections,
          resolver: () => {}
        }
      }
    ]);
  }

  function openAddToCollection(target: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: AddToCollectionDialog,
        disableCloseOnClick: true,
        props: { bookId: target.id, title: target.title, api: collections, resolver: () => {} }
      }
    ]);
  }

  function thumb(b: CatalogBook) {
    return b.thumbnail && api ? api.absolute(b.thumbnail) : '';
  }

  function blurred(b: CatalogBook) {
    return !revealed.has(b.id) && isCoverBlurred(states.get(b.id)?.blur, b.tags, tagRules);
  }

  function reveal(b: CatalogBook) {
    revealed = new Set([...revealed, b.id]);
  }

  function libraryHref(tab: string, name: string) {
    return `${pagePath}/library?${new URLSearchParams({ tab, group: name }).toString()}`;
  }
</script>

<svelte:head>
  <title>{formatPageTitle(book?.title ?? 'Book')}</title>
</svelte:head>

<AppHeader title="Book" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="book-details-page">
  <button
    class="c-link mt-4 inline-flex min-h-[3rem] items-center gap-2 text-sm"
    data-testid="details-back"
    on:click={back}
  >
    ← Back
  </button>

  {#if connection === null}
    <p class="c-notice" data-testid="not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {:else if loading && !book}
    <p class="py-8 text-c-muted">Loading…</p>
  {:else if notFound}
    <p class="c-notice" data-testid="details-not-found">This book isn't in the library.</p>
  {:else if error}
    <p class="c-notice" role="alert">{error}</p>
  {:else if book}
    <div class="c-dgrid mt-2">
      <button
        class="c-cover c-focus c-dcover relative aspect-[2/3] w-full overflow-hidden rounded-sm"
        aria-label={coverBlurred ? `Show cover: ${book.title}` : `${readLabel}: ${book.title}`}
        data-testid="details-cover"
        disabled={book.missing}
        on:click={() => (book && coverBlurred ? reveal(book) : book && open(book))}
      >
        <CoverImage src={thumb(book)} blurred={coverBlurred} />
        {#if book.series?.index !== null && book.series?.index !== undefined}
          <span class="c-dribbon">{formatSeriesIndex(book.series.index)}</span>
        {/if}
      </button>

      <div class="c-dmain flex min-w-0 flex-col gap-3">
        {#if seriesLabel}
          <a
            class="c-jp-label c-link inline-flex min-h-[2.75rem] items-center self-start tracking-[0.2em]"
            href={libraryHref('series', book.series?.name ?? '')}
            data-testid="details-series-link">{seriesLabel}</a
          >
        {/if}
        <h1
          class="break-words font-mincho text-3xl font-bold leading-snug sm:text-[2.4rem]"
          data-testid="details-title"
        >
          {book.title}
        </h1>
        {#if book.authors.length}
          <div class="-my-2 text-[15px]">
            {#each book.authors as author, i (i)}<a
                class="c-link inline-flex min-h-[2.75rem] items-center"
                href={authorHref(pagePath, author.name)}
                data-testid="details-author">{author.name}</a
              >{i < book.authors.length - 1 ? ', ' : ''}{/each}
          </div>
        {/if}
        {#if book.missing}
          <p class="c-notice font-medium" data-testid="details-missing">
            No longer in the library: the book was removed from Calibre. Its reading data is kept.
          </p>
        {/if}
        {#if fraction !== null || statusText}
          <div class="flex flex-wrap items-center gap-3">
            {#if fraction !== null}
              <div class="c-progress h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-c-track">
                <div class="h-full bg-c-fill" style="width: {Math.round(fraction * 100)}%" />
              </div>
            {/if}
            <span class="text-sm text-c-muted" data-testid="details-status">{statusText}</span>
          </div>
        {/if}
        <div class="mt-1 flex flex-wrap gap-2">
          {#if !book.missing}
            <button
              class="c-btn c-btn-primary c-round px-6"
              data-testid="details-read"
              on:click={() => book && open(book)}
            >
              {readLabel}
            </button>
          {/if}
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="details-state"
            on:click={() => book && openBookState(book)}
          >
            Book status…
          </button>
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="details-collect"
            on:click={() => book && openAddToCollection(book)}
          >
            Add to collection
          </button>
          {#if highlights > 0}
            <a
              class="c-btn c-btn-secondary c-round"
              href="{pagePath}/notes?book={encodeURIComponent(book.id)}"
              data-testid="details-highlights"
            >
              Highlights ({highlights})
            </a>
          {/if}
        </div>
      </div>

      {#if paragraphs.length}
        <section
          class="c-ddesc min-w-0 border-t pt-5"
          style="border-color: var(--c-gold)"
          aria-labelledby="details-desc"
        >
          <h2 id="details-desc" class="flex items-baseline gap-3">
            <span class="font-mincho text-lg font-bold text-c-label">内容紹介</span>
            <span class="text-sm text-c-muted">Description</span>
          </h2>
          <div
            class="mt-2 flex flex-col gap-3 text-[15px] leading-loose"
            class:c-clamped={longDescription && !descriptionOpen}
            data-testid="details-description"
          >
            {#each paragraphs as p}<p class="whitespace-pre-line">{p}</p>{/each}
          </div>
          {#if longDescription}
            <button
              class="c-link mt-1 min-h-[2.75rem] text-sm"
              aria-expanded={descriptionOpen}
              data-testid="details-more"
              on:click={() => (descriptionOpen = !descriptionOpen)}
            >
              {descriptionOpen ? 'Less' : 'More'}
            </button>
          {/if}
        </section>
      {/if}

      <section class="c-dinfo c-dpanel min-w-0 rounded px-6 py-5" aria-labelledby="details-about">
        <div class="flex items-baseline justify-between">
          <h2 id="details-about" class="flex items-baseline gap-3">
            <span class="font-mincho text-lg font-bold text-c-label">書誌</span>
            <span class="text-sm text-c-muted">About this book</span>
          </h2>
          <span class="c-seal" aria-hidden="true">蔵<br />書</span>
        </div>
        <dl class="mt-3 grid grid-cols-[7rem_minmax(0,1fr)]" data-testid="details-rows">
          {#each rows as row (row.label)}
            <dt class="c-drow py-2.5 text-xs text-c-muted">
              <span class="font-mincho font-bold text-c-label">{row.jp}</span>
              {row.label}
            </dt>
            <dd class="c-drow break-words py-2.5 text-sm">{row.value}</dd>
          {/each}
        </dl>
        {#if book.tags.length}
          <div class="mt-4 flex flex-col gap-2">
            <span class="text-xs text-c-muted">
              <span class="font-mincho font-bold text-c-label">分類</span> Tags
            </span>
            <div class="flex flex-wrap gap-2">
              {#each book.tags as tag (tag)}
                <a
                  class="c-btn c-btn-secondary min-h-[2.5rem] rounded-full px-3 text-sm"
                  href={libraryHref('tags', tag)}
                  data-testid="details-tag">{tag}</a
                >
              {/each}
            </div>
          </div>
        {/if}
      </section>
    </div>

    {#if api}
      <AudioLinkSection {api} bookId={book.id} />
    {/if}

    {#if series.length > 1 && book.series}
      <section class="mt-12" aria-labelledby="details-series" data-testid="details-series">
        <div class="flex items-center gap-4">
          <h2 id="details-series" class="flex items-baseline gap-3">
            <span class="font-mincho text-2xl font-bold">Series</span>
            <span class="c-jp-label text-xs" aria-hidden="true">同じシリーズ</span>
          </h2>
          <span class="c-section-rule" />
          <a
            class="c-link min-h-[3rem] shrink-0 text-sm leading-[3rem]"
            href={libraryHref('series', book.series.name)}>All {series.length} volumes</a
          >
        </div>
        <ul class="mt-4 {gridLayout.classes}" style={gridLayout.style || undefined}>
          {#each series as b (b.id)}
            <LibraryBookCard
              book={b}
              thumbnailUrl={thumb(b)}
              state={states.get(b.id)}
              progress={bookProgressLabel(
                b.id,
                states.get(b.id),
                positions.get(b.id) ?? [],
                b.charCount
              )}
              progressFraction={bookProgressFraction(
                b.id,
                states.get(b.id),
                positions.get(b.id) ?? [],
                b.charCount
              )}
              blurred={blurred(b)}
              selected={b.id === book.id}
              on:open={(ev) => open(ev.detail)}
              on:reveal={(ev) => reveal(ev.detail)}
              on:state={(ev) => openBookState(ev.detail)}
              on:collect={(ev) => openAddToCollection(ev.detail)}
            />
          {/each}
        </ul>
      </section>
    {/if}

    {#each alsoBy as row (row.author)}
      <section class="mt-12" data-testid="details-also-by">
        <div class="flex items-center gap-4">
          <h2 class="flex min-w-0 items-baseline gap-3">
            <span class="truncate font-mincho text-2xl font-bold">Also by {row.author}</span>
            <span class="c-jp-label shrink-0 text-xs" aria-hidden="true">同じ著者の本</span>
          </h2>
          <span class="c-section-rule" />
          <a
            class="c-link min-h-[3rem] shrink-0 text-sm leading-[3rem]"
            href={authorHref(pagePath, row.author)}>See all</a
          >
        </div>
        <ul class="mt-4 {gridLayout.classes}" style={gridLayout.style || undefined}>
          {#each row.books as b (b.id)}
            <LibraryBookCard
              book={b}
              thumbnailUrl={thumb(b)}
              state={states.get(b.id)}
              progress={bookProgressLabel(
                b.id,
                states.get(b.id),
                positions.get(b.id) ?? [],
                b.charCount
              )}
              progressFraction={bookProgressFraction(
                b.id,
                states.get(b.id),
                positions.get(b.id) ?? [],
                b.charCount
              )}
              blurred={blurred(b)}
              on:open={(ev) => open(ev.detail)}
              on:reveal={(ev) => reveal(ev.detail)}
              on:state={(ev) => openBookState(ev.detail)}
              on:collect={(ev) => openAddToCollection(ev.detail)}
            />
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<AppBottomBar />

{#if opening}
  <LibraryOpenOverlay
    title={opening.book.title}
    stage={opening.stage}
    on:cancel={() => opening?.controller.abort()}
  />
{/if}

<style>
  /* Cover | title and buttons | About this book; the description spans under the first two. */
  .c-dgrid {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr) minmax(18rem, 22rem);
    grid-template-areas:
      'cover main info'
      'desc desc info';
    column-gap: 2.5rem;
    row-gap: 1.75rem;
    align-items: start;
  }

  @media (max-width: 1023px) {
    .c-dgrid {
      grid-template-columns: 12rem minmax(0, 1fr);
      grid-template-areas:
        'cover main'
        'desc desc'
        'info info';
    }
  }

  @media (max-width: 599px) {
    .c-dgrid {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'cover' 'main' 'desc' 'info';
    }

    .c-dcover {
      max-width: 11rem;
    }
  }

  .c-dcover {
    grid-area: cover;
  }

  .c-dmain {
    grid-area: main;
  }

  .c-ddesc {
    grid-area: desc;
  }

  .c-dinfo {
    grid-area: info;
  }

  .c-dpanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
    border-top: 3px double var(--c-gold);
    border-bottom: 3px double var(--c-gold);
  }

  .c-drow {
    border-bottom: 1px dashed var(--c-line);
  }

  .c-seal {
    display: inline-flex;
    width: 2.1rem;
    height: 2.1rem;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--c-seal);
    color: var(--c-seal);
    font-family: 'Shippori Mincho', serif;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.05;
    text-align: center;
    transform: rotate(-6deg);
  }

  .c-dribbon {
    position: absolute;
    top: 0;
    left: 0.9rem;
    min-width: 1.8rem;
    padding: 0.35rem 0.4rem 0.75rem;
    background-color: var(--c-seal);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    text-align: center;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  }

  /* About six lines of the description until "More". */
  .c-clamped {
    max-height: 12.5rem;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, #000 70%, transparent);
  }

  :global(html.eink) .c-clamped {
    mask-image: none;
  }

  /* The details page's buttons are rounded (decided with the user). */
  .c-round {
    border-radius: 0.75rem;
  }
</style>
