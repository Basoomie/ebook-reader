<script lang="ts" context="module">
  export type CollectionPick = { id: string } | { newName: string };
</script>

<script lang="ts">
  /**
   * Picks the list to add the selected books to, or to take them out of (WP8b, select
   * mode). Adding can also make a new list. Plain for e-ink; Esc cancels.
   */
  import { checkName, type Collection } from '$lib/collections/collections';
  import { createEventDispatcher } from 'svelte';

  export let action: 'add' | 'remove';
  export let count: number;
  /** Lists to offer (saved searches can't hold books). */
  export let collections: Collection[];
  export let resolver: (pick: CollectionPick | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const inputClass = 'block w-full border-0 border-b-2 border-gray-400/50 px-0.5 py-2';

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

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      answer(undefined);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded bg-white p-6"
  data-testid="collection-pick-dialog"
>
  <h2 class="weight-medium mb-4 text-xl">
    {action === 'add' ? `Add ${books} to…` : `Remove ${books} from…`}
  </h2>
  {#if collections.length}
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {#each collections as c (c.id)}
        <button
          class="{buttonClass} break-all"
          data-testid="collection-pick"
          data-collection={c.id}
          on:click={() => answer({ id: c.id })}
        >
          {c.name}
        </button>
      {/each}
    </div>
  {:else}
    <p>You have no collections yet.</p>
  {/if}
  {#if action === 'add'}
    <form class="mt-5 flex flex-wrap items-end gap-2" on:submit|preventDefault={createNew}>
      <label class="min-w-[12rem] grow">
        New collection
        <input
          class={inputClass}
          maxlength="200"
          bind:value={newName}
          data-testid="pick-new-name"
        />
      </label>
      <button class={buttonClass} type="submit" data-testid="pick-new-save">Create and add</button>
    </form>
  {/if}
  {#if error}
    <p class="pt-2 font-medium" role="alert">{error}</p>
  {/if}
  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
  </footer>
</section>
