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
   * Season 2 §6: the illustrations strip (book-illustrations.svelte) under the description
   * or under the cover (the device's setting); a tap on the cover expands it.
   * Download (book-download-menu.svelte): the EPUB, and the linked audiobook file and
   * subtitles when there are any (the link comes up from the Audiobook section).
   */
  import {
    faBookOpen,
    faEllipsis,
    faHighlighter,
    faPlus,
    faTrashCan,
    faRotateRight
  } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { afterNavigate, goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import AudioLinkSection from '$lib/components/audio/audio-link-section.svelte';
  import BookDownloadMenu from '$lib/components/library/book-download-menu.svelte';
  import BookIllustrations from '$lib/components/library/book-illustrations.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import CoverImage from '$lib/components/library/cover-image.svelte';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import type { AudioLink } from '$lib/audio/audio-types';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { detailRows } from '$lib/library/book-details';
  import {
    collectionMembership,
    coverBlurDefault,
    isCoverBlurred,
    NO_COVER_RULES,
    type CoverBlurContext,
    type CoverRules
  } from '$lib/library/cover-blur';
  import type { Collection, CollectionItem } from '$lib/collections/collections';
  import { coverGrid } from '$lib/library/cover-size';
  import { descriptionParagraphs } from '$lib/library/description';
  import { authorHref, formatSeriesIndex } from '$lib/library/format';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import type { OfflineCatalog } from '$lib/library/offline/offline-catalog';
  import {
    askServerFirst,
    freshOfflineCatalog,
    isUnreachable,
    noteReachable,
    noteUnreachable,
    offlineCatalog,
    OFFLINE_NOTICE,
    saveOfflineDetail,
    saveOfflineLibraries,
    serverAnswersAgain,
    serverWorthAsking,
    startsOffline
  } from '$lib/library/offline/offline-source';
  import { isOnThisDevice, removeFromThisDevice } from '$lib/library/remove-from-device';
  import { bookProgressFraction, bookProgressLabel, positionsByBook } from '$lib/library/progress';
  import {
    bookIllustrationsPosition$,
    libraryCoverBlur$,
    libraryCoverSize$,
    libraryRequestTimeoutSeconds$
  } from '$lib/library/settings';
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
  /** Season 2 §2: the server can't be reached; the book's offline copy is shown. */
  let offline = false;
  let libraries: CatalogLibrary[] = [];
  let bookId = '';
  let book: CatalogBookDetail | null = null;
  let loading = true;
  let error = '';
  let notFound = false;
  let series: CatalogBook[] = [];
  let alsoBy: { author: string; books: CatalogBook[] }[] = [];
  let highlights = 0;
  /** WP15e: this device has a copy of the book (offers Remove from this device). */
  let onDeviceHere = false;
  /** Whether `onDeviceHere` is known for this book yet (the illustrations wait for it). */
  let onDeviceChecked = false;
  /** Season 2 §6: the illustrations strip (it also shows the expanded cover). */
  let illustrations: BookIllustrations | undefined;
  /** The book's audiobook link, from the Audiobook section (for the Download menu). */
  let audioLink: AudioLink | null = null;
  let states = new Map<string, BookState>();
  let coverRules: CoverRules = NO_COVER_RULES;
  let collectionList: Collection[] = [];
  let collectionItems = new Map<string, CollectionItem[]>();
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
  /** The status button shows the book's status ("Set status" while unread). */
  $: statusName = state && state.status !== 'unread' ? STATUS_LABELS[state.status] : '';
  let blurCtx: CoverBlurContext;
  $: blurCtx = {
    rules: coverRules,
    fallback: coverBlurDefault($libraryCoverBlur$),
    inCollection: collectionMembership({
      rules: coverRules,
      collections: collectionList,
      items: collectionItems,
      states
    })
  };
  $: coverBlurred = book
    ? !revealed.has(book.id) && isCoverBlurred(state?.blur, book, blurCtx)
    : false;
  $: gridLayout = coverGrid($libraryCoverSize$);
  // Season 2 §6: the device's setting (anything unknown counts as the default).
  $: illustrationsAt = $bookIllustrationsPosition$ === 'cover' ? 'cover' : 'description';
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
    const a = new LibraryApi(connection.serverUrl, connection.token, timeout);
    api = a;
    freshOfflineCatalog();
    // No network, or the server didn't answer a moment ago (another page): the copy on
    // this device at once, and the server is asked again in the background.
    offline = startsOffline();
    if (offline) {
      void recheckServer(connection);
    } else {
      const first = await askServerFirst(connection.serverUrl, (signal) => a.libraries({ signal }));
      if (first.status === 'ok') {
        libraries = first.value.libraries;
        void saveOfflineLibraries(libraries);
      } else if (first.status === 'unreachable') {
        offline = true;
      }
      // Other problems: the book request reports them.
    }
    if (offline && !libraries.length) {
      libraries = (
        await offlineCatalog()
          .libraries()
          .catch(() => ({ libraries: [] }))
      ).libraries;
    }
    await load();
  });

  /** Offline: when the server answers the quick check again, ask it for this book. */
  async function recheckServer(conn: LibraryConnection) {
    if (!(await serverAnswersAgain(conn.serverUrl))) return;
    if (!destroyed && offline && connection === conn) void tryServerAgain();
  }

  /** Who answers: the server, or the offline catalog while it can't be reached. */
  function source(): LibraryApi | OfflineCatalog | undefined {
    if (!api) return undefined;
    return offline ? offlineCatalog() : api;
  }

  /** "Try again": ask the server for this book again. */
  async function tryServerAgain() {
    // Away from home: no request timeout wait when the server still doesn't answer.
    if (connection && !(await serverWorthAsking(connection.serverUrl))) return;
    if (destroyed) return;
    offline = false;
    book = null;
    bookId = '';
    void load();
  }

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
    const [rules, records, coll] = await Promise.all([
      view.coverRules(),
      view.positions(),
      collections.view().catch(() => null)
    ]);
    coverRules = rules;
    if (coll) {
      collectionList = coll.collections;
      collectionItems = coll.items;
    }
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
    onDeviceHere = false;
    onDeviceChecked = false;
    audioLink = null;
    descriptionOpen = false;
    series = [];
    alsoBy = [];
    try {
      try {
        book = await (source() as LibraryApi | OfflineCatalog).book(id, {
          signal: controller.signal
        });
        if (!offline) {
          noteReachable();
          void saveOfflineDetail(book);
        }
      } catch (err) {
        // The server can't be reached: the copy on this device, when there is one.
        if (offline || !isUnreachable(err)) throw err;
        offline = true;
        noteUnreachable();
        if (!libraries.length) libraries = (await offlineCatalog().libraries()).libraries;
        try {
          book = await offlineCatalog().book(id, { signal: controller.signal });
        } catch (offlineErr) {
          if (offlineErr instanceof LibraryApiError && offlineErr.code === 'not_found') throw err;
          throw offlineErr;
        }
      }
    } catch (err) {
      if (err instanceof LibraryApiError && err.kind === 'aborted') return;
      book = null;
      if (err instanceof LibraryApiError && err.status === 404 && !offline) notFound = true;
      else error = describe(err);
      loading = false;
      return;
    }
    loading = false;
    void loadHighlights();
    void loadOnDevice();
    void loadRelated(book, controller.signal);
  }

  async function loadOnDevice() {
    const id = bookId;
    const here = await isOnThisDevice(id);
    if (id === bookId) {
      onDeviceHere = here;
      onDeviceChecked = true;
    }
  }

  /** WP15e: Remove from this device. */
  async function removeFromDevice(target: CatalogBook) {
    try {
      if (await removeFromThisDevice(target)) onDeviceHere = false;
    } catch (err) {
      showMessage('Not removed', (err as Error).message);
    }
  }

  /** The other volumes of the series and other books by each author. */
  async function loadRelated(current: CatalogBookDetail, signal: AbortSignal) {
    const a = source();
    if (!a) return;
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
      return 'The library server cannot be reached (offline, or the server is down), and the book is not on this device.';
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
        props: { bookId: target.id, title: target.title, api: collections, resolver: () => {} }
      }
    ]);
  }

  function thumb(b: CatalogBook) {
    return b.thumbnail && api ? api.absolute(b.thumbnail) : '';
  }

  function blurred(b: CatalogBook, ctx: CoverBlurContext) {
    return !revealed.has(b.id) && isCoverBlurred(states.get(b.id)?.blur, b, ctx);
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
  {/if}
  {#if offline && connection}
    <p class="c-notice flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="offline-notice">
      <span role="status">{OFFLINE_NOTICE}</span>
      <button
        class="c-btn c-btn-ghost c-btn-sm -my-1 gap-1.5 px-2.5"
        data-testid="offline-retry"
        on:click={tryServerAgain}><Fa icon={faRotateRight} />Try again</button
      >
    </p>
  {/if}
  {#if connection === null || (loading && !book)}
    <!-- Shown above. -->
  {:else if notFound}
    <p class="c-notice" data-testid="details-not-found">This book isn't in the library.</p>
  {:else if error}
    <p class="c-notice" role="alert">{error}</p>
  {:else if book}
    <div class="c-dgrid mt-2">
      <!-- Season 2 §6: a tap on the cover expands it (no longer opens the book); the
           illustrations strip sits under it when the device's setting says so. -->
      <div class="c-dcovercol">
        <button
          class="c-cover c-focus c-dcover relative aspect-[2/3] w-full overflow-hidden rounded-sm"
          aria-label={coverBlurred ? `Show cover: ${book.title}` : `Expand cover: ${book.title}`}
          data-testid="details-cover"
          on:click={() => (book && coverBlurred ? reveal(book) : illustrations?.openCover())}
        >
          <CoverImage src={thumb(book)} blurred={coverBlurred} />
          {#if book.series?.index !== null && book.series?.index !== undefined}
            <span class="c-dribbon">{formatSeriesIndex(book.series.index)}</span>
          {/if}
        </button>
        {#if illustrationsAt === 'cover'}
          <BookIllustrations
            bind:this={illustrations}
            {api}
            bookId={book.id}
            onDevice={onDeviceChecked ? onDeviceHere : null}
            {offline}
            variant="cover"
            coverThumb={thumb(book)}
          />
        {/if}
      </div>

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
        <!-- The actions (2026-11-21): Read (the one filled button) and the status button, then
             the soft ones; Remove from this device in ⋯. Phones: Read beside a Status tile, the
             rest as tiles in one row. -->
        <div class="c-dactions" data-testid="details-actions">
          <div class="c-dactions-main">
            {#if !book.missing}
              <button
                class="c-btn c-btn-primary c-dread"
                data-testid="details-read"
                on:click={() => book && open(book)}
              >
                <Fa icon={faBookOpen} />
                {readLabel}
              </button>
            {/if}
            <button
              class="c-btn c-btn-secondary c-dstatus"
              aria-label={statusName ? `Book status: ${statusName}` : 'Set book status'}
              data-testid="details-state"
              on:click={() => book && openBookState(book)}
            >
              <span class="c-dstatus-cap" aria-hidden="true">Status</span>
              <span class="c-dstatus-val" aria-hidden="true">
                {#if statusName}<span class="c-dstatus-dot" />{/if}
                {statusName || 'Set status'}
              </span>
            </button>
          </div>
          <div class="c-dactions-more">
            <button
              class="c-btn c-btn-secondary c-dtile"
              data-testid="details-collect"
              on:click={() => book && openAddToCollection(book)}
            >
              <Fa icon={faPlus} />
              <span class="c-dlong">Add to collection</span><span
                class="c-dshort"
                aria-hidden="true">Collection</span
              >
            </button>
            {#if api}
              <BookDownloadMenu
                {api}
                {book}
                link={audioLink}
                buttonClass="c-btn c-btn-secondary c-dtile"
                rootClass="c-dtile-wrap"
                on:error={(ev) => showMessage('Not downloaded', describe(ev.detail))}
              />
            {/if}
            {#if highlights > 0}
              <a
                class="c-btn c-btn-secondary c-dtile"
                href="{pagePath}/notes?book={encodeURIComponent(book.id)}"
                aria-label="Highlights ({highlights})"
                data-testid="details-highlights"
              >
                <Fa icon={faHighlighter} />
                Highlights
                <span class="c-count c-dtile-count" aria-hidden="true">{highlights}</span>
              </a>
            {/if}
            {#if onDeviceHere}
              <DropdownMenu
                buttonClass="c-btn c-btn-secondary c-dtile c-dmore"
                rootClass="c-dtile-wrap"
                align="right"
                label="More actions"
                testid="details-more-actions"
                panelWidth="w-64"
                let:close
              >
                <span slot="button" class="flex items-center gap-2">
                  <Fa icon={faEllipsis} />
                  <span class="c-dshort">More</span>
                  <span class="sr-only">More actions</span>
                </span>
                <button
                  type="button"
                  class="c-btn c-btn-ghost w-full justify-start gap-3 px-3 text-left text-c-seal"
                  data-testid="details-remove-device"
                  on:click={() => {
                    close();
                    if (book) void removeFromDevice(book);
                  }}
                >
                  <Fa icon={faTrashCan} />
                  Remove from this device
                </button>
              </DropdownMenu>
            {/if}
          </div>
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
                  class="c-chip c-chip-sm"
                  href={libraryHref('tags', tag)}
                  data-testid="details-tag">{tag}</a
                >
              {/each}
            </div>
          </div>
        {/if}
      </section>
    </div>

    {#if illustrationsAt === 'description'}
      <BookIllustrations
        bind:this={illustrations}
        {api}
        bookId={book.id}
        onDevice={onDeviceChecked ? onDeviceHere : null}
        {offline}
        variant="description"
        coverThumb={thumb(book)}
      />
    {/if}

    {#if api}
      <AudioLinkSection
        {api}
        bookId={book.id}
        {book}
        {store}
        {libraries}
        bind:bookOnDevice={onDeviceHere}
        bind:link={audioLink}
      />
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
              blurred={blurred(b, blurCtx)}
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
              blurred={blurred(b, blurCtx)}
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

  /* The cover and, when the setting says so, the illustrations strip under it. */
  .c-dcovercol {
    grid-area: cover;
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 1.25rem;
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

  /* The actions: [Read][Status]   [Add to collection][Download][Highlights][⋯], the two
     groups apart by a wider gap (no rule, which was left dangling when the row wrapped). */
  .c-dactions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.625rem 1.25rem;
    margin-top: 0.25rem;
  }

  .c-dactions-main,
  .c-dactions-more {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .c-dread {
    min-height: calc(var(--c-btn-h) + 0.375rem);
    padding: 0 1.35rem 0 1.15rem;
    font-size: 0.9375rem;
  }

  .c-dstatus {
    min-height: calc(var(--c-btn-h) + 0.375rem);
  }

  .c-dstatus-cap,
  .c-dshort {
    display: none;
  }

  .c-dstatus-val {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .c-dstatus-dot {
    width: 0.5rem;
    height: 0.5rem;
    flex: none;
    border-radius: 9999px;
    background-color: var(--c-fill);
  }

  .c-dtile-count {
    font-variant-numeric: tabular-nums;
  }

  /* Phones: Read across three quarters beside the Status tile; the rest share one row of
     tiles, icon over label. */
  @media (max-width: 599px) {
    .c-dactions {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .c-dactions-main {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .c-dread {
      grid-column: span 3;
    }

    .c-dstatus:first-child {
      grid-column: 1 / -1;
    }

    .c-dstatus {
      flex-direction: column;
      gap: 0.1875rem;
      padding: 0 0.25rem;
    }

    .c-dstatus-cap {
      display: block;
      font-size: 0.6875rem;
      font-weight: 500;
      line-height: 1;
      letter-spacing: 0.04em;
      color: var(--c-muted);
    }

    .c-dstatus-val {
      gap: 0.3125rem;
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1;
    }

    .c-dactions-more {
      flex-wrap: nowrap;
    }

    .c-dactions-more > :global(*) {
      flex: 1 1 0;
      min-width: 0;
    }

    :global(.c-dtile-wrap) {
      display: flex;
    }

    .c-dactions :global(.c-dtile) {
      position: relative;
      width: 100%;
      min-height: 4.25rem;
      flex-direction: column;
      gap: 0.375rem;
      padding: 0 0.25rem;
      font-size: 0.75rem;
    }

    .c-dactions :global(.c-dtile > span) {
      flex-direction: column;
      gap: 0.375rem;
    }

    /* svelte-fa sizes its icon at 1em. */
    .c-dactions :global(.c-dtile svg) {
      font-size: 1.125rem;
    }

    .c-dlong,
    .c-dactions :global(.c-download-chevron) {
      display: none;
    }

    .c-dactions :global(.c-dshort) {
      display: inline;
    }

    .c-dtile-count {
      position: absolute;
      top: 0.375rem;
      right: 0.5rem;
    }
  }
</style>
