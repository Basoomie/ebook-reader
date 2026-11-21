<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: a note about a book (or one whose highlight is gone) as a card with a gold
   * edge and ⋮ (Copy note, Edit note, Delete note). Moved out of notes-list.svelte (Notes at
   * scale, 2026-11-21); in the Highlights view it shows the book's title and "Open ›" at the
   * end of the date line (the text itself stays selectable). Copy note says "Copied ✓" in
   * the menu until it closes.
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import { faChevronRight, faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import MarkedText from '$lib/components/notes/marked-text.svelte';
  import NoteEditor from '$lib/components/notes/note-editor.svelte';
  import type { NoteItem } from '$lib/notes/highlights';
  import { formatWhen } from '$lib/notes/notes-format';
  import { cardBookLine, type NotesBookInfo } from '$lib/notes/notes-view';
  import { copyText } from '$lib/functions/copy-text';
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

  let copied: '' | 'note' | 'failed' = '';
  let menuOpen = false;

  $: if (!menuOpen) copied = '';
  $: editing = $list.editing?.key === note.id;

  async function copy() {
    copied = (await copyText(note.body)) ? 'note' : 'failed';
  }
</script>

<article class="c-hl-card c-book-note rounded" data-testid="notes-page-book-note">
  <div class="flex items-start">
    <div class="c-note-body min-w-0 flex-1 py-3 pl-4 pr-1">
      {#if showBook}
        <p
          class="mb-1 truncate font-mincho text-sm font-bold text-c-muted"
          data-testid="notes-card-book"
        >
          {cardBookLine(book)} · Note about the book
        </p>
      {/if}
      {#if note.quote}
        <p class="c-quote pl-2 font-mincho text-sm"><MarkedText text={note.quote} {words} /></p>
      {/if}
      {#if !editing}
        <p class="mt-1 whitespace-pre-wrap break-words"><MarkedText text={note.body} {words} /></p>
      {/if}
      <div class="mt-2 flex items-center gap-2">
        <p class="min-w-0 flex-1 text-xs text-c-muted">{formatWhen(note.createdAt)}</p>
        {#if showBook}
          <button
            type="button"
            class="c-open -my-3 inline-flex min-h-[2.75rem] shrink-0 items-center gap-1 rounded px-2 text-xs font-medium"
            title="Open book"
            aria-label="Open book"
            data-testid="notes-page-book-note-open"
            on:click={() => dispatch('open')}
          >
            Open <Fa icon={faChevronRight} size="xs" />
          </button>
        {/if}
      </div>
    </div>
    <div class="shrink-0 p-1">
      <DropdownMenu
        buttonClass={dotsButton}
        align="right"
        label="Note"
        testid="notes-page-note-menu"
        panelWidth="w-48"
        floating
        bind:open={menuOpen}
        let:close
      >
        <span slot="button" class="flex items-center justify-center" title="More">
          <Fa icon={faEllipsisVertical} />
          <span class="sr-only">More</span>
        </span>
        <div class="flex flex-col gap-1">
          <button type="button" class={menuItem} data-testid="notes-page-copy-note" on:click={copy}>
            <span aria-live="polite">{copied === 'note' ? 'Copied ✓' : 'Copy note'}</span>
          </button>
          {#if copied === 'failed'}
            <p class="px-3 text-xs text-c-muted" role="alert" data-testid="notes-copy-failed">
              This browser didn't allow copying: select the text and copy it.
            </p>
          {/if}
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

  .c-note-body {
    color: var(--c-ink);
    user-select: text;
  }

  .c-open {
    color: var(--c-link);
  }

  .c-open:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    :global(html:not(.eink)) .c-open:hover {
      background-color: var(--c-tint);
    }
  }

  :global(html.eink) .c-open {
    color: #000;
    text-decoration: underline;
  }

  .c-danger {
    color: var(--c-seal);
  }

  :global(html.eink) .c-hl-card {
    border-left-color: #000 !important;
  }
</style>
