<script lang="ts">
  /**
   * Home (WP7b, decided with the user): per-device rows. Continue Reading first by
   * default (from the local mirror, furthest place on any device), then anything
   * pinned (collections, built-in lists, series, authors, tags) and, if switched on,
   * Recently added. "Edit" reorders, hides and removes rows. E-ink plain.
   */
  import { goto } from '$app/navigation';
  import { builtinCollection } from '$lib/collections/builtins';
  import type { Collection, CollectionItem } from '$lib/collections/collections';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import HomeRow, { type HomeRowView } from '$lib/components/home/home-row.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import {
    faArrowDown,
    faArrowUp,
    faCheck,
    faGripVertical,
    faMagnifyingGlass,
    faPen,
    faRotateRight
  } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { searchHeaderButton$ } from '$lib/library/search-settings';
  import { logger } from '$lib/data/logger';
  import { audioBookIdsOnDevice } from '$lib/audio/offline/audio-offline';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { continueReadingIds } from '$lib/home/continue-reading';
  import {
    isPinnedRow,
    moveRow,
    normalizeRows,
    restoreRow,
    rowCountQuery,
    rowHref,
    rowKey,
    rowTitle,
    setRowHidden,
    unpinRow,
    type HomeRow as HomeRowEntry,
    type PinTarget
  } from '$lib/home/rows';
  import UndoNotice from '$lib/components/confirm/undo-notice.svelte';
  import { homeRowLength$, homeRows$ } from '$lib/home/settings';
  import { LibraryApi, LibraryApiError, type BookListQuery } from '$lib/library/api';
  import { existingLocalIds } from '$lib/library/browser-open-deps';
  import type { OfflineCatalog } from '$lib/library/offline/offline-catalog';
  import {
    askServerFirst,
    freshOfflineCatalog,
    isUnreachable,
    noteReachable,
    noteUnreachable,
    offlineCatalog,
    OFFLINE_NOTICE,
    refreshOfflineCopies,
    saveOfflineLibraries,
    serverAnswersAgain,
    serverWorthAsking,
    startsOffline
  } from '$lib/library/offline/offline-source';
  import { removeFromThisDevice } from '$lib/library/remove-from-device';
  import {
    collectionMembership,
    coverBlurDefault,
    isCoverBlurred,
    NO_COVER_RULES,
    type CoverBlurContext,
    type CoverRules
  } from '$lib/library/cover-blur';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import {
    bookProgressFraction,
    bookProgressLabel,
    furthestPosition,
    positionsByBook
  } from '$lib/library/progress';
  import { timeLeftMinMinutes$, timeLeftRecentMinutes$ } from '$lib/data/store';
  import type { StatEntry } from '$lib/stats/aggregate';
  import { formatTimeLeft, secondsLeft, speedEstimate } from '$lib/stats/time-left';
  import {
    libraryCoverBlur$,
    libraryInfoLine$,
    libraryRequestTimeoutSeconds$
  } from '$lib/library/settings';
  import type { CatalogBook, CatalogLibrary } from '$lib/library/types';
  import type { BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import {
    bookStateApi,
    collectionsApi,
    libraryViewApi,
    recentlyViewedApi,
    statsApi
  } from '$lib/sync/sync-service';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { forgetViewedCopy } from '$lib/confirm/confirm-copy';
  import { kept, type ViewedEntry } from '$lib/recently-viewed/recently-viewed';
  import { currentKeep, recentlyViewedOn$ } from '$lib/recently-viewed/settings';
  import { lookupInOrder } from '$lib/recently-viewed/lookup';
  import { onDestroy, onMount } from 'svelte';

  const store = getLibraryStore();
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();
  const recentlyViewed = recentlyViewedApi();
  const viewedEntries = recentlyViewed.entries;

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  /** Season 2 §2: the server can't be reached; rows show this device's books. */
  let offline = false;
  let libraries: CatalogLibrary[] = [];
  let states = new Map<string, BookState>();
  let coverRules: CoverRules = NO_COVER_RULES;
  let positions = new Map<string, LocalRecord[]>();
  let collectionList: Collection[] = [];
  let collectionItems = new Map<string, CollectionItem[]>();
  let collectionsLoaded = false;
  let onDevice = new Set<string>();
  /** Season 2 Phase 9: books whose audio is downloaded here. */
  let audioOnDevice = new Set<string>();
  let revealed = new Set<string>();
  /** Reading statistics for the hero's time left (null until read, or if they can't be). */
  let statEntries: StatEntry[] | null = null;
  let views = new Map<string, HomeRowView>();
  /** Each row's "See all" count, by row key (kept while a row reloads). */
  let counts = new Map<string, number>();
  /** The latest count asked for per row: an older answer never replaces a newer one. */
  const countAsked = new Map<string, number>();
  let editing = false;
  let ready = false;
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;

  $: rows = normalizeRows($homeRows$);
  // A pinned collection deleted (here or on another device) is skipped; Edit names it.
  // The lists are passed in so the rows update when the collections arrive or change.
  $: shownRows = rows.filter(
    (r) => !r.hidden && !collectionGone(r, collectionList, collectionsLoaded)
  );
  $: rowLength = Math.min(200, Math.max(1, Math.floor(Number($homeRowLength$) || 20)));
  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  $: infoLine = $libraryInfoLine$;

  function collectionGone(row: HomeRowEntry, list: Collection[], loaded: boolean): boolean {
    return row.type === 'collection' && loaded && !list.some((c) => c.id === row.ref);
  }

  // Reactive, so row titles follow a rename on any device.
  $: collectionName = (id: string): string | null =>
    collectionList.find((c) => c.id === id)?.name ?? null;

  onMount(async () => {
    // Offline, this visit reads this device's books once (not once per row).
    freshOfflineCatalog();
    await loadMirror();
    void loadStatEntries();
    void view.syncSoon();
    const subscriptions = [
      bookState.onChanged(onMirrorChanged),
      view.onChanged(onMirrorChanged),
      collections.onChanged(onMirrorChanged)
    ];
    for (const sub of subscriptions) {
      void sub.then((off) => {
        if (destroyed) off();
        else stopListeners.push(off);
      });
    }
    connection = (await store.getConnection()) ?? null;
    if (!connection) return;
    api = new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds);
    await refreshOnDevice();
    window.addEventListener('online', tryServerAgain);
    // No network, or the server didn't answer a moment ago (another page): this device's
    // books at once, and the server is asked again in the background.
    offline = startsOffline();
    if (offline) {
      void recheckServer(connection);
    } else {
      const a = api;
      const first = await askServerFirst(connection.serverUrl, (signal) => a.libraries({ signal }));
      if (first.status === 'ok') {
        libraries = first.value.libraries;
        void saveOfflineLibraries(libraries);
      }
      // No answer: the rows show this device's books (other problems: each row reports it).
      if (first.status === 'unreachable') offline = true;
      // The server only knows state changes that reached it (built-in lists filter by them).
      else await view.sendPendingChanges(timeoutSeconds);
    }
    ready = true;
  });

  /** "Try again", or the browser is online again: rows ask the server. */
  async function tryServerAgain() {
    if (!offline || !api || !connection) return;
    // Away from home: no 20 s wait per row when the server still doesn't answer.
    if (!(await serverWorthAsking(connection.serverUrl))) return;
    if (destroyed || !offline) return;
    offline = false;
    void loadAllRows(true);
  }

  /** Offline: when the server answers the quick check again, rows ask it. */
  async function recheckServer(conn: LibraryConnection) {
    if (!(await serverAnswersAgain(conn.serverUrl))) return;
    if (!destroyed && offline && connection === conn) void tryServerAgain();
  }

  /** Recently viewed (2026-11-24): the books the limit keeps, newest first (none while off). */
  function viewedIds(entries: readonly ViewedEntry[] | null): string[] {
    if (!$recentlyViewedOn$) return [];
    return kept(entries ?? [], currentKeep(), Date.now()).map((e) => e.bookId);
  }

  // A view, removal or clear (here or on another device) reloads the row in place.
  let viewedSeen: string | null = null;
  $: viewedKey =
    $viewedEntries === null ? null : `${$recentlyViewedOn$}:${viewedIds($viewedEntries).join(',')}`;
  $: if (viewedKey !== null && viewedKey !== viewedSeen) {
    const first = viewedSeen === null;
    viewedSeen = viewedKey;
    const row = shownRows.find((r) => r.type === 'viewed');
    if (!first && row && ready && api && views.has(rowKey(row))) void loadRow(row, true);
  }

  // Rows load when first shown (also a row pinned, shown or added while here).
  $: if (ready && api) {
    for (const row of shownRows) if (!views.has(rowKey(row))) void loadRow(row);
  }

  onDestroy(() => {
    destroyed = true;
    if (typeof window !== 'undefined') window.removeEventListener('online', tryServerAgain);
    clearTimeout(mirrorTimer);
    stopListeners.forEach((off) => off());
    opening?.controller.abort();
  });

  async function loadMirror() {
    const [s, rules, records, coll] = await Promise.all([
      bookState.getAll().catch(() => new Map<string, BookState>()),
      view.coverRules(),
      view.positions(),
      collections.view()
    ]);
    states = s;
    coverRules = rules;
    positions = positionsByBook(records);
    collectionList = coll.collections;
    collectionItems = coll.items;
    collectionsLoaded = true;
  }

  /** Reading on another device, a status change or a list change: settle, then refresh. */
  function onMirrorChanged() {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(async () => {
      if (destroyed) return;
      await loadMirror();
      if (api && ready) await loadAllRows(true);
    }, 300);
  }

  async function refreshOnDevice() {
    try {
      const [links, ids] = await Promise.all([store.getAllLinks(), existingLocalIds()]);
      onDevice = new Set(links.filter((l) => ids.has(l.localId)).map((l) => l.bookId));
    } catch (error) {
      logger.warn(`Home: could not read local links: ${(error as Error).message}`);
    }
    try {
      audioOnDevice = new Set(await audioBookIdsOnDevice());
    } catch (error) {
      logger.warn(`Home: could not read the downloaded audio: ${(error as Error).message}`);
    }
  }

  function setView(key: string, v: HomeRowView) {
    views = new Map(views).set(key, v);
  }

  /** Reloads the shown rows, keeping what they show until the new books arrive. */
  async function loadAllRows(quiet = false) {
    await Promise.all(shownRows.map((r) => loadRow(r, quiet)));
  }

  function describe(error: unknown): string {
    if (error instanceof LibraryApiError) {
      if (error.kind === 'unreachable' || error.kind === 'timeout') {
        return "The library server can't be reached right now.";
      }
      if (error.kind === 'unauthorized') {
        return 'The server no longer accepts this device. Connect it again on the Library page.';
      }
    }
    return (error as Error).message;
  }

  async function loadRow(row: HomeRowEntry, quiet = false) {
    const key = rowKey(row);
    if (!api) return;
    const asked = offline;
    if (!quiet || !views.has(key)) setView(key, { status: 'loading' });
    const source = asked ? offlineCatalog() : api;
    try {
      const { books, whole } = await fetchRow(row, source);
      if (destroyed) return;
      setView(key, { status: 'ok', books });
      if (whole) {
        countAsked.set(key, (countAsked.get(key) ?? 0) + 1);
        setCount(key, books.length);
      } else void loadCount(row, source);
      if (!asked) {
        noteReachable();
        void refreshOfflineCopies(api);
      }
    } catch (error) {
      if (destroyed) return;
      if (!asked && isUnreachable(error)) {
        // The offline Library: the row from this device's books.
        offline = true;
        noteUnreachable();
        await loadRow(row, quiet);
        return;
      }
      setView(key, { status: 'error', message: describe(error) });
    }
  }

  /**
   * A row's books. `whole`: they are the entire list the row counts (a books() page with
   * nothing after it, or every book you are partway through), so their number is the
   * count and none needs asking for.
   */
  async function fetchRow(
    row: HomeRowEntry,
    a: LibraryApi | OfflineCatalog
  ): Promise<{ books: CatalogBook[]; whole: boolean }> {
    const page = async (query: BookListQuery) => {
      const p = await a.books({ ...query, limit: rowLength });
      return { books: p.books, whole: p.nextCursor === null };
    };
    const picked = async (ids: string[]) => ({
      books: ids.length ? (await a.lookup(ids)).books : [],
      whole: false
    });
    switch (row.type) {
      case 'continue': {
        const ids = continueReadingIds(states, positions, Infinity);
        const r = await picked(ids.slice(0, rowLength));
        return { books: r.books, whole: ids.length <= rowLength };
      }
      case 'recent':
        return page({});
      case 'viewed': {
        const ids = viewedIds(await firstViewed());
        const books = await lookupInOrder(a, ids.slice(0, rowLength));
        return { books, whole: ids.length <= rowLength };
      }
      case 'builtin': {
        const b = builtinCollection(row.ref);
        return b ? page({ scope: b.query }) : { books: [], whole: true };
      }
      case 'collection': {
        const c = collectionList.find((x) => x.id === row.ref);
        if (!c) return { books: [], whole: true };
        if (c.type === 'manual') {
          return picked((collectionItems.get(c.id) ?? []).slice(0, rowLength).map((i) => i.bookId));
        }
        return c.query ? page({ scope: c.query }) : { books: [], whole: true };
      }
      default:
        return page({ group: { by: row.type, name: row.ref } });
    }
  }

  /**
   * The number beside a row's title: how many books its whole list has. Counting can take
   * a moment on a big library, so the row never waits for it; on a failure the row keeps
   * the number it had (or shows none).
   */
  async function loadCount(row: HomeRowEntry, a: LibraryApi | OfflineCatalog) {
    const key = rowKey(row);
    const collection =
      row.type === 'collection' ? collectionList.find((c) => c.id === row.ref) : null;
    const query = rowCountQuery(row, collection);
    if (!query && row.type !== 'continue' && row.type !== 'viewed') return;
    const asked = (countAsked.get(key) ?? 0) + 1;
    countAsked.set(key, asked);
    try {
      const n = query
        ? await a.count(query)
        : row.type === 'viewed'
          ? (await lookupInOrder(a, viewedIds(await firstViewed()))).length
          : await continueReadingCount(a);
      if (!destroyed && countAsked.get(key) === asked) setCount(key, n);
    } catch (error) {
      logger.warn(`Home: could not count "${key}": ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * Continue reading's whole list: every book you are partway through (this device's
   * mirror), without the ones the library no longer has or hides, as the row shows them.
   */
  async function continueReadingCount(a: LibraryApi | OfflineCatalog): Promise<number> {
    const ids = continueReadingIds(states, positions, Infinity);
    let n = 0;
    // The lookup takes at most 200 ids.
    for (let i = 0; i < ids.length; i += 200) {
      n += (await a.lookup(ids.slice(i, i + 200))).books.length;
    }
    return n;
  }

  /** The viewed list once it has been read (the store starts empty-handed: null). */
  function firstViewed(): Promise<ViewedEntry[]> {
    return new Promise((resolve) => {
      let off: (() => void) | undefined;
      let done = false;
      off = viewedEntries.subscribe((entries) => {
        if (entries === null || done) return;
        done = true;
        resolve(entries);
        // Unsubscribing inside the first call: off isn't set yet then.
        queueMicrotask(() => off?.());
      });
    });
  }

  /** Recently viewed: Remove from Recently viewed (a card's ⋮ menu), after asking. */
  async function forgetViewed(book: CatalogBook) {
    const confirmed = await confirmDestructive({
      ...forgetViewedCopy(1, book.title),
      testid: 'viewed-forget-confirm',
      confirmTestid: 'viewed-forget-confirm-button'
    });
    if (confirmed) await recentlyViewed.remove([book.id]);
  }

  function setCount(key: string, n: number) {
    if (counts.get(key) !== n) counts = new Map(counts).set(key, n);
  }

  // ---- cards ----------------------------------------------------------------

  $: thumbnailUrl = (book: CatalogBook) =>
    book.thumbnail && api ? api.absolute(book.thumbnail) : '';
  $: stateOf = (book: CatalogBook) => states.get(book.id);
  $: progressOf = (book: CatalogBook) =>
    bookProgressLabel(book.id, states.get(book.id), positions.get(book.id) ?? [], book.charCount);
  $: fractionOf = (book: CatalogBook) =>
    bookProgressFraction(
      book.id,
      states.get(book.id),
      positions.get(book.id) ?? [],
      book.charCount
    );
  /**
   * The Continue reading hero: how far into the current read (the furthest place, as
   * the cards; 100% included) and the time left at the reader's speed estimate.
   */
  $: heroProgressOf = (book: CatalogBook) => {
    const state = states.get(book.id);
    if (state?.status === 'completed') return null;
    const best = furthestPosition(book.id, state, positions.get(book.id) ?? [], book.charCount);
    if (!best) return null;
    // Characters read: the saved place (the server counts with the reader's code), else
    // the fraction of the book's count.
    const charPos = best.record.data?.charPos;
    const total = book.charCount;
    const chars = total
      ? {
          read: Math.min(
            total,
            typeof charPos === 'number' && charPos >= 0
              ? Math.round(charPos)
              : Math.round(best.fraction * total)
          ),
          total
        }
      : null;
    let timeLeft: string | null = null;
    if (statEntries && chars && best.fraction < 1) {
      const estimate = speedEstimate(
        book.id,
        statEntries,
        Math.max(1, Number($timeLeftRecentMinutes$) || 60) * 60,
        Math.max(0, Number($timeLeftMinMinutes$) || 0) * 60
      );
      const seconds = secondsLeft(chars.total - chars.read, estimate);
      timeLeft = seconds === null ? null : formatTimeLeft(seconds);
    }
    return { fraction: best.fraction, chars, timeLeft };
  };

  /** Statistics never block Home: without them the hero has no time left. */
  async function loadStatEntries() {
    try {
      statEntries = await statsApi().allEntries();
    } catch (error) {
      logger.warn(
        `Home: could not read statistics for time left: ${(error as Error)?.message ?? error}`
      );
    }
  }

  let blurCtx: CoverBlurContext;
  $: blurCtx = {
    rules: coverRules,
    fallback: coverBlurDefault($libraryCoverBlur$),
    inCollection: collectionMembership({
      rules: coverRules,
      collections: collectionList,
      items: collectionItems,
      states,
      onDevice: (id) => onDevice.has(id),
      audioOnDevice: (id) => audioOnDevice.has(id)
    })
  };
  $: blurredOf = (book: CatalogBook) =>
    !revealed.has(book.id) && isCoverBlurred(states.get(book.id)?.blur, book, blurCtx);

  function reveal(book: CatalogBook) {
    revealed = new Set([...revealed, book.id]);
  }

  /** WP19b: "Add to collection…" from a book's ⋮ menu. */
  function openAddToCollection(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: AddToCollectionDialog,
        props: { bookId: book.id, title: book.title, api: collections, resolver: () => {} }
      }
    ]);
  }

  function openBookState(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: BookStateDialog,
        props: {
          bookId: book.id,
          title: book.title,
          charCount: book.charCount,
          api: bookState,
          collections,
          resolver: () => {}
        }
      }
    ]);
  }

  /** WP15e: Remove from this device (a book's ⋮ menu). */
  async function removeFromDevice(book: CatalogBook) {
    try {
      if (!(await removeFromThisDevice(book))) return;
    } catch (error) {
      showMessage('Not removed', (error as Error).message);
      return;
    }
    await refreshOnDevice();
    // An "On this device" row needs the new list on the server first.
    await view.sendPendingChanges(timeoutSeconds);
    if (api && ready && !destroyed) await loadAllRows(true);
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  async function open(book: CatalogBook) {
    if (!api || opening) return;
    const controller = new AbortController();
    opening = { book, stage: null, controller };
    try {
      const outcome = await openCatalogBook(
        book,
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
      await refreshOnDevice();
    } catch (error) {
      logger.warn(`Home: opening "${book.title}" failed: ${(error as Error).message}`);
      showMessage('Could not open the book', describe(error));
    } finally {
      opening = null;
    }
  }

  // ---- editing ----------------------------------------------------------------

  function save(next: HomeRowEntry[]) {
    $homeRows$ = next;
  }

  /** With a mouse, rows can be dragged by their handle (as in a collection's reorder list). */
  const canDrag = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

  function dragRows(node: HTMLElement) {
    let sortable: { destroy: () => void } | null = null;
    let gone = false;
    void import('sortablejs').then(({ default: SortableJs }) => {
      if (gone) return;
      sortable = SortableJs.create(node, {
        handle: '[data-drag-handle]',
        animation: 0,
        ghostClass: 'opacity-40',
        onEnd({ oldIndex, newIndex, item, from }) {
          if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
          // Put the row back: Svelte owns the DOM and re-renders the new order.
          from.insertBefore(item, from.children[oldIndex + (oldIndex > newIndex ? 1 : 0)] ?? null);
          save(moveRow(rows, oldIndex, newIndex - oldIndex));
        }
      });
    });
    return {
      destroy() {
        gone = true;
        sortable?.destroy();
      }
    };
  }

  function showRow(index: number, hidden: boolean) {
    save(setRowHidden(rows, index, hidden));
  }

  /** WP19: the last removed row, for Undo (until dismissed, the next removal or Done). */
  let removedRow: { row: HomeRowEntry; index: number; name: string } | null = null;

  function removeRow(row: PinTarget & { hidden: boolean }, index: number) {
    removedRow = { row, index, name: rowTitle(row, collectionName) };
    save(unpinRow(rows, row));
  }

  function undoRemoveRow() {
    if (removedRow) save(restoreRow(rows, removedRow.row, removedRow.index));
    removedRow = null;
  }

  function emptyTextFor(row: HomeRowEntry): string {
    if (row.type === 'continue') return 'Nothing in progress. Open a book from the Library.';
    if (row.type === 'viewed') {
      return $recentlyViewedOn$
        ? 'Books whose details you open show up here.'
        : 'Recently viewed is off. Turn it on in Settings › Library › Recently viewed.';
    }
    return 'No books here yet.';
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Home')}</title>
</svelte:head>

<AppHeader title="Home" search />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="home-page">
  <CataloguePageHeader jp="ホーム" title="Home">
    <div class="flex items-center gap-2">
      <!-- Search palette step 2: the header's search button replaces this one while it is on. -->
      {#if !$searchHeaderButton$}
        <a
          class="c-btn c-btn-ghost c-btn-icon"
          href="{pagePath}/library?search=1"
          title="Search the library"
          data-testid="home-search"
        >
          <Fa icon={faMagnifyingGlass} />
          <span class="sr-only">Search the library</span>
        </a>
      {/if}
      <button
        class="c-btn {editing ? 'c-btn-primary' : 'c-btn-secondary'} px-3.5"
        data-testid="home-edit"
        on:click={() => {
          editing = !editing;
          removedRow = null;
          if (!editing && api && ready) void loadAllRows(true);
        }}
      >
        <Fa icon={editing ? faCheck : faPen} />
        {editing ? 'Done' : 'Edit'}
      </button>
    </div>
  </CataloguePageHeader>

  {#if connection === undefined}
    <p class="py-8 text-c-muted">Loading…</p>
  {:else if connection === null}
    <p class="c-notice" data-testid="home-not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {/if}

  {#if editing}
    <section class="pt-3" data-testid="home-edit-list">
      <p class="pb-3 text-sm text-c-muted">
        Pin more rows with "Pin to Home" on a collection (Collections page) or on a series, author
        or tag (Library). Rows are kept on this device only.
      </p>
      {#if removedRow}
        <div class="c-notice mb-3">
          <UndoNotice
            message={`Removed “${removedRow.name}” from Home.`}
            buttonClass="c-btn c-btn-secondary px-3"
            testid="home-row-undo-notice"
            undoTestid="home-row-undo"
            on:undo={undoRemoveRow}
            on:dismiss={() => (removedRow = null)}
          />
        </div>
      {/if}
      <ul class="flex flex-col gap-2" use:dragRows>
        {#each rows as row, i (rowKey(row))}
          <li
            class="c-edit-row flex flex-wrap items-center gap-2 rounded p-2"
            data-testid="home-edit-row"
          >
            {#if canDrag}
              <span
                class="flex h-10 w-8 shrink-0 cursor-grab items-center justify-center"
                title="Drag to move"
                data-drag-handle
              >
                <Fa icon={faGripVertical} />
              </span>
            {/if}
            <span class="min-w-0 grow font-medium">
              {rowTitle(row, collectionName)}
              {#if row.hidden}<span class="text-sm font-normal"> (hidden)</span>{/if}
              {#if row.type === 'author' || row.type === 'series' || row.type === 'tag'}
                <span class="text-sm font-normal"> · {row.type}</span>
              {/if}
            </span>
            <button
              class="c-btn c-btn-ghost c-btn-icon"
              aria-label="Move up"
              disabled={i === 0}
              on:click={() => save(moveRow(rows, i, -1))}
            >
              <Fa icon={faArrowUp} />
            </button>
            <button
              class="c-btn c-btn-ghost c-btn-icon"
              aria-label="Move down"
              disabled={i === rows.length - 1}
              on:click={() => save(moveRow(rows, i, 1))}
            >
              <Fa icon={faArrowDown} />
            </button>
            <button
              class="c-btn c-btn-secondary px-3"
              data-testid="home-row-toggle"
              on:click={() => showRow(i, !row.hidden)}
            >
              {row.hidden ? 'Show' : 'Hide'}
            </button>
            {#if isPinnedRow(row)}
              <button
                class="c-btn c-btn-ghost px-3"
                data-testid="home-row-remove"
                on:click={() => removeRow(row, i)}
              >
                Remove
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      <label class="flex items-center gap-3 pt-4">
        Books per row
        <input
          class="c-input w-24"
          type="number"
          min="1"
          max="200"
          step="1"
          data-testid="home-row-length"
          bind:value={$homeRowLength$}
          on:blur={() => {
            if (!(Number($homeRowLength$) >= 1)) $homeRowLength$ = 20;
          }}
        />
      </label>
    </section>
  {:else if connection}
    {#if offline}
      <p
        class="c-notice mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="offline-notice"
      >
        <span role="status">{OFFLINE_NOTICE}</span>
        <button
          class="c-btn c-btn-ghost c-btn-sm -my-1 gap-1.5 px-2.5"
          data-testid="offline-retry"
          on:click={tryServerAgain}><Fa icon={faRotateRight} />Try again</button
        >
      </p>
    {/if}
    <div class="pt-2">
      {#each shownRows as row (rowKey(row))}
        <HomeRow
          title={rowTitle(row, collectionName)}
          href={rowHref(row, pagePath)}
          view={views.get(rowKey(row)) ?? { status: 'loading' }}
          count={counts.get(rowKey(row)) ?? null}
          emptyText={emptyTextFor(row)}
          {thumbnailUrl}
          {stateOf}
          {progressOf}
          {fractionOf}
          {heroProgressOf}
          {blurredOf}
          hero={row.type === 'continue'}
          forgettable={row.type === 'viewed'}
          {onDevice}
          {audioOnDevice}
          {infoLine}
          on:open={(ev) => open(ev.detail)}
          on:reveal={(ev) => reveal(ev.detail)}
          on:state={(ev) => openBookState(ev.detail)}
          on:collect={(ev) => openAddToCollection(ev.detail)}
          on:remove={(ev) => removeFromDevice(ev.detail)}
          on:forget={(ev) => forgetViewed(ev.detail)}
          on:retry={() => loadRow(row)}
        />
      {:else}
        <p class="py-6 text-c-muted">Every row is hidden. Use "Edit" to show some.</p>
      {/each}
    </div>
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
  .c-edit-row {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line-strong);
  }
</style>
