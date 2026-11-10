<script lang="ts">
  /**
   * WP11a: this book's highlights and notes. Plain for e-ink like the search dialog: no
   * transitions, 48 px bordered controls, inert backdrop, Esc closes. Choosing an item
   * closes the panel and jumps there (recorded in the jump history, not saved). Notes are
   * written inline; removing offers Undo until the next action.
   *
   * WP11b: a Bookmarks tab (jump, rename, remove, add) and, while set, the return marker
   * ("Where you were reading") above both tabs.
   */
  import { createEventDispatcher } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { chapterLabelAt, type SectionLike } from '$lib/sync/position-prompt';
  import {
    HIGHLIGHT_COLOR_NAMES,
    HIGHLIGHT_COLORS,
    MAX_NOTE_BODY,
    type HighlightColor,
    type HighlightItem,
    type NoteItem
  } from '$lib/notes/highlights';
  import type { NoteTarget, Undo } from '$lib/notes/notes-service';
  import { EINK_UNDERLINES, HIGHLIGHT_SWATCHES } from './highlight-colors';
  import type { HighlightsView, NotesPanelAnswer } from './reader-highlights';
  import { MAX_BOOKMARK_NAME, type BookmarkItem } from '$lib/notes/bookmarks';

  export let view: Readable<HighlightsView>;
  export let bookId: string | null;
  export let total: number;
  export let sections: SectionLike[] = [];
  export let canPaint = true;
  export let eink = false;
  export let actions: {
    setColor(id: string, color: HighlightColor): Promise<void>;
    saveNote(target: NoteTarget, body: string): Promise<string | null>;
    removeHighlight(id: string): Promise<Undo>;
    removeNote(id: string): Promise<Undo>;
    renameBookmark(id: string, name: string): Promise<void>;
    removeBookmark(id: string): Promise<Undo>;
    clearReturnMarker(): void;
  };
  /** WP11b: where you were reading before jumping (reader position), if set. */
  export let returnMarker: number | null = null;
  export let initialTab: 'notes' | 'bookmarks' = 'notes';
  export let resolver: (answer: NotesPanelAnswer) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const smallButton =
    'flex min-h-[2.75rem] min-w-[2.75rem] items-center justify-center rounded border-2 border-current px-3 text-sm';

  let tab = initialTab;
  let marker = returnMarker;
  let colors = new Set<HighlightColor>();
  let editing: { key: string; target: NoteTarget; text: string } | undefined;
  let undo: { message: string; run: Undo } | undefined;
  let error = '';
  let busy = false;
  let done = false;

  $: highlights = $view.notes.highlights
    .filter((h) => !colors.size || colors.has(h.color))
    .map((h) => ({ item: h, place: $view.places.get(h.id) ?? null }))
    .sort((a, b) => (a.place ?? a.item.start) - (b.place ?? b.item.start));
  $: bookNotes = $view.notes.notes;
  $: empty = !$view.notes.highlights.length && !bookNotes.length;
  $: bookmarks = $view.bookmarks;

  function close(answer: Parameters<typeof resolver>[0]) {
    if (done) return;
    done = true;
    resolver(answer);
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (editing) editing = undefined;
      else close(null);
    }
  }

  function toggleColor(color: HighlightColor) {
    // The app compiles Svelte as immutable: only a new Set re-renders.
    const next = new Set(colors);
    if (next.has(color)) next.delete(color);
    else next.add(color);
    colors = next;
  }

  function place(position: number) {
    const parts: string[] = [];
    const chapter = chapterLabelAt(sections, position);
    if (chapter) parts.push(`「${chapter}」`);
    if (total > 0) parts.push(`${Math.min(100, (position / total) * 100).toFixed(1)}%`);
    return parts.join(' · ');
  }

  function swatch(color: HighlightColor) {
    return eink
      ? `text-decoration: underline ${EINK_UNDERLINES[color]} #000; text-decoration-thickness: 2px; text-underline-offset: 4px;`
      : `background-color: ${HIGHLIGHT_SWATCHES[color]};`;
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

  function setColor(item: HighlightItem, color: HighlightColor) {
    undo = undefined;
    act(() => actions.setColor(item.id, color));
  }

  function startRename(item: BookmarkItem) {
    undo = undefined;
    editing = { key: item.id, target: { bookId: item.bookId }, text: item.name };
  }

  function saveRename(item: BookmarkItem) {
    const current = editing;
    if (!current) return;
    const name = current.text.trim();
    if (!name) {
      error = 'A bookmark needs a name.';
      return;
    }
    if (Array.from(name).length > MAX_BOOKMARK_NAME) {
      error = `A bookmark name can be at most ${MAX_BOOKMARK_NAME} characters.`;
      return;
    }
    act(async () => {
      await actions.renameBookmark(item.id, name);
      editing = undefined;
    });
  }

  function removeBookmark(item: BookmarkItem) {
    act(async () => {
      const run = await actions.removeBookmark(item.id);
      undo = { message: 'Bookmark removed.', run };
    });
  }

  function clearMarker() {
    actions.clearReturnMarker();
    marker = null;
  }

  function showTab(next: 'notes' | 'bookmarks') {
    tab = next;
    editing = undefined;
    undo = undefined;
    error = '';
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 flex max-h-[85vh] w-[44rem] max-w-full flex-col rounded bg-white p-6"
  data-testid="notes-panel"
>
  <h2 class="weight-medium mb-3 text-xl">Notes in this book</h2>

  {#if marker !== null}
    <div
      class="mb-3 flex flex-wrap items-center gap-2 border-b border-gray-400 pb-3"
      data-testid="notes-return-marker"
    >
      <span class="flex-1">Where you were reading: {place(marker)}</span>
      <button
        class={smallButton}
        data-testid="notes-return"
        on:click={() => close({ kind: 'return' })}
      >
        Return
      </button>
      <button
        class={smallButton}
        aria-label="Forget where you were reading"
        title="Forget where you were reading"
        data-testid="notes-return-clear"
        on:click={clearMarker}
      >
        ✕
      </button>
    </div>
  {/if}

  {#if !bookId}
    <p class="mb-3">Highlights, notes and bookmarks need this book in the library.</p>
  {:else}
    <div class="mb-3 flex gap-2" role="tablist">
      <button
        class={smallButton}
        role="tab"
        aria-selected={tab === 'notes'}
        class:outline={tab === 'notes'}
        class:outline-4={tab === 'notes'}
        data-testid="notes-tab-notes"
        on:click={() => showTab('notes')}
      >
        Highlights and notes
      </button>
      <button
        class={smallButton}
        role="tab"
        aria-selected={tab === 'bookmarks'}
        class:outline={tab === 'bookmarks'}
        class:outline-4={tab === 'bookmarks'}
        data-testid="notes-tab-bookmarks"
        on:click={() => showTab('bookmarks')}
      >
        Bookmarks ({bookmarks.length})
      </button>
    </div>

    {#if undo}
      <p class="mb-2 flex items-center gap-3" role="status">
        {undo.message}
        <button class={smallButton} data-testid="notes-undo" on:click={runUndo}>Undo</button>
      </p>
    {/if}
    {#if error}
      <p class="mb-2 text-sm" role="alert">{error}</p>
    {/if}
  {/if}

  {#if bookId && tab === 'bookmarks'}
    <div class="flex">
      <button
        class="{smallButton} ml-auto"
        disabled={busy}
        data-testid="notes-add-bookmark"
        on:click={() => close({ kind: 'add-bookmark' })}
      >
        Add bookmark here
      </button>
    </div>
    <div class="mt-3 min-h-0 overflow-y-auto" data-testid="bookmarks-list">
      {#if !bookmarks.length}
        <p>
          No bookmarks yet. "Add bookmark here" (or K) keeps the page you are on under a name; it
          never moves your saved place.
        </p>
      {/if}
      {#each bookmarks as { item, place: at } (item.id)}
        <article class="border-t border-gray-400 py-2" data-testid="notes-bookmark">
          {#if editing?.key === item.id}
            <input
              bind:value={editing.text}
              aria-label="Bookmark name"
              class="min-h-[2.75rem] w-full rounded border-2 border-current px-2"
              data-testid="bookmark-rename-input"
            />
            <div class="mt-2 flex justify-end gap-2">
              <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
              <button
                class={smallButton}
                data-testid="bookmark-rename-save"
                on:click={() => saveRename(item)}
              >
                Save
              </button>
            </div>
          {:else}
            <button
              class="block min-h-[3rem] w-full text-left"
              data-testid="notes-bookmark-jump"
              on:click={() => close({ kind: 'jump', position: at ?? item.pos, highlightId: null })}
            >
              <span class="block font-medium">{item.name}</span>
              <span class="block text-sm">
                {place(at ?? item.pos)}
                {#if at === null}
                  · <b data-testid="bookmark-unplaced">Couldn't place in the current file</b>
                {/if}
              </span>
            </button>
          {/if}
          <div class="mt-2 flex gap-2">
            <button
              class={smallButton}
              disabled={busy}
              data-testid="bookmark-rename"
              on:click={() => startRename(item)}
            >
              Rename
            </button>
            <button
              class={smallButton}
              disabled={busy}
              data-testid="bookmark-remove"
              on:click={() => removeBookmark(item)}
            >
              Remove
            </button>
          </div>
        </article>
      {/each}
    </div>
  {:else if bookId}
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Show colors">
      {#each HIGHLIGHT_COLORS as color}
        <button
          class={smallButton}
          aria-pressed={colors.has(color)}
          class:outline={colors.has(color)}
          class:outline-4={colors.has(color)}
          title="Only {HIGHLIGHT_COLOR_NAMES[color]}"
          aria-label="Only {HIGHLIGHT_COLOR_NAMES[color]}"
          data-testid="notes-filter-{color}"
          on:click={() => toggleColor(color)}
        >
          <span class="block h-5 w-5 rounded-sm" style={swatch(color)}>{eink ? 'あ' : ''}</span>
        </button>
      {/each}
      <button
        class="{smallButton} ml-auto"
        disabled={busy}
        data-testid="notes-add-book-note"
        on:click={() => startNote('new', { bookId: bookId ?? '' }, '')}
      >
        Add note to this book
      </button>
    </div>

    {#if !canPaint}
      <p class="mt-2 text-sm">This browser can't show highlight colors on the page.</p>
    {/if}

    {#if editing?.key === 'new'}
      <div class="mt-3">
        <textarea
          bind:value={editing.text}
          rows="4"
          aria-label="Note about this book"
          class="w-full rounded border-2 border-current p-2"
          data-testid="notes-edit-text"
        />
        <div class="mt-2 flex justify-end gap-2">
          <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
          <button class={smallButton} data-testid="notes-edit-save" on:click={saveEditing}>
            Save
          </button>
        </div>
      </div>
    {/if}

    <div class="mt-3 min-h-0 overflow-y-auto" data-testid="notes-list">
      {#if empty && editing?.key !== 'new'}
        <p>No highlights yet. Long-press text (or select it with the mouse) to highlight it.</p>
      {/if}

      {#each highlights as { item, place: at } (item.id)}
        <article class="border-t border-gray-400 py-2" data-testid="notes-highlight">
          <button
            class="block min-h-[3rem] w-full text-left"
            data-testid="notes-highlight-jump"
            on:click={() =>
              close({ kind: 'jump', position: at ?? item.start, highlightId: item.id })}
          >
            <span class="block text-sm">
              {place(at ?? item.start)}
              {#if at === null}
                · <b data-testid="notes-unplaced">Couldn't place in the current file</b>
              {/if}
            </span>
            <span class="mt-1 block">
              <span class="px-0.5" style={swatch(item.color)}>{item.text}</span>
            </span>
          </button>
          {#if editing?.key === item.id}
            <textarea
              bind:value={editing.text}
              rows="4"
              aria-label="Note"
              class="mt-2 w-full rounded border-2 border-current p-2"
              data-testid="notes-edit-text"
            />
            <div class="mt-2 flex justify-end gap-2">
              <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
              <button class={smallButton} data-testid="notes-edit-save" on:click={saveEditing}>
                Save
              </button>
            </div>
          {:else if item.note}
            <p class="mt-1 whitespace-pre-wrap border-l-4 border-gray-500 pl-2 text-sm">
              {item.note.body}
            </p>
          {/if}
          <div class="mt-2 flex flex-wrap items-center gap-2">
            {#each HIGHLIGHT_COLORS as color}
              <button
                class={smallButton}
                aria-label={HIGHLIGHT_COLOR_NAMES[color]}
                title={HIGHLIGHT_COLOR_NAMES[color]}
                aria-pressed={item.color === color}
                disabled={busy}
                on:click={() => setColor(item, color)}
              >
                <span class="block h-4 w-4 rounded-sm" style={swatch(color)}
                  >{eink ? 'あ' : ''}</span
                >
              </button>
            {/each}
            <button
              class={smallButton}
              disabled={busy}
              data-testid="notes-edit-note"
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
              data-testid="notes-remove-highlight"
              on:click={() => removeHighlight(item)}
            >
              Remove
            </button>
          </div>
        </article>
      {/each}

      {#if bookNotes.length}
        <h3 class="mt-4 border-t border-gray-400 pt-3 font-medium">Notes about this book</h3>
        {#each bookNotes as note (note.id)}
          <article class="py-2" data-testid="notes-book-note">
            {#if note.quote}
              <p class="border-l-4 border-gray-500 pl-2 text-sm">{note.quote}</p>
            {/if}
            {#if editing?.key === note.id}
              <textarea
                bind:value={editing.text}
                rows="4"
                aria-label="Note"
                class="mt-2 w-full rounded border-2 border-current p-2"
                data-testid="notes-edit-text"
              />
              <div class="mt-2 flex justify-end gap-2">
                <button class={smallButton} on:click={() => (editing = undefined)}>Cancel</button>
                <button class={smallButton} data-testid="notes-edit-save" on:click={saveEditing}>
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
              <button class={smallButton} disabled={busy} on:click={() => removeNote(note)}>
                Remove
              </button>
            </div>
          </article>
        {/each}
      {/if}
    </div>
  {/if}

  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => close(null)}>Close</button>
  </footer>
</section>
