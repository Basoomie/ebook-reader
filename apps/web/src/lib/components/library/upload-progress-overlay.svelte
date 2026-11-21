<script lang="ts">
  /**
   * Upload progress (WP7b): which file, how far, and Cancel. The modal frame's look
   * (modal.svelte) without its closing rules: a stray tap outside never cancels the upload.
   */
  import { createEventDispatcher } from 'svelte';

  export let index: number;
  export let count: number;
  export let name: string;
  export let loaded: number;
  export let total: number;

  const dispatch = createEventDispatcher<{ cancel: void }>();

  function mb(bytes: number) {
    return (bytes / 1_000_000).toFixed(1);
  }

  $: text =
    total > 0 && loaded >= total
      ? 'Checking the library for this book…'
      : `Uploading ${mb(loaded)} of ${mb(total)} MB`;
</script>

<div class="c-modal-layer">
  <div class="c-modal-backdrop" />
  <section
    class="c-modal c-modal-sm"
    role="dialog"
    aria-modal="true"
    aria-label="Uploading"
    data-testid="upload-progress"
  >
    <header class="c-modal-head">
      <div class="c-modal-titles">
        {#if count > 1}
          <p class="c-modal-sub !mt-0">File {index + 1} of {count}</p>
        {/if}
        <h2 class="c-modal-title line-clamp-2 break-all">{name}</h2>
        <p class="c-modal-sub" aria-live="polite">{text}</p>
      </div>
    </header>
    <footer class="c-modal-foot">
      <div class="c-modal-btns">
        <button type="button" class="c-btn c-btn-secondary" on:click={() => dispatch('cancel')}>
          Cancel
        </button>
      </div>
    </footer>
  </section>
</div>
