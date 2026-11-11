<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import { canLoadWhenVisible, loadWhenVisible } from '$lib/components/load-when-visible';
  import { libraryAutoLoad$ } from '$lib/library/settings';
  import {
    EINK_UNDERLINES,
    HIGHLIGHT_SWATCHES
  } from '$lib/components/book-reader/highlight-colors';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import NotesList from '$lib/components/notes/notes-list.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { einkMode$ } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { CatalogLibrary } from '$lib/library/types';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    type BookNotes,
    type HighlightColor,
    type HighlightItem
  } from '$lib/notes/highlights';
  import {
    bookChoices,
    buildNotesView,
    EMPTY_FILTER,
    isFiltered,
    notesFilterQuery,
    parseNotesFilter,
    seriesChoices,
    unknownBookInfo,
    type NotesBookInfo,
    type NotesFilter
  } from '$lib/notes/notes-view';
  import { setPendingJump } from '$lib/notes/pending-jump';
  import { notesApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount } from 'svelte';

  /**
   * WP11c: every book's highlights and notes in one place (decisions.md "Highlights and
   * notes"). Records come from the local mirror (shown at once, offline too); titles,
   * series and lengths from the library server, or the titles this device knows. Filters
   * live in the address (?book=&series=&color=&unplaced=1) so a series view can be linked
   * from the Library. Plain for e-ink: no animations, 48 px bordered controls, Load more.
   */

  const PAGE_BOOKS = 20;
  const LOOKUP_CHUNK = 100;
  const solid = 'border-gray-800 bg-gray-800 text-white';
  const control = 'min-h-[3rem] rounded border-2 border-current bg-white px-3';
  const store = getLibraryStore();
  const notes = notesApi();

  let all = new Map<string, BookNotes>();
  let catalog = new Map<string, NotesBookInfo>();
  let titles = new Map<string, string>();
  let unplaced = new Set<string>();
  let loaded = false;
  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let libraries: CatalogLibrary[] = [];
  let infoError = '';
  let shown = PAGE_BOOKS;
  let opening: {
    title: string;
    stage: OpenStage | null;
    controller: AbortController;
  } | null = null;
  let stop: (() => void) | undefined;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  $: timeoutSeconds = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
  // Prerendered without an address: filters exist only in the browser.
  $: filter = browser ? parseNotesFilter($page.url.searchParams) : EMPTY_FILTER;
  $: info = mergedInfo(all, catalog, titles);
  $: groups = buildNotesView(all, info, unplaced, filter);
  $: visible = groups.slice(0, shown);
  $: autoLoad = browser && $libraryAutoLoad$ && canLoadWhenVisible();
  $: books = bookChoices(all, info);
  $: series = seriesChoices(all, info);
  $: highlightTotal = groups.reduce((sum, g) => sum + g.highlights.length, 0);

  onMount(async () => {
    void notes.syncSoon();
    await loadMirror();
    const off = await notes.onChanged(() => schedule());
    if (destroyed) off();
    else stop = off;
    connection = (await store.getConnection()) ?? null;
    if (!connection || destroyed) return;
    api = new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds);
    await loadInfo();
    try {
      libraries = (await api.libraries()).libraries;
    } catch {
      // Needed only to download a book that isn't on this device; opening reports it.
    }
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    stop?.();
    opening?.controller.abort();
  });

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
            charCount: book.charCount
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

  function setFilter(next: NotesFilter) {
    shown = PAGE_BOOKS;
    void goto(`${pagePath}/notes${notesFilterQuery(next)}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  }

  function toggleColor(color: HighlightColor) {
    const colors = new Set(filter.colors);
    if (colors.has(color)) colors.delete(color);
    else colors.add(color);
    setFilter({ ...filter, colors });
  }

  function swatch(color: HighlightColor) {
    return $einkMode$
      ? `text-decoration: underline ${EINK_UNDERLINES[color]} #000; text-decoration-thickness: 2px; text-underline-offset: 4px;`
      : `background-color: ${HIGHLIGHT_SWATCHES[color]};`;
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
        { id: book.id, title: book.title },
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
</script>

<svelte:head>
  <title>{formatPageTitle('Notes')}</title>
</svelte:head>

<AppHeader title="Notes" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="notes-page">
  <div class="flex flex-wrap items-center gap-2 pb-2 pt-3">
    <label class="flex w-full flex-col text-sm sm:w-auto">
      Book
      <select
        class="{control} max-w-full sm:max-w-[18rem]"
        data-testid="notes-filter-book"
        on:change={(ev) => setFilter({ ...filter, book: ev.currentTarget.value || null })}
      >
        <!-- Selected per option: the options arrive after the address is read. -->
        <option value="" selected={!filter.book}>All books</option>
        {#each books as book (book.id)}
          <option value={book.id} selected={book.id === filter.book}>{book.title}</option>
        {/each}
      </select>
    </label>
    <label class="flex w-full flex-col text-sm sm:w-auto">
      Series
      <select
        class="{control} max-w-full sm:max-w-[18rem]"
        data-testid="notes-filter-series"
        on:change={(ev) => setFilter({ ...filter, series: ev.currentTarget.value || null })}
      >
        <option value="" selected={!filter.series}>All series</option>
        {#if filter.series && !series.includes(filter.series)}
          <option value={filter.series} selected>{filter.series}</option>
        {/if}
        {#each series as name (name)}
          <option value={name} selected={name === filter.series}>{name}</option>
        {/each}
      </select>
    </label>
  </div>
  <div class="flex flex-wrap items-center gap-2 pb-3" role="group" aria-label="Show colors">
    {#each HIGHLIGHT_COLORS as color}
      <button
        class="flex min-h-[3rem] min-w-[3rem] items-center justify-center rounded border-2 border-current"
        aria-pressed={filter.colors.has(color)}
        class:outline={filter.colors.has(color)}
        class:outline-4={filter.colors.has(color)}
        title="Only {HIGHLIGHT_COLOR_NAMES[color]}"
        aria-label="Only {HIGHLIGHT_COLOR_NAMES[color]}"
        data-testid="notes-page-filter-{color}"
        on:click={() => toggleColor(color)}
      >
        <span class="block h-5 w-5 rounded-sm" style={swatch(color)}>{$einkMode$ ? 'あ' : ''}</span>
      </button>
    {/each}
    <button
      class="min-h-[3rem] rounded border-2 px-3 text-sm {filter.unplacedOnly
        ? solid
        : 'border-current'}"
      aria-pressed={filter.unplacedOnly}
      data-testid="notes-filter-unplaced"
      on:click={() => setFilter({ ...filter, unplacedOnly: !filter.unplacedOnly })}
    >
      Couldn't place
    </button>
    {#if isFiltered(filter)}
      <button
        class="min-h-[3rem] rounded border-2 border-current px-3 text-sm underline"
        data-testid="notes-filter-clear"
        on:click={() =>
          setFilter({ book: null, series: null, colors: new Set(), unplacedOnly: false })}
      >
        Show all
      </button>
    {/if}
  </div>

  {#if connection === null}
    <p class="py-1 text-sm" data-testid="not-connected">
      This device isn't connected to the library server yet, so book titles may be missing.
      <a class="underline" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {/if}
  {#if infoError}
    <p class="py-1 text-sm" role="alert" data-testid="notes-info-error">{infoError}</p>
  {/if}
  {#if filter.unplacedOnly}
    <p class="py-1 text-sm">
      Highlights this device couldn't find in its copy of the book (it checks when you open the
      book). They are kept as they were.
    </p>
  {/if}

  {#if loaded}
    {#if groups.length}
      <p class="py-1 text-sm" data-testid="notes-summary">
        {groups.length}
        {groups.length === 1 ? 'book' : 'books'} · {highlightTotal}
        {highlightTotal === 1 ? 'highlight' : 'highlights'}
      </p>
      <NotesList
        groups={visible}
        eink={$einkMode$}
        actions={{
          setColor: notes.setColor,
          saveNote: notes.saveNote,
          removeHighlight: notes.removeHighlight,
          removeNote: notes.removeNote
        }}
        on:open={(ev) => open(ev.detail.book, ev.detail.highlight)}
      />
      <!-- WP19a: more books near the end (the Library's "Load more while scrolling"). -->
      <div
        use:loadWhenVisible={{
          enabled: autoLoad && groups.length > shown,
          onVisible: () => (shown += PAGE_BOOKS)
        }}
        data-testid="notes-load-sentinel"
      />
      {#if groups.length > shown && !autoLoad}
        <button
          class="mt-3 min-h-[3rem] w-full rounded border-2 border-current px-4 font-medium"
          data-testid="notes-load-more"
          on:click={() => (shown += PAGE_BOOKS)}
        >
          Load more ({groups.length - shown} more {groups.length - shown === 1 ? 'book' : 'books'})
        </button>
      {/if}
    {:else if isFiltered(filter)}
      <p class="py-6" data-testid="notes-empty">Nothing matches these filters.</p>
    {:else}
      <p class="py-6" data-testid="notes-empty">
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
