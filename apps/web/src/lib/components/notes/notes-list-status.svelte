<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** The Undo notice and the error line above a list of cards (notes-list-state.ts). */
  import type { NotesListState } from './notes-list-state';

  export let list: NotesListState;

  const smallButton = 'c-btn c-btn-secondary min-h-[2.75rem] min-w-[2.75rem] px-3 text-sm';
</script>

{#if $list.undo}
  <p class="c-notice sticky top-14 z-10 mb-2 flex items-center gap-3" role="status">
    {$list.undo.message}
    <button class={smallButton} data-testid="notes-undo" on:click={() => list.runUndo()}
      >Undo</button
    >
  </p>
{/if}
{#if $list.error}
  <p class="mb-2 text-sm" role="alert">{$list.error}</p>
{/if}
