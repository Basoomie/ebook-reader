<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The batches the sidecar applied (WP20a), newest first, each with its items on request
   * and an Undo (asks first). Undo makes an undo batch the sidecar works through.
   */
  import { createEventDispatcher } from 'svelte';
  import type { CleanupApi, CleanupBatch, Proposal } from '$lib/cleanup/cleanup-api';
  import {
    batchCountsText,
    batchKindText,
    batchStateText,
    canUndo
  } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { undoCleanupBatchCopy } from '$lib/confirm/confirm-copy';
  import { formatWhen } from '$lib/notes/notes-format';
  import CopyRow from './cleanup-copy-row.svelte';

  export let api: CleanupApi;
  export let batches: CleanupBatch[] = [];

  const dispatch = createEventDispatcher<{ changed: void }>();

  let open: string | null = null;
  let items: (Proposal & { state: string })[] = [];
  let itemsError = '';
  let undoError = '';

  async function toggle(batch: CleanupBatch) {
    if (open === batch.id) {
      open = null;
      return;
    }
    open = batch.id;
    items = [];
    itemsError = '';
    try {
      items = (await api.batch(batch.id)).items as (Proposal & { state: string })[];
    } catch (err) {
      itemsError = (err as Error).message;
    }
  }

  async function undo(batch: CleanupBatch) {
    undoError = '';
    const count = batch.counts?.removed ?? batch.itemCount;
    if (
      !(await confirmDestructive({
        ...undoCleanupBatchCopy(count),
        testid: 'cleanup-undo-confirm'
      }))
    ) {
      return;
    }
    try {
      await api.undo(batch.id);
      dispatch('changed');
    } catch (err) {
      undoError = (err as Error).message;
    }
  }
</script>

{#if undoError}<p class="c-notice font-bold" role="alert">{undoError}</p>{/if}
{#if batches.length === 0}
  <p class="text-sm text-c-muted">No batches yet.</p>
{:else}
  <ul class="flex flex-col gap-3" data-testid="cleanup-batches">
    {#each batches as batch (batch.id)}
      <li class="c-tile flex flex-col gap-2 rounded p-3" data-testid="cleanup-batch">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-col">
            <span class="font-bold">{batchKindText(batch)} · {batchStateText(batch)}</span>
            <span class="text-sm text-c-muted">
              {formatWhen(batch.createdAt)} · {batchCountsText(batch)}
              {#if batch.error}· {batch.error}{/if}
            </span>
            {#if batch.kind === 'apply'}
              <span class="break-all text-xs text-c-muted">
                Quarantine: calibre-quarantine/{batch.id}/
              </span>
            {/if}
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              class="c-btn c-btn-ghost"
              on:click={() => toggle(batch)}
              aria-expanded={open === batch.id}
            >
              {open === batch.id ? 'Hide copies' : 'Show copies'}
            </button>
            {#if canUndo(batch, batches)}
              <button
                class="c-btn c-btn-secondary"
                on:click={() => undo(batch)}
                data-testid="cleanup-undo"
              >
                Undo
              </button>
            {/if}
          </div>
        </div>
        {#if open === batch.id}
          {#if itemsError}
            <p class="c-notice" role="alert">{itemsError}</p>
          {:else if items.length === 0}
            <p class="text-sm text-c-muted">Loading…</p>
          {:else}
            <ul class="flex flex-col gap-2">
              {#each items as item (item.id)}
                <CopyRow {item} state={item.state} />
              {/each}
            </ul>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/if}
