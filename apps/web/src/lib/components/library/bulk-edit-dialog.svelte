<script lang="ts" context="module">
  import type { BookBlur, BookStatus } from '$lib/sync/book-state';

  export type BulkChange =
    | { kind: 'status'; status: BookStatus }
    | { kind: 'favorite'; favorite: boolean }
    | { kind: 'blur'; blur: BookBlur };
</script>

<script lang="ts">
  /**
   * Bulk changes for the selected books (WP7a): status, favorite and cover. One choice
   * closes the dialog; "Completed…" continues to the finish-date step. Plain for e-ink
   * (WP8a dialogs): 48 px bordered buttons, inert backdrop, Esc cancels.
   */
  import { createEventDispatcher } from 'svelte';

  export let count: number;
  /** The chosen change, or undefined when canceled. */
  export let resolver: (change: BulkChange | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';

  let done = false;

  function answer(change: BulkChange | undefined) {
    if (done) return;
    done = true;
    resolver(change);
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      answer(undefined);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section class="mdc-elevation--z24 max-w-lg rounded bg-white p-6" data-testid="bulk-edit-dialog">
  <h2 class="weight-medium mb-4 text-xl">
    Change {count === 1 ? '1 book' : `${count.toLocaleString()} books`}
  </h2>

  <h3 class="mb-2 font-medium">Status</h3>
  <div class="mb-5 grid grid-cols-2 gap-2">
    <button
      class={buttonClass}
      data-testid="bulk-status-unread"
      on:click={() => answer({ kind: 'status', status: 'unread' })}
    >
      Unread
    </button>
    <button
      class={buttonClass}
      data-testid="bulk-status-reading"
      on:click={() => answer({ kind: 'status', status: 'reading' })}
    >
      Reading
    </button>
    <button
      class={buttonClass}
      data-testid="bulk-status-dropped"
      on:click={() => answer({ kind: 'status', status: 'dropped' })}
    >
      Dropped
    </button>
    <button
      class={buttonClass}
      data-testid="bulk-status-completed"
      on:click={() => answer({ kind: 'status', status: 'completed' })}
    >
      Completed…
    </button>
  </div>

  <h3 class="mb-2 font-medium">Favorites</h3>
  <div class="mb-5 grid grid-cols-2 gap-2">
    <button
      class={buttonClass}
      data-testid="bulk-favorite-add"
      on:click={() => answer({ kind: 'favorite', favorite: true })}
    >
      Add to favorites
    </button>
    <button
      class={buttonClass}
      data-testid="bulk-favorite-remove"
      on:click={() => answer({ kind: 'favorite', favorite: false })}
    >
      Remove from favorites
    </button>
  </div>

  <h3 class="mb-2 font-medium">Cover</h3>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
    <button
      class={buttonClass}
      data-testid="bulk-blur-inherit"
      on:click={() => answer({ kind: 'blur', blur: 'inherit' })}
    >
      Follow tag rules
    </button>
    <button
      class={buttonClass}
      data-testid="bulk-blur-always"
      on:click={() => answer({ kind: 'blur', blur: 'always' })}
    >
      Always blur
    </button>
    <button
      class={buttonClass}
      data-testid="bulk-blur-never"
      on:click={() => answer({ kind: 'blur', blur: 'never' })}
    >
      Never blur
    </button>
  </div>

  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
  </footer>
</section>
