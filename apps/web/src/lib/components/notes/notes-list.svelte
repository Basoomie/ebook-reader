<script lang="ts">
  /**
   * WP11c: highlights and notes grouped by book, shared by the Notes page and the Library's
   * series "Highlights" section. Plain for e-ink: no transitions, 44-48 px bordered
   * controls. Recolor, edit note and remove (with Undo until the next action) write to
   * the local mirror; "Open in book" is the parent's (it knows how to open books).
   */
  import { createEventDispatcher } from 'svelte';
  import {
    EINK_UNDERLINES,
    HIGHLIGHT_SWATCHES
  } from '$lib/components/book-reader/highlight-colors';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    MAX_NOTE_BODY,
    type HighlightColor,
    type HighlightItem,
    type NoteItem
  } from '$lib/notes/highlights';
  import type { NoteTarget, Undo } from '$lib/notes/notes-service';
  import { percentOf, type NotesBookGroup, type NotesBookInfo } from '$lib/notes/notes-view';

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

  const dispatch = createEventDispatcher<{
    open: { book: NotesBookInfo; highlight: HighlightItem | null };
  }>();
  const smallButton =
    'flex min-h-[2.75rem] min-w-[2.75rem] items-center justify-center rounded border-2 border-current px-3 text-sm';

  let editing: { key: string; target: NoteTarget; text: string } | undefined;
  let undo: { message: string; run: Undo } | undefined;
  let error = '';
  let busy = false;

  function swatch(color: HighlightColor) {
    return eink
      ? `text-decoration: underline ${EINK_UNDERLINES[color]} #000; text-decoration-thickness: 2px; text-underline-offset: 4px;`
      : `background-color: ${HIGHLIGHT_SWATCHES[color]};`;
  }

  function placeLine(item: HighlightItem, book: NotesBookInfo) {
    return [
      item.chapter ? `「${item.chapter}」` : '',
      percentOf(item.start, book.charCount),
      new Date(item.createdAt).toLocaleDateString()
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function seriesLine(book: NotesBookInfo) {
    if (!book.series) return '';
    const index = book.series.index;
    return index === null ? book.series.name : `${book.series.name} #${index}`;
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
  <p class="sticky top-14 z-10 mb-2 flex items-center gap-3 bg-white py-1" role="status">
    {undo.message}
    <button class={smallButton} data-testid="notes-undo" on:click={runUndo}>Undo</button>
  </p>
{/if}
{#if error}
  <p class="mb-2 text-sm" role="alert">{error}</p>
{/if}

{#each groups as group (group.info.id)}
  <section class="border-t-2 border-gray-400/60 py-3" data-testid="notes-book">
    {#if bookHeadings}
      <div class="flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-1">
          <h3 class="font-medium" data-testid="notes-book-title">{group.info.title}</h3>
          {#if seriesLine(group.info)}
            <p class="text-sm">{seriesLine(group.info)}</p>
          {/if}
        </div>
        <button
          class={smallButton}
          data-testid="notes-open-book"
          on:click={() => dispatch('open', { book: group.info, highlight: null })}
        >
          Open book
        </button>
      </div>
    {/if}

    {#each group.highlights as { item, unplaced } (item.id)}
      <article class="border-t border-gray-300 py-2" data-testid="notes-page-highlight">
        <p class="text-sm">
          {placeLine(item, group.info)}
          {#if unplaced}
            · <b data-testid="notes-page-unplaced">Couldn't place in the current file</b>
          {/if}
        </p>
        <p class="mt-1">
          <span class="px-0.5" style={swatch(item.color)} data-testid="notes-page-text"
            >{item.text}</span
          >
        </p>
        {#if editing?.key === item.id}
          <textarea
            bind:value={editing.text}
            rows="4"
            aria-label="Note"
            class="mt-2 w-full rounded border-2 border-current p-2"
            data-testid="notes-page-edit-text"
          />
          <div class="mt-2 flex justify-end gap-2">
            <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
            <button class={smallButton} data-testid="notes-page-edit-save" on:click={saveEditing}>
              Save
            </button>
          </div>
        {:else if item.note}
          <p
            class="mt-1 whitespace-pre-wrap border-l-4 border-gray-500 pl-2 text-sm"
            data-testid="notes-page-note"
          >
            {item.note.body}
          </p>
        {/if}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            class={smallButton}
            data-testid="notes-page-open"
            on:click={() => dispatch('open', { book: group.info, highlight: item })}
          >
            Open in book
          </button>
          {#each HIGHLIGHT_COLORS as color}
            <button
              class={smallButton}
              aria-label={HIGHLIGHT_COLOR_NAMES[color]}
              title={HIGHLIGHT_COLOR_NAMES[color]}
              aria-pressed={item.color === color}
              class:outline={item.color === color}
              class:outline-2={item.color === color}
              disabled={busy}
              data-testid="notes-page-color-{color}"
              on:click={() => setColor(item, color)}
            >
              <span class="block h-4 w-4 rounded-sm" style={swatch(color)}>{eink ? 'あ' : ''}</span>
            </button>
          {/each}
          <button
            class={smallButton}
            disabled={busy}
            data-testid="notes-page-edit-note"
            on:click={() =>
              startNote(
                item.id,
                { bookId: item.bookId, highlight: item, noteId: item.note?.id },
                item.note?.body ?? ''
              )}
          >
            {item.note ? 'Edit note' : 'Add note'}
          </button>
          <button
            class={smallButton}
            disabled={busy}
            data-testid="notes-page-remove"
            on:click={() => removeHighlight(item)}
          >
            Remove
          </button>
        </div>
      </article>
    {/each}

    {#if group.notes.length}
      <h4 class="mt-2 border-t border-gray-300 pt-2 text-sm font-medium">Notes about this book</h4>
      {#each group.notes as note (note.id)}
        <article class="py-2" data-testid="notes-page-book-note">
          {#if note.quote}
            <p class="border-l-4 border-gray-500 pl-2 text-sm">{note.quote}</p>
          {/if}
          {#if editing?.key === note.id}
            <textarea
              bind:value={editing.text}
              rows="4"
              aria-label="Note"
              class="mt-2 w-full rounded border-2 border-current p-2"
              data-testid="notes-page-edit-text"
            />
            <div class="mt-2 flex justify-end gap-2">
              <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
              <button class={smallButton} data-testid="notes-page-edit-save" on:click={saveEditing}>
                Save
              </button>
            </div>
          {:else}
            <p class="mt-1 whitespace-pre-wrap">{note.body}</p>
          {/if}
          <div class="mt-2 flex gap-2">
            <button
              class={smallButton}
              disabled={busy}
              on:click={() =>
                startNote(note.id, { bookId: note.bookId, noteId: note.id }, note.body)}
            >
              Edit
            </button>
            <button
              class={smallButton}
              disabled={busy}
              data-testid="notes-page-remove-note"
              on:click={() => removeNote(note)}
            >
              Remove
            </button>
          </div>
        </article>
      {/each}
    {/if}
  </section>
{/each}
