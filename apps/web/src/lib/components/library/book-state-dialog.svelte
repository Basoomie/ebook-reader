<script lang="ts">
  /**
   * Book state (WP8a, minimal until WP7a): status, favorite, cover blur and
   * read-throughs of one catalog book. Plain on purpose for e-ink (like the
   * WP9 prompt): no transitions, full-size bordered buttons, inert backdrop;
   * closes with its Close button or Esc. Every change is saved at once to the
   * local sync mirror (works offline) and synced later.
   */
  import {
    BOOK_BLURS,
    STATUS_LABELS,
    canRemoveReadThrough,
    finishedReadThroughs,
    type BookBlur,
    type BookState,
    type BookStatus,
    type ReadThrough
  } from '$lib/sync/book-state';
  import type { BookStateApi } from '$lib/sync/sync-service';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';

  export let bookId: string;
  export let title: string;
  /** The catalog's character count, kept with a manual completion. */
  export let charCount: number | null = null;
  export let api: BookStateApi;
  /** Opened from the reader: Start over moves the open book to the start at once. */
  export let inReader = false;
  /** 'start-over' after a Start over, else null. */
  export let resolver: (result: 'start-over' | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const pressedClass = 'bg-gray-700 text-white border-gray-700';
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

  function pickStatus(status: BookStatus) {
    confirmStartOver = false;
    if (status === 'completed') {
      completing = true;
      finishDate = '';
      return;
    }
    completing = false;
    void run(() => api.setStatus(bookId, status));
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

  function beginEdit(rt: ReadThrough) {
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

  /** One reading of the book in plain words, e.g. "1st read · finished 2026-11-01". */
  function describe(rt: ReadThrough): string {
    const parts: string[] = [`${ordinal(rt.number)} read`];
    if (rt.startedOn) parts.push(`started ${rt.startedOn}`);
    if (rt.finished) {
      parts.push(rt.finishedOn ? `finished ${rt.finishedOn}` : 'finished (no date)');
      parts.push(rt.manual ? 'marked as read by you' : 'read in the app');
    } else {
      parts.push('reading now');
    }
    return parts.join(' · ');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  $: readCount = state ? finishedReadThroughs(state) : 0;
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 max-h-[90vh] overflow-y-auto rounded bg-white p-6"
  data-testid="book-state-dialog"
>
  <h2 class="weight-medium mb-1 text-xl">Book status</h2>
  <p class="mb-4 line-clamp-2">{title}</p>

  {#if !state}
    <p>{error || 'Loading…'}</p>
  {:else}
    <div class="max-w-xl">
      <h3 class="mb-2 font-medium">Status</h3>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Status">
        {#each statuses as status (status)}
          <button
            class="{buttonClass} {state.status === status ? pressedClass : ''}"
            aria-pressed={state.status === status}
            disabled={busy}
            data-testid="status-{status}"
            on:click={() => pickStatus(status)}
          >
            {STATUS_LABELS[status]}
          </button>
        {/each}
      </div>
      {#if state.statusAuto && state.status === 'reading'}
        <p class="pt-1 text-sm">Set automatically on the first page turn.</p>
      {/if}

      {#if completing}
        <div class="mt-3 border-t border-gray-400 pt-3" data-testid="complete-panel">
          <label class="block max-w-xs">
            Finish date (optional)
            <input
              class="mt-1 block w-full border-0 border-b-2 border-gray-400/50 px-0.5"
              type="date"
              bind:value={finishDate}
              data-testid="finish-date"
            />
          </label>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              class={buttonClass}
              disabled={busy}
              data-testid="mark-completed"
              on:click={markCompleted}
            >
              Mark completed
            </button>
            <button class={buttonClass} disabled={busy} on:click={() => (completing = false)}>
              Cancel
            </button>
          </div>
        </div>
      {/if}

      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <label class="flex min-h-[3rem] items-center gap-3">
          <input
            type="checkbox"
            class="h-6 w-6"
            checked={state.favorite}
            disabled={busy}
            data-testid="favorite"
            on:change={(ev) => setFavorite(ev.currentTarget.checked)}
          />
          Favorite
        </label>
        <label class="flex items-center gap-2">
          Cover
          <select
            class="min-h-[3rem] border-2 border-current bg-transparent px-2"
            value={state.blur}
            disabled={busy}
            data-testid="blur"
            on:change={(ev) => pickBlur(ev.currentTarget.value)}
          >
            {#each BOOK_BLURS as blur (blur)}
              <option value={blur}>{blurLabels[blur]}</option>
            {/each}
          </select>
        </label>
      </div>
      <p class="pt-1 text-sm">The cover setting takes effect with the new library view.</p>

      <h3 class="mt-5 font-medium">
        Times read: {readCount}
      </h3>
      {#if state.readThroughs.length}
        <ul>
          {#each state.readThroughs as rt (rt.id)}
            <li class="border-t border-gray-400 py-2" data-testid="read-through">
              <p>{describe(rt)}</p>
              {#if editingId === rt.id}
                <div class="mt-2 flex flex-wrap items-end gap-2">
                  <input
                    class="border-0 border-b-2 border-gray-400/50 px-0.5"
                    type="date"
                    bind:value={editDate}
                  />
                  <button class={buttonClass} disabled={busy} on:click={saveEdit}>Save</button>
                  <button class={buttonClass} on:click={() => (editingId = '')}>Cancel</button>
                </div>
              {:else if rt.finished || canRemoveReadThrough(rt)}
                <div class="mt-2 flex flex-wrap gap-2">
                  {#if rt.finished}
                    <button class={buttonClass} disabled={busy} on:click={() => beginEdit(rt)}>
                      Change date
                    </button>
                  {/if}
                  {#if canRemoveReadThrough(rt)}
                    <button
                      class={buttonClass}
                      disabled={busy}
                      on:click={() => run(() => api.removeReadThrough(bookId, rt.id))}
                    >
                      Remove
                    </button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-sm">Not finished yet. Marking the book completed counts it as read.</p>
      {/if}

      <div class="mt-4 border-t border-gray-400 pt-3">
        {#if confirmStartOver}
          <p class="mb-2">
            Start over? You read the book again from the beginning, on every device. Your earlier
            reads and their stats are kept.
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              class={buttonClass}
              disabled={busy}
              data-testid="confirm-start-over"
              on:click={startOver}
            >
              Start over
            </button>
            <button class={buttonClass} on:click={() => (confirmStartOver = false)}>Cancel</button>
          </div>
        {:else}
          <button
            class={buttonClass}
            disabled={busy}
            data-testid="start-over"
            on:click={() => {
              completing = false;
              confirmStartOver = true;
            }}
          >
            Start over…
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if error && state}
    <p class="pt-3 font-medium" role="alert">{error}</p>
  {/if}

  <footer class="flex flex-wrap items-center justify-end pt-5">
    <button class={buttonClass} data-testid="book-state-close" on:click={() => close()}>
      Close
    </button>
  </footer>
</section>
