<script lang="ts">
  /**
   * Bulk "Mark completed" (WP8a): one optional finish date for every selected
   * book. Plain for e-ink like the Book status dialog; Esc cancels.
   */
  import { createEventDispatcher } from 'svelte';

  export let count: number;
  /** The date (YYYY-MM-DD or null for blank), or undefined when canceled. */
  export let resolver: (finishedOn: string | null | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';

  let finishDate = '';
  let done = false;

  function answer(value: string | null | undefined) {
    if (done) return;
    done = true;
    resolver(value);
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      answer(undefined);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section class="mdc-elevation--z24 rounded bg-white p-6" data-testid="mark-completed-dialog">
  <h2 class="weight-medium mb-4 text-xl">
    Mark {count === 1 ? '1 book' : `${count} books`} completed
  </h2>
  <div class="max-w-xl">
    <p class="mb-3">
      Each book is counted as read once more. Its character count joins your character totals; no
      reading time is added.
    </p>
    <label class="block max-w-xs">
      Finish date for all (optional)
      <input
        class="mt-1 block w-full border-0 border-b-2 border-gray-400/50 px-0.5"
        type="date"
        bind:value={finishDate}
        data-testid="bulk-finish-date"
      />
    </label>
  </div>
  <footer class="flex flex-wrap items-center justify-end gap-2 pt-5">
    <button class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
    <button
      class={buttonClass}
      data-testid="bulk-mark-completed"
      on:click={() => answer(finishDate || null)}
    >
      Mark completed
    </button>
  </footer>
</section>
