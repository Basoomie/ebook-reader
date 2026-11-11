<script lang="ts">
  /**
   * WP11c: the "Highlights" section of a series page in the Library: every volume's
   * highlights and notes in series order, to recap before the next volume. Collapsed by
   * default (browsing a series stays quick); the count comes from the local mirror, book
   * details are looked up when it is opened. The same list as the Notes page.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import NotesList from '$lib/components/notes/notes-list.svelte';
  import { pagePath } from '$lib/data/env';
  import type { LibraryApi } from '$lib/library/api';
  import type { CatalogBook } from '$lib/library/types';
  import type { BookNotes, HighlightItem } from '$lib/notes/highlights';
  import {
    buildNotesView,
    EMPTY_FILTER,
    highlightCount,
    notesFilterQuery,
    unknownBookInfo,
    type NotesBookInfo
  } from '$lib/notes/notes-view';
  import { notesApi } from '$lib/sync/sync-service';

  export let api: LibraryApi | undefined;
  export let seriesName: string;
  /** The series' books in series order. */
  export let bookIds: readonly string[];
  export let eink = false;

  const dispatch = createEventDispatcher<{
    open: { book: CatalogBook; highlight: HighlightItem | null };
  }>();
  const notes = notesApi();

  let all = new Map<string, BookNotes>();
  let unplaced = new Set<string>();
  let catalog = new Map<string, CatalogBook>();
  let expanded = false;
  let loadError = '';
  let stop: (() => void) | undefined;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  $: inSeries = new Set(bookIds);
  $: mine = new Map([...all].filter(([id]) => inSeries.has(id)));
  $: count = highlightCount(mine, bookIds);
  $: info = new Map<string, NotesBookInfo>(
    [...mine.keys()].map((id) => {
      const book = catalog.get(id);
      return [
        id,
        book
          ? {
              id,
              title: book.title,
              series: book.series,
              charCount: book.charCount,
              authors: book.authors.map((a) => a.name),
              // A book the server didn't return (unknownCatalogBook): no details page.
              unknown: book.libraryId ? undefined : true
            }
          : unknownBookInfo(id)
      ];
    })
  );
  $: groups = buildNotesView(mine, info, unplaced, EMPTY_FILTER, { order: bookIds });
  $: notesHref = `${pagePath}/notes${notesFilterQuery({ ...EMPTY_FILTER, series: seriesName })}`;
  $: if (expanded && api && [...mine.keys()].some((id) => !catalog.has(id))) void lookup();

  onMount(async () => {
    await load();
    const off = await notes.onChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => !destroyed && void load(), 300);
    });
    if (destroyed) off();
    else stop = off;
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    stop?.();
  });

  async function load() {
    const [a, u] = await Promise.all([notes.all(), notes.unplaced()]);
    if (destroyed) return;
    all = a;
    unplaced = u;
  }

  let looking = false;

  async function lookup() {
    if (!api || looking) return;
    const missing = [...mine.keys()].filter((id) => !catalog.has(id));
    if (!missing.length) return;
    looking = true;
    try {
      const next = new Map(catalog);
      for (let i = 0; i < missing.length; i += 100) {
        for (const book of (await api.lookup(missing.slice(i, i + 100))).books) {
          next.set(book.id, book);
        }
      }
      // Books the server didn't return (hidden) stay "Unknown book"; don't ask again.
      for (const id of missing) if (!next.has(id)) next.set(id, unknownCatalogBook(id));
      if (!destroyed) catalog = next;
      loadError = '';
    } catch (error) {
      loadError = `Book details could not be loaded: ${(error as Error).message}`;
    } finally {
      looking = false;
    }
  }

  function unknownCatalogBook(id: string): CatalogBook {
    return {
      id,
      libraryId: '',
      title: 'Unknown book',
      authors: [],
      series: null,
      tags: [],
      addedAt: 0,
      charCount: null,
      missing: true,
      thumbnail: null
    };
  }

  function open(book: NotesBookInfo, highlight: HighlightItem | null) {
    const catalogBook = catalog.get(book.id);
    if (catalogBook) dispatch('open', { book: catalogBook, highlight });
  }
</script>

{#if count > 0 || mine.size > 0}
  <div class="mt-3" data-testid="series-highlights">
    <button
      class="c-btn c-btn-secondary"
      aria-expanded={expanded}
      data-testid="series-highlights-toggle"
      on:click={() => (expanded = !expanded)}
    >
      {expanded ? '▾' : '▸'} Highlights ({count})
    </button>
    {#if expanded}
      <div class="mt-2" data-testid="series-highlights-list">
        <a
          class="c-link inline-flex min-h-[3rem] items-center"
          href={notesHref}
          data-testid="series-highlights-notes-link"
        >
          Open on the Notes page
        </a>
        {#if loadError}
          <p class="c-notice" role="alert">{loadError}</p>
        {/if}
        <NotesList
          {groups}
          {eink}
          actions={{
            setColor: notes.setColor,
            saveNote: notes.saveNote,
            removeHighlight: notes.removeHighlight,
            removeNote: notes.removeNote
          }}
          on:open={(ev) => open(ev.detail.book, ev.detail.highlight)}
        />
      </div>
    {/if}
  </div>
{/if}
