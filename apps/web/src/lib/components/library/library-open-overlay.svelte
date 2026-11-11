<script lang="ts">
  import { buttonClasses } from '$lib/css-classes';
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
        : 'Saving on this device…';
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog">
  <div class="c-panel mx-4 w-full max-w-md rounded p-6" aria-live="polite">
    <div class="mb-2 line-clamp-2 font-medium">{title}</div>
    <div class="mb-6">{text}</div>
    <div class="flex justify-end">
      <button class="{buttonClasses} border border-current" on:click={() => dispatch('cancel')}>
        Cancel
      </button>
    </div>
  </div>
</div>
