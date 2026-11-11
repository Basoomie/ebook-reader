<script lang="ts">
  /**
   * "Highlight removed. Undo" (WP19): small removals that are easy to reverse are not asked
   * about; they offer Undo instead. No timer (thresholds are user settings): the notice stays
   * until Undo, its ✕, the next removal or the view closing.
   */
  import { createEventDispatcher } from 'svelte';

  export let message: string;
  export let buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  export let testid = 'undo-notice';
  export let undoTestid = 'undo-notice-undo';

  const dispatch = createEventDispatcher<{ undo: void; dismiss: void }>();
  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
</script>

<div class="flex flex-wrap items-center gap-2" role="status" data-testid={testid}>
  <span class="grow">{message}</span>
  <button
    class="{buttonClass} {focusRing}"
    data-testid={undoTestid}
    on:click={() => dispatch('undo')}
  >
    Undo
  </button>
  <button
    class="{buttonClass} {focusRing} min-w-[3rem]"
    aria-label="Dismiss"
    title="Dismiss"
    data-testid="{testid}-dismiss"
    on:click={() => dispatch('dismiss')}
  >
    ✕
  </button>
</div>
