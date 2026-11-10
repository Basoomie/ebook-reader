<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { builtinCollection } from '$lib/collections/builtins';
  import { collectionMenu, newCollection } from '$lib/collections/collection-dialogs';
  import type { Collection, CollectionItem } from '$lib/collections/collections';
  import CollectionBookActionsDialog, {
    type CollectionBookAction
  } from '$lib/components/collections/collection-book-actions-dialog.svelte';
  import CollectionPickDialog, {
    type CollectionPick
  } from '$lib/components/collections/collection-pick-dialog.svelte';
  import CollectionReorderList from '$lib/components/collections/collection-reorder-list.svelte';
  import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import BulkEditDialog, { type BulkChange } from '$lib/components/library/bulk-edit-dialog.svelte';
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import LibraryBookRow from '$lib/components/library/library-book-row.svelte';
  import LibraryConnect from '$lib/components/library/library-connect.svelte';
  import LibraryGroupCard from '$lib/components/library/library-group-card.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import LibrarySyncStatus from '$lib/components/library/library-sync-status.svelte';
  import MarkCompletedDialog from '$lib/components/library/mark-completed-dialog.svelte';
  import SearchHelpDialog from '$lib/components/library/search-help-dialog.svelte';
  import TagCoverDialog from '$lib/components/library/tag-cover-dialog.svelte';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import MergedHeaderIcon from '$lib/components/merged-header-icon/merged-header-icon.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { baseHeaderClasses, buttonClasses, inputClasses, pxScreen } from '$lib/css-classes';
  import { dialogManager, type Dialog } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { database, selfHostStorageSource$ } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { browserOpenDeps, existingLocalIds } from '$lib/library/browser-open-deps';
  import { summarizeCharCounts } from '$lib/library/char-counts';
  import { isCoverBlurred } from '$lib/library/cover-blur';
  import { formatGroupChars, groupCount, groupTitle, plural } from '$lib/library/format';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import {
    openCalibreBook,
    type ExistingBookQuestion,
    type OpenStage
  } from '$lib/library/open-calibre-book';
  import { bookProgressLabel, positionsByBook, seriesReadCount } from '$lib/library/progress';
  import { activeChips, CHIPS, toggleChip, type ChipId } from '$lib/library/query/chips';
  import { parseQuery, usesBookState } from '$lib/library/query/parse';
  import {
    boxesOverlap,
    boxFrom,
    DRAG_THRESHOLD,
    rangeIds,
    toggled,
    withAll
  } from '$lib/library/selection';
  import {
    libraryFilter$,
    libraryInfoLine$,
    libraryRequestTimeoutSeconds$,
    libraryView$
  } from '$lib/library/settings';
  import type {
    CatalogBook,
    CatalogGroup,
    CatalogLibrary,
    GroupBy,
    GroupTile
  } from '$lib/library/types';
  import type { BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import {
    bookStateApi,
    collectionsApi,
    libraryViewApi,
    notifySyncConnectionChanged
  } from '$lib/sync/sync-service';
  import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import { onDestroy, onMount } from 'svelte';
  import Fa from 'svelte-fa';

  /**
   * Library (WP6, WP7a): browse and search the Calibre catalog and open a book through
   * the existing import pipeline. Every view is a URL
   * (?tab=all|series|authors|tags&group=<name>|none=1&q=&lib=), so going back from the
   * reader or a group restores it. Plain for e-ink: "Load more" paging, no animations.
   *
   * WP8b: ?collection=<id> shows one collection (a built-in, a saved search or a list)
   * across all libraries; the search box filters inside it. A list shows its own order
   * (from the local mirror, so moves show at once) and can be reordered.
   */

  type Tab = 'all' | 'series' | 'authors' | 'tags';
  const TABS: { id: Tab; label: string; by: GroupBy | null }[] = [
    { id: 'all', label: 'All', by: null },
    { id: 'series', label: 'Series', by: 'series' },
    { id: 'authors', label: 'Authors', by: 'author' },
    { id: 'tags', label: 'Tags', by: 'tag' }
  ];
  const BACK_LABEL: Record<GroupBy, string> = {
    series: 'Back to Series',
    author: 'Back to Authors',
    tag: 'Back to Tags'
  };
  const FIELD_OF: Record<GroupBy, string> = { series: 'series', author: 'author', tag: 'tag' };
  // The search box without the shared input's transition (e-ink).
  const searchInputClasses = inputClasses.replace(/\s*\btransition\b/, '');
  const solid = 'border-gray-800 bg-gray-800 text-white';
  /** Book ids looked up per request for a list (server limit 200). */
  const LOOKUP_CHUNK = 100;
  /** A list page shows at least this many matching books when there are more. */
  const LIST_PAGE = 50;

  const store = getLibraryStore();

  let connection: LibraryConnection | null | undefined;
  let connectNotice = '';
  let suggestedServerUrl = '';
  let api: LibraryApi | undefined;

  let libraries: CatalogLibrary[] = [];
  let indexerError = '';
  let books: CatalogBook[] = [];
  let groups: CatalogGroup[] = [];
  let nextCursor: string | null = null;
  let loading = false;
  let loadError = '';
  let onDevice = new Set<string>();

  let queryInput = '';
  let queryError = '';
  let appliedQuery = '';
  let appliedLibrary = '';
  let tab: Tab = 'all';
  let group: { by: GroupBy; name: string | null } | null = null;
  /** The open group's card (totals, read count), when the server has one. */
  let groupInfo: CatalogGroup | null = null;
  /** WP8b: the open collection (?collection=). */
  let collectionId: string | null = null;
  /** Lists: how many of its book ids have been looked up so far. */
  let listConsumed = 0;
  let reorderMode = false;
  let savingOrder = false;
  let staleNote = false;
  let listController: AbortController | undefined;

  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;

  // WP8a/WP7a: book state, tag rules and positions from the local sync mirror.
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();
  let collectionList: Collection[] = [];
  let collectionItems = new Map<string, CollectionItem[]>();
  let collectionsLoaded = false;
  let collectionsTimer: ReturnType<typeof setTimeout> | undefined;
  let states = new Map<string, BookState>();
  let tagRules = new Set<string>();
  let positions = new Map<string, LocalRecord[]>();
  let stopListeners: (() => void)[] = [];
  let destroyed = false;
  /** Covers shown with a tap this visit (nothing is stored). */
  let revealed = new Set<string>();

  let selectMode = false;
  let selected = new Set<string>();
  let lastClicked: string | null = null;
  let listElement: HTMLElement | undefined;
  let drag: { x: number; y: number; active: boolean; base: Set<string> } | null = null;
  let dragBox: { left: number; top: number; width: number; height: number } | null = null;
  let suppressClick = false;

  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  // A changed timeout setting applies to the next request.
  $: if (connection && api && api.timeoutSeconds !== timeoutSeconds) api = makeApi(connection);
  $: libraryNames = new Map(libraries.map((l) => [l.id, l.name]));
  $: enabledLibraries = libraries.filter((l) => l.enabled);
  $: charCountSummary = summarizeCharCounts(enabledLibraries);
  $: tabInfo = TABS.find((t) => t.id === tab) ?? TABS[0];
  $: builtin = collectionId ? builtinCollection(collectionId) : null;
  $: userCollection = collectionId
    ? (collectionList.find((c) => c.id === collectionId) ?? null)
    : null;
  $: isList = userCollection?.type === 'manual';
  $: listIds =
    isList && collectionId ? (collectionItems.get(collectionId) ?? []).map((i) => i.bookId) : [];
  $: collectionName = builtin?.name ?? userCollection?.name ?? null;
  $: collectionGone = collectionId !== null && collectionsLoaded && !builtin && !userCollection;
  $: canReorder = isList && !appliedQuery && books.length > 1;
  $: if (!canReorder && reorderMode && !savingOrder) reorderMode = false;
  $: showingGroups = collectionId === null && tabInfo.by !== null && group === null;
  $: chips = activeChips(queryInput);
  $: chipsDisabled = !parseQuery(queryInput).ok;
  $: grid = $libraryView$ !== 'list';
  $: infoLine = $libraryInfoLine$;
  $: parsedApplied = parseQuery(appliedQuery);
  $: usesChars = parsedApplied.ok && parsedApplied.query.terms.some((t) => t.type === 'chars');
  $: uncounted = enabledLibraries
    .filter((l) => !appliedLibrary || l.id === appliedLibrary)
    .reduce((n, l) => n + (l.counts ? l.counts.pending + l.counts.errors : 0), 0);
  $: bookIds = books.map((b) => b.id);
  $: headerTag = group?.by === 'tag' ? group.name : null;

  onMount(async () => {
    void loadMirror();
    // Places saved on other devices (and their collections) show without waiting for
    // the next timed sync.
    void view.syncSoon();
    const subscriptions = [
      bookState.onChanged(() => void loadStates()),
      view.onChanged(() => void loadViewData()),
      collections.onChanged(onCollectionsChanged)
    ];
    for (const sub of subscriptions) {
      void sub.then((off) => {
        if (destroyed) off();
        else stopListeners.push(off);
      });
    }
    suggestedServerUrl = await selfHostServerUrl();
    connection = (await store.getConnection()) ?? null;
    if (connection) await startSession(connection);
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(collectionsTimer);
    stopListeners.forEach((off) => off());
    listController?.abort();
    opening?.controller.abort();
  });

  afterNavigate(() => {
    if (connection && api) void readUrlAndLoad();
  });

  /** The self-hosted sync server's address, as a starting point for the connect form. */
  async function selfHostServerUrl(): Promise<string> {
    try {
      const name = selfHostStorageSource$.getValue();
      if (!name) return '';
      const db = await database.db;
      const source = await db.get('storageSource', name);
      const data = source?.data as { clientId?: unknown } | undefined;
      return typeof data?.clientId === 'string' ? data.clientId.replace(/\/+$/, '') : '';
    } catch {
      return '';
    }
  }

  function makeApi(conn: LibraryConnection) {
    return new LibraryApi(conn.serverUrl, conn.token, timeoutSeconds);
  }

  async function startSession(conn: LibraryConnection) {
    api = makeApi(conn);
    await refreshOnDevice();
    try {
      const result = await api.libraries();
      libraries = result.libraries;
      indexerError = result.indexer.enabled ? '' : result.indexer.error || 'The indexer is off';
    } catch (error) {
      if (handleAuthError(error)) return;
      // The list request below reports the problem.
    }
    await readUrlAndLoad();
  }

  /** Fresh character-count totals each time the Connection panel opens (no polling). */
  async function onConnectionToggle(event: Event) {
    if (!(event.currentTarget as HTMLDetailsElement).open || !api) return;
    try {
      libraries = (await api.libraries()).libraries;
    } catch {
      // Keep the totals from the session start; the book list reports connection problems.
    }
  }

  function loadMirror() {
    return Promise.all([loadStates(), loadViewData(), loadCollections()]);
  }

  async function loadCollections() {
    const result = await collections.view();
    collectionList = result.collections;
    collectionItems = result.items;
    collectionsLoaded = true;
  }

  /** Many records can change at once (a deleted collection): settle first. */
  function onCollectionsChanged() {
    clearTimeout(collectionsTimer);
    collectionsTimer = setTimeout(async () => {
      if (destroyed) return;
      const wasList = isList;
      await loadCollections();
      if (collectionId === null) return;
      if (wasList || isList) refreshList();
      else if (!userCollection && !builtin) books = [];
    }, 50);
  }

  /**
   * A list changed (a move, an add, a removal, here or on another device): show the
   * new order of what is loaded at once, then look the books up again for additions.
   */
  function refreshList() {
    const pos = new Map(listIds.map((id, i) => [id, i]));
    books = books
      .filter((b) => pos.has(b.id))
      .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    void loadPage(true, Math.max(books.length, LIST_PAGE));
  }

  async function loadStates() {
    try {
      states = await bookState.getAll();
    } catch (error) {
      logger.warn(`Library: could not read book states: ${(error as Error).message}`);
    }
  }

  async function loadViewData() {
    const [rules, records] = await Promise.all([view.tagBlurRules(), view.positions()]);
    tagRules = rules;
    positions = positionsByBook(records);
  }

  function openBookState(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: BookStateDialog,
        disableCloseOnClick: true,
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

  // ---- covers -------------------------------------------------------------

  function bookBlurred(
    book: Pick<CatalogBook, 'id' | 'tags'>,
    s: Map<string, BookState>,
    rules: Set<string>,
    shown: Set<string>
  ) {
    return !shown.has(book.id) && isCoverBlurred(s.get(book.id)?.blur, book.tags, rules);
  }

  function groupKey(g: CatalogGroup) {
    return `${g.by}:${g.name ?? ''}`;
  }

  function groupTiles(
    g: CatalogGroup,
    s: Map<string, BookState>,
    rules: Set<string>,
    shown: Set<string>
  ) {
    const list: GroupTile[] = g.cover ? [g.cover] : g.cover === null ? [] : (g.tiles ?? []);
    const groupShown = shown.has(groupKey(g));
    return list.map((t) => ({
      src: t.thumbnail && api ? api.absolute(t.thumbnail) : '',
      blurred: !groupShown && bookBlurred({ id: t.bookId, tags: t.tags }, s, rules, shown)
    }));
  }

  function reveal(key: string) {
    revealed = withAll(revealed, [key]);
  }

  async function editTagCover(tag: string) {
    await new Promise<void>((resolve) => {
      dialogManager.dialogs$.next([
        {
          component: TagCoverDialog,
          disableCloseOnClick: true,
          props: {
            tag,
            blurred: tagRules.has(tag),
            save: async (blur: boolean) => {
              await view.setTagBlur(tag, blur);
              tagRules = await view.tagBlurRules();
            },
            resolver: resolve
          }
        }
      ]);
    });
  }

  // ---- selection ----------------------------------------------------------

  function toggleSelectMode() {
    selectMode = !selectMode;
    selected = new Set();
    lastClicked = null;
  }

  function onToggle(book: CatalogBook, shift: boolean) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (shift && lastClicked) selected = withAll(selected, rangeIds(bookIds, lastClicked, book.id));
    else selected = toggled(selected, book.id);
    lastClicked = book.id;
  }

  function selectAllShown() {
    selected = withAll(selected, bookIds);
  }

  function onListPointerDown(ev: PointerEvent) {
    if (!selectMode || ev.pointerType !== 'mouse' || ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, active: false, base: selected };
  }

  function onListDragStart(ev: DragEvent) {
    // No native image or link dragging while selecting (it would cancel the box).
    if (selectMode) ev.preventDefault();
  }

  function onWindowPointerMove(ev: PointerEvent) {
    if (!drag || !listElement) return;
    if (!drag.active && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < DRAG_THRESHOLD) {
      return;
    }
    drag.active = true;
    ev.preventDefault();
    const box = boxFrom(drag.x, drag.y, ev.clientX, ev.clientY);
    dragBox = {
      left: box.left,
      top: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top
    };
    const hits: string[] = [];
    for (const el of listElement.querySelectorAll<HTMLElement>('[data-book-id]')) {
      if (boxesOverlap(box, el.getBoundingClientRect())) hits.push(el.dataset.bookId as string);
    }
    selected = withAll(drag.base, hits);
  }

  function onWindowPointerUp() {
    if (drag?.active) {
      // The click that follows this pointerup (if any) ends the drag, it isn't a tap. When
      // the drag ends over another card the browser clicks the list itself instead, so
      // the flag is cleared right after either way.
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    drag = null;
    dragBox = null;
  }

  function onWindowKeydown(ev: KeyboardEvent) {
    if (!selectMode) return;
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (dialogManager.dialogs$.getValue().length) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      toggleSelectMode();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      selectAllShown();
    }
  }

  // ---- bulk changes -------------------------------------------------------

  function ask<T>(component: Dialog['component'], props: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve) => {
      dialogManager.dialogs$.next([
        { component, disableCloseOnClick: true, props: { ...props, resolver: resolve } }
      ]);
    });
  }

  async function bulkChange() {
    const chosen = books.filter((b) => selected.has(b.id));
    if (!chosen.length) return;
    const change = await ask<BulkChange | undefined>(BulkEditDialog, { count: chosen.length });
    if (!change) return;
    const ids = chosen.map((b) => b.id);
    let failed: string[];
    if (change.kind === 'collection') {
      const pick = await ask<CollectionPick | undefined>(CollectionPickDialog, {
        action: change.action,
        count: chosen.length,
        collections: collectionList.filter((c) => c.type === 'manual')
      });
      if (!pick) return;
      try {
        const target =
          'id' in pick ? pick.id : await collections.create({ name: pick.newName, type: 'manual' });
        failed =
          change.action === 'add'
            ? await collections.addBooks(target, ids)
            : await collections.removeBooks(target, ids);
      } catch (error) {
        showMessage('Not saved', (error as Error).message);
        return;
      }
    } else if (change.kind === 'status' && change.status === 'completed') {
      const finishedOn = await ask<string | null | undefined>(MarkCompletedDialog, {
        count: chosen.length
      });
      if (finishedOn === undefined) return;
      failed = await bookState.markCompleted(
        chosen.map((b) => ({ bookId: b.id, charCount: b.charCount })),
        finishedOn
      );
    } else if (change.kind === 'status') {
      failed = await bookState.setStatusMany(ids, change.status);
    } else if (change.kind === 'favorite') {
      failed = await bookState.setFavoriteMany(ids, change.favorite);
    } else {
      failed = await bookState.setBlurMany(ids, change.blur);
    }
    await loadStates();
    if (failed.length) {
      showMessage(
        'Not all saved',
        `${failed.length} of ${chosen.length} books could not be changed. Try again.`
      );
      selected = new Set(failed);
      return;
    }
    selectMode = false;
    selected = new Set();
  }

  /** Select mode in a list: take the selected books out of it, or move them to the top. */
  async function listBulk(action: 'remove' | 'top') {
    if (!collectionId || !isList) return;
    // In the list's own order, so "Move to top" keeps their order.
    const ids = listIds.filter((id) => selected.has(id));
    if (!ids.length) return;
    const failed =
      action === 'remove'
        ? await collections.removeBooks(collectionId, ids)
        : await collections.moveBooks(collectionId, ids, 0);
    if (failed.length) {
      showMessage('Not all saved', `${failed.length} of ${ids.length} books could not be changed.`);
      selected = new Set(failed);
      return;
    }
    selectMode = false;
    selected = new Set();
  }

  // ---- reordering a list ---------------------------------------------------

  async function saveOrder(action: () => Promise<string[]>) {
    if (savingOrder) return;
    savingOrder = true;
    try {
      const failed = await action();
      if (failed.length) showMessage('Not saved', 'The new place could not be saved. Try again.');
    } catch (error) {
      showMessage('Not saved', (error as Error).message);
    } finally {
      savingOrder = false;
    }
  }

  function moveInList(book: CatalogBook, delta: -1 | 1) {
    if (!collectionId) return;
    const id = collectionId;
    void saveOrder(() => collections.moveBookBy(id, book.id, delta));
  }

  function dropInList(book: CatalogBook, index: number) {
    if (!collectionId) return;
    const id = collectionId;
    void saveOrder(() => collections.moveBooks(id, [book.id], index));
  }

  async function listBookMenu(book: CatalogBook) {
    if (!collectionId) return;
    const id = collectionId;
    const action = await ask<CollectionBookAction | undefined>(CollectionBookActionsDialog, {
      title: book.title
    });
    if (action === 'top') void saveOrder(() => collections.moveBooks(id, [book.id], 0));
    else if (action === 'bottom') {
      void saveOrder(() => collections.moveBooks(id, [book.id], Number.MAX_SAFE_INTEGER));
    } else if (action === 'remove') void saveOrder(() => collections.removeBooks(id, [book.id]));
  }

  // ---- collection header ----------------------------------------------------

  async function editCollection() {
    if (!userCollection) return;
    try {
      const result = await collectionMenu(collections, userCollection);
      if (result === 'deleted') {
        await goto(`${pagePath}/collections`);
        return;
      }
      await loadCollections();
      if (result === 'search') void loadPage(true);
    } catch (error) {
      showMessage('Not saved', (error as Error).message);
    }
  }

  /** "Save as collection": the applied search becomes a saved search. */
  async function saveSearch() {
    const id = await newCollection(collections, {
      type: 'smart',
      query: appliedQuery,
      chooseType: false
    });
    if (!id) return;
    await loadCollections();
    await goto(urlFor({ tab: 'all', q: '', lib: '', collection: id }));
  }

  // ---- loading ------------------------------------------------------------

  async function refreshOnDevice() {
    try {
      const [links, ids] = await Promise.all([store.getAllLinks(), existingLocalIds()]);
      onDevice = new Set(links.filter((l) => ids.has(l.localId)).map((l) => l.bookId));
    } catch (error) {
      logger.warn(`Library: could not read local links: ${(error as Error).message}`);
    }
  }

  async function readUrlAndLoad() {
    const params = $page.url.searchParams;
    appliedQuery = params.get('q') ?? '';
    appliedLibrary = params.has('lib') ? (params.get('lib') ?? '') : $libraryFilter$;
    const requested = TABS.find((t) => t.id === params.get('tab')) ?? TABS[0];
    const nextCollection = params.get('collection') || null;
    if (nextCollection !== collectionId) reorderMode = false;
    collectionId = nextCollection;
    tab = collectionId ? 'all' : requested.id;
    group = null;
    // A collection's definition comes from the local mirror.
    if (collectionId && !collectionsLoaded) await loadCollections();
    if (!collectionId && requested.by) {
      if (requested.by === 'series' && params.get('none') === '1')
        group = { by: 'series', name: null };
      else if (params.get('group'))
        group = { by: requested.by, name: params.get('group') as string };
    }
    queryInput = appliedQuery;
    queryError = '';
    selected = new Set();
    return loadPage(true);
  }

  async function loadPage(reset: boolean, minBooks = LIST_PAGE) {
    if (!api) return;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const parsed = parseQuery(appliedQuery);
    if (!parsed.ok) {
      queryError = parsed.error.message;
      books = [];
      groups = [];
      nextCursor = null;
      return;
    }
    loading = true;
    loadError = '';
    try {
      // The server only knows book-state changes that reached it.
      if (reset) staleNote = false;
      const scope = builtinCollection(collectionId ?? '')?.query ?? smartQuery();
      const parsedScope = scope ? parseQuery(scope) : null;
      if (usesBookState(parsed.query) || (parsedScope?.ok && usesBookState(parsedScope.query))) {
        staleNote = await view.sendPendingChanges(timeoutSeconds);
        if (controller.signal.aborted) return;
      }
      if (collectionId !== null) {
        await loadCollectionPage(reset, scope, minBooks, controller.signal);
        return;
      }
      const common = {
        q: appliedQuery || undefined,
        library: appliedLibrary || undefined,
        cursor: reset ? undefined : (nextCursor ?? undefined)
      };
      const options = { signal: controller.signal };
      // From the URL state itself: reactive values ($:) are not updated yet when the URL
      // changed in this tick.
      const by = TABS.find((t) => t.id === tab)?.by ?? null;
      if (by && group === null) {
        const result = await api.groups({ by, ...common }, options);
        groups = reset ? result.groups : [...groups, ...result.groups];
        books = [];
        nextCursor = result.nextCursor;
      } else {
        if (reset) void loadGroupInfo(controller.signal);
        const result = await api.books({ ...common, group: group ?? undefined }, options);
        books = reset ? result.books : [...books, ...result.books];
        groups = [];
        nextCursor = result.nextCursor;
      }
    } catch (error) {
      if (error instanceof LibraryApiError && error.kind === 'aborted') return;
      if (handleAuthError(error)) return;
      if (
        error instanceof LibraryApiError &&
        (error.code === 'invalid_query' || error.code === 'regex_timeout')
      ) {
        // Keep what is shown; the problem is the search text.
        queryError = error.message;
        return;
      }
      loadError = describe(error);
      if (reset) {
        books = [];
        groups = [];
        nextCursor = null;
      }
    } finally {
      if (listController === controller) loading = false;
    }
  }

  /** The open collection's saved search, if it is one. */
  function smartQuery(): string | null {
    const c = collectionList.find((x) => x.id === collectionId);
    return c?.type === 'smart' ? c.query : null;
  }

  /**
   * A collection's books: a built-in or saved search is a search across all libraries
   * (with the search box inside it); a list is looked up in its own order, a chunk of
   * ids at a time, until a page is full.
   */
  async function loadCollectionPage(
    reset: boolean,
    scope: string | null,
    minBooks: number,
    signal: AbortSignal
  ) {
    if (!api || collectionId === null) return;
    const c = collectionList.find((x) => x.id === collectionId);
    if (scope) {
      const result = await api.books(
        {
          q: appliedQuery || undefined,
          scope,
          cursor: reset ? undefined : (nextCursor ?? undefined)
        },
        { signal }
      );
      books = reset ? result.books : [...books, ...result.books];
      groups = [];
      nextCursor = result.nextCursor;
      return;
    }
    if (c?.type !== 'manual') {
      books = [];
      groups = [];
      nextCursor = null;
      return;
    }
    const ids = (collectionItems.get(c.id) ?? []).map((i) => i.bookId);
    let consumed = reset ? 0 : listConsumed;
    const found: CatalogBook[] = [];
    while (consumed < ids.length && found.length < minBooks) {
      const chunk = ids.slice(consumed, consumed + LOOKUP_CHUNK);
      const result = await api.lookup(chunk, appliedQuery || undefined, { signal });
      found.push(...result.books);
      consumed += chunk.length;
    }
    listConsumed = consumed;
    books = reset ? found : [...books, ...found];
    groups = [];
    nextCursor = consumed < ids.length ? 'more' : null;
  }

  /** Totals and the read count for the open group's header. */
  async function loadGroupInfo(signal: AbortSignal) {
    groupInfo = null;
    if (!api || !group || group.name === null || group.name.includes('"')) return;
    try {
      const result = await api.groups(
        {
          by: group.by,
          q: `${FIELD_OF[group.by]}:="${group.name}"`,
          library: appliedLibrary || undefined,
          limit: 1
        },
        { signal }
      );
      const card = result.groups[0];
      if (card && card.name === group?.name) groupInfo = card;
    } catch {
      // The header shows just the name.
    }
  }

  function describe(error: unknown): string {
    if (error instanceof LibraryApiError) {
      if (error.kind === 'unreachable' || error.kind === 'timeout') {
        return 'The library server cannot be reached (offline, or the server is down). Books already on this device open from the Manager.';
      }
      if (error.code === 'indexer_off')
        return 'The Calibre library is not available on the server.';
    }
    return (error as Error).message;
  }

  /** A revoked or unknown token: back to the connect form. */
  function handleAuthError(error: unknown): boolean {
    if (error instanceof LibraryApiError && error.kind === 'unauthorized') {
      connectNotice = 'The server no longer accepts this device. Connect it again.';
      suggestedServerUrl = connection?.serverUrl || suggestedServerUrl;
      connection = null;
      api = undefined;
      return true;
    }
    return false;
  }

  async function onConnected(conn: LibraryConnection) {
    await store.setConnection(conn);
    connection = conn;
    connectNotice = '';
    notifySyncConnectionChanged();
    await startSession(conn);
  }

  async function disconnect() {
    await store.clearConnection();
    notifySyncConnectionChanged();
    suggestedServerUrl = connection?.serverUrl || suggestedServerUrl;
    connection = null;
    api = undefined;
    books = [];
    groups = [];
  }

  // ---- navigation ---------------------------------------------------------

  function urlFor(target: {
    tab: Tab;
    group?: { by: GroupBy; name: string | null } | null;
    q: string;
    lib: string;
    collection?: string | null;
  }) {
    const params = new URLSearchParams();
    if (target.collection) {
      params.set('collection', target.collection);
      if (target.q) params.set('q', target.q);
      return `${pagePath}/library?${params.toString()}`;
    }
    if (target.tab !== 'all') params.set('tab', target.tab);
    if (target.group) {
      if (target.group.name === null) params.set('none', '1');
      else params.set('group', target.group.name);
    }
    if (target.q) params.set('q', target.q);
    if (target.lib) params.set('lib', target.lib);
    const qs = params.toString();
    return `${pagePath}/library${qs ? `?${qs}` : ''}`;
  }

  function go(q: string) {
    goto(urlFor({ tab, group, q, lib: appliedLibrary, collection: collectionId }), {
      keepFocus: true,
      noScroll: true
    });
  }

  function search() {
    const q = queryInput.trim();
    const parsed = parseQuery(q);
    if (!parsed.ok) {
      queryError = parsed.error.message;
      return;
    }
    queryError = '';
    go(q);
  }

  function onChip(chip: ChipId) {
    const next = toggleChip(queryInput, chip);
    if (next === null) {
      search(); // shows the error
      return;
    }
    queryInput = next;
    queryError = '';
    go(next.trim());
  }

  function pickLibrary(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    $libraryFilter$ = value;
    goto(urlFor({ tab, group, q: appliedQuery, lib: value }), { keepFocus: true, noScroll: true });
  }

  function groupHref(g: CatalogGroup) {
    return urlFor({ tab, group: { by: g.by, name: g.name }, q: appliedQuery, lib: appliedLibrary });
  }

  function showSearchHelp() {
    dialogManager.dialogs$.next([{ component: SearchHelpDialog, props: {} }]);
  }

  // ---- opening books ------------------------------------------------------

  function askExisting(question: ExistingBookQuestion): Promise<boolean> {
    return new Promise((resolve) => {
      dialogManager.dialogs$.next([
        {
          component: ConfirmDialog,
          disableCloseOnClick: true,
          props: {
            dialogHeader: 'Already on this device',
            dialogMessage:
              `You already have "${question.title}" on this device ` +
              `(${question.localCharacters.toLocaleString()} characters). The Calibre copy has ` +
              `${question.calibreCharacters.toLocaleString()} characters, so it may be a different ` +
              'edition. Confirm opens your copy and remembers it as this Calibre book; your copy ' +
              'and its progress are not changed.',
            resolver: (canceled: boolean) => resolve(!canceled)
          }
        }
      ]);
    });
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  async function open(book: CatalogBook) {
    if (!api || opening) return;
    const controller = new AbortController();
    opening = { book, stage: null, controller };
    try {
      const deps = browserOpenDeps(
        api,
        store,
        async (libraryId) => libraries.find((l) => l.id === libraryId)?.calibreLibraryUuid ?? null,
        askExisting
      );
      const outcome = await openCalibreBook(book, deps, controller.signal, (stage) => {
        if (opening) opening = { ...opening, stage };
      });
      if (outcome.status === 'opened') {
        await goto(`${pagePath}/b?id=${outcome.localId}`);
        return;
      }
      if (outcome.status === 'refused') showMessage('Not opened', outcome.message);
      await refreshOnDevice();
    } catch (error) {
      if (handleAuthError(error)) return;
      logger.warn(`Library: opening "${book.title}" failed: ${(error as Error).message}`);
      showMessage('Could not open the book', describe(error));
    } finally {
      opening = null;
    }
  }

  $: emptyText = appliedQuery
    ? `Nothing matches "${appliedQuery}".`
    : isList
      ? 'Nothing in this collection yet. Add books with ⋯ on a book, or with Select.'
      : collectionId !== null
        ? 'No books match.'
        : showingGroups
          ? `No ${tabInfo.label.toLowerCase()} yet.`
          : 'No books yet.';
</script>

<svelte:head>
  <title>{formatPageTitle(collectionName ?? 'Library')}</title>
</svelte:head>

<svelte:window
  on:pointermove={onWindowPointerMove}
  on:pointerup={onWindowPointerUp}
  on:pointercancel={onWindowPointerUp}
  on:keydown={onWindowKeydown}
/>

<div class="elevation-4 fixed inset-x-0 top-0 z-10">
  <div class={baseHeaderClasses}>
    <div class="{pxScreen} flex h-full items-center justify-between">
      <h1 class="text-lg font-medium">Library</h1>
      <MergedHeaderIcon
        items={[mergeEntries.MANAGE, mergeEntries.LIBRARY, mergeEntries.COLLECTIONS]}
      />
    </div>
  </div>
</div>

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="library-page">
  {#if connection === undefined}
    <p class="py-8">Loading…</p>
  {:else if connection === null}
    <LibraryConnect
      serverUrl={suggestedServerUrl}
      notice={connectNotice}
      {timeoutSeconds}
      on:connected={(ev) => onConnected(ev.detail)}
    />
  {:else}
    <form class="flex items-end gap-3 pt-3" on:submit|preventDefault={search}>
      <label class="min-w-0 grow">
        <span class="sr-only">Search the library</span>
        <input
          class={searchInputClasses}
          type="search"
          enterkeyhint="search"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Title, author or series — or author: tag: chars:<100000 …"
          aria-invalid={queryError ? 'true' : undefined}
          aria-describedby={queryError ? 'library-query-error' : undefined}
          data-testid="library-search"
          bind:value={queryInput}
        />
      </label>
      <button
        class="flex h-10 items-center rounded border border-current px-5"
        type="submit"
        title="Search"
      >
        <Fa icon={faMagnifyingGlass} />
      </button>
    </form>
    <div class="flex flex-wrap items-center justify-between gap-x-4 pb-2 pt-1 text-sm">
      {#if queryError}
        <p id="library-query-error" class="font-medium" role="alert" data-testid="query-error">
          {queryError}
        </p>
      {:else}
        <span />
      {/if}
      <div class="flex flex-wrap items-center gap-x-4">
        {#if appliedQuery && collectionId === null && !queryError}
          <button
            class="min-h-[2.75rem] underline"
            type="button"
            data-testid="save-search"
            on:click={saveSearch}
          >
            Save as collection
          </button>
        {/if}
        <button class="min-h-[2.75rem] underline" type="button" on:click={showSearchHelp}>
          Search help
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 pb-2 lg:flex-nowrap">
      {#if collectionId === null}
        <nav class="grid grow grid-cols-4 gap-1 lg:max-w-md" aria-label="Browse by">
          {#each TABS as t (t.id)}
            <a
              class="flex min-h-[3rem] items-center justify-center rounded border-2 px-2 font-medium {t.id ===
              tab
                ? solid
                : 'border-current'}"
              href={urlFor({ tab: t.id, q: appliedQuery, lib: appliedLibrary })}
              aria-current={t.id === tab ? 'page' : undefined}
              data-testid="tab-{t.id}"
              data-sveltekit-noscroll
            >
              {t.label}
            </a>
          {/each}
        </nav>
      {/if}
      <div class="flex flex-wrap items-center gap-2 text-sm">
        {#if enabledLibraries.length > 1 && collectionId === null}
          <label class="flex items-center">
            Library
            <select
              class="ml-2 min-h-[3rem] border-2 border-current bg-transparent"
              value={appliedLibrary}
              on:change={pickLibrary}
            >
              <option value="">All libraries</option>
              {#each enabledLibraries as lib (lib.id)}
                <option value={lib.id}>{lib.name}</option>
              {/each}
            </select>
          </label>
        {/if}
        <div class="flex" role="group" aria-label="View">
          <button
            class="min-h-[3rem] rounded-l border-2 px-3 {grid ? solid : 'border-current'}"
            aria-pressed={grid}
            data-testid="view-grid"
            on:click={() => ($libraryView$ = 'grid')}
          >
            Grid
          </button>
          <button
            class="-ml-0.5 min-h-[3rem] rounded-r border-2 px-3 {!grid ? solid : 'border-current'}"
            aria-pressed={!grid}
            data-testid="view-list"
            on:click={() => ($libraryView$ = 'list')}
          >
            List
          </button>
        </div>
        <button
          class="min-h-[3rem] rounded border-2 px-3 {infoLine ? solid : 'border-current'}"
          aria-pressed={infoLine}
          data-testid="view-details"
          on:click={() => ($libraryInfoLine$ = !infoLine)}
        >
          Details
        </button>
        {#if !showingGroups && !reorderMode}
          <button
            class="min-h-[3rem] rounded border-2 px-3 {selectMode ? solid : 'border-current'}"
            aria-pressed={selectMode}
            data-testid="select-mode"
            on:click={toggleSelectMode}
          >
            {selectMode ? 'Done' : 'Select'}
          </button>
        {/if}
      </div>
    </div>

    <div class="flex flex-wrap gap-2 pb-3" role="group" aria-label="Filters">
      {#each CHIPS as chip (chip.id)}
        <button
          class="min-h-[2.75rem] rounded-full border-2 px-4 text-sm font-medium disabled:opacity-50 {chips.has(
            chip.id
          )
            ? solid
            : 'border-current'}"
          aria-pressed={chips.has(chip.id)}
          disabled={chipsDisabled}
          data-testid="chip-{chip.id}"
          on:click={() => onChip(chip.id)}
        >
          {chip.label}
        </button>
      {/each}
    </div>

    {#if indexerError}
      <p class="py-2 font-medium">{indexerError}</p>
    {/if}
    {#if staleNote}
      <p class="py-1 text-sm" data-testid="stale-note">
        Some of your recent changes haven't reached the server yet; this list may be out of date.
      </p>
    {/if}
    {#if usesChars && uncounted > 0}
      <p class="py-1 text-sm" data-testid="uncounted-note">
        {plural(uncounted, "book isn't", "books aren't")} counted yet and {uncounted === 1
          ? 'is'
          : 'are'} left out.
      </p>
    {/if}
    {#if loadError}
      <p class="py-4 font-medium" role="alert">
        {loadError}
        <a class="underline" href="{pagePath}/manage">Go to the Manager</a>
      </p>
    {/if}

    {#if collectionId !== null}
      <div class="mb-3 border-b-2 border-gray-400/60 pb-3" data-testid="collection-header">
        <a class="inline-flex min-h-[3rem] items-center underline" href="{pagePath}/collections">
          Back to Collections
        </a>
        {#if collectionGone}
          <p class="py-2 font-medium" data-testid="collection-gone">
            This collection doesn't exist any more (it may have been deleted on another device).
          </p>
        {:else}
          <h2 class="break-words text-xl font-medium" data-testid="collection-title">
            {collectionName ?? ''}
          </h2>
          <p class="break-words text-sm" data-testid="collection-header-info">
            {#if builtin}
              Built-in · {builtin.query}
            {:else if userCollection?.type === 'smart'}
              Saved search · {userCollection.query}
            {:else if isList}
              {plural(listIds.length, 'book', 'books')}
            {/if}
          </p>
          {#if userCollection}
            <div class="mt-2 flex flex-wrap gap-2">
              {#if isList}
                <button
                  class="min-h-[3rem] rounded border-2 px-4 font-medium disabled:opacity-50 {reorderMode
                    ? solid
                    : 'border-current'}"
                  aria-pressed={reorderMode}
                  disabled={!canReorder || selectMode}
                  title={appliedQuery ? 'Clear the search to reorder' : undefined}
                  data-testid="reorder-mode"
                  on:click={() => (reorderMode = !reorderMode)}
                >
                  {reorderMode ? 'Done' : 'Reorder'}
                </button>
              {/if}
              <button
                class="min-h-[3rem] rounded border-2 border-current px-4 font-medium"
                data-testid="collection-header-menu"
                on:click={editCollection}
              >
                {userCollection.type === 'smart' ? 'Rename, change search…' : 'Rename, delete…'}
              </button>
            </div>
          {/if}
        {/if}
      </div>
    {:else if group}
      <div class="mb-3 border-b-2 border-gray-400/60 pb-3" data-testid="group-header">
        <a
          class="inline-flex min-h-[3rem] items-center underline"
          href={urlFor({ tab, q: appliedQuery, lib: appliedLibrary })}
          data-sveltekit-noscroll
        >
          {BACK_LABEL[group.by]}
        </a>
        <h2 class="text-xl font-medium">{group.name ?? 'No series'}</h2>
        {#if groupInfo}
          <p class="text-sm" data-testid="group-header-info">
            {[
              groupCount(groupInfo),
              groupInfo.bookIds
                ? `${seriesReadCount(groupInfo.bookIds, states)}/${groupInfo.bookCount} read`
                : '',
              groupInfo.by === 'series' ? formatGroupChars(groupInfo.chars) : ''
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        {:else if group.name === null}
          <p class="text-sm">Books that are not part of a series.</p>
        {/if}
        {#if headerTag !== null}
          <button
            class="mt-2 min-h-[3rem] rounded border-2 px-4 font-medium {tagRules.has(headerTag)
              ? solid
              : 'border-current'}"
            aria-pressed={tagRules.has(headerTag)}
            data-testid="tag-blur-header"
            on:click={() => headerTag !== null && editTagCover(headerTag)}
          >
            Blur covers with this tag
          </button>
        {/if}
      </div>
    {/if}

    {#if showingGroups}
      {#if groups.length}
        <ul
          class={grid
            ? 'grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8'
            : ''}
          data-testid="group-list"
        >
          {#each groups as g (groupKey(g))}
            <LibraryGroupCard
              group={g}
              href={groupHref(g)}
              tiles={groupTiles(g, states, tagRules, revealed)}
              readCount={g.bookIds ? seriesReadCount(g.bookIds, states) : 0}
              layout={grid ? 'grid' : 'list'}
              {infoLine}
              menu={g.by === 'tag' && g.name !== null}
              on:reveal={(ev) => reveal(groupKey(ev.detail))}
              on:menu={(ev) => ev.detail.name !== null && editTagCover(ev.detail.name)}
            />
          {/each}
        </ul>
      {:else if !loading && !loadError}
        <p class="py-8">{emptyText}</p>
      {/if}
    {:else if reorderMode && books.length}
      <CollectionReorderList
        {books}
        busy={savingOrder}
        thumbnailUrl={(book) => (book.thumbnail && api ? api.absolute(book.thumbnail) : '')}
        blurred={(book) => bookBlurred(book, states, tagRules, revealed)}
        on:move={(ev) => moveInList(ev.detail.book, ev.detail.delta)}
        on:drop={(ev) => dropInList(ev.detail.book, ev.detail.index)}
        on:more={(ev) => listBookMenu(ev.detail)}
      />
    {:else if books.length}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <ul
        bind:this={listElement}
        class={grid
          ? 'grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8'
          : ''}
        class:select-none={selectMode}
        data-testid="book-list"
        on:pointerdown={onListPointerDown}
        on:dragstart={onListDragStart}
      >
        {#each books as book (book.id)}
          {#if grid}
            <LibraryBookCard
              {book}
              thumbnailUrl={book.thumbnail && api ? api.absolute(book.thumbnail) : ''}
              state={states.get(book.id)}
              progress={bookProgressLabel(
                book.id,
                states.get(book.id),
                positions.get(book.id) ?? [],
                book.charCount
              )}
              {infoLine}
              blurred={bookBlurred(book, states, tagRules, revealed)}
              onDevice={onDevice.has(book.id)}
              {selectMode}
              selected={selected.has(book.id)}
              on:open={(ev) => open(ev.detail)}
              on:reveal={(ev) => reveal(ev.detail.id)}
              on:toggle={(ev) => onToggle(ev.detail.book, ev.detail.shift)}
              on:state={(ev) => openBookState(ev.detail)}
            />
          {:else}
            <LibraryBookRow
              {book}
              thumbnailUrl={book.thumbnail && api ? api.absolute(book.thumbnail) : ''}
              onDevice={onDevice.has(book.id)}
              state={states.get(book.id)}
              progress={bookProgressLabel(
                book.id,
                states.get(book.id),
                positions.get(book.id) ?? [],
                book.charCount
              )}
              {infoLine}
              blurred={bookBlurred(book, states, tagRules, revealed)}
              {selectMode}
              selected={selected.has(book.id)}
              libraryName={enabledLibraries.length > 1
                ? (libraryNames.get(book.libraryId) ?? '')
                : ''}
              on:open={(ev) => open(ev.detail)}
              on:reveal={(ev) => reveal(ev.detail.id)}
              on:toggle={(ev) => onToggle(ev.detail.book, ev.detail.shift)}
              on:state={(ev) => openBookState(ev.detail)}
            />
          {/if}
        {/each}
      </ul>
    {:else if !loading && !loadError && !queryError}
      <p class="py-8">{emptyText}</p>
    {/if}

    {#if loading}
      <p class="py-4">Loading…</p>
    {:else if nextCursor}
      <div class="flex justify-center py-6">
        <button
          class="min-h-[3rem] rounded border-2 border-current px-6 font-medium"
          data-testid="load-more"
          on:click={() => loadPage(false)}
        >
          Load more
        </button>
      </div>
    {/if}

    <p class="mt-10 text-sm">
      <a class="underline" href="{pagePath}/migration">Migration from the old sync</a>
    </p>

    <details class="mt-4 text-sm" on:toggle={onConnectionToggle}>
      <summary class="cursor-pointer">Connection</summary>
      <div class="py-3">
        <p>Server: {connection.serverUrl}</p>
        <p>This device: {connection.label}</p>
        {#if charCountSummary}
          <p>{charCountSummary}</p>
        {/if}
        <label class="mt-3 block max-w-xs">
          Request timeout (seconds, 0 = none)
          <input
            class={searchInputClasses}
            type="number"
            min="0"
            step="1"
            bind:value={$libraryRequestTimeoutSeconds$}
          />
        </label>
        <LibrarySyncStatus />
        <p class="mt-6">
          Disconnecting forgets the token on this device. To block it on the server too, run
          <code>token revoke</code> there.
        </p>
        <button class="{buttonClasses} mt-2 border border-current" on:click={disconnect}>
          Disconnect
        </button>
      </div>
    </details>
  {/if}
</div>

{#if dragBox}
  <div
    class="pointer-events-none fixed z-20 border-2 border-dashed border-gray-800"
    style="left: {dragBox.left}px; top: {dragBox.top}px; width: {dragBox.width}px; height: {dragBox.height}px"
    data-testid="drag-box"
  />
{/if}

{#if selectMode && connection && !showingGroups}
  <div
    class="fixed inset-x-0 bottom-0 z-10 border-t-2 border-gray-700 bg-white"
    data-testid="select-bar"
  >
    <div class="{pxScreen} flex flex-wrap items-center justify-between gap-2 py-2">
      <span data-testid="selected-count">{selected.size} selected</span>
      <div class="flex flex-wrap gap-2">
        <button
          class="min-h-[3rem] rounded border-2 border-current px-4 font-medium"
          data-testid="select-all"
          on:click={selectAllShown}
        >
          All shown
        </button>
        {#if isList}
          <button
            class="min-h-[3rem] rounded border-2 border-current px-4 font-medium disabled:opacity-50"
            disabled={!selected.size}
            data-testid="list-move-top"
            on:click={() => listBulk('top')}
          >
            Move to top
          </button>
          <button
            class="min-h-[3rem] rounded border-2 border-current px-4 font-medium disabled:opacity-50"
            disabled={!selected.size}
            data-testid="list-remove"
            on:click={() => listBulk('remove')}
          >
            Remove from collection
          </button>
        {/if}
        <button
          class="min-h-[3rem] rounded border-2 border-current px-4 font-medium disabled:opacity-50"
          disabled={!selected.size}
          data-testid="bulk-change"
          on:click={bulkChange}
        >
          Change…
        </button>
        <button
          class="min-h-[3rem] rounded border-2 border-current px-4 font-medium"
          on:click={toggleSelectMode}
        >
          Done
        </button>
      </div>
    </div>
  </div>
{/if}

{#if opening}
  <LibraryOpenOverlay
    title={opening.book.title}
    stage={opening.stage}
    on:cancel={() => opening?.controller.abort()}
  />
{/if}
