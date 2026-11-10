<script lang="ts" context="module">
  export type CollectionAction = 'rename' | 'search' | 'delete' | 'pin' | 'unpin';
</script>

<script lang="ts">
  /**
   * The "⋯" of a collection (WP8b): rename, change the search, delete; and (WP7b) pin
   * to or unpin from Home. A built-in list has only the pin action. Plain for e-ink.
   */
  import type { CollectionType } from '$lib/collections/collections';
  import { createEventDispatcher } from 'svelte';

  export let name: string;
  export let type: CollectionType | 'builtin';
  /** Whether it is on this device's Home (null: no pin action). */
  export let pinned: boolean | null = null;
  export let resolver: (action: CollectionAction | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  let done = false;

  function answer(action: CollectionAction | undefined) {
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
  data-testid="collection-actions-dialog"
>
  <h2 class="weight-medium mb-4 line-clamp-2 break-words text-xl">{name}</h2>
  <div class="grid grid-cols-1 gap-2">
    {#if pinned !== null}
      <button
        class={buttonClass}
        data-testid="collection-pin"
        on:click={() => answer(pinned ? 'unpin' : 'pin')}
      >
        {pinned ? 'Unpin from Home' : 'Pin to Home'}
      </button>
    {/if}
    {#if type !== 'builtin'}
      <button class={buttonClass} data-testid="collection-rename" on:click={() => answer('rename')}>
        Rename
      </button>
    {/if}
    {#if type === 'smart'}
      <button
        class={buttonClass}
        data-testid="collection-edit-search"
        on:click={() => answer('search')}
      >
        Change the search
      </button>
    {/if}
    {#if type !== 'builtin'}
      <button class={buttonClass} data-testid="collection-delete" on:click={() => answer('delete')}>
        Delete…
      </button>
    {/if}
  </div>
  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
  </footer>
</section>
