<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Bookmeter sync's Review (2026-11-25, docs/design/bookmeter-sync.md): the status changes
   * your 読書メーター lists would make, each with a box (all ticked). Apply makes the ticked
   * ones; Skip these marks the ticked ones as never to ask again. Either way the unticked
   * ones stay waiting here and are never applied without asking. ✕, Esc or a click outside
   * leave everything waiting.
   */
  import { createEventDispatcher } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import type { PlannedChange } from '$lib/bookmeter/plan';
  import { bookmeterApi } from '$lib/sync/sync-service';

  export let changes: PlannedChange[];
  export let resolver: (done: boolean | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const STATUS: Record<string, string> = {
    unread: 'Unread',
    reading: 'Reading',
    completed: 'Completed',
    dropped: 'Dropped'
  };
  const PAGE = 100;

  let ticked = new Set(changes.map((c) => c.bookId));
  let shown = PAGE;
  let busy = false;
  let error = '';

  $: chosen = changes.filter((c) => ticked.has(c.bookId));
  $: unticked = changes.filter((c) => !ticked.has(c.bookId));
  $: completes = changes.filter((c) => c.kind === 'complete').length;
  $: readings = changes.length - completes;

  function toggle(id: string, on: boolean) {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    ticked = next;
  }

  function all(on: boolean) {
    ticked = on ? new Set(changes.map((c) => c.bookId)) : new Set();
  }

  function close(done: boolean | undefined) {
    resolver(done);
    dispatch('close');
  }

  async function apply() {
    busy = true;
    error = '';
    await bookmeterApi().hold(unticked);
    const failed = await bookmeterApi().apply(chosen);
    busy = false;
    if (failed.length) {
      error = `${failed.length} could not be saved; they are still waiting.`;
      return;
    }
    close(true);
  }

  async function skip() {
    busy = true;
    await bookmeterApi().hold(unticked);
    await bookmeterApi().skip(chosen);
    busy = false;
    close(true);
  }

  function line(c: PlannedChange): string {
    if (c.kind === 'complete')
      return c.date
        ? `${STATUS[c.from]} → Completed, finished ${c.date.replaceAll('-', '/')}`
        : `${STATUS[c.from]} → Completed`;
    return `${STATUS[c.from]} → Reading`;
  }
</script>

<Modal
  title="Changes from 読書メーター"
  subtitle={[completes ? `${completes} to Completed` : '', readings ? `${readings} to Reading` : '']
    .filter(Boolean)
    .join(', ')}
  size="lg"
  testid="bookmeter-review"
  on:close={() => close(undefined)}
>
  <ModalSection>
    <div class="min-w-0">
      <p class="text-sm text-c-muted">
        Completed books are finished on the day you logged them on 読書メーター. They count as
        finished books in Stats, with no reading time or characters, and never make a summary by
        themselves. Nothing is changed on 読書メーター.
      </p>
      <div class="mt-3 flex gap-2">
        <button type="button" class="c-btn c-btn-ghost c-btn-sm" on:click={() => all(true)}>
          Tick all
        </button>
        <button type="button" class="c-btn c-btn-ghost c-btn-sm" on:click={() => all(false)}>
          Untick all
        </button>
      </div>
      <ul class="mt-2 flex flex-col divide-y divide-c-line" data-testid="bookmeter-review-list">
        {#each changes.slice(0, shown) as c (c.bookId)}
          <li class="flex items-start gap-3 py-2" data-testid="bookmeter-review-item">
            <input
              type="checkbox"
              class="mt-1"
              checked={ticked.has(c.bookId)}
              aria-label={c.entry.title}
              on:change={(e) => toggle(c.bookId, e.currentTarget.checked)}
            />
            <div class="min-w-0">
              <a
                class="block truncate font-medium hover:underline"
                href="/library/book?id={encodeURIComponent(c.bookId)}"
                target="_blank"
                rel="noopener">{c.entry.title}</a
              >
              <span class="text-sm text-c-muted">{line(c)}</span>
            </div>
          </li>
        {/each}
      </ul>
      {#if changes.length > shown}
        <button
          type="button"
          class="c-btn c-btn-ghost c-btn-sm mt-2"
          on:click={() => (shown += PAGE)}
        >
          Show {Math.min(PAGE, changes.length - shown)} more
        </button>
      {/if}
    </div>
  </ModalSection>
  <svelte:fragment slot="status">
    {#if error}<span class="text-red-500" role="alert">{error}</span>{/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-secondary"
      disabled={busy || chosen.length === 0}
      data-testid="bookmeter-review-skip"
      on:click={skip}
    >
      Skip these
    </button>
    <button
      type="button"
      class="c-btn c-btn-primary"
      disabled={busy || chosen.length === 0}
      data-testid="bookmeter-review-apply"
      on:click={apply}
    >
      Apply {chosen.length.toLocaleString()}
    </button>
  </svelte:fragment>
</Modal>
