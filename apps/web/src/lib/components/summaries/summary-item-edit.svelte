<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries, Edit (session 4): Change and Delete under one item while the summary is in
   * Edit. Change opens the item's fields in place; Delete asks first, in place.
   */
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import { deleteSummaryItemCopy } from '$lib/confirm/confirm-copy';
  import type { SummaryItemInput } from '$lib/summaries/summary-api';
  import type { SummaryItem, SummarySectionKey } from '$lib/summaries/summary-types';
  import SummaryItemForm from './summary-item-form.svelte';

  export let item: SummaryItem;
  export let section: SummarySectionKey;
  export let lang = 'ja';
  /** Saves a change; resolves to an error to show, or null. */
  export let save: (item: SummaryItem, input: SummaryItemInput) => Promise<string | null>;
  /** Deletes the item; resolves to an error to show, or null. */
  export let remove: ((item: SummaryItem) => Promise<string | null>) | null = null;

  let mode: 'idle' | 'change' | 'delete' = 'idle';
  let busy = false;
  let error = '';
  const copy = deleteSummaryItemCopy();

  async function onSave(input: SummaryItemInput) {
    busy = true;
    error = '';
    const e = await save(item, input);
    busy = false;
    if (e) error = e;
    else mode = 'idle';
  }
  async function onDelete() {
    if (!remove) return;
    busy = true;
    error = '';
    const e = await remove(item);
    busy = false;
    if (e) error = e;
    else mode = 'idle';
  }
</script>

{#if mode === 'change'}
  <SummaryItemForm
    {section}
    {lang}
    {busy}
    {error}
    initial={{
      text: item.text,
      heading: item.heading ?? null,
      between: item.between ?? null,
      label: item.label ?? null
    }}
    on:save={(e) => onSave(e.detail)}
    on:cancel={() => {
      mode = 'idle';
      error = '';
    }}
  />
{:else if mode === 'delete'}
  <InlineConfirm
    title={copy.title}
    message={copy.message}
    confirmLabel={copy.confirmLabel}
    irreversible={copy.irreversible}
    {busy}
    testid="summary-item-delete-confirm"
    confirmTestid="summary-item-delete-yes"
    on:confirm={onDelete}
    on:cancel={() => (mode = 'idle')}
  />
  {#if error}<p class="text-sm" role="alert">{error}</p>{/if}
{:else}
  <span class="tools">
    <button
      type="button"
      class="c-btn c-btn-ghost"
      data-testid="summary-item-change"
      on:click={() => (mode = 'change')}>Change</button
    >
    {#if remove}
      <button
        type="button"
        class="c-btn c-btn-ghost text-c-seal"
        data-testid="summary-item-delete"
        on:click={() => (mode = 'delete')}>Delete</button
      >
    {/if}
  </span>
{/if}

<style>
  .tools {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-left: 0.25rem;
    vertical-align: middle;
  }
</style>
