<script lang="ts">
  /**
   * "Add to which library?" (WP7b, decided with the user): asked on every upload,
   * nothing preselected or remembered. A tap on a library picks it; ✕, Esc or a click
   * outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  export let libraries: { id: string; name: string }[];
  export let fileCount: number;
  export let resolver: (libraryId: string | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let done = false;

  function answer(value: string | undefined) {
    if (done) return;
    done = true;
    resolver(value);
    dispatch('close');
  }
</script>

<Modal
  title="Add to which library?"
  subtitle="{fileCount === 1
    ? 'The book is'
    : `The ${fileCount} books are`} kept on the server, not in Calibre."
  size="sm"
  testid="upload-library-dialog"
  on:close={() => answer(undefined)}
>
  <div class="c-modal-actions">
    {#each libraries as lib (lib.id)}
      <button
        type="button"
        class="c-modal-action"
        data-testid="upload-library"
        on:click={() => answer(lib.id)}
      >
        <span class="c-modal-action-text">
          <span class="c-modal-action-label">{lib.name}</span>
        </span>
      </button>
    {/each}
  </div>
</Modal>
