<script lang="ts">
  /**
   * The lists one book is in (WP8b), as toggle buttons, plus "New collection…". Used in
   * the Book status dialog and the reader's "Add to collection". Saved at once to the
   * local sync mirror (works offline). Smart collections are not listed: their books
   * follow the search.
   */
  import type { Collection } from '$lib/collections/collections';
  import { checkName } from '$lib/collections/collections';
  import type { CollectionsApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount } from 'svelte';

  export let bookId: string;
  export let api: CollectionsApi;

  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const pressedClass = 'bg-gray-700 text-white border-gray-700';
  const inputClass = 'block w-full border-0 border-b-2 border-gray-400/50 px-0.5 py-2';

  let lists: Collection[] = [];
  let member = new Set<string>();
  let loaded = false;
  let busy = false;
  let error = '';
  let creating = false;
  let newName = '';
  let unsubscribe: (() => void) | undefined;

  onMount(async () => {
    await refresh();
    unsubscribe = await api.onChanged(() => {
      if (!busy) void refresh();
    });
  });

  onDestroy(() => unsubscribe?.());

  async function refresh() {
    const [view, of] = await Promise.all([api.view(), api.ofBook(bookId)]);
    lists = view.collections.filter((c) => c.type === 'manual');
    member = of;
    loaded = true;
  }

  async function run(action: () => Promise<string[] | unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const failed = await action();
      if (Array.isArray(failed) && failed.length) throw new Error('could not save the change');
    } catch (e) {
      error = `Not saved: ${(e as Error)?.message ?? e}`;
    } finally {
      busy = false;
      await refresh();
    }
  }

  function toggle(c: Collection) {
    void run(() =>
      member.has(c.id) ? api.removeBooks(c.id, [bookId]) : api.addBooks(c.id, [bookId])
    );
  }

  function create() {
    const problem = checkName(newName);
    if (problem) {
      error = problem;
      return;
    }
    void run(async () => {
      const id = await api.create({ name: newName, type: 'manual' });
      creating = false;
      newName = '';
      return api.addBooks(id, [bookId]);
    });
  }
</script>

<div data-testid="collection-toggles">
  {#if !loaded}
    <p>Loading…</p>
  {:else}
    {#if lists.length}
      <div class="flex flex-wrap gap-2" role="group" aria-label="Collections">
        {#each lists as c (c.id)}
          <button
            class="{buttonClass} {member.has(c.id) ? pressedClass : ''}"
            aria-pressed={member.has(c.id)}
            disabled={busy}
            data-testid="collection-toggle"
            data-collection={c.id}
            on:click={() => toggle(c)}
          >
            {member.has(c.id) ? '✓ ' : ''}{c.name}
          </button>
        {/each}
      </div>
    {:else}
      <p class="text-sm">You have no manual collections yet.</p>
    {/if}
    {#if creating}
      <form class="mt-3 flex flex-wrap items-end gap-2" on:submit|preventDefault={create}>
        <label class="min-w-[12rem] grow">
          Name
          <!-- svelte-ignore a11y-autofocus -->
          <input
            class={inputClass}
            maxlength="200"
            autofocus
            bind:value={newName}
            data-testid="new-collection-name"
          />
        </label>
        <button class={buttonClass} type="submit" disabled={busy} data-testid="new-collection-save">
          Create and add
        </button>
        <button class={buttonClass} type="button" on:click={() => (creating = false)}>
          Cancel
        </button>
      </form>
    {:else}
      <button
        class="{buttonClass} mt-3"
        disabled={busy}
        data-testid="new-collection"
        on:click={() => {
          creating = true;
          error = '';
        }}
      >
        New collection…
      </button>
    {/if}
  {/if}
  {#if error}
    <p class="pt-2 font-medium" role="alert">{error}</p>
  {/if}
</div>
