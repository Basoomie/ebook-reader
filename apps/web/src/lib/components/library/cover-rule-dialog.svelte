<script lang="ts">
  /**
   * A cover rule (WP7a for tags; authors, series and collections 2026-11-21): blur the
   * covers of books with this tag, by this author, in this series or in this collection,
   * everywhere they show. A book's own cover setting ("Always blur" / "Never blur") still
   * wins, and so does this device's "Hidden covers" choice (Display). The footer holds the
   * one action; ✕, Esc or a click outside cancel (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import type { BlurRuleTarget } from '$lib/library/cover-blur';
  import { createEventDispatcher } from 'svelte';

  export let target: BlurRuleTarget;
  /** The tag, author or series name, or the collection's name. */
  export let name: string;
  export let blurred: boolean;
  /** Saves the rule; rejects when it could not be saved. */
  export let save: (blur: boolean) => Promise<void>;
  export let resolver: () => void = () => {};

  const dispatch = createEventDispatcher<{ close: void }>();

  const TITLES: Record<BlurRuleTarget, (n: string) => string> = {
    tag: (n) => `Covers tagged “${n}”`,
    author: (n) => `Covers by ${n}`,
    series: (n) => `Covers in the series “${n}”`,
    collection: (n) => `Covers in “${n}”`
  };
  const WHOSE: Record<BlurRuleTarget, string> = {
    tag: 'Covers with this tag',
    author: "This author's covers",
    series: "This series' covers",
    collection: "This collection's covers"
  };

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

<Modal title={TITLES[target](name)} size="sm" testid="cover-rule-dialog" on:close={close}>
  <div class="space-y-3 pb-1 pt-3">
    <p data-testid="cover-rule-state">
      {WHOSE[target]} are {blurred ? 'blurred' : 'shown'} everywhere they appear. A book's own cover
      setting still wins. Tap a blurred cover to see it.
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
      data-testid="cover-rule-toggle"
      on:click={() => choose(!blurred)}
    >
      {blurred ? 'Stop blurring these covers' : 'Blur these covers'}
    </button>
  </svelte:fragment>
</Modal>
