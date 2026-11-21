<script lang="ts">
  /**
   * WP11a: this book's highlights and notes. Choosing an item closes the panel and jumps
   * there (recorded in the jump history, not saved). Notes are written inline; removing
   * offers Undo (WP19: until it is dismissed, the next removal or the panel closing; other
   * actions no longer clear it). ✕, Esc or a click outside close it, asking first when a
   * note or name being edited was changed (modal.svelte).
   *
   * Tabs (2026-11-21): Highlights, Bookmarks (WP11b: jump, rename, remove, add) and About
   * this book (notes about the whole book); the return marker ("Where you were reading")
   * shows above them while set.
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
  import UndoNotice from '$lib/components/confirm/undo-notice.svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';

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
  let tab: 'notes' | 'bookmarks' | 'about' = initialTab;
  let marker = returnMarker;
  let colors = new Set<HighlightColor>();
  let editing: { key: string; target: NoteTarget; text: string; original: string } | undefined;
  let undo: { message: string; run: Undo } | undefined;
  let error = '';
  let busy = false;
  let done = false;

  $: highlights = $view.notes.highlights
    .filter((h) => !colors.size || colors.has(h.color))
    .map((h) => ({ item: h, place: $view.places.get(h.id) ?? null }))
    .sort((a, b) => (a.place ?? a.item.start) - (b.place ?? b.item.start));
  $: bookNotes = $view.notes.notes;
  $: bookmarks = $view.bookmarks;
  /** A note or bookmark name being edited was changed: a close request asks first. */
  $: dirty = !done && !!editing && editing.text !== editing.original;

  function close(answer: Parameters<typeof resolver>[0]) {
    if (done) return;
    done = true;
    resolver(answer);
    dispatch('close');
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
    editing = { key, target, text, original: text };
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
    act(() => actions.setColor(item.id, color));
  }

  function startRename(item: BookmarkItem) {
    editing = {
      key: item.id,
      target: { bookId: item.bookId },
      text: item.name,
      original: item.name
    };
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

  function showTab(next: 'notes' | 'bookmarks' | 'about') {
    tab = next;
    editing = undefined;
    error = '';
  }
</script>

<Modal
  title="Notes in this book"
  size="lg"
  {dirty}
  testid="notes-panel"
  on:close={() => close(null)}
>
  <svelte:fragment slot="tabs">
    {#if bookId}
      <div class="c-modal-tabs" role="tablist">
        <button
          type="button"
          class="c-modal-tab"
          role="tab"
          aria-selected={tab === 'notes'}
          data-testid="notes-tab-notes"
          on:click={() => showTab('notes')}
        >
          Highlights <span class="c-count">{$view.notes.highlights.length}</span>
        </button>
        <button
          type="button"
          class="c-modal-tab"
          role="tab"
          aria-selected={tab === 'bookmarks'}
          data-testid="notes-tab-bookmarks"
          on:click={() => showTab('bookmarks')}
        >
          Bookmarks <span class="c-count">{bookmarks.length}</span>
        </button>
        <button
          type="button"
          class="c-modal-tab"
          role="tab"
          aria-selected={tab === 'about'}
          data-testid="notes-tab-about"
          on:click={() => showTab('about')}
        >
          About this book <span class="c-count">{bookNotes.length}</span>
        </button>
      </div>
    {/if}
  </svelte:fragment>

  {#if marker !== null || undo || error}
    <div class="grid gap-2 pt-3">
      {#if marker !== null}
        <div
          class="c-notice !my-0 flex flex-wrap items-center gap-2"
          data-testid="notes-return-marker"
        >
          <span class="min-w-[10rem] flex-1">
            Where you were reading: <b>{place(marker)}</b>
          </span>
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-sm"
            data-testid="notes-return"
            on:click={() => close({ kind: 'return' })}
          >
            Return there
          </button>
          <button
            type="button"
            class="c-btn c-btn-ghost c-btn-sm"
            aria-label="Forget where you were reading"
            title="Forget where you were reading"
            data-testid="notes-return-clear"
            on:click={clearMarker}
          >
            Forget
          </button>
        </div>
      {/if}
      {#if undo}
        <div class="c-notice !my-0">
          <UndoNotice
            message={undo.message}
            buttonClass="c-btn c-btn-secondary c-btn-sm"
            testid="notes-undo-notice"
            undoTestid="notes-undo"
            on:undo={runUndo}
            on:dismiss={() => (undo = undefined)}
          />
        </div>
      {/if}
      {#if error}
        <p class="c-modal-error" role="alert"><span aria-hidden="true">⚠</span>{error}</p>
      {/if}
    </div>
  {/if}

  {#if !bookId}
    <p class="py-4">Highlights, notes and bookmarks need this book in the library.</p>
  {:else if tab === 'bookmarks'}
    <ModalSection
      title="Bookmarks"
      hint="A bookmark keeps a page under a name. It never moves your saved place."
    >
      <svelte:fragment slot="aside">
        <button
          type="button"
          class="c-btn c-btn-primary c-btn-sm"
          disabled={busy}
          data-testid="notes-add-bookmark"
          on:click={() => close({ kind: 'add-bookmark' })}
        >
          + Add bookmark here
        </button>
      </svelte:fragment>
      <div data-testid="bookmarks-list">
        {#if !bookmarks.length}
          <p class="text-sm text-c-muted">No bookmarks yet. Press K in the book to add one.</p>
        {/if}
        {#each bookmarks as { item, place: at } (item.id)}
          <article class="c-modal-row" data-testid="notes-bookmark">
            {#if editing?.key === item.id}
              <form
                class="flex w-full flex-wrap gap-2 py-1"
                on:submit|preventDefault={() => saveRename(item)}
              >
                <input
                  bind:value={editing.text}
                  aria-label="Bookmark name"
                  class="c-input min-w-[12rem] flex-1"
                  data-testid="bookmark-rename-input"
                />
                <div class="flex gap-2">
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    on:click={() => (editing = undefined)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    class="c-btn c-btn-secondary c-btn-sm"
                    data-testid="bookmark-rename-save"
                  >
                    Save
                  </button>
                </div>
              </form>
            {:else}
              <button
                type="button"
                class="c-modal-row-button"
                data-testid="notes-bookmark-jump"
                on:click={() =>
                  close({ kind: 'jump', position: at ?? item.pos, highlightId: null })}
              >
                <span class="c-modal-row-title block">{item.name}</span>
                <span class="c-modal-row-meta block">
                  {place(at ?? item.pos)}
                  {#if at === null}
                    · <b data-testid="bookmark-unplaced">Not found in this copy of the book</b>
                  {/if}
                </span>
              </button>
              <div class="c-modal-row-actions">
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={busy}
                  data-testid="bookmark-rename"
                  on:click={() => startRename(item)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={busy}
                  data-testid="bookmark-remove"
                  on:click={() => removeBookmark(item)}
                >
                  Remove
                </button>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    </ModalSection>
  {:else if tab === 'about'}
    <ModalSection
      title="Notes about this book"
      hint="Your own notes about the whole book, not one passage."
    >
      <svelte:fragment slot="aside">
        <button
          type="button"
          class="c-btn c-btn-primary c-btn-sm"
          disabled={busy || editing?.key === 'new'}
          data-testid="notes-add-book-note"
          on:click={() => startNote('new', { bookId: bookId ?? '' }, '')}
        >
          + Add note
        </button>
      </svelte:fragment>
      {#if editing?.key === 'new'}
        <div class="c-modal-inline">
          <textarea
            bind:value={editing.text}
            rows="4"
            aria-label="Note about this book"
            class="c-input w-full py-2.5"
            data-testid="notes-edit-text"
          />
          <div class="c-modal-inline-btns">
            <button
              type="button"
              class="c-btn c-btn-ghost c-btn-sm"
              on:click={() => (editing = undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              class="c-btn c-btn-primary c-btn-sm"
              data-testid="notes-edit-save"
              on:click={saveEditing}
            >
              Save note
            </button>
          </div>
        </div>
      {/if}
      {#if !bookNotes.length && editing?.key !== 'new'}
        <p class="text-sm text-c-muted">No notes about this book yet.</p>
      {/if}
      <div>
        {#each bookNotes as note (note.id)}
          <article class="c-modal-row !block py-3" data-testid="notes-book-note">
            {#if note.quote}
              <p class="border-l-4 border-c-strong pl-2 font-serif text-sm text-c-muted">
                {note.quote}
              </p>
            {/if}
            {#if editing?.key === note.id}
              <textarea
                bind:value={editing.text}
                rows="4"
                aria-label="Note"
                class="c-input mt-2 w-full py-2.5"
                data-testid="notes-edit-text"
              />
              <div class="c-modal-inline-btns mt-2">
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
                  on:click={() => (editing = undefined)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-sm"
                  data-testid="notes-edit-save"
                  on:click={saveEditing}
                >
                  Save
                </button>
              </div>
            {:else}
              <div class="flex flex-wrap items-start gap-2">
                <p class="mt-1 min-w-0 flex-1 whitespace-pre-wrap">{note.body}</p>
                <div class="c-modal-row-actions">
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={busy}
                    on:click={() =>
                      startNote(note.id, { bookId: note.bookId, noteId: note.id }, note.body)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={busy}
                    on:click={() => removeNote(note)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    </ModalSection>
  {:else}
    <section class="c-modal-section">
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Show colors">
        <span class="mr-1 text-sm text-c-muted">Show</span>
        {#each HIGHLIGHT_COLORS as color}
          <button
            type="button"
            class="c-swatch"
            aria-pressed={colors.has(color)}
            title="Only {HIGHLIGHT_COLOR_NAMES[color]}"
            aria-label="Only {HIGHLIGHT_COLOR_NAMES[color]}"
            data-testid="notes-filter-{color}"
            on:click={() => toggleColor(color)}
          >
            <span class="c-swatch-dot" style={swatch(color)}>{eink ? 'あ' : ''}</span>
          </button>
        {/each}
        {#if colors.size}
          <button
            type="button"
            class="c-btn c-btn-ghost c-btn-sm"
            on:click={() => (colors = new Set())}
          >
            Show all
          </button>
        {/if}
      </div>
      {#if !canPaint}
        <p class="mt-2 text-sm text-c-muted">
          This browser can't show highlight colors on the page.
        </p>
      {/if}

      <div class="pt-2" data-testid="notes-list">
        {#if !$view.notes.highlights.length}
          <p class="text-sm text-c-muted">
            No highlights yet. Long-press text (or select it with the mouse) to highlight it.
          </p>
        {:else if !highlights.length}
          <p class="text-sm text-c-muted">No highlights in these colors.</p>
        {/if}

        {#each highlights as { item, place: at } (item.id)}
          <article class="c-modal-row !block py-3" data-testid="notes-highlight">
            <button
              type="button"
              class="c-modal-row-button w-full"
              data-testid="notes-highlight-jump"
              on:click={() =>
                close({ kind: 'jump', position: at ?? item.start, highlightId: item.id })}
            >
              <span class="c-modal-row-meta block">
                {place(at ?? item.start)}
                {#if at === null}
                  · <b data-testid="notes-unplaced">Not found in this copy of the book</b>
                {/if}
              </span>
              <span class="mt-1 block font-serif">
                <span class="px-0.5" style={swatch(item.color)}>{item.text}</span>
              </span>
            </button>
            {#if editing?.key === item.id}
              <textarea
                bind:value={editing.text}
                rows="4"
                aria-label="Note"
                class="c-input mt-2 w-full py-2.5"
                data-testid="notes-edit-text"
              />
              <div class="c-modal-inline-btns mt-2">
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
                  on:click={() => (editing = undefined)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-sm"
                  data-testid="notes-edit-save"
                  on:click={saveEditing}
                >
                  Save
                </button>
              </div>
            {:else if item.note}
              <p class="mt-1 whitespace-pre-wrap border-l-4 border-c-strong pl-2 text-sm">
                {item.note.body}
              </p>
            {/if}
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              {#each HIGHLIGHT_COLORS as color}
                <button
                  type="button"
                  class="c-swatch c-swatch-sm"
                  aria-label={HIGHLIGHT_COLOR_NAMES[color]}
                  title={HIGHLIGHT_COLOR_NAMES[color]}
                  aria-pressed={item.color === color}
                  disabled={busy}
                  on:click={() => setColor(item, color)}
                >
                  <span class="c-swatch-dot" style={swatch(color)}>{eink ? 'あ' : ''}</span>
                </button>
              {/each}
              <span class="c-modal-row-actions">
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
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
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={busy}
                  data-testid="notes-remove-highlight"
                  on:click={() => removeHighlight(item)}
                >
                  Remove
                </button>
              </span>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {/if}
</Modal>
