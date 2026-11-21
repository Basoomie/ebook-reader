<script lang="ts" context="module">
  import type { CollectionType } from '$lib/collections/collections';

  export interface CollectionEditValues {
    name: string;
    type: CollectionType;
    query: string;
  }
</script>

<script lang="ts">
  /**
   * New collection, rename, or change a saved search (WP8b). `save` stores the values and
   * resolves to the collection id; its error is shown here. The footer holds the one action
   * (Create / Save); ✕, Esc or a click outside cancel, asking first when something was typed.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { checkName, checkQuery } from '$lib/collections/collections';
  import { createEventDispatcher } from 'svelte';

  export let mode: 'new' | 'rename' | 'search' = 'new';
  export let name = '';
  export let type: CollectionType = 'manual';
  export let query = '';
  /** New collections: offer both kinds (false = only the given type). */
  export let chooseType = true;
  export let save: (values: CollectionEditValues) => Promise<string>;
  /** The saved collection's id, or undefined when canceled. */
  export let resolver: (id: string | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const titles = {
    new: 'New collection',
    rename: 'Rename collection',
    search: 'Change the search'
  };
  const formId = `collection-edit-${Math.random().toString(36).slice(2, 10)}`;
  const initial = { name, type, query };

  let error = '';
  let busy = false;
  let done = false;

  $: dirty =
    !done &&
    (name.trim() !== initial.name.trim() ||
      query.trim() !== initial.query.trim() ||
      type !== initial.type);

  function answer(id: string | undefined) {
    if (done) return;
    done = true;
    resolver(id);
    dispatch('close');
  }

  async function submit() {
    if (busy) return;
    const problem =
      (mode !== 'search' ? checkName(name) : null) ??
      (type === 'smart' && mode !== 'rename' ? checkQuery(query) : null);
    if (problem) {
      error = problem;
      return;
    }
    busy = true;
    error = '';
    try {
      answer(await save({ name: name.trim(), type, query: query.trim() }));
    } catch (e) {
      error = `Not saved: ${(e as Error)?.message ?? e}`;
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  title={titles[mode]}
  subtitle={mode === 'new' ? '' : initial.name}
  size="md"
  {dirty}
  testid="collection-edit-dialog"
  on:close={() => answer(undefined)}
>
  <form id={formId} class="grid gap-4 pb-1 pt-4" on:submit|preventDefault={submit}>
    {#if mode !== 'search'}
      <label class="c-modal-field">
        <span class="c-modal-label">Name</span>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="c-input w-full"
          maxlength="200"
          autofocus
          bind:value={name}
          data-testid="collection-name"
        />
      </label>
    {/if}
    {#if mode === 'new' && chooseType}
      <div class="c-modal-field">
        <span class="c-modal-label" id="{formId}-kind">Kind</span>
        <div>
          <div class="c-choice" role="group" aria-labelledby="{formId}-kind">
            <button
              type="button"
              aria-pressed={type === 'manual'}
              data-testid="collection-type-manual"
              on:click={() => (type = 'manual')}
            >
              Manual
            </button>
            <button
              type="button"
              aria-pressed={type === 'smart'}
              data-testid="collection-type-smart"
              on:click={() => (type = 'smart')}
            >
              Smart
            </button>
          </div>
        </div>
        <p class="c-modal-hint !mb-0">
          {type === 'manual'
            ? 'Books you add yourself, in your own order, like a reading queue. Add them from the Library or the reader.'
            : 'Always shows the books that match a search right now.'}
        </p>
      </div>
    {/if}
    {#if type === 'smart' && mode !== 'rename'}
      <label class="c-modal-field">
        <span class="c-modal-label">Search</span>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="c-input w-full"
          type="search"
          autocapitalize="off"
          spellcheck="false"
          maxlength="500"
          autofocus={mode === 'search'}
          placeholder="e.g. tag:SF chars:<100000"
          bind:value={query}
          data-testid="collection-query"
        />
        <span class="c-modal-hint !mb-0">
          The same search as the Library's search box (see Search help there).
        </span>
      </label>
    {/if}
    {#if error}
      <p class="c-modal-error" role="alert" data-testid="collection-edit-error">
        <span aria-hidden="true">⚠</span>{error}
      </p>
    {/if}
  </form>
  <svelte:fragment slot="footer">
    <button
      type="submit"
      form={formId}
      class="c-btn c-btn-primary"
      disabled={busy}
      data-testid="collection-save"
    >
      {mode === 'new' ? 'Create collection' : 'Save'}
    </button>
  </svelte:fragment>
</Modal>
