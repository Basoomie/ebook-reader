<script lang="ts">
  /** "Delete this collection?" (WP8b). Plain for e-ink; Esc cancels. */
  import { createEventDispatcher } from 'svelte';

  export let name: string;
  export let resolver: (confirmed: boolean) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  let done = false;

  function answer(confirmed: boolean) {
    if (done) return;
    done = true;
    resolver(confirmed);
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      answer(false);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 max-w-lg rounded bg-white p-6"
  data-testid="collection-delete-dialog"
>
  <h2 class="weight-medium mb-3 text-xl">Delete “{name}”?</h2>
  <p>The collection goes away on every device. The books stay in your library.</p>
  <footer class="flex flex-wrap items-center justify-end gap-2 pt-5">
    <button class={buttonClass} on:click={() => answer(false)}>Cancel</button>
    <button
      class={buttonClass}
      data-testid="collection-delete-confirm"
      on:click={() => answer(true)}
    >
      Delete
    </button>
  </footer>
</section>
