<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries session 2: the accuracy test's marks under one summary item. Tapping the
   * pressed mark again clears it. Claude's check of the item against the book shows above the
   * buttons: found right (you can skip it), flagged with the reason, or a spot check (an item
   * Claude found right that you mark too, to measure Claude's checks).
   */
  import { createEventDispatcher } from 'svelte';
  import { ITEM_MARKS, type ItemMark } from '$lib/summaries/summary-types';

  export let mark: ItemMark | null = null;
  export let ref: string;
  /** The summary this mark was copied from (the same item there), or null. */
  export let copiedFrom: string | null = null;
  /** Claude's check of this item against the book, or null (not checked). */
  export let check: { verdict: ItemMark; reason: string | null; spot: boolean } | null = null;

  const dispatch = createEventDispatcher<{ mark: { ref: string; mark: ItemMark | null } }>();
  const LABEL: Record<ItemMark, string> = {
    right: 'right',
    mistake: 'has a mistake',
    not_needed: 'not needed',
    unsure: 'unsure'
  };
</script>

{#if check}
  {#if check.spot}
    <p class="check check-spot mt-1 text-xs" data-testid="item-check-spot">
      Spot check: Claude found this right; please mark it yourself.
    </p>
  {:else if check.verdict === 'right'}
    <p class="mt-1 text-xs opacity-70" data-testid="item-check-right">
      Checked against the book: right{mark ? '' : ' (counted as Right unless you mark it)'}
    </p>
  {:else}
    <p class="check check-flag mt-1 text-xs" lang="en" data-testid="item-check-flag">
      Checked against the book: <b>{LABEL[check.verdict]}</b>{check.reason
        ? ` — ${check.reason}`
        : ''}
    </p>
  {/if}
{/if}
<div class="mt-1 flex flex-wrap gap-2" role="group" aria-label="Mark this item">
  {#each ITEM_MARKS as m (m.value)}
    <button
      type="button"
      class="c-btn c-btn-secondary c-btn-sm"
      aria-pressed={mark === m.value}
      data-testid="item-mark-{m.value}"
      on:click={() => dispatch('mark', { ref, mark: mark === m.value ? null : m.value })}
      >{m.label}</button
    >
  {/each}
</div>
{#if copiedFrom && mark}
  <p class="mt-1 text-xs opacity-70" data-testid="item-mark-copied">
    Copied from your mark on the same item in {copiedFrom}
  </p>
{/if}

<style>
  .check {
    padding: 0.35rem 0.6rem;
    border-radius: 10px;
    white-space: pre-wrap;
  }
  .check-flag {
    background: rgba(220, 120, 40, 0.14);
  }
  .check-spot {
    background: rgba(60, 130, 220, 0.14);
  }
</style>
