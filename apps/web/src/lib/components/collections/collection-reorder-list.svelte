<script lang="ts">
  /**
   * Reordering a list (WP8b). Every row has ↑ and ↓ and a "⋯" (Move to top, Move to
   * bottom, Remove), so it works on touch screens and e-ink without dragging. With a
   * mouse, rows can also be dragged by their handle (sortablejs, no animation). Alt+↑ /
   * Alt+↓ move the focused row. The page saves each move; this list only reports them.
   */
  import CoverImage from '$lib/components/library/cover-image.svelte';
  import type { CatalogBook } from '$lib/library/types';
  import {
    faArrowDown,
    faArrowUp,
    faEllipsisVertical,
    faGripVertical
  } from '@fortawesome/free-solid-svg-icons';
  import type Sortable from 'sortablejs';
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import Fa from 'svelte-fa';

  export let books: CatalogBook[];
  export let thumbnailUrl: (book: CatalogBook) => string;
  export let blurred: (book: CatalogBook) => boolean;
  /** No moves while one is being saved. */
  export let busy = false;

  const dispatch = createEventDispatcher<{
    move: { book: CatalogBook; delta: -1 | 1 };
    drop: { book: CatalogBook; index: number };
    more: CatalogBook;
  }>();
  const iconButton =
    'flex h-12 w-12 shrink-0 items-center justify-center rounded border-2 border-current disabled:opacity-40';

  let list: HTMLElement | undefined;
  let sortable: Sortable | null = null;
  let canDrag = false;

  onMount(async () => {
    canDrag = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    if (!canDrag || !list) return;
    await tick();
    const { default: SortableJs } = await import('sortablejs');
    if (!list) return;
    sortable = SortableJs.create(list, {
      handle: '[data-drag-handle]',
      animation: 0,
      ghostClass: 'opacity-40',
      onEnd(evt) {
        const { oldIndex, newIndex, item, from } = evt;
        if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
        // Put the row back: Svelte owns the DOM; the page re-renders the new order.
        from.insertBefore(item, from.children[oldIndex + (oldIndex > newIndex ? 1 : 0)] ?? null);
        const book = books[oldIndex];
        if (book) dispatch('drop', { book, index: newIndex });
      }
    });
  });

  onDestroy(() => sortable?.destroy());

  /**
   * The row moved with the keyboard: moving a row in the DOM takes the focus away, so it
   * is put back each time the list is redrawn (until the user focuses something else).
   */
  let refocusId: string | null = null;
  $: if (books && refocusId) void restoreFocus(refocusId);

  async function restoreFocus(id: string) {
    await tick();
    const el = list?.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`);
    if (el && document.activeElement !== el) el.focus();
  }

  function onFocusIn(ev: FocusEvent) {
    const id = (ev.target as HTMLElement | null)?.getAttribute?.('data-reorder-id');
    if (refocusId && id !== refocusId) refocusId = null;
  }

  function onRowKeydown(ev: KeyboardEvent, book: CatalogBook, index: number) {
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    const delta = ev.key === 'ArrowUp' ? -1 : 1;
    if (busy || index + delta < 0 || index + delta >= books.length) return;
    refocusId = book.id;
    dispatch('move', { book, delta });
  }
</script>

<ol
  bind:this={list}
  data-testid="reorder-list"
  on:focusin={onFocusIn}
  on:pointerdown={() => (refocusId = null)}
>
  {#each books as book, i (book.id)}
    <!-- Focusable so Alt+Up/Down can move the row (the buttons do the same). -->
    <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
    <li
      class="flex items-center gap-2 border-b border-gray-400/40 py-2 outline-offset-2"
      tabindex="0"
      data-reorder-id={book.id}
      data-testid="reorder-row"
      aria-label="{i + 1}. {book.title}"
      on:keydown={(ev) => onRowKeydown(ev, book, i)}
    >
      {#if canDrag}
        <span
          class="flex h-12 w-8 shrink-0 cursor-grab items-center justify-center"
          title="Drag to move"
          data-drag-handle
        >
          <Fa icon={faGripVertical} />
        </span>
      {/if}
      <span class="w-8 shrink-0 text-right text-sm opacity-75">{i + 1}</span>
      <div class="h-[60px] w-10 shrink-0">
        <CoverImage src={thumbnailUrl(book)} blurred={blurred(book)} compact />
      </div>
      <div class="min-w-0 grow">
        <div class="line-clamp-2 font-medium">{book.title}</div>
        <div class="truncate text-sm opacity-75">
          {book.authors.map((a) => a.name).join(', ')}
        </div>
      </div>
      <button
        class={iconButton}
        title="Move up"
        aria-label="Move up: {book.title}"
        disabled={busy || i === 0}
        data-testid="reorder-up"
        on:click={() => dispatch('move', { book, delta: -1 })}
      >
        <Fa icon={faArrowUp} />
      </button>
      <button
        class={iconButton}
        title="Move down"
        aria-label="Move down: {book.title}"
        disabled={busy || i === books.length - 1}
        data-testid="reorder-down"
        on:click={() => dispatch('move', { book, delta: 1 })}
      >
        <Fa icon={faArrowDown} />
      </button>
      <button
        class="flex h-12 w-10 shrink-0 items-center justify-center"
        title="More"
        aria-label="More: {book.title}"
        disabled={busy}
        data-testid="reorder-more"
        on:click={() => dispatch('more', book)}
      >
        <Fa icon={faEllipsisVertical} />
      </button>
    </li>
  {/each}
</ol>
