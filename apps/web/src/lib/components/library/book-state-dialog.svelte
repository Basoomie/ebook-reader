<script lang="ts">
  /**
   * Book state (WP8a): status, favorite, cover blur (shown by the library, WP7a) and
   * read-throughs of one catalog book, in sections: Status, Options, Times read,
   * Collections, Start over (last). Closes with ✕, Esc or a click outside (modal.svelte);
   * there is nothing to save: every change is saved at once to the local sync mirror
   * (works offline) and synced later.
   */
  import {
    BOOK_BLURS,
    STATUS_LABELS,
    canRemoveReadThrough,
    finishedReadThroughs,
    readThroughLines,
    type BookBlur,
    type BookState,
    type BookStatus,
    type ReadThrough,
    type ReadThroughLine
  } from '$lib/sync/book-state';
  import CollectionToggles from '$lib/components/collections/collection-toggles.svelte';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import SettingSwitch from '$lib/components/settings/setting-switch.svelte';
  import { removeReadCopy, startOverCopy, unreadResetCopy } from '$lib/confirm/confirm-copy';
  import type { BookStateApi, CollectionsApi } from '$lib/sync/sync-service';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';

  export let bookId: string;
  export let title: string;
  /** The catalog's character count, kept with a manual completion. */
  export let charCount: number | null = null;
  export let api: BookStateApi;
  /** WP8b: the lists this book is in (omitted = no Collections section). */
  export let collections: CollectionsApi | null = null;
  /** Opened from the reader: Start over moves the open book to the start at once. */
  export let inReader = false;
  /** 'start-over' after a Start over, else null. */
  export let resolver: (result: 'start-over' | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = `book-state-${Math.random().toString(36).slice(2, 10)}`;
  const statuses: BookStatus[] = ['unread', 'reading', 'completed', 'dropped'];
  const blurLabels: Record<BookBlur, string> = {
    inherit: 'Follow tag rules',
    always: 'Always blur',
    never: 'Never blur'
  };

  let state: BookState | undefined;
  let error = '';
  let busy = false;
  let done = false;
  /** The Completed panel (optional finish date) is open. */
  let completing = false;
  let finishDate = '';
  let confirmStartOver = false;
  /** "Set to Unread?": Unread on a part-read book also takes it back to the start. */
  let confirmUnread = false;
  /** WP19: the read-through waiting for "Remove the 2nd read?". */
  let confirmRemoveId = '';
  /** Read-through whose finish date is being edited, and the edited value. */
  let editingId = '';
  let editDate = '';
  let unsubscribe: (() => void) | undefined;

  onMount(async () => {
    await refresh();
    unsubscribe = await api.onChanged((ids) => {
      if (ids.has(bookId) && !busy) void refresh();
    });
  });

  onDestroy(() => unsubscribe?.());

  async function refresh() {
    try {
      state = await api.get(bookId);
    } catch (e) {
      error = `Could not read this book's state: ${(e as Error)?.message ?? e}`;
    }
  }

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (e) {
      error = `Not saved: ${(e as Error)?.message ?? e}`;
    } finally {
      busy = false;
      await refresh();
    }
  }

  function close(result: 'start-over' | null = null) {
    if (done) return;
    done = true;
    resolver(result);
    dispatch('close');
  }

  async function pickStatus(status: BookStatus) {
    confirmStartOver = false;
    confirmUnread = false;
    if (status === 'completed') {
      completing = true;
      finishDate = '';
      return;
    }
    completing = false;
    // Unread on a part-read book also takes it back to the start: ask first.
    if (status === 'unread' && (await api.currentReadHasPlace(bookId))) {
      confirmUnread = true;
      return;
    }
    void run(() => api.setStatus(bookId, status));
  }

  function setUnread() {
    void run(async () => {
      const reset = await api.currentReadHasPlace(bookId);
      await api.setStatus(bookId, 'unread');
      confirmUnread = false;
      if (reset && inReader) close('start-over');
    });
  }

  function pickBlur(value: string) {
    const blur = BOOK_BLURS.find((b) => b === value);
    if (blur) void run(() => api.setBlur(bookId, blur));
  }

  function setFavorite(favorite: boolean) {
    void run(() => api.setFavorite(bookId, favorite));
  }

  function markCompleted() {
    void run(async () => {
      const failed = await api.markCompleted([{ bookId, charCount }], finishDate || null);
      if (failed.length) throw new Error('could not save the completion');
      completing = false;
    });
  }

  function startOver() {
    void run(async () => {
      await api.startOver(bookId);
      confirmStartOver = false;
      if (inReader) close('start-over');
    });
  }

  function removeRead(id: string) {
    void run(async () => {
      await api.removeReadThrough(bookId, id);
      confirmRemoveId = '';
    });
  }

  function beginEdit(rt: ReadThrough) {
    confirmRemoveId = '';
    editingId = rt.id;
    editDate = rt.finishedOn ?? '';
  }

  function saveEdit() {
    const id = editingId;
    void run(async () => {
      await api.editFinish(bookId, id, editDate || null);
      editingId = '';
    });
  }

  function ordinal(n: number): string {
    const tens = n % 100;
    const suffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
    const suffix = tens >= 11 && tens <= 13 ? 'th' : (suffixes[n % 10] ?? 'th');
    return `${n}${suffix}`;
  }

  /** "1st read" (finished reads are numbered among themselves) or "Current read". */
  function readName(finishedNumber: ReadThroughLine['finishedNumber']): string {
    return finishedNumber ? `${ordinal(finishedNumber)} read` : 'Current read';
  }

  /** The rest in plain words, e.g. "Started 2026-10-02 · finished 2026-11-01 · read in the app". */
  function describe(rt: ReadThrough): string {
    const parts: string[] = [];
    if (rt.startedOn) parts.push(`started ${rt.startedOn}`);
    if (rt.finished) {
      parts.push(rt.finishedOn ? `finished ${rt.finishedOn}` : 'finished (no date)');
      parts.push(rt.manual ? 'marked as read by you' : 'read in the app');
    }
    const text = parts.join(' · ');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  $: readCount = state ? finishedReadThroughs(state) : 0;
  $: lines = state ? readThroughLines(state) : [];
</script>

<Modal
  title="Book status"
  subtitle={title}
  size="lg"
  testid="book-state-dialog"
  closeTestid="book-state-close"
  on:close={() => close()}
>
  {#if error && state}
    <p class="c-notice c-modal-error sticky top-0 z-10" role="alert">
      <span aria-hidden="true">⚠</span>{error}
    </p>
  {/if}

  {#if !state}
    <p class="py-4">{error || 'Loading…'}</p>
  {:else}
    <ModalSection title="Status" testid="book-state-status">
      <svelte:fragment slot="hint">
        {#if state.statusAuto && state.status === 'reading'}
          Set automatically on the first page turn.
        {/if}
      </svelte:fragment>
      <div>
        <div class="c-choice" role="group" aria-label="Status">
          {#each statuses as status (status)}
            <button
              type="button"
              aria-pressed={state.status === status}
              disabled={busy}
              data-testid="status-{status}"
              on:click={() => pickStatus(status)}
            >
              {STATUS_LABELS[status]}
            </button>
          {/each}
        </div>
      </div>

      {#if confirmUnread}
        <InlineConfirm
          {...unreadResetCopy()}
          {busy}
          testid="unread-confirm"
          confirmTestid="confirm-unread"
          on:confirm={setUnread}
          on:cancel={() => (confirmUnread = false)}
        />
      {/if}

      {#if completing}
        <form
          class="c-modal-inline"
          data-testid="complete-panel"
          on:submit|preventDefault={markCompleted}
        >
          <p class="c-modal-inline-title">Mark as completed</p>
          <label class="c-modal-field">
            <span class="c-modal-label">
              Finish date <span class="font-normal text-c-muted">(optional)</span>
            </span>
            <input
              class="c-input w-full max-w-[14rem]"
              type="date"
              bind:value={finishDate}
              data-testid="finish-date"
            />
          </label>
          <div class="c-modal-inline-btns">
            <button
              type="button"
              class="c-btn c-btn-secondary c-btn-sm"
              disabled={busy}
              on:click={() => (completing = false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="c-btn c-btn-primary c-btn-sm"
              disabled={busy}
              data-testid="mark-completed"
            >
              Mark completed
            </button>
          </div>
        </form>
      {/if}
    </ModalSection>

    <ModalSection title="Options">
      <div>
        <div class="c-modal-row">
          <div class="c-modal-row-main">
            <div class="c-modal-row-title" id="{id}-favorite">Favorite</div>
            <div class="c-modal-row-meta">Shows in the Favorites collection.</div>
          </div>
          <SettingSwitch
            checked={state.favorite}
            labelledby="{id}-favorite"
            disabled={busy}
            testid="favorite"
            on:change={(ev) => setFavorite(ev.detail)}
          />
        </div>
        <div class="c-modal-row">
          <label class="c-modal-row-main" for="{id}-blur">
            <span class="c-modal-row-title block">Blur the cover</span>
            <span class="c-modal-row-meta block">For covers you'd rather not show.</span>
          </label>
          <select
            id="{id}-blur"
            class="c-input pr-10"
            value={state.blur}
            disabled={busy}
            data-testid="blur"
            on:change={(ev) => pickBlur(ev.currentTarget.value)}
          >
            {#each BOOK_BLURS as blur (blur)}
              <option value={blur}>{blurLabels[blur]}</option>
            {/each}
          </select>
        </div>
      </div>
    </ModalSection>

    <ModalSection
      title="Times read"
      count={readCount}
      hint={lines.length ? '' : 'Not finished yet. Marking the book completed counts it as read.'}
    >
      {#if lines.length}
        <ul>
          {#each lines as { readThrough: rt, finishedNumber } (rt.id)}
            <li class="c-modal-row" data-testid="read-through">
              {#if confirmRemoveId === rt.id}
                <div class="w-full py-1">
                  <InlineConfirm
                    {...removeReadCopy(ordinal(finishedNumber ?? rt.number))}
                    {busy}
                    testid="remove-read-confirm"
                    confirmTestid="confirm-remove-read"
                    on:confirm={() => removeRead(rt.id)}
                    on:cancel={() => (confirmRemoveId = '')}
                  />
                </div>
              {:else}
                <div class="c-modal-row-main">
                  <div class="c-modal-row-title">{readName(finishedNumber)}</div>
                  <div class="c-modal-row-meta">{describe(rt)}</div>
                </div>
                {#if editingId === rt.id}
                  <form class="c-modal-row-actions" on:submit|preventDefault={saveEdit}>
                    <input
                      class="c-input"
                      type="date"
                      aria-label="Finish date"
                      bind:value={editDate}
                    />
                    <button
                      type="button"
                      class="c-btn c-btn-ghost c-btn-sm"
                      on:click={() => (editingId = '')}
                    >
                      Cancel
                    </button>
                    <button type="submit" class="c-btn c-btn-secondary c-btn-sm" disabled={busy}>
                      Save
                    </button>
                  </form>
                {:else if rt.finished || canRemoveReadThrough(rt)}
                  <div class="c-modal-row-actions">
                    {#if rt.finished}
                      <button
                        type="button"
                        class="c-btn c-btn-ghost c-btn-sm"
                        disabled={busy}
                        on:click={() => beginEdit(rt)}
                      >
                        Change date
                      </button>
                    {/if}
                    {#if canRemoveReadThrough(rt)}
                      <button
                        type="button"
                        class="c-btn c-btn-ghost c-btn-sm"
                        disabled={busy}
                        data-testid="remove-read"
                        on:click={() => {
                          editingId = '';
                          confirmRemoveId = rt.id;
                        }}
                      >
                        Remove…
                      </button>
                    {/if}
                  </div>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </ModalSection>

    {#if collections}
      <ModalSection title="Collections" hint="Tap a collection to add or remove this book.">
        <CollectionToggles {bookId} api={collections} />
      </ModalSection>
    {/if}

    <ModalSection
      title="Start over"
      hint="Read the book again from the beginning. Earlier reads and their stats are kept."
    >
      {#if confirmStartOver}
        <InlineConfirm
          {...startOverCopy()}
          {busy}
          testid="start-over-confirm"
          confirmTestid="confirm-start-over"
          on:confirm={startOver}
          on:cancel={() => (confirmStartOver = false)}
        />
      {:else}
        <div>
          <button
            type="button"
            class="c-btn c-btn-danger-line"
            disabled={busy}
            data-testid="start-over"
            on:click={() => {
              completing = false;
              confirmUnread = false;
              confirmStartOver = true;
            }}
          >
            Start over…
          </button>
        </div>
      {/if}
    </ModalSection>
  {/if}
</Modal>
