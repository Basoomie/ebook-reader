<script lang="ts">
  /** What happened to each uploaded file (WP7b), with "Open" for the books. E-ink plain. */
  import type { CatalogBook } from '$lib/library/types';
  import type { UploadResult } from '$lib/library/upload-flow';
  import { createEventDispatcher } from 'svelte';

  export let results: UploadResult[];
  /** The book to open, or undefined. */
  export let resolver: (book: CatalogBook | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  let done = false;

  function answer(value: CatalogBook | undefined) {
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

  const LABELS: Record<UploadResult['status'], string> = {
    added: 'Added',
    'used-copy': 'Using the library copy',
    cancelled: 'Cancelled',
    failed: 'Not added'
  };
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 w-full max-w-lg rounded bg-white p-6"
  data-testid="upload-summary-dialog"
>
  <h2 class="weight-medium mb-4 text-xl">Upload</h2>
  <ul class="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
    {#each results as r, i (i)}
      <li class="flex flex-wrap items-center justify-between gap-2" data-testid="upload-result">
        <div class="min-w-0">
          <div class="break-all font-medium">{r.name}</div>
          <div class="text-sm" data-testid="upload-result-status">
            {LABELS[r.status]}{r.status === 'failed' ? `: ${r.message}` : ''}
          </div>
        </div>
        {#if r.status === 'added' || r.status === 'used-copy'}
          <button class={buttonClass} data-testid="upload-open" on:click={() => answer(r.book)}>
            Open
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  <footer class="flex justify-end pt-5">
    <button
      class={buttonClass}
      data-testid="upload-summary-close"
      on:click={() => answer(undefined)}>Close</button
    >
  </footer>
</section>
