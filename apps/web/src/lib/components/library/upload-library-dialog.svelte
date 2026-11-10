<script lang="ts">
  /**
   * "Add to which library?" (WP7b, decided with the user): asked on every upload,
   * nothing preselected or remembered. Plain for e-ink; Esc cancels.
   */
  import { createEventDispatcher } from 'svelte';

  export let libraries: { id: string; name: string }[];
  export let fileCount: number;
  export let resolver: (libraryId: string | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';
  let done = false;

  function answer(value: string | undefined) {
    if (done) return;
    done = true;
    resolver(value);
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
  class="mdc-elevation--z24 w-full max-w-md rounded bg-white p-6"
  data-testid="upload-library-dialog"
>
  <h2 class="weight-medium mb-2 text-xl">Add to which library?</h2>
  <p class="mb-4">
    {fileCount === 1 ? 'The book is' : `The ${fileCount} books are`} kept on the server, not in Calibre.
  </p>
  <div class="grid grid-cols-1 gap-2">
    {#each libraries as lib (lib.id)}
      <button class={buttonClass} data-testid="upload-library" on:click={() => answer(lib.id)}>
        {lib.name}
      </button>
    {/each}
  </div>
  <footer class="flex justify-end pt-5">
    <button class={buttonClass} on:click={() => answer(undefined)}>Cancel</button>
  </footer>
</section>
