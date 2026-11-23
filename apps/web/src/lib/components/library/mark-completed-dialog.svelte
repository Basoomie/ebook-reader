<script lang="ts">
  /**
   * Bulk "Mark completed" (WP8a): one optional finish date for every selected book. The
   * footer holds the action; ✕, Esc or a click outside cancel (modal.svelte).
   *
   * Book summaries (session 3): when some of the books would get a summary (their first
   * completion, no summary yet, text to read), a line asks first with about what it costs,
   * checked by default (decided with the user, 2026-11-23); unticked, none is made for them.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { bulkSummaryLine } from '$lib/summaries/bulk-summaries';
  import { createEventDispatcher } from 'svelte';

  export let count: number;
  /** The books that would get a summary and about what it costs (null: none would). */
  export let summaries: { count: number; usd: number | null } | null = null;
  /** The date (YYYY-MM-DD or null for blank) and the summary answer, or undefined when canceled. */
  export let resolver: (
    answer: { finishedOn: string | null; makeSummaries: boolean } | undefined
  ) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = `mark-completed-${Math.random().toString(36).slice(2, 10)}`;

  let finishDate = '';
  let makeSummaries = true;
  let done = false;

  function answer(value: { finishedOn: string | null; makeSummaries: boolean } | undefined) {
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
    {#if summaries && summaries.count > 0}
      <label class="flex items-start gap-2" data-testid="bulk-summaries">
        <input
          type="checkbox"
          class="mt-1"
          bind:checked={makeSummaries}
          data-testid="bulk-summaries-check"
        />
        <span>{bulkSummaryLine(summaries.count, summaries.usd)}</span>
      </label>
    {/if}
  </div>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-primary"
      data-testid="bulk-mark-completed"
      on:click={() =>
        answer({
          finishedOn: finishDate || null,
          makeSummaries: !!summaries && summaries.count > 0 && makeSummaries
        })}
    >
      Mark completed
    </button>
  </svelte:fragment>
</Modal>
