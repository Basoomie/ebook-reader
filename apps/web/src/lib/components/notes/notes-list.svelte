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
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import {
    faChevronDown,
    faChevronRight,
    faEllipsisVertical,
    faNoteSticky
  } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import QuoteImageDialog from '$lib/components/notes/quote-image-dialog.svelte';
  import { dialogManager } from '$lib/data/dialog-manager';
  import ColorDot from '$lib/components/notes/color-dot.svelte';
  import { pagePath } from '$lib/data/env';
  import { downloadBlob } from '$lib/functions/download-blob';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    MAX_NOTE_BODY,
    type HighlightColor,
    type HighlightItem,
    type NoteItem
  } from '$lib/notes/highlights';
  import type { NoteTarget, Undo } from '$lib/notes/notes-service';
  import { notesCsvBlob, notesCsvFileName } from '$lib/notes/notes-csv';
  import { formatDate, formatWhen } from '$lib/notes/notes-format';
  import { percentOf, type NotesBookGroup, type NotesBookInfo } from '$lib/notes/notes-view';
  import { HIGHLIGHT_SOLIDS, swatchStyle } from '$lib/notes/swatch';

  export let groups: NotesBookGroup[];
  export let eink = false;
  export let actions: {
    setColor(id: string, color: HighlightColor): Promise<void>;
    saveNote(target: NoteTarget, body: string): Promise<string | null>;
    removeHighlight(id: string): Promise<Undo>;
    removeNote(id: string): Promise<Undo>;
  };
  /** Shown above each book (off when the list is about one book only). */
  export let bookHeadings = true;
  /** WP19d: each book is a row that opens (the Notes page). */
  export let collapsible = false;
  /** WP19d: the books shown open when `collapsible`. */
  export let openBooks: ReadonlySet<string> = new Set();

  const dispatch = createEventDispatcher<{
    open: { book: NotesBookInfo; highlight: HighlightItem | null };
    toggle: { id: string };
  }>();
  // WP19b: the catalogue buttons (light, dark, E-ink).
  const smallButton = 'c-btn c-btn-secondary min-h-[2.75rem] min-w-[2.75rem] px-3 text-sm';
  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left text-sm';
  const dotsButton = 'c-btn c-btn-ghost h-11 min-h-0 w-11 p-0';

  let editing: { key: string; target: NoteTarget; text: string } | undefined;
  let undo: { message: string; run: Undo } | undefined;
  let error = '';
  let busy = false;

  function isOpen(id: string, open: ReadonlySet<string>, canCollapse: boolean) {
    return !canCollapse || open.has(id);
  }

  function placeLine(item: HighlightItem, book: NotesBookInfo) {
    return [
      item.chapter ? `「${item.chapter}」` : '',
      percentOf(item.start, book.charCount),
      formatWhen(item.createdAt)
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function bookLine(book: NotesBookInfo) {
    const series = book.series
      ? book.series.index === null
        ? book.series.name
        : `${book.series.name} #${book.series.index}`
      : '';
    return [(book.authors ?? []).join(', '), series].filter(Boolean).join(' · ');
  }

  function countLine(group: NotesBookGroup) {
    const h = group.highlights.length;
    const n = group.notes.length + group.highlights.filter((r) => r.item.note).length;
    return [
      `${h} ${h === 1 ? 'highlight' : 'highlights'}`,
      n ? `${n} ${n === 1 ? 'note' : 'notes'}` : '',
      formatDate(group.lastChange)
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function detailsHref(book: NotesBookInfo) {
    return book.unknown ? '' : `${pagePath}/library/book?id=${encodeURIComponent(book.id)}`;
  }

  function exportBook(group: NotesBookGroup) {
    downloadBlob(notesCsvBlob([group]), notesCsvFileName(new Date(), group.info.title));
  }

  /** WP19d: the quote image dialog for one highlight. */
  function openQuoteImage(item: HighlightItem, book: NotesBookInfo) {
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

  function edgeColor(color: HighlightColor) {
    return eink ? '#000' : HIGHLIGHT_SOLIDS[color];
  }

  async function act(run: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await run();
    } catch (e) {
      error = (e as Error)?.message || 'Something went wrong.';
    } finally {
      busy = false;
    }
  }

  function startNote(key: string, target: NoteTarget, text: string) {
    undo = undefined;
    error = '';
    editing = { key, target, text };
  }

  function saveEditing() {
    const current = editing;
    if (!current) return;
    if (Array.from(current.text).length > MAX_NOTE_BODY) {
      error = `A note can be at most ${MAX_NOTE_BODY.toLocaleString()} characters.`;
      return;
    }
    act(async () => {
      await actions.saveNote(current.target, current.text);
      editing = undefined;
    });
  }

  function setColor(item: HighlightItem, color: HighlightColor) {
    undo = undefined;
    act(() => actions.setColor(item.id, color));
  }

  function removeHighlight(item: HighlightItem) {
    act(async () => {
      const run = await actions.removeHighlight(item.id);
      undo = { message: 'Highlight removed.', run };
    });
  }

  function removeNote(note: NoteItem) {
    act(async () => {
      const run = await actions.removeNote(note.id);
      undo = { message: 'Note removed.', run };
    });
  }

  function runUndo() {
    const current = undo;
    undo = undefined;
    if (current) act(current.run);
  }
</script>

{#if undo}
  <p class="c-notice sticky top-14 z-10 mb-2 flex items-center gap-3" role="status">
    {undo.message}
    <button class={smallButton} data-testid="notes-undo" on:click={runUndo}>Undo</button>
  </p>
{/if}
{#if error}
  <p class="mb-2 text-sm" role="alert">{error}</p>
{/if}

{#each groups as group (group.info.id)}
  <section class="c-notes-book mb-3 rounded" data-testid="notes-book">
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
        {#each group.highlights as { item, unplaced } (item.id)}
          <article
            class="c-hl-card rounded"
            style="border-left-color: {edgeColor(item.color)}"
            data-testid="notes-page-highlight"
          >
            <div class="flex items-start">
              <button
                type="button"
                class="c-hl-open flex min-w-0 flex-1 items-center gap-2 rounded-r py-3 pl-4 pr-1 text-left"
                title="Open in book"
                data-testid="notes-page-open"
                on:click={() => dispatch('open', { book: group.info, highlight: item })}
              >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span
                    class="block whitespace-pre-wrap break-words font-mincho text-[1.05rem] leading-relaxed"
                    data-testid="notes-page-text">{item.text}</span
                  >
                  {#if item.note && editing?.key !== item.id}
                    <span
                      class="c-hl-note mt-2 flex gap-2 rounded px-3 py-2 text-sm"
                      data-testid="notes-page-note"
                    >
                      <span class="mt-0.5 shrink-0 text-c-muted" aria-hidden="true">
                        <Fa icon={faNoteSticky} />
                      </span>
                      <span class="min-w-0 whitespace-pre-wrap break-words">{item.note.body}</span>
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
                    <span>{placeLine(item, group.info)}</span>
                    {#if unplaced}
                      <b data-testid="notes-page-unplaced">· Couldn't place in the current file</b>
                    {/if}
                  </span>
                </span>
                <span class="shrink-0 px-1 text-c-muted" aria-hidden="true">
                  <Fa icon={faChevronRight} />
                </span>
              </button>
              <div class="shrink-0 p-1">
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
                      disabled={busy}
                      data-testid="notes-page-edit-note"
                      on:click={() => {
                        close();
                        startNote(
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
                        openQuoteImage(item, group.info);
                      }}
                    >
                      Quote image
                    </button>
                    <div class="px-3 pt-1 text-xs font-medium text-c-muted">Colour</div>
                    <div class="flex items-center gap-0.5 px-1" role="group" aria-label="Colour">
                      {#each HIGHLIGHT_COLORS as color}
                        <button
                          type="button"
                          class="flex h-11 w-11 items-center justify-center rounded-full"
                          aria-label={HIGHLIGHT_COLOR_NAMES[color]}
                          title={HIGHLIGHT_COLOR_NAMES[color]}
                          aria-pressed={item.color === color}
                          disabled={busy}
                          data-testid="notes-page-color-{color}"
                          on:click={() => {
                            close();
                            setColor(item, color);
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
                      disabled={busy}
                      data-testid="notes-page-remove"
                      on:click={() => {
                        close();
                        removeHighlight(item);
                      }}
                    >
                      Delete highlight
                    </button>
                  </div>
                </DropdownMenu>
              </div>
            </div>
            {#if editing?.key === item.id}
              <div class="px-4 pb-3">
                <textarea
                  bind:value={editing.text}
                  rows="4"
                  aria-label="Note"
                  class="c-input w-full p-2"
                  data-testid="notes-page-edit-text"
                />
                <div class="mt-2 flex justify-end gap-2">
                  <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
                  <button
                    class="{smallButton} c-btn-primary"
                    data-testid="notes-page-edit-save"
                    on:click={saveEditing}
                  >
                    Save
                  </button>
                </div>
              </div>
            {/if}
          </article>
        {/each}

        {#if group.notes.length}
          <h4 class="mt-2 font-mincho font-bold">Notes about this book</h4>
          {#each group.notes as note (note.id)}
            <article class="c-hl-card c-book-note rounded" data-testid="notes-page-book-note">
              <div class="flex items-start">
                <div class="min-w-0 flex-1 py-3 pl-4 pr-1">
                  {#if note.quote}
                    <p class="c-quote pl-2 font-mincho text-sm">{note.quote}</p>
                  {/if}
                  {#if editing?.key !== note.id}
                    <p class="mt-1 whitespace-pre-wrap break-words">{note.body}</p>
                  {/if}
                  <p class="mt-2 text-xs text-c-muted">{formatWhen(note.createdAt)}</p>
                </div>
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
                        disabled={busy}
                        data-testid="notes-page-book-note-edit"
                        on:click={() => {
                          close();
                          startNote(note.id, { bookId: note.bookId, noteId: note.id }, note.body);
                        }}
                      >
                        Edit note
                      </button>
                      <button
                        type="button"
                        class="{menuItem} c-danger"
                        disabled={busy}
                        data-testid="notes-page-remove-note"
                        on:click={() => {
                          close();
                          removeNote(note);
                        }}
                      >
                        Delete note
                      </button>
                    </div>
                  </DropdownMenu>
                </div>
              </div>
              {#if editing?.key === note.id}
                <div class="px-4 pb-3">
                  <textarea
                    bind:value={editing.text}
                    rows="4"
                    aria-label="Note"
                    class="c-input w-full p-2"
                    data-testid="notes-page-edit-text"
                  />
                  <div class="mt-2 flex justify-end gap-2">
                    <button class={smallButton} on:click={() => (editing = undefined)}>
                      Cancel
                    </button>
                    <button
                      class="{smallButton} c-btn-primary"
                      data-testid="notes-page-edit-save"
                      on:click={saveEditing}
                    >
                      Save
                    </button>
                  </div>
                </div>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    {/if}
  </section>
{/each}

<style>
  .c-notes-book {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-notes-thumb {
    background-color: var(--c-tint);
    border: var(--c-border-width) solid var(--c-line);
    color: var(--c-muted);
  }

  /* A highlight or note: a card inside the book's panel, the color as its left edge. */
  .c-hl-card {
    background-color: var(--c-bg);
    border: var(--c-border-width) solid var(--c-line);
    border-left-width: 5px;
  }

  .c-book-note {
    border-left-color: var(--c-gold);
  }

  .c-hl-note {
    background-color: var(--c-raised);
    border-left: 3px solid var(--c-gold);
  }

  .c-quote {
    border-left: 4px solid var(--c-gold);
  }

  .c-hl-open,
  .c-notes-head {
    color: var(--c-ink);
    user-select: text;
  }

  .c-hl-open:focus-visible,
  .c-notes-head:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    .c-hl-open:hover,
    .c-notes-head:hover {
      background-color: var(--c-tint);
    }
  }

  .c-hl-open:active,
  .c-notes-head:active {
    background-color: var(--c-sec-active);
  }

  .c-danger {
    color: var(--c-seal);
  }

  :global(html.eink) .c-hl-card {
    border-left-color: #000 !important;
  }

  :global(html.eink) .c-hl-open:hover,
  :global(html.eink) .c-notes-head:hover {
    background-color: transparent;
  }

  :global(html.eink) .c-hl-open:active,
  :global(html.eink) .c-notes-head:active {
    background-color: #000;
    color: #fff;
  }
</style>
