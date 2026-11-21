<script lang="ts">
  /**
   * Bulk "Mark completed" (WP8a): one optional finish date for every selected book. The
   * footer holds the action; ✕, Esc or a click outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  export let count: number;
  /** The date (YYYY-MM-DD or null for blank), or undefined when canceled. */
  export let resolver: (finishedOn: string | null | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = `mark-completed-${Math.random().toString(36).slice(2, 10)}`;

  let finishDate = '';
  let done = false;

  function answer(value: string | null | undefined) {
    if (done) return;
    done = true;
    resolver(value);
    dispatch('close');
  }
</script>

<Modal
  title="Mark {count === 1 ? '1 book' : `${count.toLocaleString()} books`} completed"
  size="md"
  testid="mark-completed-dialog"
  on:close={() => answer(undefined)}
>
  <div class="grid gap-4 pb-1 pt-3">
    <p>
      Each book is counted as read once more. Its character count joins your character totals; no
      reading time is added.
    </p>
    <label class="c-modal-field" for={id}>
      <span class="c-modal-label">
        Finish date for all <span class="font-normal text-c-muted">(optional)</span>
      </span>
      <input
        {id}
        class="c-input w-full max-w-[14rem]"
        type="date"
        bind:value={finishDate}
        data-testid="bulk-finish-date"
      />
    </label>
  </div>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-primary"
      data-testid="bulk-mark-completed"
      on:click={() => answer(finishDate || null)}
    >
      Mark completed
    </button>
  </svelte:fragment>
</Modal>
