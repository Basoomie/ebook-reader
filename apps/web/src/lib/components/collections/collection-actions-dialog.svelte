<script lang="ts" context="module">
  export type CollectionAction = 'rename' | 'search' | 'delete' | 'pin' | 'unpin';
</script>

<script lang="ts">
  /**
   * The "⋯" of a collection (WP8b): rename, change the search, delete; and (WP7b) pin
   * to or unpin from Home. A built-in list has only the pin action. A list of actions,
   * Delete last in red; ✕, Esc or a click outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import type { CollectionType } from '$lib/collections/collections';
  import { createEventDispatcher } from 'svelte';

  export let name: string;
  export let type: CollectionType | 'builtin';
  /** Whether it is on this device's Home (null: no pin action). */
  export let pinned: boolean | null = null;
  export let resolver: (action: CollectionAction | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let done = false;

  function answer(action: CollectionAction | undefined) {
    if (done) return;
    done = true;
    resolver(action);
    dispatch('close');
  }
</script>

<Modal
  title={name}
  subtitle="Collection"
  size="sm"
  testid="collection-actions-dialog"
  on:close={() => answer(undefined)}
>
  <div class="c-modal-actions">
    {#if pinned !== null}
      <button
        type="button"
        class="c-modal-action"
        data-testid="collection-pin"
        on:click={() => answer(pinned ? 'unpin' : 'pin')}
      >
        <span class="c-modal-action-text">
          <span class="c-modal-action-label">{pinned ? 'Unpin from Home' : 'Pin to Home'}</span>
          <span class="c-modal-action-hint">
            {pinned
              ? 'Its row leaves Home on this device.'
              : 'Shows it as a row on Home on this device.'}
          </span>
        </span>
      </button>
    {/if}
    {#if type !== 'builtin'}
      <button
        type="button"
        class="c-modal-action"
        data-testid="collection-rename"
        on:click={() => answer('rename')}
      >
        <span class="c-modal-action-text">
          <span class="c-modal-action-label">Rename</span>
        </span>
      </button>
    {/if}
    {#if type === 'smart'}
      <button
        type="button"
        class="c-modal-action"
        data-testid="collection-edit-search"
        on:click={() => answer('search')}
      >
        <span class="c-modal-action-text">
          <span class="c-modal-action-label">Change the search</span>
          <span class="c-modal-action-hint">Which books it holds.</span>
        </span>
      </button>
    {/if}
    {#if type !== 'builtin'}
      <button
        type="button"
        class="c-modal-action is-danger"
        data-testid="collection-delete"
        on:click={() => answer('delete')}
      >
        <span class="c-modal-action-text">
          <span class="c-modal-action-label">Delete…</span>
          <span class="c-modal-action-hint">The books stay in your library.</span>
        </span>
      </button>
    {/if}
  </div>
</Modal>
