<script lang="ts">
  /** Upload progress (WP7b): which file, how far, and Cancel. No animation (e-ink). */
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

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog">
  <div
    class="c-panel mx-4 w-full max-w-md rounded p-6"
    aria-live="polite"
    data-testid="upload-progress"
  >
    {#if count > 1}
      <div class="mb-1 text-sm">File {index + 1} of {count}</div>
    {/if}
    <div class="mb-2 line-clamp-2 break-all font-medium">{name}</div>
    <div class="mb-6">{text}</div>
    <div class="flex justify-end">
      <button
        class="flex min-h-[3rem] items-center rounded border-2 border-current px-5 font-medium"
        on:click={() => dispatch('cancel')}
      >
        Cancel
      </button>
    </div>
  </div>
</div>
