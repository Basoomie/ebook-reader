<script lang="ts">
  /**
   * "Opening the book…" progress: the modal frame's look (modal.svelte) without its closing
   * rules: a stray tap outside never cancels the download; Cancel does.
   */
  import type { OpenStage } from '$lib/library/open-calibre-book';
  import { createEventDispatcher } from 'svelte';

  export let title: string;
  export let stage: OpenStage | null;

  const dispatch = createEventDispatcher<{ cancel: void }>();

  function mb(bytes: number) {
    return (bytes / 1_000_000).toFixed(1);
  }

  $: text = !stage
    ? 'Checking…'
    : stage.stage === 'download'
      ? stage.total
        ? `Downloading ${mb(stage.loaded)} of ${mb(stage.total)} MB`
        : `Downloading ${mb(stage.loaded)} MB`
      : stage.stage === 'prepare'
        ? 'Preparing the book…'
        : stage.stage === 'audiobook'
          ? 'Getting audiobook data…'
          : 'Saving on this device…';
</script>

<div class="c-modal-layer">
  <div class="c-modal-backdrop" />
  <section class="c-modal c-modal-sm" role="dialog" aria-modal="true" aria-label={title}>
    <header class="c-modal-head">
      <div class="c-modal-titles">
        <h2 class="c-modal-title line-clamp-2">{title}</h2>
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
