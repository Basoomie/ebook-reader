<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Notes at scale (2026-11-21): the Notes page's Highlights view, one page of highlight
   * and book-note cards across all books (lib/notes/notes-view.ts `flattenNotesView`),
   * each with its book's title. The same cards, ⋮ menu and Undo as the Books view.
   */
  import { createEventDispatcher } from 'svelte';
  import BookNoteCard from '$lib/components/notes/book-note-card.svelte';
  import HighlightCard from '$lib/components/notes/highlight-card.svelte';
  import NotesListStatus from '$lib/components/notes/notes-list-status.svelte';
  import type { HighlightItem } from '$lib/notes/highlights';
  import type { NotesBookInfo, NotesFlatRow } from '$lib/notes/notes-view';
  import { createNotesListState, type NotesListActions } from './notes-list-state';

  export let rows: NotesFlatRow[];
  export let eink = false;
  export let actions: NotesListActions;
  export let words: readonly string[] = [];

  const dispatch = createEventDispatcher<{
    open: { book: NotesBookInfo; highlight: HighlightItem | null };
  }>();
  const list = createNotesListState(() => actions);
</script>

<NotesListStatus {list} />

<div class="flex flex-col gap-2" data-testid="notes-flat-list">
  {#each rows as row (row.key)}
    {#if row.highlight}
      <HighlightCard
        item={row.highlight.item}
        unplaced={row.highlight.unplaced}
        book={row.book}
        {list}
        {eink}
        {words}
        showBook
        on:open={() =>
          row.highlight && dispatch('open', { book: row.book, highlight: row.highlight.item })}
      />
    {:else if row.note}
      <BookNoteCard
        note={row.note}
        book={row.book}
        {list}
        {words}
        showBook
        on:open={() => dispatch('open', { book: row.book, highlight: null })}
      />
    {/if}
  {/each}
</div>
