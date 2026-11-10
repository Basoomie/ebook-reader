<script lang="ts">
  /**
   * "Add to collection" for one book (WP8b), from the reader's menu. Plain for e-ink like
   * the other library dialogs: no transitions, 48 px bordered buttons, inert backdrop,
   * Esc or Close closes. Changes are saved at once.
   */
  import type { CollectionsApi } from '$lib/sync/sync-service';
  import { createEventDispatcher } from 'svelte';
  import CollectionToggles from './collection-toggles.svelte';

  export let bookId: string;
  export let title: string;
  export let api: CollectionsApi;
  export let resolver: () => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  let done = false;

  function close() {
    if (done) return;
    done = true;
    resolver();
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 max-h-[90vh] max-w-xl overflow-y-auto rounded bg-white p-6"
  data-testid="add-to-collection-dialog"
>
  <h2 class="weight-medium mb-1 text-xl">Add to collection</h2>
  <p class="mb-4 line-clamp-2">{title}</p>
  <CollectionToggles {bookId} {api} />
  <footer class="flex flex-wrap items-center justify-end pt-5">
    <button class={buttonClass} data-testid="add-to-collection-close" on:click={close}>
      Close
    </button>
  </footer>
</section>
