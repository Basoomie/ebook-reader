<script lang="ts">
  /**
   * What happened to each uploaded file (WP7b), with "Open" on the books' rows. Nothing
   * to save: ✕, Esc or a click outside close (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import type { CatalogBook } from '$lib/library/types';
  import type { UploadResult } from '$lib/library/upload-flow';
  import { createEventDispatcher } from 'svelte';

  export let results: UploadResult[];
  /** The book to open, or undefined. */
  export let resolver: (book: CatalogBook | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let done = false;

  function answer(value: CatalogBook | undefined) {
    if (done) return;
    done = true;
    resolver(value);
    dispatch('close');
  }

  const LABELS: Record<UploadResult['status'], string> = {
    added: 'Added',
    'used-copy': 'Using the library copy',
    cancelled: 'Cancelled',
    failed: 'Not added'
  };
</script>

<Modal
  title="Upload"
  subtitle={results.length === 1 ? '1 file' : `${results.length} files`}
  size="md"
  testid="upload-summary-dialog"
  closeTestid="upload-summary-close"
  on:close={() => answer(undefined)}
>
  <ul class="py-2">
    {#each results as r, i (i)}
      <li class="c-modal-row" data-testid="upload-result">
        <div class="c-modal-row-main">
          <div class="c-modal-row-title [overflow-wrap:anywhere]">{r.name}</div>
          <div class="c-modal-row-meta" data-testid="upload-result-status">
            {LABELS[r.status]}{r.status === 'failed' ? `: ${r.message}` : ''}
          </div>
        </div>
        {#if r.status === 'added' || r.status === 'used-copy'}
          <div class="c-modal-row-actions">
            <button
              type="button"
              class="c-btn c-btn-secondary c-btn-sm"
              data-testid="upload-open"
              on:click={() => answer(r.book)}
            >
              Open
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</Modal>
