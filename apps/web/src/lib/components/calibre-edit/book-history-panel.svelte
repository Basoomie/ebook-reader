<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * "History of changes" (⋯ on the book page; design 2026-11-23): every change to the book in
   * Calibre, newest first: the user's, the cleanup's per stage, and changes made in Calibre's
   * own program. Undo asks first (naming the field and the value it goes back to) and writes
   * that value back; it then counts as the user's. An entry whose field changed since can't be
   * undone until the later change is (the server decides, and says why).
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import { CalibreEditApi, editUnreachable } from '$lib/calibre-edit/api';
  import { fieldLabel, valueText, whoText } from '$lib/calibre-edit/format';
  import type { HistoryEntry } from '$lib/calibre-edit/types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { undoChangeCopy } from '$lib/confirm/confirm-copy';

  export let api: CalibreEditApi;
  export let bookId: string;
  export let title: string;

  const dispatch = createEventDispatcher<{ close: void; undone: void }>();

  let entries: HistoryEntry[] | null = null;
  let error = '';
  let busy = '';
  let message = '';

  onMount(load);

  async function load() {
    try {
      entries = (await api.history(bookId)).entries;
      error = '';
    } catch (err) {
      error = editUnreachable(err)
        ? 'The history needs the library server, which can’t be reached right now.'
        : (err as Error).message;
    }
  }

  function when(at: number): string {
    const d = new Date(at);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `Today ${time}`;
    return `${d.toLocaleDateString()} ${time}`;
  }

  async function undo(e: HistoryEntry) {
    const ok = await confirmDestructive({
      ...undoChangeCopy(fieldLabel(e.field), valueText(e.field, e.undo.to ?? e.old)),
      testid: 'history-undo-confirm',
      confirmTestid: 'history-undo-confirm-yes'
    });
    if (!ok) return;
    busy = e.id;
    message = '';
    try {
      await api.undo(bookId, e.id);
      message = 'Undone: the earlier value goes back to Calibre (now yours).';
      dispatch('undone');
      await load();
    } catch (err) {
      message = (err as Error).message;
    } finally {
      busy = '';
    }
  }
</script>

<Modal
  title="History of changes"
  subtitle={title}
  size="lg"
  placement="side"
  testid="history-panel"
  on:close={() => dispatch('close')}
>
  <p class="mt-3 text-sm text-c-muted">
    Every change to this book in Calibre: yours, the cleanup’s, and changes made in Calibre’s own
    program. Undo puts back the field’s earlier value; that value then counts as yours.
  </p>
  {#if message}<p class="c-notice mt-3 text-sm" role="status" data-testid="history-message">
      {message}
    </p>{/if}
  {#if error}
    <p class="c-notice mt-3" role="alert">{error}</p>
  {:else if !entries}
    <p class="py-6 text-c-muted">Loading…</p>
  {:else if entries.length === 0}
    <p class="py-6 text-c-muted" data-testid="history-empty">
      No changes recorded for this book yet.
    </p>
  {:else}
    <ol class="mt-3 flex flex-col" data-testid="history-list">
      {#each entries as e (e.id)}
        <li class="c-hist" data-testid="history-entry" data-entry={e.id}>
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-c-muted">
            <span>{when(e.at)}</span>
            <span class="c-hist-who" class:is-you={e.who === 'you' || e.who === 'confirm'}
              >{whoText(e)}</span
            >
            <span class="font-semibold text-c-ink">{fieldLabel(e.field)}</span>
          </div>
          <p class="mt-1 break-words text-sm" data-testid="history-change">
            {#if e.who === 'confirm'}
              {valueText(e.field, e.new)}
            {:else}
              <span class="text-c-muted">{valueText(e.field, e.old)}</span> → {valueText(
                e.field,
                e.new
              )}
            {/if}
          </p>
          {#if e.reason}<p class="mt-1 text-xs text-c-muted">{e.reason}</p>{/if}
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {#if e.undo.possible}
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                disabled={busy !== ''}
                data-testid="history-undo"
                on:click={() => undo(e)}>{busy === e.id ? 'Undoing…' : 'Undo'}</button
              >
            {:else if e.undo.why}
              <span class="text-xs text-c-muted" data-testid="history-why">{e.undo.why}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</Modal>

<style>
  .c-hist {
    padding: 0.75rem 0;
    border-top: 1px solid var(--c-line);
  }

  .c-hist:first-child {
    border-top: 0;
  }

  .c-hist-who {
    padding: 0 0.5rem;
    border-radius: 999px;
    border: var(--c-border-width) solid var(--c-line-strong);
  }

  .c-hist-who.is-you {
    color: var(--c-ink);
    background-color: var(--c-tint);
  }
</style>
