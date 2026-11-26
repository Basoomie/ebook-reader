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
    canUndo,
    writesFields
  } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    undoCleanupBatchCopy,
    undoFileMetadataBatchCopy,
    undoOnlineSourcesBatchCopy,
    undoGenresTagsBatchCopy,
    undoMoveBatchCopy,
    undoFormatsBatchCopy
  } from '$lib/confirm/confirm-copy';
  import { formatWhen } from '$lib/notes/notes-format';
  import CopyRow from './cleanup-copy-row.svelte';
  import FieldRow from './cleanup-field-row.svelte';

  export let api: CleanupApi;

  /** Manga part A: a move item's title (its evidence) and state, as the move card names them. */
  function moveItemTitle(item: Proposal): string {
    const ev = item.evidence as { title?: string } | null;
    return ev?.title ?? `Calibre #${item.calibre_id}`;
  }
  const MOVE_ITEM_STATES: Record<string, string> = {
    pending: 'Waiting',
    verified: 'Checked',
    exported: 'Saved to the quarantine',
    tagged: 'Added to the manga library and checked',
    removed: 'Moved',
    restored: 'Moved back',
    skipped: 'Skipped',
    failed: 'Failed'
  };
  const moveItemState = (s: string) => MOVE_ITEM_STATES[s] ?? s;
  // Books without an EPUB (stage 12): an EPUB added to its book, or a copy folded into its twin.
  const FORMAT_ITEM_STATES: Record<string, string> = {
    pending: 'Waiting',
    verified: 'Checked',
    exported: 'Copy saved to the quarantine',
    tagged: 'Its file and tags given to the EPUB book',
    written: 'EPUB added',
    removed: 'Copy folded into its EPUB book',
    restored: 'Taken back',
    skipped: 'Skipped',
    failed: 'Failed'
  };
  const itemState = (stage: number, s: string) =>
    stage === 12 ? (FORMAT_ITEM_STATES[s] ?? s) : moveItemState(s);
  export let batches: CleanupBatch[] = [];

  const dispatch = createEventDispatcher<{ changed: void }>();

  let open: string | null = null;
  let items: (Proposal & { state: string })[] = [];
  let openStage = 1;
  let itemsError = '';
  let undoError = '';

  async function toggle(batch: CleanupBatch) {
    if (open === batch.id) {
      open = null;
      return;
    }
    open = batch.id;
    openStage = batch.stage;
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
    const count =
      (batch.stage === 12
        ? (batch.counts?.written ?? 0) + (batch.counts?.removed ?? 0)
        : writesFields(batch)
          ? batch.counts?.written
          : batch.counts?.removed) ?? batch.itemCount;
    const copy =
      batch.stage === 5
        ? undoGenresTagsBatchCopy(count)
        : batch.stage === 11
          ? undoMoveBatchCopy(count)
          : batch.stage === 12
            ? undoFormatsBatchCopy(count)
            : batch.stage === 4
              ? undoOnlineSourcesBatchCopy(count)
              : batch.stage === 2
                ? undoFileMetadataBatchCopy(count)
                : undoCleanupBatchCopy(count);
    if (!(await confirmDestructive({ ...copy, testid: 'cleanup-undo-confirm' }))) {
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
              {open === batch.id
                ? writesFields(batch)
                  ? 'Hide changes'
                  : 'Hide copies'
                : writesFields(batch)
                  ? 'Show changes'
                  : 'Show copies'}
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
                {#if openStage === 2 || openStage === 4}
                  <FieldRow {item} state={item.state} detail={item.detail ?? null} />
                {:else if openStage === 11 || openStage === 12}
                  <!-- Manga part A: a moved book (its title, the state, and why it failed). -->
                  <li
                    class="c-tile flex flex-col gap-1 rounded p-3 text-sm"
                    data-testid="move-item"
                  >
                    <span class="font-bold">{moveItemTitle(item)}</span>
                    <span class="text-c-muted"
                      >Calibre #{item.calibre_id} · {itemState(openStage, item.state)}</span
                    >
                    {#if item.detail}<span>{item.detail}</span>{/if}
                  </li>
                {:else}
                  <CopyRow {item} state={item.state} />
                {/if}
              {/each}
            </ul>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/if}
