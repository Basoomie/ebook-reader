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
    class="c-reader-notice writing-horizontal-tb fixed inset-x-4 top-4 z-30 mx-auto flex max-w-md items-center gap-2 p-2"
    role="status"
    data-testid="app-update-notice"
  >
    <span class="grow px-1">New version available.</span>
    <button
      class="c-btn c-btn-secondary c-btn-sm shrink-0 px-3"
      data-testid="app-update-reload"
      disabled={reloading}
      on:click={reload}
    >
      Reload
    </button>
    <button
      class="c-btn c-btn-ghost c-btn-icon c-btn-sm"
      aria-label="Close"
      data-testid="app-update-close"
      on:click={() => appUpdate.dismiss()}
    >
      ✕
    </button>
  </div>
{/if}
