<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries, ⋯ › Earlier versions (session 4): every summary the book had, newest first
   * (kept on the server only), to view, bring back or delete. Answers true when something
   * changed, so the page loads the summary again.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import { deleteSummaryVersionCopy, restoreSummaryCopy } from '$lib/confirm/confirm-copy';
  import type { SummaryApi, SummaryMeta, SummaryView as View } from '$lib/summaries/summary-api';
  import { madeLine, summaryDate } from '$lib/summaries/summary-page';
  import SummaryView from './summary-view.svelte';

  export let api: SummaryApi;
  export let bookId: string;
  export let title: string;
  export let charCount: number | null = null;
  export let resolver: (changed: boolean) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let answered = false;
  let changed = false;
  function answer() {
    if (answered) return;
    answered = true;
    resolver(changed);
    dispatch('close');
  }
  onDestroy(() => {
    if (!answered) resolver(changed);
    answered = true;
  });

  let versions: SummaryMeta[] = [];
  let loading = true;
  let error = '';
  let viewing: View | null = null;
  let confirming: { id: number; what: 'restore' | 'delete' } | null = null;
  let busy = false;

  async function load() {
    loading = true;
    error = '';
    try {
      versions = (await api.versions(bookId)).versions;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function view(v: SummaryMeta) {
    error = '';
    try {
      viewing = (await api.version(bookId, v.id)).summary;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function act() {
    if (!confirming) return;
    busy = true;
    error = '';
    try {
      if (confirming.what === 'restore') await api.restore(bookId, confirming.id);
      else await api.deleteVersion(bookId, confirming.id);
      changed = true;
      confirming = null;
      viewing = null;
      await load();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
  const when = (v: SummaryMeta) => summaryDate(v.madeAt);
  $: copy = confirming
    ? confirming.what === 'restore'
      ? restoreSummaryCopy(when(versions.find((v) => v.id === confirming?.id)!))
      : deleteSummaryVersionCopy(when(versions.find((v) => v.id === confirming?.id)!))
    : null;
</script>

<Modal
  title="Earlier versions"
  subtitle={title}
  size="lg"
  testid="summary-versions"
  on:close={answer}
>
  {#if viewing}
    <div class="pt-2">
      <button
        type="button"
        class="c-btn c-btn-ghost c-btn-flush-start"
        data-testid="summary-version-back"
        on:click={() => (viewing = null)}>← All versions</button
      >
      <p class="mt-1 text-sm text-c-muted">{madeLine(viewing)}</p>
      <div class="mt-3">
        <SummaryView summary={viewing} {bookId} {charCount} showMade={false} />
      </div>
    </div>
  {:else if loading}
    <p class="py-4 text-c-muted">Loading…</p>
  {:else}
    <ul class="list" data-testid="summary-version-list">
      {#each versions as v (v.id)}
        <li class="row" data-testid="summary-version">
          <div class="min-w-0 flex-1">
            <p class="font-semibold">
              {when(v)}{#if v.state === 'current'}<span
                  class="ml-2 text-sm font-normal text-c-muted">Current</span
                >{/if}
            </p>
            <p class="text-sm text-c-muted">
              {madeLine(v)}{v.editedAt ? ' · edited by you' : ''}{v.origin === 'import'
                ? ' · from the accuracy test'
                : ''}
            </p>
          </div>
          <div class="flex flex-wrap gap-1">
            <button
              type="button"
              class="c-btn c-btn-secondary"
              data-testid="summary-version-view"
              on:click={() => view(v)}>View</button
            >
            {#if v.state !== 'current'}
              <button
                type="button"
                class="c-btn c-btn-secondary"
                data-testid="summary-version-restore"
                on:click={() => (confirming = { id: v.id, what: 'restore' })}>Restore</button
              >
              <button
                type="button"
                class="c-btn c-btn-ghost text-c-seal"
                data-testid="summary-version-delete"
                on:click={() => (confirming = { id: v.id, what: 'delete' })}>Delete</button
              >
            {/if}
          </div>
          {#if confirming?.id === v.id && copy}
            <div class="w-full">
              <InlineConfirm
                title={copy.title}
                message={copy.message}
                confirmLabel={copy.confirmLabel}
                irreversible={copy.irreversible}
                danger={copy.danger ?? true}
                {busy}
                testid="summary-version-confirm"
                confirmTestid="summary-version-confirm-yes"
                on:confirm={act}
                on:cancel={() => (confirming = null)}
              />
            </div>
          {/if}
        </li>
      {:else}
        <li class="py-3 text-c-muted">No summaries yet.</li>
      {/each}
    </ul>
  {/if}
  {#if error}<p class="c-notice mt-3" role="alert">{error}</p>{/if}
</Modal>

<style>
  .list {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.75rem 0;
    border-top: var(--c-border-width) solid var(--c-line);
  }
  .row:first-child {
    border-top: 0;
  }
</style>
