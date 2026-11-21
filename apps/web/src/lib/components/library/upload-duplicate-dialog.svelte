<script lang="ts">
  /**
   * An upload that looks like a book already in the library (WP7b, decided with the
   * user): always asked, never merged. "Use the library copy" drops the upload;
   * "Add as a separate book" keeps both; ✕, Esc or a click outside drop it too.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
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
  let done = false;

  function answer(value: UploadDecision) {
    if (done) return;
    done = true;
    resolver(value);
    dispatch('close');
  }
</script>

<Modal
  title="Already in your library?"
  subtitle="{staged.title}{staged.authors.length ? ` · ${staged.authors.join(', ')}` : ''}"
  size="md"
  testid="upload-duplicate-dialog"
  on:close={() => answer('cancel')}
>
  <ModalSection title="It looks like" count={staged.duplicates.length}>
    <ul>
      {#each staged.duplicates as d (d.book.id)}
        <li class="c-modal-row !items-start" data-testid="upload-duplicate">
          <div class="aspect-[2/3] w-14 shrink-0">
            <CoverImage src={thumbnailUrl(d.book.thumbnail)} compact />
          </div>
          <div class="c-modal-row-main">
            <div class="c-modal-row-title">{d.book.title}</div>
            <div class="c-modal-row-meta">{authorNames(d.book)}</div>
            <div class="c-modal-row-meta">
              {libraryName(d.book.libraryId)}{d.book.source === 'upload' ? ' · Uploaded' : ''}
            </div>
            <div class="text-sm font-semibold" data-testid="upload-duplicate-reason">
              {MATCH_LABELS[d.match]}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  </ModalSection>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-secondary"
      data-testid="upload-add-separate"
      on:click={() => answer('add')}
    >
      Add as a separate book
    </button>
    <button
      type="button"
      class="c-btn c-btn-primary"
      data-testid="upload-use-copy"
      on:click={() => answer('use')}
    >
      Use the library copy
    </button>
  </svelte:fragment>
</Modal>
