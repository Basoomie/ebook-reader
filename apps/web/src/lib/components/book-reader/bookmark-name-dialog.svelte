<script lang="ts">
  /**
   * WP11b: names a new bookmark (pre-filled with the first sentence of the page). Enter or
   * "Save bookmark" saves; ✕, Esc or a click outside cancel, asking first when the name was
   * changed (modal.svelte). Saving a bookmark never moves the saved place.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher, onMount } from 'svelte';
  import { MAX_BOOKMARK_NAME } from '$lib/notes/bookmarks';

  export let place = '';
  export let name = '';
  export let resolver: (name: string | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const formId = `bookmark-name-${Math.random().toString(36).slice(2, 10)}`;

  let text = name;
  let done = false;
  let inputEl: HTMLInputElement;

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  function close(answer: string | null) {
    if (done) return;
    done = true;
    resolver(answer);
    dispatch('close');
  }

  $: empty = !text.trim();
  $: tooLong = Array.from(text.trim()).length > MAX_BOOKMARK_NAME;
  $: dirty = !done && text !== name;
</script>

<Modal
  title="Add a bookmark"
  subtitle={place}
  size="md"
  {dirty}
  testid="bookmark-name-dialog"
  on:close={() => close(null)}
>
  <form
    id={formId}
    class="c-modal-field pb-1 pt-4"
    on:submit|preventDefault={() => !empty && !tooLong && close(text.trim())}
  >
    <label class="c-modal-label" for="{formId}-name">Name</label>
    <input
      id="{formId}-name"
      bind:this={inputEl}
      bind:value={text}
      enterkeyhint="done"
      class="c-input w-full"
      data-testid="bookmark-name-input"
    />
    {#if tooLong}
      <p class="c-modal-error" role="alert">
        <span aria-hidden="true">⚠</span>A bookmark name can be at most {MAX_BOOKMARK_NAME} characters.
      </p>
    {:else}
      <p class="c-modal-hint !mb-0">
        A bookmark keeps this page under a name. It never moves your saved place.
      </p>
    {/if}
  </form>
  <svelte:fragment slot="footer">
    <button
      type="submit"
      form={formId}
      class="c-btn c-btn-primary"
      disabled={empty || tooLong}
      data-testid="bookmark-name-save"
    >
      Save bookmark
    </button>
  </svelte:fragment>
</Modal>
