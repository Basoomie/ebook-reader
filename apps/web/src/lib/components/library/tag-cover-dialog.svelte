<script lang="ts">
  /**
   * A tag's cover rule (WP7a): blur the covers of books with this tag. A book's own
   * cover setting ("Always blur" / "Never blur") still wins. The footer holds the one
   * action; ✕, Esc or a click outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  export let tag: string;
  export let blurred: boolean;
  /** Saves the rule; rejects when it could not be saved. */
  export let save: (blur: boolean) => Promise<void>;
  export let resolver: () => void = () => {};

  const dispatch = createEventDispatcher<{ close: void }>();

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
</script>

<Modal title="Covers tagged “{tag}”" size="sm" testid="tag-cover-dialog" on:close={close}>
  <div class="space-y-3 pb-1 pt-3">
    <p>
      {blurred ? 'Covers with this tag are blurred.' : 'Covers with this tag are shown.'}
      A book's own cover setting still wins. Tap a blurred cover to see it.
    </p>
    {#if error}
      <p class="c-modal-error" role="alert"><span aria-hidden="true">⚠</span>{error}</p>
    {/if}
  </div>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-primary"
      disabled={busy}
      data-testid="tag-blur-toggle"
      on:click={() => choose(!blurred)}
    >
      {blurred ? 'Stop blurring these covers' : 'Blur these covers'}
    </button>
  </svelte:fragment>
</Modal>
