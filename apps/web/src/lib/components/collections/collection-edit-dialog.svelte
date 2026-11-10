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
   * resolves to the collection id; its error is shown here. Plain for e-ink: no
   * transitions, 48 px bordered buttons, inert backdrop, Esc cancels.
   */
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
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const pressedClass = 'bg-gray-700 text-white border-gray-700';
  const inputClass = 'block w-full border-0 border-b-2 border-gray-400/50 px-0.5 py-2';
  const titles = { new: 'New collection', rename: 'Rename', search: 'Change the search' };

  let error = '';
  let busy = false;
  let done = false;

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
  data-testid="collection-edit-dialog"
>
  <h2 class="weight-medium mb-4 text-xl">{titles[mode]}</h2>
  <form on:submit|preventDefault={submit}>
    {#if mode !== 'search'}
      <label class="block">
        Name
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class={inputClass}
          maxlength="200"
          autofocus
          bind:value={name}
          data-testid="collection-name"
        />
      </label>
    {/if}
    {#if mode === 'new' && chooseType}
      <div class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Kind">
        <button
          type="button"
          class="{buttonClass} {type === 'manual' ? pressedClass : ''}"
          aria-pressed={type === 'manual'}
          data-testid="collection-type-manual"
          on:click={() => (type = 'manual')}
        >
          Manual
        </button>
        <button
          type="button"
          class="{buttonClass} {type === 'smart' ? pressedClass : ''}"
          aria-pressed={type === 'smart'}
          data-testid="collection-type-smart"
          on:click={() => (type = 'smart')}
        >
          Smart
        </button>
      </div>
      <p class="pt-2 text-sm">
        {type === 'manual'
          ? 'Books you add yourself, in your own order, like a reading queue. Add them from the Library or the reader.'
          : 'Always shows the books that match a search right now.'}
      </p>
    {/if}
    {#if type === 'smart' && mode !== 'rename'}
      <label class="mt-4 block">
        Search
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class={inputClass}
          type="search"
          autocapitalize="off"
          spellcheck="false"
          maxlength="500"
          autofocus={mode === 'search'}
          placeholder="e.g. tag:SF chars:<100000"
          bind:value={query}
          data-testid="collection-query"
        />
      </label>
      <p class="pt-1 text-sm">
        The same search as the Library's search box (see Search help there).
      </p>
    {/if}
    {#if error}
      <p class="pt-3 font-medium" role="alert" data-testid="collection-edit-error">{error}</p>
    {/if}
    <footer class="flex flex-wrap items-center justify-end gap-2 pt-5">
      <button type="button" class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
      <button type="submit" class={buttonClass} disabled={busy} data-testid="collection-save">
        {mode === 'new' ? 'Create' : 'Save'}
      </button>
    </footer>
  </form>
</section>
