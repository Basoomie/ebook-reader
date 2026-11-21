<script lang="ts">
  /**
   * "Add to collection" for one book (WP8b), from the reader's menu. Changes are saved at
   * once, so there is no footer: ✕, Esc or a click outside closes (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import type { CollectionsApi } from '$lib/sync/sync-service';
  import { createEventDispatcher } from 'svelte';
  import CollectionToggles from './collection-toggles.svelte';

  export let bookId: string;
  export let title: string;
  export let api: CollectionsApi;
  export let resolver: () => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let done = false;

  function close() {
    if (done) return;
    done = true;
    resolver();
    dispatch('close');
  }
</script>

<Modal
  title="Add to collection"
  subtitle={title}
  size="md"
  testid="add-to-collection-dialog"
  closeTestid="add-to-collection-close"
  on:close={close}
>
  <div class="pb-1 pt-4">
    <p class="c-modal-hint">Tap a collection to add or remove this book.</p>
    <CollectionToggles {bookId} {api} />
  </div>
</Modal>
