<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: a note about a book (or one whose highlight is gone) as a card with a gold
   * edge and ⋮ (Edit note, Delete note). Moved out of notes-list.svelte (Notes at scale,
   * 2026-11-21); in the Highlights view it shows the book's title and opens the book.
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import MarkedText from '$lib/components/notes/marked-text.svelte';
  import NoteEditor from '$lib/components/notes/note-editor.svelte';
  import type { NoteItem } from '$lib/notes/highlights';
  import { formatWhen } from '$lib/notes/notes-format';
  import { cardBookLine, type NotesBookInfo } from '$lib/notes/notes-view';
  import type { NotesListState } from './notes-list-state';

  export let note: NoteItem;
  export let book: NotesBookInfo;
  export let list: NotesListState;
  export let words: readonly string[] = [];
  /** The book's title on the card, and a tap opens the book (the Highlights view). */
  export let showBook = false;

  const dispatch = createEventDispatcher<{ open: void }>();
  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left text-sm';
  const dotsButton = 'c-btn c-btn-ghost h-11 min-h-0 w-11 p-0';

  $: editing = $list.editing?.key === note.id;
</script>

<article class="c-hl-card c-book-note rounded" data-testid="notes-page-book-note">
  <div class="flex items-start">
    {#if showBook}
      <button
        type="button"
        class="c-note-open min-w-0 flex-1 rounded-r py-3 pl-4 pr-1 text-left"
        title="Open book"
        data-testid="notes-page-book-note-open"
        on:click={() => dispatch('open')}
      >
        <span
          class="mb-1 block truncate font-mincho text-sm font-bold text-c-muted"
          data-testid="notes-card-book">{cardBookLine(book)} · Note about the book</span
        >
        {#if note.quote}
          <span class="c-quote block pl-2 font-mincho text-sm"
            ><MarkedText text={note.quote} {words} /></span
          >
        {/if}
        {#if !editing}
          <span class="mt-1 block whitespace-pre-wrap break-words"
            ><MarkedText text={note.body} {words} /></span
          >
        {/if}
        <span class="mt-2 block text-xs text-c-muted">{formatWhen(note.createdAt)}</span>
      </button>
    {:else}
      <div class="min-w-0 flex-1 py-3 pl-4 pr-1">
        {#if note.quote}
          <p class="c-quote pl-2 font-mincho text-sm"><MarkedText text={note.quote} {words} /></p>
        {/if}
        {#if !editing}
          <p class="mt-1 whitespace-pre-wrap break-words">
            <MarkedText text={note.body} {words} />
          </p>
        {/if}
        <p class="mt-2 text-xs text-c-muted">{formatWhen(note.createdAt)}</p>
      </div>
    {/if}
    <div class="shrink-0 p-1">
      <DropdownMenu
        buttonClass={dotsButton}
        align="right"
        label="Note"
        testid="notes-page-note-menu"
        panelWidth="w-48"
        floating
        let:close
      >
        <span slot="button" class="flex items-center justify-center" title="More">
          <Fa icon={faEllipsisVertical} />
          <span class="sr-only">More</span>
        </span>
        <div class="flex flex-col gap-1">
          <button
            type="button"
            class={menuItem}
            disabled={$list.busy}
            data-testid="notes-page-book-note-edit"
            on:click={() => {
              close();
              list.startNote(note.id, { bookId: note.bookId, noteId: note.id }, note.body);
            }}
          >
            Edit note
          </button>
          <button
            type="button"
            class="{menuItem} c-danger"
            disabled={$list.busy}
            data-testid="notes-page-remove-note"
            on:click={() => {
              close();
              list.removeNote(note);
            }}
          >
            Delete note
          </button>
        </div>
      </DropdownMenu>
    </div>
  </div>
  {#if editing && $list.editing}
    <NoteEditor
      initial={$list.editing.text}
      on:cancel={() => list.cancelEdit()}
      on:save={(e) => list.saveNote(e.detail)}
    />
  {/if}
</article>

<style>
  .c-hl-card {
    background-color: var(--c-bg);
    border: var(--c-border-width) solid var(--c-line);
    border-left-width: 5px;
  }

  .c-book-note {
    border-left-color: var(--c-gold);
  }

  .c-quote {
    border-left: 4px solid var(--c-gold);
  }

  .c-note-open {
    color: var(--c-ink);
    user-select: text;
  }

  .c-note-open:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    :global(html:not(.eink)) .c-note-open:hover {
      background-color: var(--c-tint);
    }
  }

  .c-danger {
    color: var(--c-seal);
  }

  :global(html.eink) .c-hl-card {
    border-left-color: #000 !important;
  }
</style>
