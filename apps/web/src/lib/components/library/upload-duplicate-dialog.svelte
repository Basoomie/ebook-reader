<script lang="ts">
  /**
   * An upload that looks like a book already in the library (WP7b, decided with the
   * user): always asked, never merged. "Use the library copy" drops the upload;
   * "Add as a separate book" keeps both; "Cancel" drops it too. Plain for e-ink.
   */
  import { authorNames } from '$lib/library/format';
  import type { StagedUpload } from '$lib/library/types';
  import { MATCH_LABELS, type UploadDecision } from '$lib/library/upload-flow';
  import { createEventDispatcher } from 'svelte';
  import CoverImage from './cover-image.svelte';

  export let staged: StagedUpload;
  export let thumbnailUrl: (relative: string | null) => string;
  export let libraryName: (id: string) => string;
  export let resolver: (decision: UploadDecision) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';
  let done = false;

  function answer(value: UploadDecision) {
    if (done) return;
    done = true;
    resolver(value);
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      answer('cancel');
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 w-full max-w-lg rounded bg-white p-6"
  data-testid="upload-duplicate-dialog"
>
  <h2 class="weight-medium mb-2 text-xl">Already in your library?</h2>
  <p class="mb-4 break-words">
    "{staged.title}"{staged.authors.length ? ` by ${staged.authors.join(', ')}` : ''} looks like:
  </p>
  <ul class="mb-2 flex max-h-[45vh] flex-col gap-3 overflow-y-auto">
    {#each staged.duplicates as d (d.book.id)}
      <li class="flex gap-3" data-testid="upload-duplicate">
        <div class="aspect-[2/3] w-16 shrink-0">
          <CoverImage src={thumbnailUrl(d.book.thumbnail)} compact />
        </div>
        <div class="min-w-0">
          <div class="break-words font-medium">{d.book.title}</div>
          <div class="text-sm">{authorNames(d.book)}</div>
          <div class="text-sm">
            {libraryName(d.book.libraryId)}{d.book.source === 'upload' ? ' · Uploaded' : ''}
          </div>
          <div class="text-sm font-medium" data-testid="upload-duplicate-reason">
            {MATCH_LABELS[d.match]}
          </div>
        </div>
      </li>
    {/each}
  </ul>
  <footer class="flex flex-wrap items-center justify-end gap-2 pt-4">
    <button class={buttonClass} on:click={() => answer('cancel')}>Cancel</button>
    <button class={buttonClass} data-testid="upload-add-separate" on:click={() => answer('add')}>
      Add as a separate book
    </button>
    <button
      class="{buttonClass} border-gray-800 bg-gray-800 text-white"
      data-testid="upload-use-copy"
      on:click={() => answer('use')}
    >
      Use the library copy
    </button>
  </footer>
</section>
