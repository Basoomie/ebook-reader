<script lang="ts" context="module">
  export type CollectionPick = { id: string } | { newName: string };
</script>

<script lang="ts">
  /**
   * Picks the list to add the selected books to, or to take them out of (WP8b, select
   * mode). Adding can also make a new list. A tap on a list picks it; ✕, Esc or a click
   * outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import { checkName, type Collection } from '$lib/collections/collections';
  import { createEventDispatcher } from 'svelte';

  export let action: 'add' | 'remove';
  export let count: number;
  /** Lists to offer (saved searches can't hold books). */
  export let collections: Collection[];
  export let resolver: (pick: CollectionPick | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();

  let done = false;
  let newName = '';
  let error = '';

  $: books = count === 1 ? '1 book' : `${count.toLocaleString()} books`;

  function answer(pick: CollectionPick | undefined) {
    if (done) return;
    done = true;
    resolver(pick);
    dispatch('close');
  }

  function createNew() {
    const problem = checkName(newName);
    if (problem) {
      error = problem;
      return;
    }
    answer({ newName: newName.trim() });
  }
</script>

<Modal
  title={action === 'add' ? `Add ${books} to…` : `Remove ${books} from…`}
  size="md"
  dirty={!done && newName.trim() !== ''}
  testid="collection-pick-dialog"
  on:close={() => answer(undefined)}
>
  <ModalSection title="Your collections" count={collections.length}>
    {#if collections.length}
      <div class="c-modal-actions !py-0">
        {#each collections as c (c.id)}
          <button
            type="button"
            class="c-modal-action"
            data-testid="collection-pick"
            data-collection={c.id}
            on:click={() => answer({ id: c.id })}
          >
            <span class="c-modal-action-text">
              <span class="c-modal-action-label [overflow-wrap:anywhere]">{c.name}</span>
            </span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="text-sm text-c-muted">You have no manual collections yet.</p>
    {/if}
  </ModalSection>
  {#if action === 'add'}
    <ModalSection title="New collection" hint="Makes the collection and adds the books to it.">
      <form class="flex flex-wrap items-end gap-2" on:submit|preventDefault={createNew}>
        <label class="c-modal-field min-w-[12rem] flex-1">
          <span class="sr-only">Name</span>
          <input
            class="c-input w-full"
            maxlength="200"
            placeholder="Name"
            bind:value={newName}
            data-testid="pick-new-name"
          />
        </label>
        <button class="c-btn c-btn-secondary" type="submit" data-testid="pick-new-save">
          Create and add
        </button>
      </form>
      {#if error}
        <p class="c-modal-error" role="alert"><span aria-hidden="true">⚠</span>{error}</p>
      {/if}
    </ModalSection>
  {/if}
</Modal>
