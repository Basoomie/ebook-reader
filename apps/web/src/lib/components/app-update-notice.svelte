<script lang="ts">
  import type { AppUpdate } from '$lib/app-update/app-update';

  /** Same kind of notice as the reader's "Newer audiobook data from another device." */
  export let appUpdate: AppUpdate;

  const { available } = appUpdate;
  let reloading = false;

  function reload() {
    if (reloading) return;
    reloading = true;
    appUpdate.reload().catch((error) => {
      reloading = false;
      console.warn('App update: reload failed', error);
    });
  }
</script>

{#if $available}
  <div
    class="writing-horizontal-tb fixed inset-x-4 top-4 z-30 mx-auto flex max-w-md items-center gap-2 rounded border-2 border-gray-700 bg-white p-2 text-black"
    role="status"
    data-testid="app-update-notice"
  >
    <span class="grow px-1">New version available.</span>
    <button
      class="min-h-[2.75rem] rounded border-2 border-gray-700 px-3 font-medium"
      data-testid="app-update-reload"
      disabled={reloading}
      on:click={reload}
    >
      Reload
    </button>
    <button
      class="min-h-[2.75rem] px-3"
      aria-label="Close"
      data-testid="app-update-close"
      on:click={() => appUpdate.dismiss()}
    >
      ✕
    </button>
  </div>
{/if}
