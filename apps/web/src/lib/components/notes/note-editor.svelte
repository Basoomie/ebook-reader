<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** The inline note editor of a highlight or book-note card (WP11c/WP19d). */
  import { createEventDispatcher } from 'svelte';

  export let initial: string;

  const dispatch = createEventDispatcher<{ save: string; cancel: void }>();
  const smallButton = 'c-btn c-btn-secondary c-btn-sm min-w-[var(--c-btn-h-sm)] px-3 text-sm';

  let text = initial;
</script>

<div class="px-4 pb-3">
  <textarea
    bind:value={text}
    rows="4"
    aria-label="Note"
    class="c-input w-full p-2"
    data-testid="notes-page-edit-text"
  />
  <div class="mt-2 flex justify-end gap-2">
    <button class={smallButton} on:click={() => dispatch('cancel')}>Cancel</button>
    <button
      class="{smallButton} c-btn-primary"
      data-testid="notes-page-edit-save"
      on:click={() => dispatch('save', text)}
    >
      Save
    </button>
  </div>
</div>
