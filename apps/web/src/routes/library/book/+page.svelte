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
  import SummarySection from '$lib/components/summaries/summary-section.svelte';
  import BookDescription from '$lib/components/summaries/book-description.svelte';
  import BookDownloadMenu from '$lib/components/library/book-download-menu.svelte';
  import BookLinks from '$lib/components/library/book-links.svelte';
  import NativelyLevelTag from '$lib/components/library/natively-level.svelte';
  import { hasDirectNatively, withNativelyLevel } from '$lib/library/natively-level';
  import { sortTags } from '$lib/library/tag-kinds';
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
  import { coverSize } from '$lib/library/cover-size';
  import { descriptionParagraphs } from '$lib/library/description';
  import {
    authorHref,
    formatSeriesIndex,
    illustratorQuery,
    libraryQueryHref
  } from '$lib/library/format';
  import { bookLinksPlacement$ } from '$lib/book-links/settings';
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
  import {
    bookStateApi,
    collectionsApi,
    libraryViewApi,
    notesApi,
    recentlyViewedApi
  } from '$lib/sync/sync-service';
  import { ViewTimer } from '$lib/recently-viewed/view-timer';
  import { currentDwellSeconds, recentlyViewedOn$ } from '$lib/recently-viewed/settings';
  import { onDestroy, onMount } from 'svelte';
  import BookEditForm from '$lib/components/calibre-edit/book-edit-form.svelte';
  import BookHistoryPanel from '$lib/components/calibre-edit/book-history-panel.svelte';
  import SeriesEdit from '$lib/components/calibre-edit/series-edit.svelte';
  import StoreRatingsLine from '$lib/components/library/store-ratings-line.svelte';
  import { CalibreEditApi } from '$lib/calibre-edit/api';
  import { bookEditAs$, bookRatingEmpty$, seriesEditAs$ } from '$lib/calibre-edit/settings';
  import { editableBook, notWritten, stillWaiting, withSaved } from '$lib/calibre-edit/overlay';
  import { fieldLabel } from '$lib/calibre-edit/format';
  import type { EditValues, FieldStatus } from '$lib/calibre-edit/types';
  import { serverReachability } from '$lib/library/offline/reachability';
  import { faClockRotateLeft, faPen } from '@fortawesome/free-solid-svg-icons';

  /** Books per "Series" / "Also by" row. */
  const ROW_BOOKS = 12;
  /** Authors that get their own "Also by" row. */
  const AUTHOR_ROWS = 2;

  const store = getLibraryStore();
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();
  const notes = notesApi();
  const recentlyViewed = recentlyViewedApi();

  /**
   * Recently viewed (2026-11-24): the book counts once its page has been visible for the
   * set time. Never blocks the page: recording failures are only logged.
   */
  const viewTimer = new ViewTimer({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    record: (id) => {
      if ($recentlyViewedOn$) void recentlyViewed.record(id);
    }
  });
  const onVisibility = () => viewTimer.visibilityChanged();

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
  /** Where Back goes: the previous page (history) when the app came from one. */
  let cameFromApp = false;
  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  let loadController: AbortController | undefined;
  /** Calibre metadata editing (tier 3 item 2): the client, the open panels, a saved edit. */
  let editApi: CalibreEditApi | undefined;
  let editing = false;
  let historyOpen = false;
  let seriesEditing: string | null = null;
  /** The values just saved, shown at once until the library has them. */
  let saved: Partial<EditValues> | null = null;
  let savedCover: string | null = null;
  let editStatus: FieldStatus[] = [];
  let editPoll: ReturnType<typeof setInterval> | undefined;

  $: state = book ? states.get(book.id) : undefined;
  // The page shows a saved edit at once (design: until the library shows it).
  $: shown = book ? withSaved(book, saved) : null;
  $: canEdit = editableBook(book);
  $: editOffline = offline || serverReachability.knownUnreachable();
  $: waitingForLibrary = !!saved && stillWaiting(editStatus);
  $: refused = notWritten(editStatus);
  $: showRating = !!shown && (!!shown.rating || $bookRatingEmpty$ === 'show');
  $: paragraphs = descriptionParagraphs(shown?.description);
  $: rows = shown
    ? detailRows(shown, libraries.find((l) => l.id === shown?.libraryId)?.name ?? '')
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
  // The Series and Also by rows scroll sideways like Home's rows (2026-11-23): the Library's
  // cover size, else Home's automatic widths.
  $: stripSize = coverSize($libraryCoverSize$);
  $: stripClass = `c-strip grid grid-flow-col gap-4 pb-2 ${
    stripSize ? '' : 'auto-cols-[7rem] sm:auto-cols-[8.5rem]'
  }`;
  $: stripStyle = stripSize ? `grid-auto-columns: ${stripSize}px` : undefined;

  /** Scrolls the Series row sideways so this book's volume is in view (never the page). */
  function showCurrent(node: HTMLElement, id: string) {
    const run = (current: string) => {
      requestAnimationFrame(() => {
        const card = node.querySelector<HTMLElement>(`[data-book-id="${CSS.escape(current)}"]`);
        if (!card) return;
        const box = node.getBoundingClientRect();
        const at = card.getBoundingClientRect();
        node.scrollLeft = Math.max(
          0,
          node.scrollLeft + (at.left - box.left) - (box.width - at.width) / 2
        );
      });
    };
    run(id);
    return { update: run };
  }
  // Season 2 §6: the device's setting (anything unknown counts as the default).
  $: illustrationsAt = $bookIllustrationsPosition$ === 'cover' ? 'cover' : 'description';
  // Where the links go (Settings > Library, per device; anything unknown is the default).
  $: linksAt =
    $bookLinksPlacement$ === 'buttons' || $bookLinksPlacement$ === 'panel'
      ? $bookLinksPlacement$
      : 'section';
  $: illustrators = shown?.illustrators ?? [];
  // The format above the title, the other tags by kind (2026-11-24).
  $: sortedTags = sortTags((shown ?? book)?.tags ?? []);
  $: seriesLabel = shown?.series
    ? `${shown.series.name}${shown.series.index !== null ? ` · 第${formatSeriesIndex(shown.series.index)}巻` : ''}`
    : '';

  onMount(async () => {
    document.addEventListener('visibilitychange', onVisibility);
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
    editApi = new CalibreEditApi(connection.serverUrl, connection.token, timeout || 30);
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
    viewTimer.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    clearInterval(editPoll);
    if (savedCover) URL.revokeObjectURL(savedCover);
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
    if (id !== bookId) {
      forgetSaved();
      viewTimer.stop();
    }
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
    if ($recentlyViewedOn$) viewTimer.start(book.id, currentDwellSeconds());
    void loadHighlights();
    void loadOnDevice();
    void loadRelated(book, controller.signal);
    void refreshNativelyLevel(book, controller.signal);
  }

  /**
   * The Natively level (2026-11-24): the saved one shows at once; when it is older than the
   * server's setting the server reads it again and the page updates in place. Offline the saved
   * one stays.
   */
  async function refreshNativelyLevel(target: CatalogBookDetail, signal: AbortSignal) {
    if (offline || !api || !hasDirectNatively(target)) return;
    try {
      const answer = await api.nativelyLevel(target.id, true, { signal, timeoutSeconds: 40 });
      if (signal.aborted || !book || book.id !== target.id) return;
      const next = withNativelyLevel(book, answer);
      if (next !== book) {
        book = next;
        void saveOfflineDetail(next);
      }
    } catch {
      // An older server, or Natively unreachable: the saved level stays.
    }
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

  /** After a save: the new values at once, then the library's state every 10 s until shown. */
  function onSaved(values: Partial<EditValues>, cover: string | null) {
    saved = { ...(saved ?? {}), ...values };
    if (cover) {
      if (savedCover) URL.revokeObjectURL(savedCover);
      savedCover = cover;
    }
    editStatus = [];
    void pollEdits();
    clearInterval(editPoll);
    editPoll = setInterval(() => void pollEdits(), 10_000);
  }

  async function pollEdits() {
    if (!editApi || !bookId) return;
    try {
      editStatus = (await editApi.status(bookId)).status;
    } catch {
      return; // asked again on the next tick
    }
    if (!stillWaiting(editStatus)) {
      clearInterval(editPoll);
      // The library shows it now: read the book again (the saved values come from it).
      const id = bookId;
      const fresh = await api?.book(id).catch(() => null);
      if (fresh && id === bookId) {
        book = fresh;
        void saveOfflineDetail(fresh);
        if (!refused.length) forgetSaved();
      }
    }
  }

  function forgetSaved() {
    clearInterval(editPoll);
    saved = null;
    editStatus = [];
    if (savedCover) URL.revokeObjectURL(savedCover);
    savedCover = null;
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
          <CoverImage src={savedCover ?? thumb(book)} blurred={coverBlurred} />
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
        {#if sortedTags.formats.length || seriesLabel || shown?.nativelyLevel}
          <!-- The format, the series line, and the Natively level's tag after it (placement C,
               2026-11-24). The format opens the Library's tag of that name. -->
          <div class="flex min-h-[2.75rem] flex-wrap items-center gap-x-3 gap-y-1 self-start">
            {#each sortedTags.formats as format (format)}
              <a
                class="c-jp-label c-link inline-flex min-h-[2.75rem] items-center tracking-[0.2em] !text-c-seal"
                href={libraryHref('tags', format)}
                data-testid="details-format">{format}</a
              >
            {/each}
            {#if seriesLabel}
              <a
                class="c-jp-label c-link inline-flex min-h-[2.75rem] items-center tracking-[0.2em]"
                href={libraryHref('series', book.series?.name ?? '')}
                data-testid="details-series-link">{seriesLabel}</a
              >
            {/if}
            {#if shown?.nativelyLevel}
              <NativelyLevelTag level={shown.nativelyLevel} testid="details-natively-level" />
            {/if}
          </div>
        {/if}
        <h1
          class="break-words font-mincho text-3xl font-bold leading-snug sm:text-[2.4rem]"
          data-testid="details-title"
        >
          {shown?.title ?? book.title}
        </h1>
        {#if (shown ?? book).authors.length || illustrators.length}
          <!-- The byline: "<author>, illustrated by <illustrator>"; each illustrator opens the
               Library filtered by illustrator:"<name>". -->
          <div class="-my-2 text-[15px]" data-testid="details-byline">
            {#each (shown ?? book).authors as author, i (i)}<a
                class="c-link inline-flex min-h-[2.75rem] items-center"
                href={authorHref(pagePath, author.name)}
                data-testid="details-author">{author.name}</a
              >{i < (shown ?? book).authors.length - 1
                ? ', '
                : ''}{/each}{#if illustrators.length}<span class="text-c-muted"
                >{(shown ?? book).authors.length ? ', illustrated by ' : 'Illustrated by '}</span
              >{#each illustrators as name, i (i)}<a
                  class="c-link inline-flex min-h-[2.75rem] items-center"
                  href={libraryQueryHref(pagePath, illustratorQuery(name))}
                  title="Opens the illustrator's books"
                  data-testid="details-illustrator">{name}</a
                >{i < illustrators.length - 1 ? ', ' : ''}{/each}{/if}
          </div>
        {/if}
        {#if shown}
          <!-- Ratings under the byline (redesign 2026-11-25): other readers' stars on one line
               with your own rating beside it; a book without your rating follows the device's
               setting (hidden by default). -->
          <StoreRatingsLine
            book={shown}
            api={api ?? null}
            {offline}
            yourRating={shown.rating ?? null}
            showYours={showRating}
          />
        {/if}
        {#if waitingForLibrary}
          <p class="text-sm text-c-muted" role="status" data-testid="details-edit-waiting">
            Saved · waiting for the library to show it (about 1–11 minutes)
          </p>
        {/if}
        {#if refused.length}
          <p class="c-notice text-sm" role="alert" data-testid="details-edit-refused">
            Not written to Calibre: {refused
              .map((r) => `${fieldLabel(r.field)} (${r.reason ?? 'no reason given'})`)
              .join('; ')}
          </p>
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
            {#if onDeviceHere || canEdit}
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
                {#if canEdit}
                  <button
                    type="button"
                    class="c-btn c-btn-ghost w-full justify-start gap-3 px-3 text-left"
                    disabled={editOffline}
                    title={editOffline ? 'The history needs the library server' : undefined}
                    data-testid="details-history"
                    on:click={() => {
                      close();
                      historyOpen = true;
                    }}
                  >
                    <Fa icon={faClockRotateLeft} />
                    History of changes
                  </button>
                {/if}
                {#if onDeviceHere}
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
                {/if}
              </DropdownMenu>
            {/if}
          </div>
        </div>
        {#if linksAt === 'buttons'}
          <BookLinks {book} variant="buttons" nativelyLevel={shown?.nativelyLevel} />
        {/if}
      </div>

      {#if paragraphs.length}
        <section
          class="c-ddesc min-w-0 border-t pt-5"
          style="border-color: var(--c-gold)"
          aria-labelledby="details-desc"
        >
          <!-- The heading, text and More; session 4b: its language buttons. -->
          <BookDescription
            bookId={book.id}
            description={shown?.description}
            {paragraphs}
            libraryLanguage={libraries.find((l) => l.id === book?.libraryId)?.language}
            languages={shown?.languages}
            {offline}
          />
        </section>
      {/if}

      <div class="c-dinfo min-w-0">
        <section class="c-dpanel min-w-0 rounded px-6 py-5" aria-labelledby="details-about">
          <div class="flex items-baseline justify-between">
            <h2 id="details-about" class="flex items-baseline gap-3">
              <span class="font-mincho text-lg font-bold text-c-label">書誌</span>
              <span class="text-sm text-c-muted">About this book</span>
            </h2>
            {#if canEdit}
              <!-- The pencil in place of the 蔵書 seal (design 2026-11-23): no visible border,
                   only a light hover; greyed out while the server can't be reached. -->
              <button
                type="button"
                class="c-dpencil"
                aria-label="Edit details"
                title={editOffline
                  ? 'Editing needs the library server, which can’t be reached right now'
                  : 'Edit details'}
                disabled={editOffline}
                data-testid="details-edit"
                on:click={() => (editing = true)}
              >
                <Fa icon={faPen} />
              </button>
            {:else}
              <span class="c-seal" aria-hidden="true">蔵<br />書</span>
            {/if}
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
          {#if sortedTags.others.length}
            <div class="mt-4 flex flex-col gap-2">
              <span class="text-xs text-c-muted">
                <span class="font-mincho font-bold text-c-label">分類</span> Tags
              </span>
              <div class="flex flex-wrap gap-2">
                {#each sortedTags.others as tag (tag)}
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
        {#if linksAt === 'panel'}
          <BookLinks {book} variant="panel" nativelyLevel={shown?.nativelyLevel} />
        {/if}
      </div>
    </div>

    {#if linksAt === 'section'}
      <BookLinks {book} variant="section" nativelyLevel={shown?.nativelyLevel} />
    {/if}

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

    <SummarySection book={shown ?? book} status={state?.status} {offline} />

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
        <ul
          class="c-dstrip mt-4 {stripClass}"
          style={stripStyle}
          data-testid="details-series-books"
          use:showCurrent={book.id}
        >
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
        <ul
          class="c-dstrip mt-4 {stripClass}"
          style={stripStyle}
          data-testid="details-also-by-books"
        >
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

{#if editing && book && editApi}
  <BookEditForm
    api={editApi}
    library={api}
    bookId={book.id}
    title={shown?.title ?? book.title}
    libraryName={libraries.find((l) => l.id === book?.libraryId)?.name ?? ''}
    coverThumb={savedCover ?? thumb(book)}
    placement={$bookEditAs$ === 'modal' ? 'center' : 'side'}
    on:close={() => (editing = false)}
    on:saved={(e) => onSaved(e.detail.values, e.detail.cover)}
    on:series={() => {
      editing = false;
      seriesEditing = shown?.series?.name ?? null;
    }}
  />
{/if}

{#if historyOpen && book && editApi}
  <BookHistoryPanel
    api={editApi}
    bookId={book.id}
    title={shown?.title ?? book.title}
    on:close={() => (historyOpen = false)}
    on:undone={() => onSaved({}, null)}
  />
{/if}

{#if seriesEditing && book && editApi}
  <SeriesEdit
    api={editApi}
    name={seriesEditing}
    libraryId={book.libraryId}
    placement={$seriesEditAs$ === 'modal' ? 'center' : 'side'}
    on:close={() => (seriesEditing = null)}
    on:saved={() => onSaved({}, null)}
  />
{/if}

<style>
  /* The pencil in place of the 蔵書 seal: no visible border, a light hover (design 2026-11-23). */
  .c-dpencil {
    display: inline-grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    margin: -0.5rem -0.5rem -0.5rem 0;
    border-radius: 999px;
    color: var(--c-label);
  }

  @media (hover: hover) {
    .c-dpencil:not(:disabled):hover {
      background-color: var(--c-tint);
    }
  }

  .c-dpencil:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  .c-dpencil:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

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

    /* Phones: the cover in the middle (2026-11-23); the rest stays left. */
    .c-dcover {
      max-width: 11rem;
      align-self: center;
    }
  }

  /* Room for the covers' hover lift inside the scrolling rows (as Home's), and for this
     book's outline at either end of the Series row. */
  .c-dstrip {
    padding-top: 6px;
    padding-inline: 5px;
    margin-inline: -5px;
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
