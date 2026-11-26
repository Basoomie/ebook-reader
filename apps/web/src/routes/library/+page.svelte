<script lang="ts">
  import SeriesHighlights from '$lib/components/notes/series-highlights.svelte';
  import SeriesRecap from '$lib/components/summaries/series-recap.svelte';
  import { setPendingJump, type PendingJump } from '$lib/notes/pending-jump';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { saveListSnapshot, takeListSnapshot } from '$lib/library/list-snapshot';
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
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import BulkEditDialog, { type BulkChange } from '$lib/components/library/bulk-edit-dialog.svelte';
  import LibraryBookCard from '$lib/components/library/library-book-card.svelte';
  import { loadRatingFeatures, ratingFeatures$, volumeOneText } from '$lib/library/store-ratings';
  import LibraryBookRow from '$lib/components/library/library-book-row.svelte';
  import LibraryConnect from '$lib/components/library/library-connect.svelte';
  import LibraryGroupCard from '$lib/components/library/library-group-card.svelte';
  import LibraryDisplayMenu from '$lib/components/library/library-display-menu.svelte';
  import LibraryGroupByMenu from '$lib/components/library/library-group-by-menu.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import LibrarySortMenu from '$lib/components/library/library-sort-menu.svelte';
  import SelectDownloadMenu from '$lib/components/library/select-download-menu.svelte';
  import { canLoadWhenVisible, loadWhenVisible } from '$lib/components/load-when-visible';
  import MarkCompletedDialog from '$lib/components/library/mark-completed-dialog.svelte';
  import SearchHelpDialog from '$lib/components/library/search-help-dialog.svelte';
  import CoverRuleDialog from '$lib/components/library/cover-rule-dialog.svelte';
  import UploadDuplicateDialog from '$lib/components/library/upload-duplicate-dialog.svelte';
  import UploadLibraryDialog from '$lib/components/library/upload-library-dialog.svelte';
  import UploadProgressOverlay from '$lib/components/library/upload-progress-overlay.svelte';
  import UploadSummaryDialog from '$lib/components/library/upload-summary-dialog.svelte';
  import { uploadFiles, type UploadDecision, type UploadResult } from '$lib/library/upload-flow';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { browser } from '$app/environment';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import BookmeterWantedMissing from '$lib/components/bookmeter/bookmeter-wanted-missing.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager, type Dialog } from '$lib/data/dialog-manager';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    removeFavoritesCopy,
    removeFromCollectionCopy,
    unreadManyCopy
  } from '$lib/confirm/confirm-copy';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { audioBookIdsOnDevice } from '$lib/audio/offline/audio-offline';
  import { database, einkMode$ } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
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
    startsOffline
  } from '$lib/library/offline/offline-source';
  import { removeFromThisDevice } from '$lib/library/remove-from-device';
  import {
    collectionMembership,
    coverBlurDefault,
    hasCoverRule,
    isCoverBlurred,
    NO_COVER_RULES,
    tileBlurBook,
    type BlurBook,
    type BlurRuleTarget,
    type CoverBlurContext,
    type CoverRules
  } from '$lib/library/cover-blur';
  import { coverGrid } from '$lib/library/cover-size';
  import {
    authorHref,
    formatGroupChars,
    groupCount,
    groupTitle,
    plural
  } from '$lib/library/format';
  import {
    defaultSort,
    formatSort,
    parseSort,
    serverSort,
    type SortContext,
    type SortValue
  } from '$lib/library/sort';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import { isPinnedToHome, setPinnedToHome } from '$lib/home/pins';
  import type { PinTarget } from '$lib/home/rows';
  import { homeRows$ } from '$lib/home/settings';
  import {
    bookProgressFraction,
    bookProgressLabel,
    positionsByBook,
    seriesReadCount
  } from '$lib/library/progress';
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import {
    activeChips,
    chipOnlyQuery,
    CHIPS,
    toggleChip,
    type ChipId
  } from '$lib/library/query/chips';
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
    collectionGroupsAs$,
    collectionSectionsBy$,
    libraryAutoLoad$,
    libraryCoverBlur$,
    libraryCoverSize$,
    libraryFilter$,
    libraryGroupSort$,
    libraryInfoLine$,
    libraryRequestTimeoutSeconds$,
    librarySort$,
    libraryView$
  } from '$lib/library/settings';
  import type {
    CatalogBook,
    CatalogGroup,
    CatalogLibrary,
    GroupBy,
    GroupTile,
    UploadInfo
  } from '$lib/library/types';
  import { finishedReadThroughs, type BookState } from '$lib/sync/book-state';
  import type { LocalRecord } from '$lib/sync/sync-db';
  import {
    bookStateApi,
    collectionsApi,
    getSyncEngine,
    libraryViewApi,
    notifySyncConnectionChanged,
    searchHistoryApi
  } from '$lib/sync/sync-service';
  import { bulkSummaryPlan, skipAutomaticSummaries } from '$lib/summaries/summary-sync';
  import { summaryAutoOnFirstCompletion$ } from '$lib/summaries/settings';
  import {
    faArrowUpFromBracket,
    faArrowsUpDown,
    faCheck,
    faEyeSlash,
    faMagnifyingGlass,
    faPen,
    faRotateRight,
    faSquareCheck,
    faThumbtack
  } from '@fortawesome/free-solid-svg-icons';
  import { onDestroy, onMount, tick } from 'svelte';
  import SeriesEdit from '$lib/components/calibre-edit/series-edit.svelte';
  import { CalibreEditApi } from '$lib/calibre-edit/api';
  import { seriesEditAs$ } from '$lib/calibre-edit/settings';
  import Fa from 'svelte-fa';
  import LibrarySearchHistory from '$lib/components/search-history/library-search-history.svelte';
  import { searchHistoryOn$ } from '$lib/search-history/settings';
  import SearchSuggestions from '$lib/components/library/search-suggestions.svelte';
  import { openSearchPalette } from '$lib/search-palette/open';
  import { describeQuery } from '$lib/library/query/describe';
  import { searchReadsAsOn$, searchSuggestionsOn$ } from '$lib/library/search-settings';
  import type { NameListQuery } from '$lib/library/api';

  /**
   * Library (WP6, WP7a): browse and search the Calibre catalog and open a book through
   * the existing import pipeline. Every view is a URL
   * (?tab=all|series|authors|tags&group=<name>|none=1&q=&lib=), so going back from the
   * reader or a group restores it. Plain for e-ink: no animations.
   *
   * WP19a: &sort= (lib/library/sort.ts), a count of the list, the next page loading near
   * the end (a "Load more" button when that is off), cover size and author links. The
   * Connection panel and the migration link moved to Settings > Data.
   *
   * WP8b: ?collection=<id> shows one collection (a built-in, a saved search or a list)
   * across all libraries; the search box filters inside it. A list shows its own order
   * (from the local mirror, so moves show at once) and can be reordered.
   *
   * 2026-11-24: a collection shows its books' series, authors and tags too
   * (?collection=<id>&tab=series[&group=<name>]), counted inside the collection: as the
   * Library's tabs, or as sections under headings (Settings › Library › Theme and display).
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
  const TAB_OF: Record<GroupBy, Tab> = { series: 'series', author: 'authors', tag: 'tags' };
  /** Sections: books shown under each heading before "See all". */
  const SECTION_BOOKS = 12;
  const HEADER_RULE_LABEL: Record<BlurRuleTarget, string> = {
    tag: 'Blur covers with this tag',
    author: "Blur this author's covers",
    series: "Blur this series' covers",
    collection: 'Blur covers'
  };
  // The search box without the shared input's transition (e-ink).
  /** Book ids looked up per request for a list (server limit 200). */
  const LOOKUP_CHUNK = 100;
  /** A list page shows at least this many matching books when there are more. */
  const LIST_PAGE = 50;

  const store = getLibraryStore();

  let connection: LibraryConnection | null | undefined;
  let connectNotice = '';
  let suggestedServerUrl = '';
  let api: LibraryApi | undefined;
  /**
   * Season 2 §2, offline Library: the server can't be reached, so every list is answered
   * by the offline catalog (this device's books) until "Try again" or the network returns.
   */
  let offline = false;
  /** The series editor (Calibre metadata editing): open on this series page. */
  let seriesEditOpen = false;
  let seriesSaved = false;

  /** Who answers the lists: the server, or the offline catalog while offline. */
  function source(): LibraryApi | OfflineCatalog | undefined {
    if (!api) return undefined;
    return offline ? offlineCatalog() : api;
  }

  let libraries: CatalogLibrary[] = [];
  let indexerError = '';
  let books: CatalogBook[] = [];
  let groups: CatalogGroup[] = [];
  let nextCursor: string | null = null;
  let loading = false;
  let loadError = '';
  /** WP19a: loading the next page failed ("Couldn't load more · Retry"). */
  let moreError = '';
  /** WP19a: the list's sort and what the Sort menu offers here. */
  let sortContext: SortContext = 'books';
  let sortValue: SortValue = defaultSort('books', { books: '', groups: '' });
  /** WP19a: how many books (or groups) the list has; null = unknown or still counting. */
  let resultCount: number | null = null;
  let counting = false;
  let countController: AbortController | undefined;
  /** WP19b: counts on the tabs and chips, for the current search (loadSideCounts). */
  let tabCounts: Partial<Record<Tab, number>> = {};
  let chipCounts = new Map<ChipId, number>();
  let tabCountsKey: string | null = null;
  let chipCountsKey: string | null = null;
  let sideCountsController: AbortController | undefined;
  let tabCountsPending = false;
  let sideCountsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Opened from a Home row's "See all" (`from=home`): the back link goes to Home. */
  let fromHome = false;
  let searchInput: HTMLInputElement | undefined;
  // Search history (2026-11-24): the drop-down under the box.
  let searchBox: HTMLElement | undefined;
  let searchHistory: LibrarySearchHistory | undefined;
  let historyOpen = false;
  let historyActiveId: string | undefined;
  // Search palette step 1 (2026-11-24): suggestions while typing and the "Reads as" line.
  let suggestions: SearchSuggestions | undefined;
  let suggestOpen = false;
  let suggestActiveId: string | undefined;
  /** The caret's place in the search box. */
  let searchCursor = 0;
  let searchFocused = false;
  $: reading = $searchReadsAsOn$
    ? describeQuery(queryInput, searchCursor)
    : { kind: 'none' as const };

  function trackCursor() {
    searchCursor = searchInput?.selectionStart ?? queryInput.length;
  }

  function suggestNames(q: NameListQuery) {
    const s = source();
    return s ? s.names(q) : Promise.resolve([]);
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (suggestions?.onKeydown(event)) return;
    searchHistory?.onKeydown(event);
  }

  async function pickSuggestion(next: { text: string; cursor: number }) {
    queryInput = next.text;
    queryError = '';
    await tick();
    searchInput?.focus();
    searchInput?.setSelectionRange(next.cursor, next.cursor);
    searchCursor = next.cursor;
  }
  /** WP19c: how the page was last reached ('popstate' = back/forward). */
  let lastNavigation: string | null = null;
  /** WP19c: what a list snapshot keeps. */
  interface ListState {
    books: CatalogBook[];
    groups: CatalogGroup[];
    nextCursor: string | null;
    resultCount: number | null;
    listConsumed: number;
  }
  let onDevice = new Set<string>();
  /** Season 2 Phase 9: books whose audio is downloaded here. */
  let audioOnDevice = new Set<string>();

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
  /** Sections (2026-11-24): the books under each heading (key: groupKey). */
  let sectionBooks = new Map<string, CatalogBook[] | 'loading' | 'error'>();
  let sectionsController: AbortController | undefined;
  let staleNote = false;
  let listController: AbortController | undefined;

  let opening: { book: CatalogBook; stage: OpenStage | null; controller: AbortController } | null =
    null;
  // WP7b: uploads (shown when the server takes them).
  let uploadInfo: UploadInfo | null = null;
  let uploadInput: HTMLInputElement | undefined;
  let uploading: {
    index: number;
    count: number;
    name: string;
    loaded: number;
    total: number;
    controller: AbortController;
  } | null = null;

  // WP8a/WP7a: book state, tag rules and positions from the local sync mirror.
  const bookState = bookStateApi();
  const view = libraryViewApi();
  const collections = collectionsApi();
  let collectionList: Collection[] = [];
  let collectionItems = new Map<string, CollectionItem[]>();
  let collectionsLoaded = false;
  let collectionsTimer: ReturnType<typeof setTimeout> | undefined;
  let states = new Map<string, BookState>();
  /** Cover blur rules: tags, authors, series and collections (cover-blur.ts). */
  let coverRules: CoverRules = NO_COVER_RULES;
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
  /** Select all: the server is listing every matching book. */
  let selectingAll = false;
  let selectAllController: AbortController | undefined;
  /** Change… on books not loaded yet: looking them up ("Loading 400 of 2,000 books"). */
  let selectBusy = '';

  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  // A changed timeout setting applies to the next request.
  $: if (connection && api && api.timeoutSeconds !== timeoutSeconds) api = makeApi(connection);
  $: libraryNames = new Map(libraries.map((l) => [l.id, l.name]));
  $: enabledLibraries = libraries.filter((l) => l.enabled);
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
  $: canReorder = isList && !appliedQuery && books.length > 1 && sortValue.key === 'list';
  $: if (!canReorder && reorderMode && !savingOrder) reorderMode = false;
  $: showingGroups = tabInfo.by !== null && group === null;
  /** A collection shows its series, authors and tags as tabs, or as sections (Group by). */
  $: collectionSections = collectionId !== null && $collectionGroupsAs$ === 'sections';
  $: collectionTabs = collectionId !== null && !collectionSections;
  $: chips = activeChips(queryInput);
  $: chipsDisabled = !parseQuery(queryInput).ok;
  $: grid = $libraryView$ !== 'list';
  $: infoLine = $libraryInfoLine$;
  $: gridLayout = coverGrid($libraryCoverSize$);
  // WP19a: load the next page near the end of the list (else a "Load more" button).
  $: autoLoad = browser && $libraryAutoLoad$ && canLoadWhenVisible();
  // WP19b: the page header's label and title.
  $: headerJp = group
    ? { series: '叢書', author: '著者', tag: '分類' }[group.by]
    : collectionId !== null
      ? '書架'
      : '蔵書一覧';
  $: headerTitle = group
    ? (group.name ?? 'No series')
    : collectionId !== null
      ? collectionGone
        ? 'Collection'
        : (collectionName ?? '')
      : 'Library';
  $: parsedApplied = parseQuery(appliedQuery);
  $: usesChars = parsedApplied.ok && parsedApplied.query.terms.some((t) => t.type === 'chars');
  $: uncounted = enabledLibraries
    .filter((l) => !appliedLibrary || l.id === appliedLibrary)
    .reduce((n, l) => n + (l.counts ? l.counts.pending + l.counts.errors : 0), 0);
  $: bookIds = books.map((b) => b.id);
  /** A series page (not "No series"): Edit series opens its editor (Calibre metadata editing). */
  $: seriesEditName =
    group && group.by === 'series' && group.name !== null && connection ? group.name : null;
  /** The open tag, author or series (not "No series"): its cover rule in the header. */
  $: headerRule =
    group && group.name !== null ? { target: group.by as BlurRuleTarget, name: group.name } : null;
  // WP7b: "Pin to Home" for an open collection, series, author or tag ("No series" can't be).
  let pinTarget: PinTarget | null = null;
  $: pinTarget = group
    ? group.name !== null
      ? { type: group.by, ref: group.name }
      : null
    : collectionId !== null
      ? collectionGone
        ? null
        : builtin
          ? { type: 'builtin', ref: builtin.id }
          : userCollection
            ? { type: 'collection', ref: userCollection.id }
            : null
      : null;
  $: pinnedHere = pinTarget ? isPinnedToHome($homeRows$, pinTarget) : false;

  function togglePin() {
    if (pinTarget) setPinnedToHome(pinTarget, !pinnedHere);
  }

  onMount(async () => {
    // Offline, this visit reads this device's books once (not once per request).
    freshOfflineCatalog();
    void loadMirror();
    // Places saved on other devices (and their collections) show without waiting for
    // the next timed sync.
    void view.syncSoon();
    const subscriptions = [
      bookState.onChanged(() => {
        void loadStates();
        onStatesChangedForCounts();
      }),
      view.onChanged(() => void loadViewData()),
      collections.onChanged(onCollectionsChanged)
    ];
    for (const sub of subscriptions) {
      void sub.then((off) => {
        if (destroyed) off();
        else stopListeners.push(off);
      });
    }
    window.addEventListener('online', onBrowserOnline);
    suggestedServerUrl = await selfHostServerUrl();
    connection = (await store.getConnection()) ?? null;
    if (connection) await startSession(connection);
  });

  onDestroy(() => {
    destroyed = true;
    if (browser) window.removeEventListener('online', onBrowserOnline);
    clearTimeout(collectionsTimer);
    clearTimeout(sideCountsTimer);
    stopListeners.forEach((off) => off());
    listController?.abort();
    sideCountsController?.abort();
    opening?.controller.abort();
  });

  // WP19c: keep the list when leaving (a book's details, the reader…) for back/forward.
  beforeNavigate(() => {
    if (!connection || (!books.length && !groups.length)) return;
    saveListSnapshot<ListState>(snapshotKey(), window.scrollY, {
      books,
      groups,
      nextCursor,
      resultCount,
      listConsumed
    });
  });

  afterNavigate((nav) => {
    lastNavigation = nav.type;
    if (connection && api) void readUrlAndLoad();
  });

  /**
   * The old self-hosted sync server's address, as a starting point for the connect form.
   * WP15e removed the old sync; its stored source (if any) is only read here.
   */
  async function selfHostServerUrl(): Promise<string> {
    try {
      const name = window.localStorage.getItem('selfHostStorageSource');
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
    const ratingsApi = api;
    void loadRatingFeatures(() => ratingsApi.ratingFeatures({ timeoutSeconds: 20 }));
    // "Loading…" until the first list is shown ("No books yet" only for an empty list).
    loading = true;
    await refreshOnDevice();
    // No network at all, or the server didn't answer a moment ago (another page): show
    // this device's books at once and ask the server in the background.
    offline = startsOffline();
    if (offline) {
      void recheckServer(conn);
    } else {
      const reached = await askLibraries(api, conn);
      if (reached === 'unauthorized') {
        loading = false;
        return;
      }
      if (reached === 'unreachable') offline = true;
    }
    if (offline) await useOfflineLibraries();
    await readUrlAndLoad();
  }

  /**
   * The libraries, with the quick server check beside it: when the check gets no answer
   * in its short time, the request is given up (away from home it would only end at the
   * request timeout) and the page shows this device's books.
   */
  async function askLibraries(
    a: LibraryApi,
    conn: LibraryConnection
  ): Promise<'ok' | 'unreachable' | 'unauthorized' | 'failed'> {
    const first = await askServerFirst(conn.serverUrl, (signal) => a.libraries({ signal }));
    if (first.status === 'unreachable') return 'unreachable';
    if (first.status === 'error') {
      if (handleAuthError(first.error)) return 'unauthorized';
      // Another problem: the list request below reports it.
      return 'failed';
    }
    const result = first.value;
    libraries = result.libraries;
    indexerError = result.indexer.enabled ? '' : result.indexer.error || 'The indexer is off';
    uploadInfo = result.uploads ?? null;
    void saveOfflineLibraries(result.libraries);
    return 'ok';
  }

  /** Offline: when the server answers the quick check again, show the whole library. */
  async function recheckServer(conn: LibraryConnection) {
    if (!(await serverAnswersAgain(conn.serverUrl))) return;
    if (!destroyed && offline && connection === conn) tryServerAgain();
  }

  /** The libraries the server named last time (picker, names), while offline. */
  async function useOfflineLibraries() {
    if (libraries.length) return;
    try {
      libraries = (await offlineCatalog().libraries()).libraries;
    } catch {
      // No picker.
    }
  }

  /**
   * The server can't be reached: from now on this visit shows the offline Library (the
   * books on this device) until "Try again" or the network comes back.
   */
  async function goOffline() {
    noteUnreachable();
    if (offline) return;
    offline = true;
    staleNote = false;
    uploadInfo = null;
    tabCountsKey = null;
    chipCountsKey = null;
    await useOfflineLibraries();
    await loadPage(true);
  }

  /** "Try again", or the browser is online again: ask the server. */
  function tryServerAgain() {
    if (!offline || !connection) return;
    offline = false;
    // Ask the server itself (with the quick check), not what the last page found.
    noteReachable();
    tabCountsKey = null;
    chipCountsKey = null;
    void startSession(connection);
  }

  function onBrowserOnline() {
    tryServerAgain();
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
      const filterBefore = JSON.stringify(collectionFilter());
      await loadCollections();
      if (collectionId === null) return;
      // WP19a: a collection that arrived after the page opened (pulled from another
      // device) only now says whether it is a list, which decides its sorts. A smart
      // collection that arrived, or whose search changed, lists other books (2026-11-24).
      const context = contextNow();
      const filterChanged = JSON.stringify(collectionFilter()) !== filterBefore;
      if (context !== sortContext || filterChanged) {
        sortContext = context;
        sortValue =
          parseSort(addressSort(), context) ??
          defaultSort(context, { books: $librarySort$, groups: $libraryGroupSort$ });
        void loadPage(true);
        return;
      }
      if (wasList || isList) refreshList();
      else if (!userCollection && !builtin) books = [];
    }, 50);
  }

  /**
   * A list changed (a move, an add, a removal, here or on another device): show the
   * new order of what is loaded at once, then look the books up again for additions.
   */
  function refreshList() {
    // Sorted another way: the server has the order.
    if (serverSort(sortValue, 'list')) {
      void loadPage(true, Math.max(books.length, LIST_PAGE));
      return;
    }
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
    const [rules, records] = await Promise.all([view.coverRules(), view.positions()]);
    coverRules = rules;
    positions = positionsByBook(records);
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

  /** WP19b: "Add to collection…" from a book's ⋮ menu. */
  function openAddToCollection(book: CatalogBook) {
    dialogManager.dialogs$.next([
      {
        component: AddToCollectionDialog,
        props: { bookId: book.id, title: book.title, api: collections, resolver: () => {} }
      }
    ]);
  }

  // ---- covers -------------------------------------------------------------

  // A collection rule needs the collection's members: lists from the mirror, searches
  // evaluated on the device (cover-blur.ts).
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

  function bookBlurred(
    book: BlurBook,
    ctx: CoverBlurContext,
    s: Map<string, BookState>,
    shown: Set<string>
  ) {
    return !shown.has(book.id) && isCoverBlurred(s.get(book.id)?.blur, book, ctx);
  }

  function groupKey(g: CatalogGroup) {
    return `${g.by}:${g.name ?? ''}`;
  }

  function groupTiles(
    g: CatalogGroup,
    ctx: CoverBlurContext,
    s: Map<string, BookState>,
    shown: Set<string>
  ) {
    const list: GroupTile[] = g.cover ? [g.cover] : g.cover === null ? [] : (g.tiles ?? []);
    const groupShown = shown.has(groupKey(g));
    return list.map((t) => ({
      src: t.thumbnail && api ? api.absolute(t.thumbnail) : '',
      blurred: !groupShown && bookBlurred(tileBlurBook(t), ctx, s, shown)
    }));
  }

  function reveal(key: string) {
    revealed = withAll(revealed, [key]);
  }

  /** A tag's, author's, series' or collection's cover rule; `label` names it on screen. */
  async function editCoverRule(target: BlurRuleTarget, key: string, label = key) {
    await new Promise<void>((resolve) => {
      dialogManager.dialogs$.next([
        {
          component: CoverRuleDialog,
          props: {
            target,
            name: label,
            blurred: hasCoverRule(coverRules, target, key),
            save: async (blur: boolean) => {
              await view.setCoverRule(target, key, blur);
              coverRules = await view.coverRules();
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
    selectAllController?.abort();
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

  /** The open list as a book-list query (what loadPage asks for); null for none. */
  function currentListQuery(): { query: BookListQuery; scope: string | null } | null {
    const q = appliedQuery || undefined;
    if (collectionId === null) {
      return {
        query: { q, library: appliedLibrary || undefined, group: group ?? undefined },
        scope: null
      };
    }
    const filter = collectionFilter();
    if (!filter) return null;
    return { query: { q, ...filter, group: group ?? undefined }, scope: filter.scope ?? null };
  }

  /**
   * The open collection's books as list filters: a built-in's or smart collection's search,
   * or a manual collection's id (null: no collection, or not known yet).
   */
  function collectionFilter(): { scope?: string; collection?: string } | null {
    if (collectionId === null) return null;
    const scope = builtinCollection(collectionId)?.query ?? smartQuery();
    if (scope) return { scope };
    const c = collectionList.find((x) => x.id === collectionId);
    return c?.type === 'manual' ? { collection: c.id } : null;
  }

  /**
   * Select all: every book of the list, also the ones not loaded yet (the server lists
   * their ids; offline, this device's books). Added to what is already selected.
   */
  async function selectAll() {
    const a = source();
    const list = currentListQuery();
    if (!a || !list || selectingAll) return;
    const asked = offline;
    const controller = new AbortController();
    selectAllController = controller;
    selectingAll = true;
    try {
      // The server only knows book-state changes that reached it (as loadPage).
      const parsed = parseQuery(appliedQuery);
      const parsedScope = list.scope ? parseQuery(list.scope) : null;
      if (
        !asked &&
        ((parsed.ok && usesBookState(parsed.query)) ||
          (parsedScope?.ok && usesBookState(parsedScope.query)))
      ) {
        await view.sendPendingChanges(timeoutSeconds);
      }
      const ids = await a.bookIds(list.query, { signal: controller.signal });
      if (controller.signal.aborted || !selectMode) return;
      // Loaded books too (a list being changed right now may have one the answer lacks).
      selected = withAll(withAll(selected, bookIds), ids);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof LibraryApiError && error.kind === 'aborted') return;
      if (handleAuthError(error)) return;
      selected = withAll(selected, bookIds);
      showMessage(
        'Only the loaded books were selected',
        `The full list couldn't be fetched: ${describe(error)}`
      );
    } finally {
      if (selectAllController === controller) selectingAll = false;
    }
  }

  function deselectAll() {
    selectAllController?.abort();
    selected = new Set();
    lastClicked = null;
  }

  /**
   * The selected books as catalog entries, in selection order: the loaded ones, the
   * others looked up (a Select all can reach books never scrolled to). Books the catalog
   * no longer shows are left out.
   */
  async function selectedBooks(ids: string[]): Promise<CatalogBook[]> {
    const byId = new Map(books.map((b) => [b.id, b]));
    const missing = ids.filter((id) => !byId.has(id));
    const a = source();
    try {
      for (let i = 0; a && i < missing.length; i += LOOKUP_CHUNK) {
        selectBusy = `Loading ${i.toLocaleString('en-US')} of ${missing.length.toLocaleString('en-US')} books…`;
        const result = await a.lookup(missing.slice(i, i + LOOKUP_CHUNK));
        result.books.forEach((b) => byId.set(b.id, b));
      }
    } finally {
      selectBusy = '';
    }
    return ids.flatMap((id) => byId.get(id) ?? []);
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
      void selectAll();
    }
  }

  // ---- bulk changes -------------------------------------------------------

  function ask<T>(component: Dialog['component'], props: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve) => {
      dialogManager.dialogs$.next([{ component, props: { ...props, resolver: resolve } }]);
    });
  }

  async function bulkChange() {
    const ids = [...selected];
    if (!ids.length || selectBusy) return;
    // The loaded ones (titles for the questions); Select all may reach unloaded books.
    const chosen = books.filter((b) => selected.has(b.id));
    const change = await ask<BulkChange | undefined>(BulkEditDialog, { count: ids.length });
    if (!change) return;
    let failed: string[];
    if (change.kind === 'collection') {
      const pick = await ask<CollectionPick | undefined>(CollectionPickDialog, {
        action: change.action,
        count: ids.length,
        collections: collectionList.filter((c) => c.type === 'manual')
      });
      if (!pick) return;
      // WP19: taking books out of a collection asks first.
      if (
        change.action === 'remove' &&
        'id' in pick &&
        !(await confirmRemoveFromCollection(
          chosen,
          collectionList.find((c) => c.id === pick.id)?.name ?? 'the collection',
          ids.length
        ))
      ) {
        return;
      }
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
      let completed: CatalogBook[];
      try {
        // Completing needs each book's character count (and the summary line its plan).
        completed = await selectedBooks(ids);
      } catch (error) {
        showMessage('Not saved', describe(error));
        return;
      }
      // Book summaries: the books whose first completion this is get one (asked first). With
      // "Make a summary when a book is first completed" off (session 4b) there is no line:
      // markCompleted writes the books' "summary-skip" records itself.
      const engine = await getSyncEngine();
      const plan = $summaryAutoOnFirstCompletion$
        ? await bulkSummaryPlan(
            engine,
            completed.map((b) => ({ id: b.id, charCount: b.charCount })),
            (id) => {
              const s = states.get(id);
              return !!s && (s.status === 'completed' || finishedReadThroughs(s) > 0);
            }
          )
        : { books: [], usd: null };
      const answer = await ask<{ finishedOn: string | null; makeSummaries: boolean } | undefined>(
        MarkCompletedDialog,
        {
          count: ids.length,
          summaries: plan.books.length ? { count: plan.books.length, usd: plan.usd } : null
        }
      );
      if (answer === undefined) return;
      if (plan.books.length && !answer.makeSummaries)
        await skipAutomaticSummaries(engine, plan.books);
      failed = await bookState.markCompleted(
        completed.map((b) => ({ bookId: b.id, charCount: b.charCount })),
        answer.finishedOn
      );
    } else if (change.kind === 'status') {
      // Unread takes part-read books back to the start: ask first when any is part-read.
      if (
        change.status === 'unread' &&
        (await Promise.all(ids.map((id) => bookState.currentReadHasPlace(id)))).some(Boolean) &&
        !(await confirmDestructive({
          ...unreadManyCopy(ids.length),
          testid: 'unread-many-confirm',
          confirmTestid: 'unread-many-confirm-button'
        }))
      ) {
        return;
      }
      failed = await bookState.setStatusMany(ids, change.status);
    } else if (change.kind === 'favorite') {
      if (
        !change.favorite &&
        !(await confirmDestructive({
          ...removeFavoritesCopy(ids.length),
          testid: 'remove-favorites-confirm',
          confirmTestid: 'remove-favorites-confirm-button'
        }))
      ) {
        return;
      }
      failed = await bookState.setFavoriteMany(ids, change.favorite);
    } else {
      failed = await bookState.setBlurMany(ids, change.blur);
    }
    await loadStates();
    if (failed.length) {
      showMessage(
        'Not all saved',
        `${failed.length} of ${ids.length} books could not be changed. Try again.`
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
    if (
      action === 'remove' &&
      !(await confirmRemoveFromCollection(
        books.filter((b) => ids.includes(b.id)),
        userCollection?.name ?? 'the collection',
        ids.length
      ))
    ) {
      return;
    }
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
    } else if (
      action === 'remove' &&
      (await confirmRemoveFromCollection([book], userCollection?.name ?? 'the collection'))
    ) {
      void saveOrder(() => collections.removeBooks(id, [book.id]));
    }
  }

  /** WP19: "Remove 3 books from “Name”?"; true when confirmed. */
  function confirmRemoveFromCollection(
    chosen: CatalogBook[],
    name: string,
    count = chosen.length
  ): Promise<boolean> {
    return confirmDestructive({
      ...removeFromCollectionCopy({ count, title: chosen[0]?.title, collection: name }),
      testid: 'remove-from-collection-confirm',
      confirmTestid: 'remove-from-collection-confirm-button'
    });
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

  /** "Save as smart collection": the applied search becomes a smart collection. */
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
    try {
      audioOnDevice = new Set(await audioBookIdsOnDevice());
    } catch (error) {
      logger.warn(`Library: could not read the downloaded audio: ${(error as Error).message}`);
    }
  }

  async function readUrlAndLoad() {
    const params = $page.url.searchParams;
    appliedQuery = params.get('q') ?? '';
    fromHome = params.get('from') === 'home';
    appliedLibrary = params.has('lib') ? (params.get('lib') ?? '') : $libraryFilter$;
    const requested = TABS.find((t) => t.id === params.get('tab')) ?? TABS[0];
    const nextCollection = params.get('collection') || null;
    if (nextCollection !== collectionId) reorderMode = false;
    collectionId = nextCollection;
    // Sections open a collection grouped as last picked on this device.
    const remembered = $collectionSectionsBy$;
    tab =
      collectionId && !params.has('tab') && $collectionGroupsAs$ === 'sections' && remembered
        ? TAB_OF[remembered]
        : requested.id;
    group = null;
    // A collection's definition comes from the local mirror.
    if (collectionId && !collectionsLoaded) await loadCollections();
    if (requested.by && tab === requested.id) {
      if (requested.by === 'series' && params.get('none') === '1')
        group = { by: 'series', name: null };
      else if (params.get('group'))
        group = { by: requested.by, name: params.get('group') as string };
    }
    sortContext = contextNow();
    sortValue =
      parseSort(params.get('sort'), sortContext) ??
      defaultSort(sortContext, { books: $librarySort$, groups: $libraryGroupSort$ });
    queryInput = appliedQuery;
    queryError = '';
    selected = new Set();
    dropStaleSideCounts();
    // WP19b: Home's search button opens the Library with the search box focused.
    if (params.get('search') === '1') setTimeout(() => searchInput?.focus(), 0);
    // WP19c: back from a book's details: the list as it was, at the same place.
    if (lastNavigation === 'popstate' && (await restoreSnapshot())) {
      void loadSideCounts();
      return;
    }
    // The tab and chip numbers are asked once the list's first page is there.
    return loadPage(true);
  }

  /** The address the snapshot of this list is kept under. */
  function snapshotKey() {
    // An offline list (offset cursors) is only restored offline, and the other way round.
    return `${offline ? 'offline:' : ''}${$page.url.pathname}${$page.url.search}`;
  }

  async function restoreSnapshot(): Promise<boolean> {
    const snap = takeListSnapshot<ListState>(snapshotKey());
    if (!snap) return false;
    listController?.abort();
    loading = false;
    loadError = '';
    moreError = '';
    ({ books, groups, nextCursor, resultCount, listConsumed } = snap.data);
    if (group) void loadGroupInfo(new AbortController().signal);
    await tick();
    window.scrollTo(0, snap.scrollY);
    return true;
  }

  /**
   * Which sorts apply to what is shown (from the URL state itself: reactive values are not
   * updated yet in the tick the URL changed).
   */
  function contextNow(): SortContext {
    const by = TABS.find((t) => t.id === tab)?.by ?? null;
    if (by && group === null) return 'groups';
    if (group?.by === 'series' && group.name !== null) return 'series';
    if (group) return 'books';
    if (collectionId !== null) {
      const c = collectionList.find((x) => x.id === collectionId);
      if (c?.type === 'manual') return 'list';
      return collectionId === 'completed' ? 'completed' : 'books';
    }
    // Next in your series' See all: the search status:next alone, in the Home row's order.
    if (appliedQuery.trim().toLowerCase() === 'status:next') return 'next';
    return 'books';
  }

  /** WP19a: a new sort from the Sort menu (remembered per device outside a series or list). */
  function onSort(value: SortValue) {
    if (sortContext === 'groups') $libraryGroupSort$ = formatSort(value, 'groups');
    else if (sortContext === 'books') $librarySort$ = formatSort(value, 'books');
    goto(
      urlFor({
        tab,
        group,
        q: appliedQuery,
        lib: appliedLibrary,
        collection: collectionId,
        sort: formatSort(value, sortContext)
      }),
      { keepFocus: true, noScroll: true }
    );
  }

  /** The word after the count: "books", "series", "authors", "tags". */
  function countNoun(n: number): string {
    if (sortContext !== 'groups') return n === 1 ? 'book' : 'books';
    const by = TABS.find((t) => t.id === tab)?.by;
    if (by === 'series') return 'series';
    if (by === 'author') return n === 1 ? 'author' : 'authors';
    return n === 1 ? 'tag' : 'tags';
  }

  /**
   * WP19b: the counts on the tabs (books, series, authors, tags) and the filter chips.
   * They follow the search (fix-library-counts-follow-search; before, they were the picked
   * library's totals):
   * - a tab counts the search in that tab (books, or the groups with a matching book).
   *   A tab link keeps the search and leaves an open group, so the group doesn't count.
   * - a chip counts what the list would show with that chip as the only one on
   *   (chipOnlyQuery), in the header's unit: books, groups in a grouped tab, or the open
   *   group's books.
   * Asked after the list's first page (pattern searches share one worker with the list),
   * again when a book's status or favorite changes (a few seconds later). A search that
   * doesn't parse keeps the previous numbers, like the list keeps its results.
   */
  function sideCountKeys() {
    const by = TABS.find((t) => t.id === tab)?.by ?? null;
    const openGroup = by ? group : null;
    // In a collection the tabs and chips count inside it (its own search or list).
    const tabsKey = JSON.stringify([
      appliedLibrary,
      appliedQuery,
      collectionId,
      collectionFilter()
    ]);
    return { by, openGroup, tabsKey, chipsKey: JSON.stringify([tabsKey, by, openGroup]) };
  }

  /**
   * When the URL names another search, tab or group: the numbers of the previous one go
   * at once (they would be wrong while the new list loads); loadSideCounts asks again.
   */
  function dropStaleSideCounts() {
    const { tabsKey, chipsKey } = sideCountKeys();
    if (tabsKey === tabCountsKey && chipsKey === chipCountsKey) return;
    sideCountsController?.abort();
    sideCountsController = undefined;
    if (tabsKey !== tabCountsKey) {
      tabCountsKey = null;
      tabCounts = {};
    }
    chipCountsKey = null;
    chipCounts = new Map();
  }

  async function loadSideCounts() {
    const a = source();
    if (!a || !parseQuery(appliedQuery).ok) return;
    const filter = collectionFilter();
    if (collectionId !== null && !filter) return;
    // A collection spans every library; the Library follows the picked one.
    const base = filter ?? { library: appliedLibrary || undefined };
    const q = appliedQuery || undefined;
    const { by, openGroup, tabsKey, chipsKey } = sideCountKeys();
    // Sections show no tabs, so they need no tab numbers.
    if (collectionId !== null && $collectionGroupsAs$ === 'sections' && tabCountsKey !== tabsKey) {
      tabCountsKey = tabsKey;
      tabCounts = {};
      tabCountsPending = false;
    }
    if (tabsKey === tabCountsKey && chipsKey === chipCountsKey) return;
    // Aborting a load whose tab numbers haven't arrived means asking for them again.
    const loadTabs = tabsKey !== tabCountsKey || tabCountsPending;
    sideCountsController?.abort();
    const controller = new AbortController();
    sideCountsController = controller;
    const options = { signal: controller.signal };
    chipCountsKey = chipsKey;
    chipCounts = new Map();
    if (loadTabs) {
      tabCountsKey = tabsKey;
      tabCounts = {};
      tabCountsPending = true;
    }
    const current = () => sideCountsController === controller;
    const groupTotal = (groupBy: GroupBy, query: string | undefined) =>
      a.groups({ by: groupBy, q: query, ...base, limit: 1 }, options).then((r) => r.total);

    const tabsDone = loadTabs
      ? Promise.all([
          a.count({ q, ...base }, options),
          ...(['series', 'author', 'tag'] as GroupBy[]).map((g) => groupTotal(g, q))
        ]).then(
          ([all, series, authors, tags]) => {
            if (!current()) return;
            tabCounts = { all, series, authors, tags };
            tabCountsPending = false;
          },
          () => {
            // No numbers on the tabs; asked again with the next search.
            if (!current()) return;
            tabCountsKey = null;
            tabCountsPending = false;
          }
        )
      : Promise.resolve();
    const chipsDone = Promise.all(
      CHIPS.map(async (c) => {
        const chipQuery = chipOnlyQuery(appliedQuery, c.id) ?? undefined;
        const n =
          by && !openGroup
            ? await groupTotal(by, chipQuery)
            : await a.count({ q: chipQuery, ...base, group: openGroup ?? undefined }, options);
        return [c.id, n] as const;
      })
    ).then(
      (entries) => {
        if (!current()) return;
        chipCounts = new Map(
          entries.filter((e): e is readonly [ChipId, number] => typeof e[1] === 'number')
        );
      },
      () => {
        if (current()) chipCountsKey = null;
      }
    );
    await Promise.all([tabsDone, chipsDone]);
  }

  function onStatesChangedForCounts() {
    clearTimeout(sideCountsTimer);
    // After the sync has had a moment to send the change.
    sideCountsTimer = setTimeout(() => {
      tabCountsKey = null;
      chipCountsKey = null;
      void loadSideCounts();
    }, 4000);
  }

  /**
   * WP19a: "1,234 books" for a list of books. Counting can take a moment on a big library,
   * so the list never waits for it; on a failure (or an older server) nothing is shown.
   */
  async function loadCount(scope: string | null) {
    countController?.abort();
    resultCount = null;
    const a = source();
    if (!a || sortContext === 'groups') return;
    const controller = new AbortController();
    countController = controller;
    counting = true;
    try {
      const n = await a.count(
        collectionId !== null
          ? {
              q: appliedQuery || undefined,
              ...(collectionFilter() ?? (scope ? { scope } : { collection: collectionId })),
              group: group ?? undefined
            }
          : {
              q: appliedQuery || undefined,
              library: appliedLibrary || undefined,
              group: group ?? undefined
            },
        { signal: controller.signal }
      );
      if (countController === controller) resultCount = n;
    } catch {
      // No count shown.
    } finally {
      if (countController === controller) counting = false;
    }
  }

  async function loadPage(reset: boolean, minBooks = LIST_PAGE) {
    const a = source();
    if (!a) return;
    const asked = offline;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const parsed = parseQuery(appliedQuery);
    if (!parsed.ok) {
      queryError = parsed.error.message;
      books = [];
      groups = [];
      nextCursor = null;
      loading = false;
      return;
    }
    loading = true;
    loadError = '';
    moreError = '';
    try {
      // The server only knows book-state changes that reached it.
      if (reset) staleNote = false;
      const scope = builtinCollection(collectionId ?? '')?.query ?? smartQuery();
      const parsedScope = scope ? parseQuery(scope) : null;
      // A manual collection in another order is sorted by the server from its records.
      const sortsOnServer = collectionId !== null && !scope && serverSort(sortValue, 'list');
      // Offline, the device answers from its own records (unsent changes included).
      if (
        !asked &&
        (usesBookState(parsed.query) ||
          (parsedScope?.ok && usesBookState(parsedScope.query)) ||
          sortsOnServer)
      ) {
        staleNote = await view.sendPendingChanges(timeoutSeconds);
        if (controller.signal.aborted) return;
      }
      if (reset) void loadCount(scope);
      if (reset) resetSections();
      // From the URL state itself: reactive values ($:) are not updated yet when the URL
      // changed in this tick.
      const by = TABS.find((t) => t.id === tab)?.by ?? null;
      if (collectionId !== null && by === null && group === null) {
        await loadCollectionPage(reset, scope, minBooks, controller.signal);
        if (reset && listController === controller) void loadSideCounts();
        return;
      }
      // A collection's series, authors and tags count only its books.
      const filter = collectionFilter();
      if (collectionId !== null && !filter) {
        books = [];
        groups = [];
        nextCursor = null;
        return;
      }
      const common = {
        q: appliedQuery || undefined,
        ...(filter ?? { library: appliedLibrary || undefined }),
        cursor: reset ? undefined : (nextCursor ?? undefined)
      };
      const options = { signal: controller.signal };
      if (by && group === null) {
        const result = await a.groups(
          { by, ...common, sort: serverSort(sortValue, 'groups') },
          options
        );
        groups = reset ? result.groups : [...groups, ...result.groups];
        books = [];
        nextCursor = result.nextCursor;
        if (reset) resultCount = result.total ?? null;
        // Without IntersectionObserver every heading loads its books at once.
        if (collectionId !== null && $collectionGroupsAs$ === 'sections' && !canLoadWhenVisible()) {
          result.groups.forEach((g) => void loadSection(g));
        }
      } else {
        if (reset) void loadGroupInfo(controller.signal);
        const result = await a.books(
          { ...common, group: group ?? undefined, sort: serverSort(sortValue, sortContext) },
          options
        );
        books = reset ? result.books : [...books, ...result.books];
        groups = [];
        nextCursor = result.nextCursor;
      }
      // After the first page: a pattern search's counts then queue behind its list.
      if (reset && listController === controller) void loadSideCounts();
      // The offline Library's copies of this device's books (at most once a minute).
      if (reset && !asked && api) {
        noteReachable();
        void refreshOfflineCopies(api);
      }
    } catch (error) {
      if (error instanceof LibraryApiError && error.kind === 'aborted') return;
      if (handleAuthError(error)) return;
      if (!asked && reset && isUnreachable(error)) {
        // Stays "Loading…" until this device's books are shown.
        await goOffline();
        return;
      }
      if (
        error instanceof LibraryApiError &&
        (error.code === 'invalid_query' || error.code === 'regex_timeout')
      ) {
        // Keep what is shown; the problem is the search text.
        queryError = error.message;
        return;
      }
      if (!reset) {
        // Keep what is shown; the end of the list offers Retry.
        moreError = describe(error);
        return;
      }
      loadError = describe(error);
      books = [];
      groups = [];
      nextCursor = null;
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
    const a = source();
    if (!a || collectionId === null) return;
    const c = collectionList.find((x) => x.id === collectionId);
    if (scope) {
      const result = await a.books(
        {
          q: appliedQuery || undefined,
          scope,
          sort: serverSort(sortValue, sortContext),
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
    const sort = serverSort(sortValue, 'list');
    if (sort) {
      // WP19a: another order than the collection's own: the server sorts its items.
      const result = await a.books(
        {
          q: appliedQuery || undefined,
          collection: c.id,
          sort,
          cursor: reset ? undefined : (nextCursor ?? undefined)
        },
        { signal }
      );
      books = reset ? result.books : [...books, ...result.books];
      groups = [];
      nextCursor = result.nextCursor;
      return;
    }
    const ids = (collectionItems.get(c.id) ?? []).map((i) => i.bookId);
    let consumed = reset ? 0 : listConsumed;
    const found: CatalogBook[] = [];
    while (consumed < ids.length && found.length < minBooks) {
      const chunk = ids.slice(consumed, consumed + LOOKUP_CHUNK);
      const result = await a.lookup(chunk, appliedQuery || undefined, { signal });
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
    const a = source();
    if (!a || !group || group.name === null || group.name.includes('"')) return;
    // Inside a collection: its books of this group only.
    const filter = collectionFilter();
    if (collectionId !== null && !filter) return;
    try {
      const result = await a.groups(
        {
          by: group.by,
          q: `${FIELD_OF[group.by]}:="${group.name}"`,
          ...(filter ?? { library: appliedLibrary || undefined }),
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

  function resetSections() {
    sectionsController?.abort();
    sectionsController = new AbortController();
    sectionBooks = new Map();
  }

  /** Sections: the first books under one heading (inside the collection, with the search). */
  async function loadSection(g: CatalogGroup) {
    const key = groupKey(g);
    const a = source();
    const filter = collectionFilter();
    if (!a || !filter || sectionBooks.has(key)) return;
    const controller = sectionsController ?? (sectionsController = new AbortController());
    sectionBooks = new Map(sectionBooks).set(key, 'loading');
    try {
      const result = await a.books(
        {
          q: appliedQuery || undefined,
          ...filter,
          group: { by: g.by, name: g.name },
          limit: SECTION_BOOKS
        },
        { signal: controller.signal }
      );
      if (!controller.signal.aborted) sectionBooks = new Map(sectionBooks).set(key, result.books);
    } catch {
      if (!controller.signal.aborted) sectionBooks = new Map(sectionBooks).set(key, 'error');
    }
  }

  function retrySection(g: CatalogGroup) {
    const next = new Map(sectionBooks);
    next.delete(groupKey(g));
    sectionBooks = next;
    void loadSection(g);
  }

  /** A section's books, or [] while loading or after a failure. */
  function sectionList(entry: CatalogBook[] | 'loading' | 'error' | undefined): CatalogBook[] {
    return Array.isArray(entry) ? entry : [];
  }

  /** "12 volumes · 3/12 read" under a heading. */
  function sectionInfo(g: CatalogGroup, s: Map<string, BookState>): string {
    return [groupCount(g), g.bookIds ? `${seriesReadCount(g.bookIds, s)}/${g.bookCount} read` : '']
      .filter(Boolean)
      .join(' · ');
  }

  /** The props of a book card or row in a section (the main list passes them one by one). */
  function sectionBookProps(
    book: CatalogBook,
    s: Map<string, BookState>,
    pos: Map<string, LocalRecord[]>,
    shown: Set<string>,
    ctx: CoverBlurContext,
    here: Set<string>,
    audioHere: Set<string>,
    withInfo: boolean
  ) {
    const state = s.get(book.id);
    const records = pos.get(book.id) ?? [];
    return {
      book,
      thumbnailUrl: book.thumbnail && api ? api.absolute(book.thumbnail) : '',
      state,
      progress: bookProgressLabel(book.id, state, records, book.charCount),
      progressFraction: bookProgressFraction(book.id, state, records, book.charCount),
      infoLine: withInfo,
      blurred: bookBlurred(book, ctx, s, shown),
      onDevice: here.has(book.id),
      audioOnDevice: audioHere.has(book.id),
      authorLink
    };
  }

  /** Sections: a new Group by (remembered on this device). */
  function onGroupBy(by: GroupBy | null) {
    $collectionSectionsBy$ = by ?? '';
    goto(
      urlFor({
        tab: by ? TAB_OF[by] : 'all',
        q: appliedQuery,
        lib: appliedLibrary,
        collection: collectionId
      }),
      { keepFocus: true, noScroll: true }
    );
  }

  function describe(error: unknown): string {
    if (error instanceof LibraryApiError) {
      if (error.kind === 'unreachable' || error.kind === 'timeout') {
        // Only a book that isn't on this device needs the server (the list then switches
        // to the books on this device).
        return 'The library server cannot be reached (offline, or the server is down), and the book is not on this device.';
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

  // ---- navigation ---------------------------------------------------------

  function urlFor(target: {
    tab: Tab;
    group?: { by: GroupBy; name: string | null } | null;
    q: string;
    lib: string;
    collection?: string | null;
    /** WP19a: "title-asc" (absent: the remembered or the list's own order). */
    sort?: string | null;
  }) {
    const params = new URLSearchParams();
    // Opened from Home's "See all": a search or sort in the same list keeps "← Home".
    const keepFromHome =
      fromHome &&
      (target.collection
        ? target.collection === collectionId
        : !!target.group &&
          !!group &&
          target.group.by === group.by &&
          target.group.name === group.name);
    if (target.collection) {
      params.set('collection', target.collection);
      if (target.tab !== 'all') params.set('tab', target.tab);
      if (target.group) {
        if (target.group.name === null) params.set('none', '1');
        else params.set('group', target.group.name);
      }
      if (target.q) params.set('q', target.q);
      if (target.sort) params.set('sort', target.sort);
      if (keepFromHome) params.set('from', 'home');
      return `${pagePath}/library?${params.toString()}`;
    }
    if (target.tab !== 'all') params.set('tab', target.tab);
    if (target.group) {
      if (target.group.name === null) params.set('none', '1');
      else params.set('group', target.group.name);
    }
    if (target.q) params.set('q', target.q);
    if (target.lib) params.set('lib', target.lib);
    if (target.sort) params.set('sort', target.sort);
    if (keepFromHome) params.set('from', 'home');
    const qs = params.toString();
    return `${pagePath}/library${qs ? `?${qs}` : ''}`;
  }

  /** The sort as it is in the address now (a search keeps it). */
  function addressSort(): string | null {
    return $page.url.searchParams.get('sort');
  }

  function go(q: string) {
    goto(
      urlFor({
        tab,
        group,
        q,
        lib: appliedLibrary,
        collection: collectionId,
        sort: addressSort()
      }),
      { keepFocus: true, noScroll: true }
    );
  }

  function search() {
    const q = queryInput.trim();
    const parsed = parseQuery(q);
    if (!parsed.ok) {
      queryError = parsed.error.message;
      return;
    }
    queryError = '';
    searchHistory?.hide();
    suggestions?.hide();
    // Remembered only when typed and searched (or picked from the list): never chips,
    // tab or group links, back/forward or opening a collection.
    if (q && $searchHistoryOn$) void searchHistoryApi().recordLibrary(q);
    go(q);
  }

  /** A remembered search was picked: search it now. */
  function searchFromHistory(q: string) {
    queryInput = q;
    search();
  }

  /** ↖ on a remembered search: put it in the box to edit first. */
  async function editFromHistory(q: string) {
    queryInput = q;
    await tick();
    searchInput?.focus();
    searchInput?.setSelectionRange(q.length, q.length);
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
    goto(urlFor({ tab, group, q: appliedQuery, lib: value, sort: addressSort() }), {
      keepFocus: true,
      noScroll: true
    });
  }

  function groupHref(g: CatalogGroup) {
    return urlFor({
      tab,
      group: { by: g.by, name: g.name },
      q: appliedQuery,
      lib: appliedLibrary,
      collection: collectionId
    });
  }

  /** WP19a: an author's name on a card leads to that author (in the picked library). */
  function authorLink(name: string) {
    return authorHref(pagePath, name, appliedLibrary);
  }

  function showSearchHelp() {
    dialogManager.dialogs$.next([{ component: SearchHelpDialog, props: {} }]);
  }

  // ---- opening books ------------------------------------------------------

  // ---- upload (WP7b) ---------------------------------------------------------

  async function onUploadFiles(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    await uploadPicked(files);
  }

  /**
   * Files dragged onto the page (where the Upload button is) go through the same steps as
   * picked ones; files that aren't EPUBs are listed as not uploaded in the summary.
   */
  $: canUpload = !!uploadInfo?.enabled && collectionId === null && !selectMode;
  let dragDepth = 0;
  let dropping = false;

  function draggingFiles(ev: DragEvent): boolean {
    return !!ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
  }

  function onWindowDragEnter(ev: DragEvent) {
    if (!canUpload || uploading || !draggingFiles(ev)) return;
    ev.preventDefault();
    dragDepth++;
    dropping = true;
  }

  function onWindowDragOver(ev: DragEvent) {
    if (!dropping || !ev.dataTransfer) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }

  function onWindowDragLeave() {
    if (!dropping) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropping = false;
  }

  function onWindowDrop(ev: DragEvent) {
    if (!dropping) return;
    ev.preventDefault();
    dragDepth = 0;
    dropping = false;
    void uploadPicked([...(ev.dataTransfer?.files ?? [])]);
  }

  async function uploadPicked(files: File[]) {
    if (!files.length || !api || uploading) return;
    // Asked on every upload; nothing preselected or remembered (decided with the user).
    const libraryId = await ask<string | undefined>(UploadLibraryDialog, {
      libraries: enabledLibraries.map((l) => ({ id: l.id, name: l.name })),
      fileCount: files.length
    });
    if (!libraryId || !api) return;
    const uploadApi = api;
    const controller = new AbortController();
    uploading = { index: 0, count: files.length, name: '', loaded: 0, total: 0, controller };
    let results: UploadResult[];
    try {
      results = await uploadFiles(files, libraryId, {
        api: uploadApi,
        maxBytes: uploadInfo?.maxBytes ?? 0,
        signal: controller.signal,
        onProgress: (index, name, loaded, total) => {
          if (uploading) uploading = { ...uploading, index, name, loaded, total };
        },
        askDuplicate: async (staged) => {
          const before = uploading;
          uploading = null;
          const decision = await ask<UploadDecision | undefined>(UploadDuplicateDialog, {
            staged,
            thumbnailUrl: (t: string | null) => (t ? uploadApi.absolute(t) : ''),
            libraryName: (id: string) => libraryNames.get(id) ?? ''
          });
          uploading = before;
          return decision ?? 'cancel';
        }
      });
    } finally {
      uploading = null;
    }
    if (results.some((r) => r.status === 'added')) void loadPage(true);
    const chosen = await ask<CatalogBook | undefined>(UploadSummaryDialog, { results });
    if (chosen) void open(chosen);
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
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
    if (showsOnDevice()) void loadPage(true, Math.max(books.length, LIST_PAGE));
  }

  /** The list shown depends on this device's books ("On this device", on:device). */
  function showsOnDevice(): boolean {
    const scope = builtinCollection(collectionId ?? '')?.query ?? smartQuery();
    return [appliedQuery, scope].some((text) => {
      const parsedText = text ? parseQuery(text) : null;
      return (
        !!parsedText?.ok &&
        parsedText.query.terms.some((t) => t.type === 'device' || t.type === 'deviceAudio')
      );
    });
  }

  /** WP11c: `jump` (Highlights section) is left for the reader once the book opened. */
  async function open(book: CatalogBook, jump?: PendingJump) {
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
        if (jump) setPendingJump(jump);
        await goto(`${pagePath}/b?id=${outcome.localId}`);
        return;
      }
      if (outcome.status === 'refused') showMessage('Not opened', outcome.message);
      await refreshOnDevice();
    } catch (error) {
      if (handleAuthError(error)) return;
      logger.warn(`Library: opening "${book.title}" failed: ${(error as Error).message}`);
      showMessage('Could not open the book', describe(error));
      if (isUnreachable(error)) void goOffline();
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
  on:dragenter={onWindowDragEnter}
  on:dragover={onWindowDragOver}
  on:dragleave={onWindowDragLeave}
  on:drop={onWindowDrop}
  on:pointermove={onWindowPointerMove}
  on:pointerup={onWindowPointerUp}
  on:pointercancel={onWindowPointerUp}
  on:keydown={onWindowKeydown}
/>

<AppHeader title="Library" />

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
    <CataloguePageHeader
      jp={headerJp}
      title={headerTitle}
      titleTestid={collectionId !== null && !collectionGone && !group ? 'collection-title' : ''}
    >
      <span slot="meta" class="flex items-baseline gap-2" aria-live="polite">
        {#if !loadError && resultCount !== null}
          <span data-testid="result-count"
            ><span class="font-mincho text-[22px] font-bold"
              >{resultCount.toLocaleString('en')}</span
            > <span class="text-sm text-c-muted">{countNoun(resultCount)}</span></span
          >
        {:else if !loadError && counting}
          <span class="text-sm text-c-muted" data-testid="result-count">Counting…</span>
        {/if}
      </span>
      <svelte:fragment slot="back">
        {#if collectionId !== null && group}
          <!-- A series, author or tag inside a collection: back to the collection. -->
          <a
            class="c-link inline-flex min-h-[2.75rem] items-center"
            href={urlFor({ tab, q: appliedQuery, lib: appliedLibrary, collection: collectionId })}
            data-testid="back-collection"
            data-sveltekit-noscroll
          >
            ← {collectionName ?? 'Collection'}
          </a>
        {:else if fromHome && (collectionId !== null || group)}
          <a
            class="c-link inline-flex min-h-[2.75rem] items-center"
            href="{pagePath}/home"
            data-testid="back-home"
          >
            ← Home
          </a>
        {:else if collectionId !== null}
          <a class="c-link inline-flex min-h-[2.75rem] items-center" href="{pagePath}/collections">
            ← Collections
          </a>
        {:else if group}
          <a
            class="c-link inline-flex min-h-[2.75rem] items-center"
            href={urlFor({ tab, q: appliedQuery, lib: appliedLibrary })}
            data-sveltekit-noscroll
          >
            ← {BACK_LABEL[group.by].replace(/^Back to /, '')}
          </a>
          <span class="sr-only">{BACK_LABEL[group.by]}</span>
        {/if}
      </svelte:fragment>
      <svelte:fragment slot="sub">
        {#if collectionId !== null && !group}
          <div
            class="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1"
            data-testid="collection-header"
          >
            {#if collectionGone}
              <p class="py-2 font-medium" data-testid="collection-gone">
                This collection doesn't exist any more (it may have been deleted on another device).
              </p>
            {:else}
              <p class="break-words text-sm text-c-muted" data-testid="collection-header-info">
                {#if builtin}
                  Built-in · {builtin.query}
                {:else if userCollection?.type === 'smart'}
                  Smart · {userCollection.query}
                {:else if isList}
                  Manual · {plural(listIds.length, 'book', 'books')}
                {/if}
              </p>
              <!-- The collection's own actions (soft, like a series page's). Pin and Blur are toggles
                 that look on; Reorder turns into a filled Done while its mode is on. -->
              <div class="flex flex-wrap gap-2" data-testid="collection-actions">
                {#if pinTarget}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3 text-sm"
                    aria-pressed={pinnedHere}
                    data-testid="pin-home"
                    on:click={togglePin}
                  >
                    <Fa icon={faThumbtack} />
                    {pinnedHere ? 'Pinned to Home' : 'Pin to Home'}
                  </button>
                {/if}
                {#if collectionId !== null && collectionName}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3 text-sm"
                    aria-pressed={hasCoverRule(coverRules, 'collection', collectionId)}
                    data-testid="cover-rule-collection"
                    on:click={() =>
                      collectionId !== null &&
                      editCoverRule('collection', collectionId, collectionName ?? '')}
                  >
                    <Fa
                      icon={hasCoverRule(coverRules, 'collection', collectionId)
                        ? faCheck
                        : faEyeSlash}
                    />
                    Blur covers
                  </button>
                {/if}
                {#if userCollection}
                  {#if isList && tab === 'all'}
                    <button
                      class="c-btn {reorderMode
                        ? 'c-btn-primary'
                        : 'c-btn-secondary'} c-btn-sm px-3 text-sm"
                      disabled={!canReorder || selectMode}
                      title={appliedQuery ? 'Clear the search to reorder' : undefined}
                      data-testid="reorder-mode"
                      on:click={() => (reorderMode = !reorderMode)}
                    >
                      <Fa icon={reorderMode ? faCheck : faArrowsUpDown} />
                      {reorderMode ? 'Done' : 'Reorder'}
                    </button>
                  {/if}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3 text-sm"
                    title={userCollection.type === 'smart'
                      ? 'Rename, change the search or delete'
                      : 'Rename or delete'}
                    data-testid="collection-header-menu"
                    on:click={editCollection}
                  >
                    <Fa icon={faPen} />
                    Edit
                  </button>
                {/if}
              </div>
            {/if}
          </div>
          {#if userCollection?.type === 'smart' && /\bbookmeter[:：]\S*wish/i.test(userCollection.query ?? '')}
            <!-- Bookmeter sync (2026-11-25): wanted books the library doesn't have. -->
            <BookmeterWantedMissing />
          {/if}
        {:else if group}
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1" data-testid="group-header">
            {#if groupInfo}
              <p class="text-sm text-c-muted" data-testid="group-header-info">
                {[
                  groupCount(groupInfo),
                  groupInfo.bookIds
                    ? `${seriesReadCount(groupInfo.bookIds, states)}/${groupInfo.bookCount} read`
                    : '',
                  groupInfo.by === 'series' ? formatGroupChars(groupInfo.chars) : '',
                  // Store ratings: volume 1's figures (later volumes rate higher).
                  groupInfo.by === 'series' && groupInfo.name !== null
                    ? (volumeOneText(groupInfo.cover, $ratingFeatures$) ?? '')
                    : ''
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            {:else if group.name === null}
              <p class="text-sm text-c-muted">Books that are not part of a series.</p>
            {/if}
            {#if collectionId !== null}
              <p class="text-sm text-c-muted" data-testid="group-in-collection">
                In {collectionName ?? 'this collection'} ·
                <a
                  class="c-link"
                  href={urlFor({ tab, group, q: '', lib: '' })}
                  data-testid="group-whole-library">See all in the Library</a
                >
              </p>
            {/if}
            {#if pinTarget || headerRule || seriesEditName}
              <div class="flex flex-wrap gap-2">
                {#if pinTarget}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3 text-sm"
                    aria-pressed={pinnedHere}
                    data-testid="pin-home"
                    on:click={togglePin}
                  >
                    <Fa icon={faThumbtack} />
                    {pinnedHere ? 'Pinned to Home' : 'Pin to Home'}
                  </button>
                {/if}
                {#if headerRule}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3 text-sm"
                    aria-pressed={hasCoverRule(coverRules, headerRule.target, headerRule.name)}
                    data-testid="cover-rule-header"
                    on:click={() => headerRule && editCoverRule(headerRule.target, headerRule.name)}
                  >
                    <Fa
                      icon={hasCoverRule(coverRules, headerRule.target, headerRule.name)
                        ? faCheck
                        : faEyeSlash}
                    />
                    {HEADER_RULE_LABEL[headerRule.target]}
                  </button>
                {/if}
                {#if seriesEditName}
                  <!-- Calibre metadata editing: the series editor (design 2026-11-23). -->
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3 text-sm"
                    disabled={offline}
                    title={offline
                      ? 'Editing needs the library server, which can’t be reached right now'
                      : undefined}
                    data-testid="series-edit-open"
                    on:click={() => (seriesEditOpen = true)}
                  >
                    <Fa icon={faPen} />
                    Edit series
                  </button>
                {/if}
              </div>
            {/if}
            {#if seriesSaved}
              <p class="text-sm text-c-muted" role="status" data-testid="series-edit-saved">
                Saved · waiting for the library to show it (about 1–11 minutes)
              </p>
            {/if}
          </div>
        {/if}
      </svelte:fragment>
      <div class="flex w-full min-w-0 flex-col sm:w-[22rem] lg:w-[24rem]">
        <div class="relative" bind:this={searchBox}>
          <form
            class="flex w-full min-w-0 items-stretch gap-2"
            role="search"
            on:submit|preventDefault={search}
          >
            <label class="c-input flex min-w-0 grow items-center gap-2">
              <span class="text-c-muted" aria-hidden="true"><Fa icon={faMagnifyingGlass} /></span>
              <span class="sr-only">Search the library</span>
              <input
                class="w-full min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0"
                type="search"
                enterkeyhint="search"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Title, author or series — or author: tag: chars:<100000 …"
                aria-invalid={queryError ? 'true' : undefined}
                aria-describedby={queryError ? 'library-query-error' : undefined}
                data-testid="library-search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggestOpen || historyOpen}
                aria-controls={suggestOpen
                  ? 'library-search-suggestions'
                  : 'library-search-history'}
                aria-activedescendant={suggestOpen ? suggestActiveId : historyActiveId}
                autocomplete="off"
                bind:value={queryInput}
                bind:this={searchInput}
                on:focus={() => {
                  searchFocused = true;
                  trackCursor();
                  searchHistory?.show();
                }}
                on:blur={() => (searchFocused = false)}
                on:click={() => {
                  trackCursor();
                  searchHistory?.show();
                }}
                on:input={() => {
                  trackCursor();
                  // The live line under the box takes over from the last search's error.
                  if ($searchReadsAsOn$) queryError = '';
                  searchHistory?.show();
                }}
                on:keyup={trackCursor}
                on:select={trackCursor}
                on:keydown={onSearchKeydown}
              />
            </label>
            <button class="c-btn c-btn-secondary px-4" type="submit" title="Search">
              <Fa icon={faMagnifyingGlass} />
              <span class="sr-only">Search</span>
            </button>
          </form>
          <LibrarySearchHistory
            bind:this={searchHistory}
            bind:open={historyOpen}
            bind:activeId={historyActiveId}
            query={queryInput}
            enabled={$searchHistoryOn$ && !suggestOpen}
            more={(q) => openSearchPalette(q)}
            container={searchBox}
            on:pick={(event) => searchFromHistory(event.detail)}
            on:edit={(event) => editFromHistory(event.detail)}
          />
          <SearchSuggestions
            bind:this={suggestions}
            bind:open={suggestOpen}
            bind:activeId={suggestActiveId}
            query={queryInput}
            cursor={searchFocused ? searchCursor : -1}
            enabled={$searchSuggestionsOn$}
            names={api ? suggestNames : undefined}
            library={appliedLibrary || undefined}
            container={searchBox}
            on:pick={(event) => pickSuggestion(event.detail)}
          />
        </div>
        {#if reading.kind === 'reads' && !queryError}
          <p class="pt-2 text-sm text-c-muted" data-testid="query-reads-as">
            Reads as: {reading.text}
          </p>
        {:else if reading.kind === 'error' && !queryError && queryInput.trim() !== appliedQuery}
          <p class="pt-2 text-sm text-c-seal" data-testid="query-reads-as-error">
            {reading.error.message}
          </p>
        {/if}
        {#if queryError}
          <p
            id="library-query-error"
            class="pt-2 text-sm font-medium text-c-seal"
            role="alert"
            data-testid="query-error"
          >
            {queryError}
          </p>
        {/if}
        <div class="flex flex-wrap items-center justify-end gap-x-4 text-sm">
          {#if appliedQuery && collectionId === null && !queryError}
            <button
              class="c-link min-h-[2.75rem]"
              type="button"
              data-testid="save-search"
              on:click={saveSearch}
            >
              Save as smart collection
            </button>
          {/if}
          <button class="c-link min-h-[2.75rem]" type="button" on:click={showSearchHelp}>
            Search help
          </button>
        </div>
      </div>
    </CataloguePageHeader>

    {#if collectionId === null && group && group.by === 'series' && group.name !== null && groupInfo?.bookIds}
      <!-- Keyed: another series starts collapsed. -->
      {#key group.name}
        <!-- Session 5: "▸ Story so far" beside "▸ Highlights", both closed; their panels open
             below the row, the story so far first. -->
        <div class="series-tools mt-3" data-testid="series-tools">
          <SeriesRecap series={group.name} statusOf={(id) => states.get(id)?.status} {offline} />
          <SeriesHighlights
            api={offline && api ? offlineCatalog() : api}
            seriesName={group.name}
            bookIds={groupInfo.bookIds}
            eink={$einkMode$}
            on:open={(ev) =>
              open(
                ev.detail.book,
                ev.detail.highlight
                  ? {
                      bookId: ev.detail.book.id,
                      highlightId: ev.detail.highlight.id,
                      position: ev.detail.highlight.start
                    }
                  : undefined
              )}
          />
        </div>
      {/key}
    {/if}

    <div
      class="flex flex-wrap items-end justify-between gap-3 border-b pb-3"
      style="border-color: var(--c-gold)"
    >
      {#if collectionId === null || (collectionTabs && !collectionGone)}
        <nav class="c-strip -mx-1 flex max-w-full gap-1 px-1" aria-label="Browse by">
          {#each TABS as t (t.id)}
            <a
              class="c-focus flex min-h-[3rem] shrink-0 items-center gap-2 border-b-2 px-3 text-sm {t.id ===
              tab
                ? 'border-c-seal font-bold text-c-ink'
                : 'border-transparent text-c-muted hover:text-c-ink'}"
              href={urlFor({
                tab: t.id,
                q: appliedQuery,
                lib: appliedLibrary,
                collection: collectionId
              })}
              aria-current={t.id === tab ? 'page' : undefined}
              data-testid="tab-{t.id}"
              data-sveltekit-noscroll
            >
              {t.label}
              {#if tabCounts[t.id] !== undefined}
                <span
                  class="c-count"
                  class:c-count-current={t.id === tab}
                  data-testid="tab-count-{t.id}">{tabCounts[t.id]?.toLocaleString('en')}</span
                >
              {/if}
            </a>
          {/each}
        </nav>
      {:else}
        <span />
      {/if}
      <div class="flex flex-wrap items-center gap-2 text-sm sm:ml-auto sm:justify-end">
        {#if collectionSections && !collectionGone && !group && !reorderMode}
          <LibraryGroupByMenu value={tabInfo.by} on:change={(ev) => onGroupBy(ev.detail)} />
        {/if}
        {#if !reorderMode}
          <LibrarySortMenu
            context={sortContext}
            value={sortValue}
            shortOnPhone
            on:change={(ev) => onSort(ev.detail)}
          />
        {/if}
        <LibraryDisplayMenu />
        {#if !showingGroups && !reorderMode}
          <button
            class="c-btn {selectMode ? 'c-btn-primary' : 'c-btn-ghost'} px-3"
            data-testid="select-mode"
            on:click={toggleSelectMode}
          >
            <Fa icon={selectMode ? faCheck : faSquareCheck} />
            {selectMode ? 'Done' : 'Select'}
          </button>
        {/if}
        {#if uploadInfo?.enabled && collectionId === null && !selectMode}
          <button
            class="c-btn c-btn-primary px-4"
            data-testid="upload-button"
            on:click={() => uploadInput?.click()}
          >
            <Fa icon={faArrowUpFromBracket} />
            Upload
          </button>
          <input
            class="hidden"
            type="file"
            accept=".epub,application/epub+zip"
            multiple
            data-testid="upload-input"
            bind:this={uploadInput}
            on:change={onUploadFiles}
          />
        {/if}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3 pt-3">
      <div
        class="c-strip -mx-1 flex max-w-full gap-2 px-1 sm:flex-wrap"
        role="group"
        aria-label="Filters"
      >
        {#each CHIPS as chip (chip.id)}
          <button
            class="c-chip px-4"
            aria-pressed={chips.has(chip.id)}
            disabled={chipsDisabled}
            data-testid="chip-{chip.id}"
            on:click={() => onChip(chip.id)}
          >
            {#if chips.has(chip.id)}<Fa icon={faCheck} size="xs" />{/if}
            {chip.label}
            {#if chipCounts.has(chip.id)}
              <span class="text-xs opacity-80" data-testid="chip-count-{chip.id}"
                >{chipCounts.get(chip.id)?.toLocaleString('en')}</span
              >
            {/if}
          </button>
        {/each}
      </div>
      {#if enabledLibraries.length > 1 && collectionId === null}
        <label class="ml-auto flex items-center gap-2 text-sm">
          <span class="text-c-muted">Library</span>
          <select class="c-input text-sm" value={appliedLibrary} on:change={pickLibrary}>
            <option value="">All libraries</option>
            {#each enabledLibraries as lib (lib.id)}
              <option value={lib.id}>{lib.name}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    {#if offline}
      <p class="c-notice flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="offline-notice">
        <span role="status">{OFFLINE_NOTICE}</span>
        <button
          class="c-btn c-btn-ghost c-btn-sm -my-1 gap-1.5 px-2.5"
          data-testid="offline-retry"
          on:click={tryServerAgain}><Fa icon={faRotateRight} />Try again</button
        >
      </p>
    {/if}
    {#if indexerError}
      <p class="c-notice" role="status">{indexerError}</p>
    {/if}
    {#if staleNote}
      <p class="c-notice" data-testid="stale-note">
        Some of your recent changes haven't reached the server yet; this list may be out of date.
      </p>
    {/if}
    {#if usesChars && uncounted > 0}
      <p class="c-notice" data-testid="uncounted-note">
        {plural(uncounted, "book isn't", "books aren't")} counted yet and {uncounted === 1
          ? 'is'
          : 'are'} left out.
      </p>
    {/if}
    {#if loadError}
      <p class="c-notice font-medium" role="alert">
        {loadError}
        <a class="c-link" href="{pagePath}/home">Go to Home</a>
      </p>
    {/if}

    {#if showingGroups && collectionSections}
      {#if groups.length}
        <div class="flex flex-col gap-8 pt-2" data-testid="group-sections">
          {#each groups as g (groupKey(g))}
            <section class="flex flex-col gap-3" data-testid="group-section">
              <div
                class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2"
                style="border-color: var(--c-line)"
                use:loadWhenVisible={{
                  enabled: !sectionBooks.has(groupKey(g)),
                  onVisible: () => void loadSection(g)
                }}
              >
                <h2 class="min-w-0 break-words text-lg font-bold">
                  <a class="hover:underline" href={groupHref(g)} data-testid="group-section-title"
                    >{groupTitle(g)}</a
                  >
                  <span class="ml-2 text-sm font-normal text-c-muted">{sectionInfo(g, states)}</span
                  >
                </h2>
                {#if g.bookCount > sectionList(sectionBooks.get(groupKey(g))).length}
                  <a class="c-link text-sm" href={groupHref(g)} data-testid="group-section-all"
                    >See all {g.bookCount.toLocaleString('en')}</a
                  >
                {/if}
              </div>
              {#if sectionBooks.get(groupKey(g)) === 'error'}
                <p class="flex flex-wrap items-center gap-3 text-sm" role="alert">
                  <span class="font-medium">Couldn't load these books.</span>
                  <button
                    class="c-btn c-btn-secondary c-btn-sm px-3"
                    on:click={() => retrySection(g)}>Retry</button
                  >
                </p>
              {:else if !Array.isArray(sectionBooks.get(groupKey(g)))}
                <p class="text-sm text-c-muted" data-testid="group-section-loading">Loading…</p>
              {:else}
                <ul
                  class={grid ? gridLayout.classes : ''}
                  style={grid && gridLayout.style ? gridLayout.style : undefined}
                  data-testid="group-section-books"
                >
                  {#each sectionList(sectionBooks.get(groupKey(g))) as book (book.id)}
                    {#if grid}
                      <LibraryBookCard
                        {...sectionBookProps(
                          book,
                          states,
                          positions,
                          revealed,
                          blurCtx,
                          onDevice,
                          audioOnDevice,
                          infoLine
                        )}
                        on:open={(ev) => open(ev.detail)}
                        on:reveal={(ev) => reveal(ev.detail.id)}
                        on:state={(ev) => openBookState(ev.detail)}
                        on:collect={(ev) => openAddToCollection(ev.detail)}
                        on:remove={(ev) => removeFromDevice(ev.detail)}
                      />
                    {:else}
                      <LibraryBookRow
                        {...sectionBookProps(
                          book,
                          states,
                          positions,
                          revealed,
                          blurCtx,
                          onDevice,
                          audioOnDevice,
                          infoLine
                        )}
                        libraryName={enabledLibraries.length > 1
                          ? (libraryNames.get(book.libraryId) ?? '')
                          : ''}
                        on:open={(ev) => open(ev.detail)}
                        on:reveal={(ev) => reveal(ev.detail.id)}
                        on:state={(ev) => openBookState(ev.detail)}
                        on:collect={(ev) => openAddToCollection(ev.detail)}
                        on:remove={(ev) => removeFromDevice(ev.detail)}
                      />
                    {/if}
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        </div>
      {:else if !loading && !loadError}
        <p class="py-8 text-c-muted">{emptyText}</p>
      {/if}
    {:else if showingGroups}
      {#if groups.length}
        <ul
          class={grid ? gridLayout.classes : ''}
          style={grid && gridLayout.style ? gridLayout.style : undefined}
          data-testid="group-list"
        >
          {#each groups as g (groupKey(g))}
            <LibraryGroupCard
              group={g}
              href={groupHref(g)}
              tiles={groupTiles(g, blurCtx, states, revealed)}
              readCount={g.bookIds ? seriesReadCount(g.bookIds, states) : 0}
              layout={grid ? 'grid' : 'list'}
              {infoLine}
              menu={g.name !== null}
              on:reveal={(ev) => reveal(groupKey(ev.detail))}
              on:menu={(ev) =>
                ev.detail.name !== null && editCoverRule(ev.detail.by, ev.detail.name)}
            />
          {/each}
        </ul>
      {:else if !loading && !loadError}
        <p class="py-8 text-c-muted">{emptyText}</p>
      {/if}
    {:else if reorderMode && books.length}
      <CollectionReorderList
        {books}
        busy={savingOrder}
        thumbnailUrl={(book) => (book.thumbnail && api ? api.absolute(book.thumbnail) : '')}
        blurred={(book) => bookBlurred(book, blurCtx, states, revealed)}
        on:move={(ev) => moveInList(ev.detail.book, ev.detail.delta)}
        on:drop={(ev) => dropInList(ev.detail.book, ev.detail.index)}
        on:more={(ev) => listBookMenu(ev.detail)}
      />
    {:else if books.length}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <ul
        bind:this={listElement}
        class={grid ? gridLayout.classes : ''}
        style={grid && gridLayout.style ? gridLayout.style : undefined}
        class:select-none={selectMode}
        data-testid="book-list"
        on:pointerdown={onListPointerDown}
        on:dragstart={onListDragStart}
      >
        {#each books as book (book.id)}
          {#if grid}
            <LibraryBookCard
              {book}
              sortKey={sortValue.key}
              thumbnailUrl={book.thumbnail && api ? api.absolute(book.thumbnail) : ''}
              state={states.get(book.id)}
              progress={bookProgressLabel(
                book.id,
                states.get(book.id),
                positions.get(book.id) ?? [],
                book.charCount
              )}
              {infoLine}
              blurred={bookBlurred(book, blurCtx, states, revealed)}
              onDevice={onDevice.has(book.id)}
              audioOnDevice={audioOnDevice.has(book.id)}
              {selectMode}
              selected={selected.has(book.id)}
              {authorLink}
              progressFraction={bookProgressFraction(
                book.id,
                states.get(book.id),
                positions.get(book.id) ?? [],
                book.charCount
              )}
              on:open={(ev) => open(ev.detail)}
              on:reveal={(ev) => reveal(ev.detail.id)}
              on:toggle={(ev) => onToggle(ev.detail.book, ev.detail.shift)}
              on:state={(ev) => openBookState(ev.detail)}
              on:collect={(ev) => openAddToCollection(ev.detail)}
              on:remove={(ev) => removeFromDevice(ev.detail)}
            />
          {:else}
            <LibraryBookRow
              {book}
              thumbnailUrl={book.thumbnail && api ? api.absolute(book.thumbnail) : ''}
              onDevice={onDevice.has(book.id)}
              audioOnDevice={audioOnDevice.has(book.id)}
              state={states.get(book.id)}
              progress={bookProgressLabel(
                book.id,
                states.get(book.id),
                positions.get(book.id) ?? [],
                book.charCount
              )}
              {infoLine}
              blurred={bookBlurred(book, blurCtx, states, revealed)}
              {selectMode}
              selected={selected.has(book.id)}
              libraryName={enabledLibraries.length > 1
                ? (libraryNames.get(book.libraryId) ?? '')
                : ''}
              {authorLink}
              progressFraction={bookProgressFraction(
                book.id,
                states.get(book.id),
                positions.get(book.id) ?? [],
                book.charCount
              )}
              on:open={(ev) => open(ev.detail)}
              on:reveal={(ev) => reveal(ev.detail.id)}
              on:toggle={(ev) => onToggle(ev.detail.book, ev.detail.shift)}
              on:state={(ev) => openBookState(ev.detail)}
              on:collect={(ev) => openAddToCollection(ev.detail)}
              on:remove={(ev) => removeFromDevice(ev.detail)}
            />
          {/if}
        {/each}
      </ul>
    {:else if !loading && !loadError && !queryError}
      <p class="py-8 text-c-muted">{emptyText}</p>
    {/if}

    <!-- WP19a: the next page loads when the end comes near; the button is the fallback
         (setting off, no IntersectionObserver) and Retry after a failed page. -->
    <div
      use:loadWhenVisible={{
        enabled: autoLoad && !!nextCursor && !loading && !moreError && !loadError,
        onVisible: () => {
          if (!loading && nextCursor) void loadPage(false);
        }
      }}
      data-testid="load-sentinel"
    />
    {#if loading}
      <p class="c-rule-text py-8 text-sm text-c-muted" data-testid="loading-more">Loading…</p>
    {:else if moreError}
      <div class="flex flex-wrap items-center justify-center gap-3 py-6" role="alert">
        <span class="font-medium" data-testid="load-more-error">Couldn't load more.</span>
        <button
          class="c-btn c-btn-secondary px-6"
          data-testid="load-more-retry"
          on:click={() => loadPage(false)}
        >
          Retry
        </button>
      </div>
    {:else if nextCursor && !autoLoad}
      <div class="flex justify-center py-6">
        <button
          class="c-btn c-btn-secondary px-6"
          data-testid="load-more"
          on:click={() => loadPage(false)}
        >
          Load more
        </button>
      </div>
    {/if}
  {/if}
</div>

{#if dragBox}
  <div
    class="pointer-events-none fixed z-20 border-2 border-dashed"
    style:border-color="var(--c-link)"
    style="left: {dragBox.left}px; top: {dragBox.top}px; width: {dragBox.width}px; height: {dragBox.height}px"
    data-testid="drag-box"
  />
{/if}

{#if selectMode && connection && !showingGroups}
  <div class="c-select-bar fixed inset-x-0 bottom-0 z-10" data-testid="select-bar">
    <div class="{pxScreen} flex flex-wrap items-center justify-between gap-2 py-2">
      <span class="font-medium" data-testid="selected-count" aria-live="polite"
        >{selectBusy || `${selected.size.toLocaleString('en-US')} selected`}</span
      >
      <div class="flex flex-wrap gap-2">
        <button
          class="c-btn c-btn-secondary"
          disabled={selectingAll}
          aria-busy={selectingAll}
          data-testid="select-all"
          on:click={selectAll}
        >
          {selectingAll ? 'Selecting…' : 'Select all'}
        </button>
        <button
          class="c-btn c-btn-secondary"
          disabled={!selected.size}
          data-testid="deselect-all"
          on:click={deselectAll}
        >
          Deselect all
        </button>
        {#if isList}
          <button
            class="c-btn c-btn-secondary"
            disabled={!selected.size}
            data-testid="list-move-top"
            on:click={() => listBulk('top')}
          >
            Move to top
          </button>
          <button
            class="c-btn c-btn-secondary"
            disabled={!selected.size}
            data-testid="list-remove"
            on:click={() => listBulk('remove')}
          >
            Remove from collection
          </button>
        {/if}
        <button
          class="c-btn c-btn-secondary"
          disabled={!selected.size || !!selectBusy}
          data-testid="bulk-change"
          on:click={bulkChange}
        >
          Change…
        </button>
        <SelectDownloadMenu
          api={offline ? null : (api ?? null)}
          selection={selected}
          on:error={(e) => showMessage('Download failed', describe(e.detail))}
          on:notice={(e) => showMessage(e.detail.title, e.detail.message)}
        />
        <button class="c-btn c-btn-primary" on:click={toggleSelectMode}> Done </button>
      </div>
    </div>
  </div>
{/if}

<AppBottomBar hidden={selectMode && !!connection && !showingGroups} />

{#if dropping}
  <!-- Plain for e-ink: a frame and a line of text, no animation. -->
  <div class="c-drop-target" aria-hidden="true" data-testid="upload-drop-target">
    <p class="c-drop-target-text">Drop EPUB files to upload</p>
  </div>
{/if}

{#if uploading}
  <UploadProgressOverlay
    index={uploading.index}
    count={uploading.count}
    name={uploading.name}
    loaded={uploading.loaded}
    total={uploading.total}
    on:cancel={() => uploading?.controller.abort()}
  />
{/if}

{#if opening}
  <LibraryOpenOverlay
    title={opening.book.title}
    stage={opening.stage}
    on:cancel={() => opening?.controller.abort()}
  />
{/if}

{#if seriesEditOpen && seriesEditName && connection}
  <SeriesEdit
    api={new CalibreEditApi(connection.serverUrl, connection.token)}
    name={seriesEditName}
    placement={$seriesEditAs$ === 'modal' ? 'center' : 'side'}
    on:close={() => (seriesEditOpen = false)}
    on:saved={() => (seriesSaved = true)}
  />
{/if}

<style>
  /* Session 5: the series page's tools: the toggles in one row, their open panels below it
     (the story so far first, above the volumes). */
  .series-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .series-tools :global(.series-tool-panel) {
    flex-basis: 100%;
    min-width: 0;
    order: 2;
  }
  .series-tools :global(.series-tool-panel.recap) {
    order: 1;
  }
</style>
