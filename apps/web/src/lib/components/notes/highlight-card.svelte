<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: one highlight as a card, its color on the left edge (E-ink: black, with the
   * color's underline mark); the rest is in the ⋮ menu. Moved out of notes-list.svelte
   * (Notes at scale, 2026-11-21) so the Highlights view uses the same card, with the book's
   * title on it (`showBook`) and the search's words marked.
   *
   * 2026-11-21 (user): the text is plain, selectable text (a whole-card button opened the
   * book when text was selected to copy it); the book opens from the › button, and ⋮ has
   * Copy text (and Copy note).
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import {
    faChevronRight,
    faEllipsisVertical,
    faNoteSticky
  } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import ColorDot from '$lib/components/notes/color-dot.svelte';
  import MarkedText from '$lib/components/notes/marked-text.svelte';
  import NoteEditor from '$lib/components/notes/note-editor.svelte';
  import QuoteImageDialog from '$lib/components/notes/quote-image-dialog.svelte';
  import { dialogManager } from '$lib/data/dialog-manager';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    type HighlightItem
  } from '$lib/notes/highlights';
  import { formatWhen } from '$lib/notes/notes-format';
  import { cardBookLine, percentOf, type NotesBookInfo } from '$lib/notes/notes-view';
  import { HIGHLIGHT_SOLIDS, swatchStyle } from '$lib/notes/swatch';
  import type { NotesListState } from './notes-list-state';

  export let item: HighlightItem;
  export let unplaced = false;
  export let book: NotesBookInfo;
  export let list: NotesListState;
  export let eink = false;
  /** Folded search words to mark. */
  export let words: readonly string[] = [];
  /** The book's title on the card (the Highlights view). */
  export let showBook = false;

  const dispatch = createEventDispatcher<{ open: void }>();
  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left text-sm';
  const dotsButton = 'c-btn c-btn-ghost h-11 min-h-0 w-11 p-0';

  $: editing = $list.editing?.key === item.id;
  $: edge = eink ? '#000' : HIGHLIGHT_SOLIDS[item.color];
  $: place = [
    item.chapter ? `「${item.chapter}」` : '',
    percentOf(item.start, book.charCount),
    formatWhen(item.createdAt)
  ]
    .filter(Boolean)
    .join(' · ');
  $: bookLine = cardBookLine(book);

  function openQuoteImage() {
    dialogManager.dialogs$.next([
      {
        component: QuoteImageDialog,
        props: {
          content: {
            text: item.text,
            note: item.note?.body ?? null,
            title: book.unknown ? '' : book.title,
            author: (book.authors ?? []).join(', '),
            color: item.color,
            coverUrl: book.thumbnail ?? null
          }
        }
      }
    ]);
  }
</script>

<article
  class="c-hl-card rounded"
  style="border-left-color: {edge}"
  data-testid="notes-page-highlight"
>
  <div class="flex items-start">
    <div class="c-hl-body flex min-w-0 flex-1 py-3 pl-4 pr-1">
      <span class="flex min-w-0 flex-1 flex-col">
        {#if showBook}
          <span
            class="mb-1 truncate font-mincho text-sm font-bold text-c-muted"
            data-testid="notes-card-book">{bookLine}</span
          >
        {/if}
        <span
          class="block whitespace-pre-wrap break-words font-mincho text-[1.05rem] leading-relaxed"
          data-testid="notes-page-text"><MarkedText text={item.text} {words} /></span
        >
        {#if item.note && !editing}
          <span
            class="c-hl-note mt-2 flex gap-2 rounded px-3 py-2 text-sm"
            data-testid="notes-page-note"
          >
            <span class="mt-0.5 shrink-0 text-c-muted" aria-hidden="true">
              <Fa icon={faNoteSticky} />
            </span>
            <span class="min-w-0 whitespace-pre-wrap break-words"
              ><MarkedText text={item.note.body} {words} /></span
            >
          </span>
        {/if}
        <span
          class="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-c-muted"
          data-testid="notes-page-place"
        >
          {#if eink}
            <span
              class="font-bold text-black"
              style={swatchStyle(item.color, true)}
              title={HIGHLIGHT_COLOR_NAMES[item.color]}>あ</span
            >
          {/if}
          <span><MarkedText text={place} {words} /></span>
          {#if unplaced}
            <b data-testid="notes-page-unplaced">· Not found in this copy of the book</b>
          {/if}
        </span>
      </span>
    </div>
    <div class="flex shrink-0 flex-col items-center p-1">
      <DropdownMenu
        buttonClass={dotsButton}
        align="right"
        label="Highlight"
        testid="notes-page-menu"
        panelWidth="w-60"
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
            data-testid="notes-page-copy"
            on:click={() => {
              close();
              list.copy(item.text);
            }}
          >
            Copy text
          </button>
          {#if item.note}
            <button
              type="button"
              class={menuItem}
              data-testid="notes-page-copy-note"
              on:click={() => {
                close();
                if (item.note) list.copy(item.note.body);
              }}
            >
              Copy note
            </button>
          {/if}
          <button
            type="button"
            class={menuItem}
            disabled={$list.busy}
            data-testid="notes-page-edit-note"
            on:click={() => {
              close();
              list.startNote(
                item.id,
                { bookId: item.bookId, highlight: item, noteId: item.note?.id },
                item.note?.body ?? ''
              );
            }}
          >
            {item.note ? 'Edit note' : 'Add note'}
          </button>
          <button
            type="button"
            class={menuItem}
            data-testid="notes-page-quote-image"
            on:click={() => {
              close();
              openQuoteImage();
            }}
          >
            Quote image
          </button>
          <div class="px-3 pt-1 text-xs font-medium text-c-muted">Color</div>
          <div class="flex items-center gap-0.5 px-1" role="group" aria-label="Color">
            {#each HIGHLIGHT_COLORS as color}
              <button
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-full"
                aria-label={HIGHLIGHT_COLOR_NAMES[color]}
                title={HIGHLIGHT_COLOR_NAMES[color]}
                aria-pressed={item.color === color}
                disabled={$list.busy}
                data-testid="notes-page-color-{color}"
                on:click={() => {
                  close();
                  list.setColor(item, color);
                }}
              >
                <ColorDot {color} {eink} size={26} picked={item.color === color} />
              </button>
            {/each}
          </div>
          <div class="my-1 border-t" style="border-color: var(--c-line)" />
          <button
            type="button"
            class="{menuItem} c-danger"
            disabled={$list.busy}
            data-testid="notes-page-remove"
            on:click={() => {
              close();
              list.removeHighlight(item);
            }}
          >
            Delete highlight
          </button>
        </div>
      </DropdownMenu>
      <button
        type="button"
        class="c-btn c-btn-ghost h-11 min-h-0 w-11 p-0 text-c-muted"
        title="Open in book"
        aria-label="Open in book"
        data-testid="notes-page-open"
        on:click={() => dispatch('open')}
      >
        <Fa icon={faChevronRight} />
      </button>
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

  .c-hl-note {
    background-color: var(--c-raised);
    border-left: 3px solid var(--c-gold);
  }

  .c-hl-body {
    color: var(--c-ink);
    user-select: text;
  }

  .c-danger {
    color: var(--c-seal);
  }

  :global(html.eink) .c-hl-card {
    border-left-color: #000 !important;
  }
</style>
