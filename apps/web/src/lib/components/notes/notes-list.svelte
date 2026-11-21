<script lang="ts">
  /**
   * WP11c: highlights and notes grouped by book, shared by the Notes page and the Library's
   * series "Highlights" section. Recolor, edit note and remove (with Undo until the next
   * action) write to the local mirror; opening a book is the parent's (it knows how).
   *
   * WP19d: cards with the highlight's color on their edge (not over the text), date and
   * time, a tap on the card opens the book there, and the rest in a ⋮ menu. On the Notes
   * page (`collapsible`) each book is one row until opened; which ones are open is the
   * parent's (`openBooks`, `toggle`). Plain for e-ink: no transitions, 44-48 px controls,
   * black edges with the color's underline mark.
   *
   * Notes at scale (2026-11-21): the cards are their own components (highlight-card,
   * book-note-card; shared with the Highlights view), an opened book shows 20 items at a
   * time ("‹ 1–20 of 340 ›"), and the search's words are marked.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import Fa from 'svelte-fa';
  import {
    faChevronDown,
    faChevronRight,
    faEllipsisVertical
  } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import PagedList from '$lib/components/paged-list.svelte';
  import BookNoteCard from '$lib/components/notes/book-note-card.svelte';
  import HighlightCard from '$lib/components/notes/highlight-card.svelte';
  import NotesListStatus from '$lib/components/notes/notes-list-status.svelte';
  import { pagePath } from '$lib/data/env';
  import { downloadBlob } from '$lib/functions/download-blob';
  import type { HighlightItem, NoteItem } from '$lib/notes/highlights';
  import { notesCsvBlob, notesCsvFileName } from '$lib/notes/notes-csv';
  import { formatDate } from '$lib/notes/notes-format';
  import {
    groupCounts,
    NOTES_IN_BOOK_PER_PAGE,
    seriesLine,
    type NotesBookGroup,
    type NotesBookInfo,
    type NotesHighlightRow
  } from '$lib/notes/notes-view';
  import { createNotesListState, type NotesListActions } from './notes-list-state';

  export let groups: NotesBookGroup[];
  export let eink = false;
  export let actions: NotesListActions;
  /** Shown above each book (off when the list is about one book only). */
  export let bookHeadings = true;
  /** WP19d: each book is a row that opens (the Notes page). */
  export let collapsible = false;
  /** WP19d: the books shown open when `collapsible`. */
  export let openBooks: ReadonlySet<string> = new Set();
  /** Folded search words to mark (and to start each book's items on their first page). */
  export let words: readonly string[] = [];

  const dispatch = createEventDispatcher<{
    open: { book: NotesBookInfo; highlight: HighlightItem | null };
    toggle: { id: string };
  }>();
  const dotsButton = 'c-btn c-btn-ghost h-11 min-h-0 w-11 p-0';
  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left text-sm';
  const list = createNotesListState(() => actions);

  type Entry =
    | { key: string; row: NotesHighlightRow; note: null }
    | { key: string; row: null; note: NoteItem };

  $: searchKey = words.join(' ');

  function isOpen(id: string, open: ReadonlySet<string>, canCollapse: boolean) {
    return !canCollapse || open.has(id);
  }

  function entriesOf(group: NotesBookGroup): Entry[] {
    return [
      ...group.highlights.map((row) => ({ key: row.item.id, row, note: null })),
      ...group.notes.map((note) => ({ key: note.id, row: null, note }))
    ];
  }

  /** The "Notes about this book" heading goes before the first book note of a page. */
  function startsNotes(entries: Entry[], i: number) {
    return !!entries[i].note && (i === 0 || !entries[i - 1].note);
  }

  function bookLine(book: NotesBookInfo) {
    return [(book.authors ?? []).join(', '), seriesLine(book)].filter(Boolean).join(' · ');
  }

  function countLine(group: NotesBookGroup) {
    const { highlights: h, notes: n } = groupCounts(group);
    const shown = group.highlights.length + group.notes.length;
    return [
      group.hit === 'items' ? `${shown} of ${group.total} match` : '',
      `${h} ${h === 1 ? 'highlight' : 'highlights'}`,
      n ? `${n} ${n === 1 ? 'note' : 'notes'}` : '',
      formatDate(group.lastChange)
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** After paging inside a book, its top (the row and the first card) back in view. */
  async function keepBookInView(id: string) {
    await tick();
    const section = [...document.querySelectorAll<HTMLElement>('[data-notes-book]')].find(
      (el) => el.dataset.notesBook === id
    );
    if (section && section.getBoundingClientRect().top < 64) {
      section.scrollIntoView({ block: 'start' });
    }
  }

  function detailsHref(book: NotesBookInfo) {
    return book.unknown ? '' : `${pagePath}/library/book?id=${encodeURIComponent(book.id)}`;
  }

  function exportBook(group: NotesBookGroup) {
    downloadBlob(notesCsvBlob([group]), notesCsvFileName(new Date(), group.info.title));
  }
</script>

<NotesListStatus {list} />

{#each groups as group (group.info.id)}
  <section
    class="c-notes-book mb-3 rounded"
    data-testid="notes-book"
    data-notes-book={group.info.id}
  >
    {#if bookHeadings}
      <div class="flex items-center gap-1 p-1 sm:pr-2">
        {#if collapsible}
          <h3 class="min-w-0 flex-1">
            <button
              type="button"
              class="c-notes-head flex w-full min-w-0 items-center gap-3 rounded p-2 text-left"
              aria-expanded={isOpen(group.info.id, openBooks, collapsible)}
              data-testid="notes-book-toggle"
              on:click={() => dispatch('toggle', { id: group.info.id })}
            >
              {#if group.info.thumbnail}
                <img
                  src={group.info.thumbnail}
                  alt=""
                  loading="lazy"
                  class="c-notes-thumb h-14 w-10 shrink-0 rounded-sm object-cover"
                />
              {:else}
                <span
                  class="c-notes-thumb flex h-14 w-10 shrink-0 items-center justify-center rounded-sm font-mincho text-lg"
                  aria-hidden="true">書</span
                >
              {/if}
              <span class="flex min-w-0 flex-1 flex-col">
                <span
                  class="truncate font-mincho text-lg font-bold leading-snug"
                  data-testid="notes-book-title">{group.info.title}</span
                >
                {#if bookLine(group.info)}
                  <span class="truncate text-sm text-c-muted">{bookLine(group.info)}</span>
                {/if}
                <span class="text-xs text-c-muted" data-testid="notes-book-counts">
                  {countLine(group)}
                </span>
              </span>
              <span class="shrink-0 px-1 text-c-muted" aria-hidden="true">
                <Fa
                  icon={isOpen(group.info.id, openBooks, collapsible)
                    ? faChevronDown
                    : faChevronRight}
                />
              </span>
            </button>
          </h3>
        {:else}
          <div class="min-w-0 flex-1 p-2">
            <h3 class="font-mincho text-lg font-bold" data-testid="notes-book-title">
              {group.info.title}
            </h3>
            {#if bookLine(group.info)}
              <p class="text-sm text-c-muted">{bookLine(group.info)}</p>
            {/if}
          </div>
        {/if}
        <DropdownMenu
          buttonClass={dotsButton}
          align="right"
          label="Book: {group.info.title}"
          testid="notes-book-menu"
          panelWidth="w-56"
          floating
          let:close
        >
          <span slot="button" class="flex items-center justify-center" title="More">
            <Fa icon={faEllipsisVertical} />
            <span class="sr-only">More: {group.info.title}</span>
          </span>
          <div class="flex flex-col gap-1">
            <button
              type="button"
              class="c-btn c-btn-primary w-full justify-start px-3 text-sm"
              data-testid="notes-open-book"
              on:click={() => {
                close();
                dispatch('open', { book: group.info, highlight: null });
              }}
            >
              Open book
            </button>
            {#if detailsHref(group.info)}
              <a
                class={menuItem}
                href={detailsHref(group.info)}
                data-testid="notes-book-details"
                on:click={close}
              >
                Details
              </a>
            {/if}
            <button
              type="button"
              class={menuItem}
              data-testid="notes-book-export"
              on:click={() => {
                close();
                exportBook(group);
              }}
            >
              Export CSV
            </button>
          </div>
        </DropdownMenu>
      </div>
    {/if}

    {#if isOpen(group.info.id, openBooks, collapsible)}
      <div class="flex flex-col gap-2 px-3 pb-3" class:pt-3={!bookHeadings}>
        <PagedList
          items={entriesOf(group)}
          size={NOTES_IN_BOOK_PER_PAGE}
          resetKey={searchKey}
          label="Highlights in {group.info.title}"
          testid="notes-book-pager"
          on:page={() => keepBookInView(group.info.id)}
          let:pageItems
        >
          {#each pageItems as entry, i (entry.key)}
            {#if entry.row}
              <HighlightCard
                item={entry.row.item}
                unplaced={entry.row.unplaced}
                book={group.info}
                {list}
                {eink}
                {words}
                on:open={() =>
                  entry.row && dispatch('open', { book: group.info, highlight: entry.row.item })}
              />
            {:else if entry.note}
              {#if startsNotes(pageItems, i)}
                <h4 class="mt-2 font-mincho font-bold">Notes about this book</h4>
              {/if}
              <BookNoteCard note={entry.note} book={group.info} {list} {words} />
            {/if}
          {/each}
        </PagedList>
      </div>
    {/if}
  </section>
{/each}

<style>
  .c-notes-book {
    scroll-margin-top: 4.5rem;
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-notes-thumb {
    background-color: var(--c-tint);
    border: var(--c-border-width) solid var(--c-line);
    color: var(--c-muted);
  }

  .c-notes-head {
    color: var(--c-ink);
    user-select: text;
  }

  .c-notes-head:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    .c-notes-head:hover {
      background-color: var(--c-tint);
    }
  }

  .c-notes-head:active {
    background-color: var(--c-sec-active);
  }

  :global(html.eink) .c-notes-head:hover {
    background-color: transparent;
  }

  :global(html.eink) .c-notes-head:active {
    background-color: #000;
    color: #fff;
  }
</style>
