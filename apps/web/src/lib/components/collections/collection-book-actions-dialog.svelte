<script lang="ts" context="module">
  export type CollectionBookAction = 'top' | 'bottom' | 'remove';
</script>

<script lang="ts">
  /** A book's "⋯" while reordering a list (WP8b). Plain for e-ink; Esc cancels. */
  import { createEventDispatcher } from 'svelte';

  export let title: string;
  export let resolver: (action: CollectionBookAction | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  let done = false;

  function answer(action: CollectionBookAction | undefined) {
    if (done) return;
    done = true;
    resolver(action);
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

<section
  class="mdc-elevation--z24 w-full max-w-sm rounded bg-white p-6"
  data-testid="collection-book-actions-dialog"
>
  <h2 class="weight-medium mb-4 line-clamp-2 break-words text-xl">{title}</h2>
  <div class="grid grid-cols-1 gap-2">
    <button class={buttonClass} data-testid="book-move-top" on:click={() => answer('top')}>
      Move to top
    </button>
    <button class={buttonClass} data-testid="book-move-bottom" on:click={() => answer('bottom')}>
      Move to bottom
    </button>
    <button class={buttonClass} data-testid="book-remove" on:click={() => answer('remove')}>
      Remove from collection
    </button>
  </div>
  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
  </footer>
</section>
