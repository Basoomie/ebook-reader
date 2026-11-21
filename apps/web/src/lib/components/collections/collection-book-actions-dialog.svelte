<script lang="ts" context="module">
  export type CollectionBookAction = 'top' | 'bottom' | 'remove';
</script>

<script lang="ts">
  /**
   * A book's "⋯" while reordering a list (WP8b): a list of actions, Remove last in red;
   * ✕, Esc or a click outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  export let title: string;
  export let resolver: (action: CollectionBookAction | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let done = false;

  function answer(action: CollectionBookAction | undefined) {
    if (done) return;
    done = true;
    resolver(action);
    dispatch('close');
  }
</script>

<Modal
  {title}
  subtitle="In this collection"
  size="sm"
  testid="collection-book-actions-dialog"
  on:close={() => answer(undefined)}
>
  <div class="c-modal-actions">
    <button
      type="button"
      class="c-modal-action"
      data-testid="book-move-top"
      on:click={() => answer('top')}
    >
      <span class="c-modal-action-text">
        <span class="c-modal-action-label">Move to top</span>
      </span>
    </button>
    <button
      type="button"
      class="c-modal-action"
      data-testid="book-move-bottom"
      on:click={() => answer('bottom')}
    >
      <span class="c-modal-action-text">
        <span class="c-modal-action-label">Move to bottom</span>
      </span>
    </button>
    <button
      type="button"
      class="c-modal-action is-danger"
      data-testid="book-remove"
      on:click={() => answer('remove')}
    >
      <span class="c-modal-action-text">
        <span class="c-modal-action-label">Remove from collection</span>
        <span class="c-modal-action-hint">The book stays in your library.</span>
      </span>
    </button>
  </div>
</Modal>
