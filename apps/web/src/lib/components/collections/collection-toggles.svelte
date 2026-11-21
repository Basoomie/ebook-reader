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

<div class="grid gap-3" data-testid="collection-toggles">
  {#if !loaded}
    <p class="text-sm text-c-muted">Loading…</p>
  {:else}
    {#if lists.length}
      <div class="flex flex-wrap gap-2" role="group" aria-label="Collections">
        {#each lists as c (c.id)}
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-sm"
            aria-pressed={member.has(c.id)}
            disabled={busy}
            data-testid="collection-toggle"
            data-collection={c.id}
            on:click={() => toggle(c)}
          >
            <span aria-hidden="true">{member.has(c.id) ? '✓' : '+'}</span>{c.name}
          </button>
        {/each}
      </div>
    {:else}
      <p class="text-sm text-c-muted">You have no manual collections yet.</p>
    {/if}
    {#if creating}
      <form class="c-modal-inline" on:submit|preventDefault={create}>
        <label class="c-modal-field">
          <span class="c-modal-label">New collection</span>
          <!-- svelte-ignore a11y-autofocus -->
          <input
            class="c-input w-full"
            maxlength="200"
            autofocus
            bind:value={newName}
            data-testid="new-collection-name"
          />
        </label>
        <div class="c-modal-inline-btns">
          <button
            class="c-btn c-btn-secondary c-btn-sm"
            type="button"
            on:click={() => (creating = false)}
          >
            Cancel
          </button>
          <button
            class="c-btn c-btn-primary c-btn-sm"
            type="submit"
            disabled={busy}
            data-testid="new-collection-save"
          >
            Create and add
          </button>
        </div>
      </form>
    {:else}
      <div>
        <button
          type="button"
          class="c-btn c-btn-ghost c-btn-sm c-btn-flush-start"
          disabled={busy}
          data-testid="new-collection"
          on:click={() => {
            creating = true;
            error = '';
          }}
        >
          + New collection…
        </button>
      </div>
    {/if}
  {/if}
  {#if error}
    <p class="c-modal-error" role="alert"><span aria-hidden="true">⚠</span>{error}</p>
  {/if}
</div>
