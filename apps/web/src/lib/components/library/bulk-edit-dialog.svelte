<script lang="ts" context="module">
  import type { BookBlur, BookStatus } from '$lib/sync/book-state';

  export type BulkChange =
    | { kind: 'status'; status: BookStatus }
    | { kind: 'favorite'; favorite: boolean }
    | { kind: 'blur'; blur: BookBlur }
    | { kind: 'collection'; action: 'add' | 'remove' };
</script>

<script lang="ts">
  /**
   * Bulk changes for the selected books (WP7a): status, favorite, cover and (WP8b) adding
   * to or removing from a collection, which continues to the collection picker. One tap
   * applies a change and closes the dialog; "Completed…" continues to the finish-date step.
   * ✕, Esc or a click outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import { createEventDispatcher } from 'svelte';

  export let count: number;
  /** The chosen change, or undefined when canceled. */
  export let resolver: (change: BulkChange | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const button = 'c-btn c-btn-secondary';

  let done = false;

  function answer(change: BulkChange | undefined) {
    if (done) return;
    done = true;
    resolver(change);
    dispatch('close');
  }
</script>

<Modal
  title="Change {count === 1 ? '1 book' : `${count.toLocaleString()} books`}"
  subtitle="One tap changes every selected book."
  size="md"
  testid="bulk-edit-dialog"
  on:close={() => answer(undefined)}
>
  <ModalSection title="Status">
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <button
        type="button"
        class={button}
        data-testid="bulk-status-unread"
        on:click={() => answer({ kind: 'status', status: 'unread' })}
      >
        Unread
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-status-reading"
        on:click={() => answer({ kind: 'status', status: 'reading' })}
      >
        Reading
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-status-completed"
        on:click={() => answer({ kind: 'status', status: 'completed' })}
      >
        Completed…
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-status-dropped"
        on:click={() => answer({ kind: 'status', status: 'dropped' })}
      >
        Dropped
      </button>
    </div>
  </ModalSection>

  <ModalSection title="Favorites">
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button
        type="button"
        class={button}
        data-testid="bulk-favorite-add"
        on:click={() => answer({ kind: 'favorite', favorite: true })}
      >
        Add to favorites
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-favorite-remove"
        on:click={() => answer({ kind: 'favorite', favorite: false })}
      >
        Remove from favorites
      </button>
    </div>
  </ModalSection>

  <ModalSection title="Collection" hint="Continues to a list of your collections.">
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button
        type="button"
        class={button}
        data-testid="bulk-collection-add"
        on:click={() => answer({ kind: 'collection', action: 'add' })}
      >
        Add to…
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-collection-remove"
        on:click={() => answer({ kind: 'collection', action: 'remove' })}
      >
        Remove from…
      </button>
    </div>
  </ModalSection>

  <ModalSection title="Blur the cover">
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <button
        type="button"
        class={button}
        data-testid="bulk-blur-inherit"
        on:click={() => answer({ kind: 'blur', blur: 'inherit' })}
      >
        Follow tag rules
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-blur-always"
        on:click={() => answer({ kind: 'blur', blur: 'always' })}
      >
        Always blur
      </button>
      <button
        type="button"
        class={button}
        data-testid="bulk-blur-never"
        on:click={() => answer({ kind: 'blur', blur: 'never' })}
      >
        Never blur
      </button>
    </div>
  </ModalSection>
</Modal>
