<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import { canLoadWhenVisible, loadWhenVisible } from '$lib/components/load-when-visible';
  import { libraryAutoLoad$ } from '$lib/library/settings';
  import LibraryOpenOverlay from '$lib/components/library/library-open-overlay.svelte';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import ColorDot from '$lib/components/notes/color-dot.svelte';
  import NotesList from '$lib/components/notes/notes-list.svelte';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { notesCsvBlob, notesCsvFileName } from '$lib/notes/notes-csv';
  import { loadOpenBooks, saveOpenBooks } from '$lib/notes/notes-open';
  import { faFileCsv } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
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
    type NotesBookGroup,
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
   *
   * WP19d: books start as one row each and open on a tap (remembered on this device; a
   * book or series filter, or a single book, opens them); compact color dots; Export CSV
   * of everything the filters show.
   */

  const PAGE_BOOKS = 20;
  const LOOKUP_CHUNK = 100;
  // WP19b: the catalogue look.
  const control = 'c-input';
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
  let openBooks = browser ? loadOpenBooks() : new Set<string>();
  /** The filter and books the automatic opening last ran for. */
  let autoOpenedFor = '';

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
  $: noteTotal = groups.reduce(
    (sum, g) => sum + g.notes.length + g.highlights.filter((r) => r.item.note).length,
    0
  );
  $: allOpen = groups.length > 0 && groups.every((g) => openBooks.has(g.info.id));
  $: if (loaded) autoOpen(filter, groups);

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

  function setOpen(ids: readonly string[], open: boolean) {
    const next = new Set(openBooks);
    for (const id of ids) {
      if (open) next.add(id);
      else next.delete(id);
    }
    openBooks = next;
    saveOpenBooks(next);
  }

  function toggleBook(id: string) {
    setOpen([id], !openBooks.has(id));
  }

  /**
   * A book or series filter (from a link: the details page, a series) opens what it shows;
   * so does a page with a single book. Runs again when the filter or the books change, so
   * books that arrive later (titles looked up) open too. Never closes anything.
   */
  function autoOpen(f: NotesFilter, shownGroups: NotesBookGroup[]) {
    const ids = shownGroups.map((g) => g.info.id);
    const key = `${f.book ?? ''}|${f.series ?? ''}|${ids.join(',')}`;
    if (key === autoOpenedFor) return;
    autoOpenedFor = key;
    if (f.book || f.series || ids.length === 1) {
      const closed = ids.filter((id) => !openBooks.has(id));
      if (closed.length) setOpen(closed, true);
    }
  }

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
</script>

<svelte:head>
  <title>{formatPageTitle('Notes')}</title>
</svelte:head>

<AppHeader title="Notes" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="notes-page">
  <!-- WP19d: the counts are in the line above the list (with notes and Expand all). -->
  <CataloguePageHeader jp="抜き書き" title="Notes">
    {#if loaded && groups.length}
      <button
        type="button"
        class="c-btn c-btn-secondary px-4 text-sm"
        title="Download what the filters show as a spreadsheet (CSV)"
        data-testid="notes-export-csv"
        on:click={exportCsv}
      >
        <Fa icon={faFileCsv} />
        Export CSV
      </button>
    {/if}
  </CataloguePageHeader>
  <div class="grid grid-cols-2 items-end gap-3 pb-2 pt-2 sm:flex sm:flex-wrap">
    <label class="flex min-w-0 flex-col gap-1 text-sm text-c-muted">
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
    <label class="flex min-w-0 flex-col gap-1 text-sm text-c-muted">
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
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3">
    <div class="flex items-center" role="group" aria-label="Show colors">
      <span class="pr-2 text-xs font-medium uppercase tracking-wider text-c-muted">Colour</span>
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
      class="c-btn c-btn-secondary min-h-[2.75rem] rounded-full px-4 text-sm"
      aria-pressed={filter.unplacedOnly}
      data-testid="notes-filter-unplaced"
      on:click={() => setFilter({ ...filter, unplacedOnly: !filter.unplacedOnly })}
    >
      Couldn't place
    </button>
    {#if isFiltered(filter)}
      <button
        class="c-link min-h-[2.75rem] px-2 text-sm"
        data-testid="notes-filter-clear"
        on:click={() =>
          setFilter({ book: null, series: null, colors: new Set(), unplacedOnly: false })}
      >
        Show all
      </button>
    {/if}
  </div>

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
    <p class="c-notice">
      Highlights this device couldn't find in its copy of the book (it checks when you open the
      book). They are kept as they were.
    </p>
  {/if}

  {#if loaded}
    {#if groups.length}
      <div class="flex flex-wrap items-center justify-between gap-2 pb-2 pt-1">
        <p class="text-sm text-c-muted" data-testid="notes-summary">
          {groups.length}
          {groups.length === 1 ? 'book' : 'books'} · {highlightTotal}
          {highlightTotal === 1 ? 'highlight' : 'highlights'} · {noteTotal}
          {noteTotal === 1 ? 'note' : 'notes'}
        </p>
        <button
          type="button"
          class="c-link min-h-[2.75rem] px-2 text-sm"
          data-testid="notes-expand-all"
          on:click={() =>
            setOpen(
              groups.map((g) => g.info.id),
              !allOpen
            )}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <NotesList
        groups={visible}
        collapsible
        {openBooks}
        on:toggle={(ev) => toggleBook(ev.detail.id)}
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
          class="c-btn c-btn-secondary mt-3 w-full"
          data-testid="notes-load-more"
          on:click={() => (shown += PAGE_BOOKS)}
        >
          Load more ({groups.length - shown} more {groups.length - shown === 1 ? 'book' : 'books'})
        </button>
      {/if}
    {:else if isFiltered(filter)}
      <p class="py-6 text-c-muted" data-testid="notes-empty">Nothing matches these filters.</p>
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
</style>
