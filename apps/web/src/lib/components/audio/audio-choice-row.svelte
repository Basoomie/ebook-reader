<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One audiobook folder or subtitle file the user can choose (WP15b): name, the folder it
   * is in, its details, an optional note, and a "Use this" button. Nothing is chosen until
   * the button is pressed.
   */
  import { createEventDispatcher } from 'svelte';

  export let name: string;
  export let parent: string | null = null;
  export let details = '';
  export let note = '';
  /** Shown instead of the button for the item that is linked now. */
  export let current = false;
  export let disabled = false;
  export let testid = 'audio-choice';

  const dispatch = createEventDispatcher<{ choose: void }>();
</script>

<li
  class="c-achoice flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
  data-testid={testid}
  data-name={name}
>
  <div class="min-w-0 grow basis-60">
    <div class="break-words font-mincho text-[15px] font-bold leading-snug">{name}</div>
    {#if parent}
      <div class="break-words text-xs text-c-muted" data-testid="audio-choice-parent">
        in {parent}
      </div>
    {/if}
    {#if details}
      <div class="mt-0.5 text-sm text-c-muted" data-testid="audio-choice-details">{details}</div>
    {/if}
    {#if note}
      <div class="mt-1 text-sm font-medium" data-testid="audio-choice-note">{note}</div>
    {/if}
  </div>
  {#if current}
    <span class="text-sm text-c-muted" data-testid="audio-choice-current">Linked now</span>
  {:else}
    <button
      class="c-btn c-btn-secondary c-round shrink-0 px-5"
      data-testid="audio-choice-use"
      {disabled}
      on:click={() => dispatch('choose')}
    >
      Use this
    </button>
  {/if}
</li>

<style>
  .c-round {
    border-radius: 0.75rem;
  }
</style>
