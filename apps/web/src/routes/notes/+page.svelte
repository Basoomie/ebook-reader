<script lang="ts">
  import { browser } from '$app/environment';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import LibrarySortMenu from '$lib/components/library/library-sort-menu.svelte';
  import ListPager from '$lib/components/list-pager.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import ColorDot from '$lib/components/notes/color-dot.svelte';
  import NotesFlatList from '$lib/components/notes/notes-flat-list.svelte';
  import NotesList from '$lib/components/notes/notes-list.svelte';
  import SearchPicker, { type PickerOption } from '$lib/components/notes/search-picker.svelte';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { notesCsvBlob, notesCsvFileName } from '$lib/notes/notes-csv';
  import { loadOpenBooks, saveOpenBooks } from '$lib/notes/notes-open';
  import {
    faFileCsv,
    faFilter,
    faMagnifyingGlass,
    faXmark
  } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { einkMode$ } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { pageRangeText } from '$lib/functions/paginate';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { saveListSnapshot, takeListSnapshot } from '$lib/library/list-snapshot';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import {
    libraryRequestTimeoutSeconds$,
    notesBookSort$,
    notesHighlightSort$
  } from '$lib/library/settings';
  import { formatSort, type SortValue } from '$lib/library/sort';
  import type { CatalogLibrary } from '$lib/library/types';
  import { queryWords } from '$lib/settings/paged-list';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    type BookNotes,
    type HighlightColor,
    type HighlightItem
  } from '$lib/notes/highlights';
  import {
    activeFilterCount,
    bookChoices,
    buildNotesView,
    defaultBookSort,
    defaultHighlightSort,
    EMPTY_FILTER,
    flattenNotesView,
    isFiltered,
    notesPage,
    notesPageQuery,
    NOTES_BOOKS_PER_PAGE,
    NOTES_HIGHLIGHTS_PER_PAGE,
    parseNotesPage,
    seriesChoices,
    seriesHighlightCounts,
    seriesLine,
    unknownBookInfo,
    dateRangeLabel,
    dayOf,
    presetRange,
    validDay,
    type DatePreset,
    unplacedCount,
    viewTotals,
    type NotesBookGroup,
    type NotesBookInfo,
    type NotesFilter,
    type NotesPageState,
    type NotesViewMode
  } from '$lib/notes/notes-view';
  import { setPendingJump } from '$lib/notes/pending-jump';
  import { notesApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount, tick } from 'svelte';

  /**
   * WP11c: every book's highlights and notes in one place (decisions.md "Highlights and
   * notes"). Records come from the local mirror (shown at once, offline too); titles,
   * series and lengths from the library server, or the titles this device knows. Filters
   * live in the address so a series view can be linked from the Library. Plain for e-ink:
   * no animations, 48 px bordered controls.
   *
   * WP19d: books start as one row each and open on a tap (remembered on this device; a
   * book filter, or a single book, opens them); compact color dots; Export CSV of
   * everything the filters show.
   *
   * Notes at scale (2026-11-21, decided with the user): a search (highlights, notes,
   * chapters, titles, authors, series), searchable Book and Series pickers, more filters
   * in a panel with chips for what is on, a Sort menu, a Books | Highlights view, and
   * numbered pages (20 books, 25 highlights) instead of loading while scrolling, so the
   * page never grows with the library. Everything is in the address; Back from the reader
   * comes back to the same page and place.
   */

  const LOOKUP_CHUNK = 100;
  /** The search runs this long after the last key (each run re-filters every record). */
  const SEARCH_PAUSE_MS = 200;
  /** The Series picker's "No series" (not a series name). */
  const NO_SERIES = '\u0000none';
  const store = getLibraryStore();
  const notes = notesApi();
  const actions = {
    setColor: notes.setColor,
    saveNote: notes.saveNote,
    removeHighlight: notes.removeHighlight,
    removeNote: notes.removeNote
  };
  const chip = 'c-btn c-btn-secondary min-h-[2.75rem] shrink-0 gap-2 rounded-full px-3 text-sm';

  let all = new Map<string, BookNotes>();
  let catalog = new Map<string, NotesBookInfo>();
  let titles = new Map<string, string>();
  let unplaced = new Set<string>();
  let loaded = false;
  let infoSettled = false;
  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let libraries: CatalogLibrary[] = [];
  let infoError = '';
  let opening: {
    title: string;
    stage: OpenStage | null;
    controller: AbortController;
  } | null = null;
  let stop: (() => void) | undefined;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let openBooks = browser ? loadOpenBooks() : new Set<string>();
  /** Books the search opened that were closed by hand during this search. */
  let searchClosed = new Set<string>();
  /** The filter and books the automatic opening last ran for. */
  let autoOpenedFor = '';
  let filtersOpen = false;
  let queryText = '';
  /** The search the address had when the box was last set from it (or applied). */
  let appliedQuery: string | null = null;
  let searchInput: HTMLInputElement;
  let listTop: HTMLDivElement;
  /** The scroll position to go back to (Back from the reader), once the list is drawn. */
  let restoreY: number | null = null;

  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  // Prerendered without an address: filters exist only in the browser.
  $: state = browser
    ? parseNotesPage($page.url.searchParams)
    : ({ filter: EMPTY_FILTER, view: 'books', sort: null, page: 1 } as NotesPageState);
  $: filter = state.filter;
  $: syncQuery(filter.query);
  $: words = queryWords(filter.query);
  $: info = mergedInfo(all, catalog, titles);
  $: bookSort =
    state.view === 'books' && state.sort ? state.sort : defaultBookSort(filter, $notesBookSort$);
  $: highlightSort =
    state.view === 'highlights' && state.sort
      ? state.sort
      : defaultHighlightSort($notesHighlightSort$);
  $: sortValue = state.view === 'books' ? bookSort : highlightSort;
  $: groups = buildNotesView(all, info, unplaced, filter, { sort: bookSort });
  $: totals = viewTotals(groups);
  $: flat = state.view === 'highlights' ? flattenNotesView(groups, highlightSort) : [];
  $: bookPage = notesPage(groups, state.page, NOTES_BOOKS_PER_PAGE);
  $: flatPage = notesPage(flat, state.page, NOTES_HIGHLIGHTS_PER_PAGE);
  $: shownPage = state.view === 'books' ? bookPage : flatPage;
  $: forced = forcedOpen(filter, bookPage.items);
  $: displayOpen = mergeOpen(openBooks, forced, searchClosed);
  $: allOpenOnPage =
    bookPage.items.length > 0 && bookPage.items.every((g) => displayOpen.has(g.info.id));
  $: allItems = [...all.values()].reduce((n, e) => n + e.highlights.length + e.notes.length, 0);
  $: unplacedTotal = unplacedCount(all, unplaced);
  $: filterCount = activeFilterCount(filter);
  $: bookOptions = pickerBooks(all, info, filter.series, filter.noSeries);
  $: seriesOptions = pickerSeries(all, info);
  $: bookLabel = filter.book ? (info.get(filter.book)?.title ?? '') : '';
  $: if (loaded) autoOpen(filter, groups);
  $: if (restoreY !== null && loaded && infoSettled) void restoreScroll();

  onMount(async () => {
    void notes.syncSoon();
    await loadMirror();
    const off = await notes.onChanged(() => schedule());
    if (destroyed) off();
    else stop = off;
    connection = (await store.getConnection()) ?? null;
    if (!connection || destroyed) {
      infoSettled = true;
      return;
    }
    api = new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds);
    await loadInfo();
    infoSettled = true;
    try {
      libraries = (await api.libraries()).libraries;
    } catch {
      // Needed only to download a book that isn't on this device; opening reports it.
    }
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    clearTimeout(searchTimer);
    stop?.();
    opening?.controller.abort();
  });

  // Back from the reader (or a book's details) shows the same place in the list.
  beforeNavigate((nav) => {
    if (nav.to?.url.pathname !== $page.url.pathname) {
      saveListSnapshot(snapshotKey($page.url), window.scrollY, null);
    }
  });

  afterNavigate((nav) => {
    if (nav.type !== 'popstate' || nav.from?.url.pathname === $page.url.pathname) return;
    const snap = takeListSnapshot<null>(snapshotKey($page.url));
    if (snap) restoreY = snap.scrollY;
  });

  function snapshotKey(url: URL) {
    return `notes:${url.pathname}${url.search}`;
  }

  async function restoreScroll() {
    const y = restoreY;
    restoreY = null;
    await tick();
    if (y !== null) window.scrollTo(0, y);
  }

  /** Changes come in bursts (a sync, an Undo): settle first. */
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (destroyed) return;
      await loadMirror();
      await loadInfo();
    }, 300);
  }

  async function loadMirror() {
    const [a, u, t] = await Promise.all([notes.all(), notes.unplaced(), notes.titles()]);
    all = a;
    unplaced = u;
    titles = t;
    loaded = true;
  }

  /** Titles, series and lengths of the books not looked up yet. */
  async function loadInfo() {
    if (!api) return;
    const missing = [...all.keys()].filter((id) => !catalog.has(id));
    if (!missing.length) return;
    const next = new Map(catalog);
    try {
      for (let i = 0; i < missing.length; i += LOOKUP_CHUNK) {
        const chunk = missing.slice(i, i + LOOKUP_CHUNK);
        const result = await api.lookup(chunk);
        for (const book of result.books) {
          next.set(book.id, {
            id: book.id,
            title: book.title,
            series: book.series,
            charCount: book.charCount,
            authors: book.authors.map((a) => a.name),
            thumbnail: book.thumbnail && api ? api.absolute(book.thumbnail) : null
          });
        }
      }
      infoError = '';
    } catch (error) {
      infoError =
        error instanceof LibraryApiError &&
        (error.kind === 'unreachable' || error.kind === 'timeout')
          ? "The library server can't be reached, so some titles, series and percents are missing."
          : `Book details could not be loaded: ${(error as Error).message}`;
    }
    if (!destroyed) catalog = next;
  }

  function mergedInfo(
    a: Map<string, BookNotes>,
    c: Map<string, NotesBookInfo>,
    t: Map<string, string>
  ): Map<string, NotesBookInfo> {
    const out = new Map<string, NotesBookInfo>();
    for (const id of a.keys()) out.set(id, c.get(id) ?? unknownBookInfo(id, t.get(id)));
    return out;
  }

  // ---- The address --------------------------------------------------------------------

  function setState(next: NotesPageState) {
    void goto(`${pagePath}/notes${notesPageQuery(next)}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  }

  /** A new filter goes back to the first page (the sort and view stay). */
  function setFilter(next: NotesFilter) {
    if (next.query !== filter.query || next.unplacedOnly !== filter.unplacedOnly) {
      searchClosed = new Set();
    }
    setState({ ...state, filter: next, page: 1 });
  }

  function clearFilters() {
    setFilter({ ...EMPTY_FILTER, query: filter.query });
  }

  const DATE_PRESETS: { id: DatePreset; label: string }[] = [
    { id: 'week', label: 'Last 7 days' },
    { id: 'month', label: 'Last 30 days' },
    { id: 'year', label: 'This year' }
  ];

  /** Today's date for the date inputs' limit (local). */
  $: today = browser ? dayOf(Date.now()) : undefined;

  /** `f` is passed in so the buttons' pressed state follows the filter. */
  function isPreset(preset: DatePreset, f: NotesFilter) {
    const r = presetRange(preset);
    return f.from === r.from && f.to === r.to;
  }

  /** A quick pick sets the range; tapping the one that is on clears it. */
  function pickPreset(preset: DatePreset) {
    const r = presetRange(preset);
    setFilter(isPreset(preset, filter) ? { ...filter, from: null, to: null } : { ...filter, ...r });
  }

  function toggleColor(color: HighlightColor) {
    const colors = new Set(filter.colors);
    if (colors.has(color)) colors.delete(color);
    else colors.add(color);
    setFilter({ ...filter, colors });
  }

  function setView(view: NotesViewMode) {
    if (view !== state.view) setState({ ...state, view, sort: null, page: 1 });
  }

  function onSort(value: SortValue) {
    if (state.view === 'highlights') $notesHighlightSort$ = formatSort(value, 'notes-highlights');
    // A series opens in series order; a sort picked there is not remembered for the rest.
    else if (!filter.series) $notesBookSort$ = formatSort(value, 'notes-books');
    setState({ ...state, sort: value, page: 1 });
  }

  async function goToPage(next: number) {
    setState({ ...state, page: next });
    await tick();
    // Keep the list's top in view after a page change from the pager under it.
    const top = listTop?.getBoundingClientRect().top ?? 0;
    if (top < 64) listTop.scrollIntoView({ block: 'start' });
  }

  // ---- Search ---------------------------------------------------------------------------

  /** The box follows the address when the address changes from elsewhere (Clear, Back). */
  function syncQuery(q: string) {
    if (q === appliedQuery) return;
    appliedQuery = q;
    queryText = q;
  }

  function applySearch() {
    clearTimeout(searchTimer);
    const q = queryText.trim();
    if (q === filter.query) return;
    appliedQuery = q;
    setFilter({ ...filter, query: q });
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, SEARCH_PAUSE_MS);
  }

  function clearSearch() {
    queryText = '';
    applySearch();
    searchInput?.focus();
  }

  /** "/" anywhere on the page goes to the search box (not while typing elsewhere). */
  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    searchInput?.focus();
  }

  // ---- Opened books ---------------------------------------------------------------------

  /**
   * While searching, the shown books whose highlights matched open; with "Not found in
   * book", every shown book (those few highlights are the point). Not remembered.
   */
  function forcedOpen(f: NotesFilter, shown: NotesBookGroup[]): Set<string> {
    if (f.unplacedOnly) return new Set(shown.map((g) => g.info.id));
    if (!f.query.trim()) return new Set();
    return new Set(shown.filter((g) => g.hit === 'items').map((g) => g.info.id));
  }

  function mergeOpen(
    remembered: ReadonlySet<string>,
    byQuery: ReadonlySet<string>,
    closed: ReadonlySet<string>
  ): Set<string> {
    const out = new Set(remembered);
    for (const id of byQuery) if (!closed.has(id)) out.add(id);
    return out;
  }

  function setOpen(ids: readonly string[], open: boolean) {
    const next = new Set(openBooks);
    for (const id of ids) {
      if (open) next.add(id);
      else next.delete(id);
    }
    openBooks = next;
    saveOpenBooks(next);
  }

  function setSearchClosed(ids: readonly string[], closed: boolean) {
    const next = new Set(searchClosed);
    for (const id of ids) {
      if (closed) next.add(id);
      else next.delete(id);
    }
    searchClosed = next;
  }

  function toggleBook(id: string) {
    if (displayOpen.has(id)) {
      if (openBooks.has(id)) setOpen([id], false);
      if (forced.has(id)) setSearchClosed([id], true);
    } else if (forced.has(id)) {
      setSearchClosed([id], false);
    } else {
      setOpen([id], true);
    }
  }

  /** "Open all" and "Close all" act on this page's books only. */
  function toggleAllOnPage() {
    const ids = bookPage.items.map((g) => g.info.id);
    if (allOpenOnPage) {
      setOpen(ids, false);
      setSearchClosed(
        ids.filter((id) => forced.has(id)),
        true
      );
    } else {
      setOpen(ids, true);
      setSearchClosed(ids, false);
    }
  }

  /**
   * A book filter (the link from a book's details page) opens that book; so does a page
   * with a single book and no search. Runs again when the filter or the books change, so
   * books that arrive later (titles looked up) open too. Never closes anything.
   */
  function autoOpen(f: NotesFilter, shownGroups: NotesBookGroup[]) {
    const ids = shownGroups.map((g) => g.info.id);
    const key = `${f.book ?? ''}|${f.query}|${ids.join(',')}`;
    if (key === autoOpenedFor) return;
    autoOpenedFor = key;
    if (f.book || (ids.length === 1 && !f.query.trim())) {
      const closed = ids.filter((id) => !openBooks.has(id));
      if (closed.length) setOpen(closed, true);
    }
  }

  // ---- Pickers ----------------------------------------------------------------------------

  /** The Book picker's books (only the picked series' when a series is picked). */
  function pickerBooks(
    a: Map<string, BookNotes>,
    i: Map<string, NotesBookInfo>,
    series: string | null,
    noSeries: boolean
  ): PickerOption[] {
    return bookChoices(a, i)
      .filter((b) => (series ? b.series?.name === series : noSeries ? !b.series : true))
      .map((b) => ({
        id: b.id,
        label: b.title,
        sub: [(b.authors ?? []).join(', '), seriesLine(b)].filter(Boolean).join(' · '),
        count: (a.get(b.id)?.highlights.length ?? 0) + (a.get(b.id)?.notes.length ?? 0)
      }));
  }

  function pickerSeries(a: Map<string, BookNotes>, i: Map<string, NotesBookInfo>): PickerOption[] {
    const counts = seriesHighlightCounts(a, i);
    const options: PickerOption[] = seriesChoices(a, i).map((name) => ({
      id: name,
      label: name,
      count: counts.get(name) ?? 0
    }));
    if (counts.has('')) options.push({ id: NO_SERIES, label: 'No series', count: counts.get('') });
    return options;
  }

  function pickSeries(id: string | null) {
    setFilter({
      ...filter,
      series: id && id !== NO_SERIES ? id : null,
      noSeries: id === NO_SERIES,
      // A picked book outside the new series would show nothing.
      book:
        filter.book && id
          ? (
              id === NO_SERIES
                ? !info.get(filter.book)?.series
                : info.get(filter.book)?.series?.name === id
            )
            ? filter.book
            : null
          : filter.book
    });
  }

  // ---- Actions ----------------------------------------------------------------------------

  function exportCsv() {
    downloadBlob(notesCsvBlob(groups), notesCsvFileName(new Date()));
  }

  function showMessage(title: string, message: string) {
    dialogManager.dialogs$.next([{ component: MessageDialog, props: { title, message } }]);
  }

  /** Opens the book (as the Library does), then the reader jumps to the highlight. */
  async function open(book: NotesBookInfo, highlight: HighlightItem | null) {
    if (opening) return;
    if (!api) {
      showMessage('Not opened', "This device isn't connected to the library server yet.");
      return;
    }
    const controller = new AbortController();
    opening = { title: book.title, stage: null, controller };
    try {
      const outcome = await openCatalogBook(
        // WP19d: with the authors, so the link keeps them for quote images in the reader.
        { id: book.id, title: book.title, authors: (book.authors ?? []).map((name) => ({ name })) },
        api,
        store,
        libraries,
        controller.signal,
        (stage) => {
          if (opening) opening = { ...opening, stage };
        }
      );
      if (outcome.status === 'opened') {
        if (highlight) {
          setPendingJump({ bookId: book.id, highlightId: highlight.id, position: highlight.start });
        }
        await goto(`${pagePath}/b?id=${outcome.localId}`);
        return;
      }
      if (outcome.status === 'refused') showMessage('Not opened', outcome.message);
    } catch (error) {
      logger.warn(`Notes: opening "${book.title}" failed: ${(error as Error).message}`);
      showMessage(
        'Could not open the book',
        error instanceof LibraryApiError &&
          (error.kind === 'unreachable' || error.kind === 'timeout')
          ? "The library server can't be reached, and this book isn't on this device yet."
          : (error as Error).message
      );
    } finally {
      opening = null;
    }
  }

  function plural(n: number, one: string, many: string) {
    return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  }

  /** "21–40 of 312" with more than one page, else "312". */
  function rangeOf(p: { pages: number; from: number; to: number; total: number }) {
    return p.pages > 1 ? pageRangeText(p) : p.total.toLocaleString('en-US');
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Notes')}</title>
</svelte:head>

<svelte:window on:keydown={onWindowKeydown} />

<AppHeader title="Notes" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="notes-page">
  <CataloguePageHeader jp="抜き書き" title="Notes">
    {#if loaded && all.size}
      <form
        class="flex w-full min-w-0 sm:w-[22rem] lg:w-[26rem]"
        role="search"
        on:submit|preventDefault={applySearch}
      >
        <label class="c-input flex min-h-[2.75rem] min-w-0 grow items-center gap-2">
          <span class="text-c-muted" aria-hidden="true"><Fa icon={faMagnifyingGlass} /></span>
          <span class="sr-only">Search highlights and notes</span>
          <input
            class="c-notes-search w-full min-w-0 border-0 bg-transparent p-0 text-sm focus:ring-0"
            type="search"
            enterkeyhint="search"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search highlights, notes, books, series…"
            data-testid="notes-search"
            bind:value={queryText}
            bind:this={searchInput}
            on:input={onSearchInput}
            on:keydown={(e) => {
              if (e.key === 'Escape' && queryText) {
                e.preventDefault();
                clearSearch();
              }
            }}
          />
          {#if queryText}
            <button
              type="button"
              class="c-btn c-btn-ghost -my-2 -mr-3 h-11 min-h-0 w-11 shrink-0 p-0"
              title="Clear the search"
              aria-label="Clear the search"
              data-testid="notes-search-clear"
              on:click={clearSearch}
            >
              <Fa icon={faXmark} />
            </button>
          {/if}
        </label>
      </form>
    {/if}
  </CataloguePageHeader>

  {#if loaded && all.size}
    <div class="flex flex-wrap items-center gap-2 pb-2" data-testid="notes-toolbar">
      <div class="c-segmented flex" role="group" aria-label="Show">
        <button
          type="button"
          class="c-btn c-btn-secondary min-h-[2.75rem] rounded-r-none px-4 text-sm"
          aria-pressed={state.view === 'books'}
          data-testid="notes-view-books"
          on:click={() => setView('books')}
        >
          Books
        </button>
        <button
          type="button"
          class="c-btn c-btn-secondary -ml-px min-h-[2.75rem] rounded-l-none px-4 text-sm"
          aria-pressed={state.view === 'highlights'}
          data-testid="notes-view-highlights"
          on:click={() => setView('highlights')}
        >
          Highlights
        </button>
      </div>
      <button
        type="button"
        class="c-btn c-btn-secondary min-h-[2.75rem] gap-2 px-3 text-sm"
        aria-expanded={filtersOpen}
        aria-controls="notes-filters"
        data-testid="notes-filters-toggle"
        on:click={() => (filtersOpen = !filtersOpen)}
      >
        <Fa icon={faFilter} />
        Filters{#if filterCount}<span class="c-count-badge" data-testid="notes-filter-count"
            >{filterCount}</span
          >{/if}
      </button>
      <!-- Phones: [Books | Highlights] [Filters] on one row, Sort and CSV on the next. -->
      <LibrarySortMenu
        context={state.view === 'books' ? 'notes-books' : 'notes-highlights'}
        value={sortValue}
        shortOnPhone
        on:change={(e) => onSort(e.detail)}
      />
      {#if groups.length}
        <button
          type="button"
          class="c-btn c-btn-secondary ml-auto min-h-[2.75rem] min-w-[2.75rem] gap-2 px-3 text-sm"
          title="Download what the search and filters show as a spreadsheet (CSV)"
          aria-label="Export CSV"
          data-testid="notes-export-csv"
          on:click={exportCsv}
        >
          <Fa icon={faFileCsv} />
          <span class="hidden sm:inline">Export CSV</span>
        </button>
      {/if}
    </div>

    {#if filtersOpen}
      <div
        id="notes-filters"
        class="c-notes-panel mb-2 grid gap-3 rounded p-3 sm:grid-cols-2"
        data-testid="notes-filters"
      >
        <SearchPicker
          label="Book"
          allLabel="All books"
          placeholder="Type a title or author"
          options={bookOptions}
          value={filter.book}
          valueLabel={bookLabel}
          testid="notes-filter-book"
          on:change={(e) => setFilter({ ...filter, book: e.detail })}
        />
        <SearchPicker
          label="Series"
          allLabel="All series"
          placeholder="Type a series name"
          options={seriesOptions}
          value={filter.noSeries ? NO_SERIES : filter.series}
          valueLabel={filter.series ?? ''}
          testid="notes-filter-series"
          on:change={(e) => pickSeries(e.detail)}
        />
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 sm:col-span-2">
          <div class="flex items-center" role="group" aria-label="Show colors">
            <span class="pr-2 text-xs font-medium uppercase tracking-wider text-c-muted">Color</span
            >
            {#each HIGHLIGHT_COLORS as color}
              <button
                type="button"
                class="c-dot-btn flex h-11 w-11 items-center justify-center rounded-full"
                aria-pressed={filter.colors.has(color)}
                title="Only {HIGHLIGHT_COLOR_NAMES[color]}"
                aria-label="Only {HIGHLIGHT_COLOR_NAMES[color]}"
                data-testid="notes-page-filter-{color}"
                on:click={() => toggleColor(color)}
              >
                <ColorDot {color} eink={$einkMode$} picked={filter.colors.has(color)} />
              </button>
            {/each}
          </div>
          <button
            type="button"
            class="c-btn c-btn-secondary min-h-[2.75rem] rounded-full px-4 text-sm"
            aria-pressed={filter.withNote}
            data-testid="notes-filter-note"
            on:click={() => setFilter({ ...filter, withNote: !filter.withNote })}
          >
            With a note
          </button>
          {#if unplacedTotal > 0 || filter.unplacedOnly}
            <button
              type="button"
              class="c-btn c-btn-secondary min-h-[2.75rem] gap-2 rounded-full px-4 text-sm"
              aria-pressed={filter.unplacedOnly}
              title="Highlights this device couldn't find in its copy of the book"
              data-testid="notes-filter-unplaced"
              on:click={() => setFilter({ ...filter, unplacedOnly: !filter.unplacedOnly })}
            >
              Not found in book
              <span class="text-xs opacity-80">{unplacedTotal.toLocaleString('en-US')}</span>
            </button>
          {/if}
        </div>
        <fieldset class="flex flex-wrap items-end gap-x-3 gap-y-2 sm:col-span-2">
          <legend class="pb-1 text-xs font-medium uppercase tracking-wider text-c-muted">
            Date highlighted
          </legend>
          <label class="flex flex-col gap-1 text-sm text-c-muted">
            From
            <input
              class="c-input min-h-[2.75rem]"
              type="date"
              value={filter.from ?? ''}
              max={filter.to ?? today}
              data-testid="notes-filter-from"
              on:change={(e) => setFilter({ ...filter, from: validDay(e.currentTarget.value) })}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm text-c-muted">
            To
            <input
              class="c-input min-h-[2.75rem]"
              type="date"
              value={filter.to ?? ''}
              min={filter.from ?? undefined}
              data-testid="notes-filter-to"
              on:change={(e) => setFilter({ ...filter, to: validDay(e.currentTarget.value) })}
            />
          </label>
          <div class="flex flex-wrap gap-2" role="group" aria-label="Quick dates">
            {#each DATE_PRESETS as preset (preset.id)}
              <button
                type="button"
                class="c-btn c-btn-secondary min-h-[2.75rem] rounded-full px-3 text-sm"
                aria-pressed={isPreset(preset.id, filter)}
                data-testid="notes-date-{preset.id}"
                on:click={() => pickPreset(preset.id)}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        </fieldset>
      </div>
    {/if}

    {#if filterCount}
      <div
        class="flex flex-wrap items-center gap-2 pb-2"
        role="group"
        aria-label="Filters on"
        data-testid="notes-chips"
      >
        {#if filter.book}
          <button
            type="button"
            class={chip}
            data-testid="notes-chip"
            on:click={() => setFilter({ ...filter, book: null })}
          >
            <span class="max-w-[14rem] truncate">Book: {bookLabel || 'Unknown book'}</span>
            <Fa icon={faXmark} /><span class="sr-only">Remove</span>
          </button>
        {/if}
        {#if filter.series || filter.noSeries}
          <button
            type="button"
            class={chip}
            data-testid="notes-chip"
            on:click={() => setFilter({ ...filter, series: null, noSeries: false })}
          >
            <span class="max-w-[14rem] truncate"
              >{filter.series ? `Series: ${filter.series}` : 'No series'}</span
            >
            <Fa icon={faXmark} /><span class="sr-only">Remove</span>
          </button>
        {/if}
        {#each HIGHLIGHT_COLORS.filter((c) => filter.colors.has(c)) as color}
          <button
            type="button"
            class={chip}
            data-testid="notes-chip"
            on:click={() => toggleColor(color)}
          >
            <ColorDot {color} eink={$einkMode$} size={16} />
            {HIGHLIGHT_COLOR_NAMES[color]}
            <Fa icon={faXmark} /><span class="sr-only">Remove</span>
          </button>
        {/each}
        {#if filter.withNote}
          <button
            type="button"
            class={chip}
            data-testid="notes-chip"
            on:click={() => setFilter({ ...filter, withNote: false })}
          >
            With a note <Fa icon={faXmark} /><span class="sr-only">Remove</span>
          </button>
        {/if}
        {#if filter.unplacedOnly}
          <button
            type="button"
            class={chip}
            data-testid="notes-chip"
            on:click={() => setFilter({ ...filter, unplacedOnly: false })}
          >
            Not found in book <Fa icon={faXmark} /><span class="sr-only">Remove</span>
          </button>
        {/if}
        {#if filter.from || filter.to}
          <button
            type="button"
            class={chip}
            data-testid="notes-chip"
            on:click={() => setFilter({ ...filter, from: null, to: null })}
          >
            <span class="max-w-[16rem] truncate">{dateRangeLabel(filter)}</span>
            <Fa icon={faXmark} /><span class="sr-only">Remove</span>
          </button>
        {/if}
        <button
          type="button"
          class="c-link min-h-[2.75rem] px-2 text-sm"
          data-testid="notes-filter-clear"
          on:click={clearFilters}
        >
          Clear all
        </button>
      </div>
    {/if}
  {/if}

  {#if connection === null}
    <p class="c-notice" data-testid="not-connected">
      This device isn't connected to the library server yet, so book titles may be missing.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {/if}
  {#if infoError}
    <p class="c-notice" role="alert" data-testid="notes-info-error">{infoError}</p>
  {/if}
  {#if filter.unplacedOnly}
    <p class="c-notice" data-testid="notes-unplaced-help">
      Highlights this device couldn't find in its copy of the book (the book's file changed since
      they were made). They are kept as they were.
    </p>
  {/if}

  {#if loaded}
    <div bind:this={listTop} class="c-list-top" />
    {#if groups.length}
      <div class="flex flex-wrap items-center justify-between gap-2 pb-2 pt-1">
        <p class="text-sm text-c-muted" aria-live="polite" data-testid="notes-summary">
          {#if state.view === 'books'}
            {rangeOf(bookPage)}
            {totals.books === 1 ? 'book' : 'books'} · {plural(
              totals.highlights,
              'highlight',
              'highlights'
            )} · {plural(totals.notes, 'note', 'notes')}
            {#if isFiltered(filter)}· {plural(all.size, 'book', 'books')} in all{/if}
          {:else}
            {rangeOf(flatPage)}
            {flat.length === 1 ? 'highlight or note' : 'highlights and notes'}
            {#if isFiltered(filter)}· {allItems.toLocaleString('en-US')} in all{/if}
          {/if}
        </p>
        {#if state.view === 'books'}
          <button
            type="button"
            class="c-link min-h-[2.75rem] px-2 text-sm"
            data-testid="notes-expand-all"
            on:click={toggleAllOnPage}
          >
            {allOpenOnPage
              ? 'Close all'
              : bookPage.pages > 1
                ? 'Open all on this page'
                : 'Open all'}
          </button>
        {/if}
      </div>
      {#if state.view === 'books'}
        <NotesList
          groups={bookPage.items}
          collapsible
          openBooks={displayOpen}
          {words}
          on:toggle={(ev) => toggleBook(ev.detail.id)}
          eink={$einkMode$}
          {actions}
          on:open={(ev) => open(ev.detail.book, ev.detail.highlight)}
        />
      {:else}
        <NotesFlatList
          rows={flatPage.items}
          {words}
          eink={$einkMode$}
          {actions}
          on:open={(ev) => open(ev.detail.book, ev.detail.highlight)}
        />
      {/if}
      {#if shownPage.pages > 1}
        <div class="mt-3">
          <ListPager
            page={shownPage.page + 1}
            pages={shownPage.pages}
            label={state.view === 'books' ? 'Books' : 'Highlights'}
            testid="notes"
            on:go={(e) => goToPage(e.detail)}
          />
        </div>
      {/if}
    {:else if isFiltered(filter)}
      <div class="py-6 text-c-muted" data-testid="notes-empty">
        <p>
          {filter.query.trim()
            ? `Nothing matches “${filter.query.trim()}”${filterCount ? ' with these filters' : ''}.`
            : 'Nothing matches these filters.'}
        </p>
        <button
          type="button"
          class="c-link mt-1 min-h-[2.75rem] text-sm"
          data-testid="notes-empty-clear"
          on:click={() => {
            queryText = '';
            appliedQuery = '';
            setFilter(EMPTY_FILTER);
          }}
        >
          Clear the search and filters
        </button>
      </div>
    {:else}
      <p class="py-6 text-c-muted" data-testid="notes-empty">
        No highlights or notes yet. In a book, long-press text (or select it with the mouse) to
        highlight it; L shows a book's highlights and notes.
      </p>
    {/if}
  {/if}
</div>

<AppBottomBar />

{#if opening}
  <LibraryOpenOverlay
    title={opening.title}
    stage={opening.stage}
    on:cancel={() => opening?.controller.abort()}
  />
{/if}

<style>
  .c-dot-btn:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    :global(html:not(.eink)) .c-dot-btn:hover {
      background-color: var(--c-tint);
    }
  }

  .c-notes-panel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-count-badge {
    display: inline-flex;
    min-width: 1.25rem;
    height: 1.25rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.3rem;
    border-radius: 999px;
    background-color: var(--c-sel-bg);
    color: var(--c-sel-ink);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  /* The page draws its own ✕ (44 px, E-ink friendly): no second one from the browser. */
  .c-notes-search::-webkit-search-cancel-button {
    -webkit-appearance: none;
    appearance: none;
    display: none;
  }

  /* Under the fixed header when the pager scrolls back to the list's top. */
  .c-list-top {
    scroll-margin-top: 4.5rem;
  }
</style>
