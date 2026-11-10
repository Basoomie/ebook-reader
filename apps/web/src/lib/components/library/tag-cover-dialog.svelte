<script lang="ts">
  /**
   * A tag's cover rule (WP7a): blur the covers of books with this tag. A book's own
   * cover setting ("Always blur" / "Never blur") still wins. Plain for e-ink.
   */
  import { createEventDispatcher } from 'svelte';

  export let tag: string;
  export let blurred: boolean;
  /** Saves the rule; rejects when it could not be saved. */
  export let save: (blur: boolean) => Promise<void>;
  export let resolver: () => void = () => {};

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';

  let busy = false;
  let error = '';

  async function choose(blur: boolean) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await save(blur);
      close();
    } catch (e) {
      error = (e as Error).message || 'Could not save';
    } finally {
      busy = false;
    }
  }

  function close() {
    resolver();
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section class="mdc-elevation--z24 max-w-lg rounded bg-white p-6" data-testid="tag-cover-dialog">
  <h2 class="weight-medium mb-2 text-xl">Covers tagged “{tag}”</h2>
  <p class="mb-4">
    {blurred ? 'Covers with this tag are blurred.' : 'Covers with this tag are shown.'}
    A book's own cover setting still wins. Tap a blurred cover to see it.
  </p>
  {#if error}
    <p class="mb-3 font-medium" role="alert">{error}</p>
  {/if}
  <div class="flex flex-wrap justify-end gap-2">
    <button class={buttonClass} on:click={close}>Cancel</button>
    <button
      class={buttonClass}
      disabled={busy}
      data-testid="tag-blur-toggle"
      on:click={() => choose(!blurred)}
    >
      {blurred ? 'Stop blurring these covers' : 'Blur these covers'}
    </button>
  </div>
</section>
