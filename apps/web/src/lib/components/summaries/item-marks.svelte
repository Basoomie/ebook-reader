<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries session 2: the accuracy test's marks under one summary item. Tapping the
   * pressed mark again clears it.
   */
  import { createEventDispatcher } from 'svelte';
  import { ITEM_MARKS, type ItemMark } from '$lib/summaries/summary-types';

  export let mark: ItemMark | null = null;
  export let ref: string;
  /** The summary this mark was copied from (the same item there), or null. */
  export let copiedFrom: string | null = null;

  const dispatch = createEventDispatcher<{ mark: { ref: string; mark: ItemMark | null } }>();
</script>

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
