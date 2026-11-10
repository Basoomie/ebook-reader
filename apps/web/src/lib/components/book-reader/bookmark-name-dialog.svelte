<script lang="ts">
  /**
   * WP11b: names a new bookmark (pre-filled with the first sentence of the page). Plain for
   * e-ink like the search dialog: no transitions, 48 px bordered controls, inert backdrop,
   * Enter saves, Esc cancels. Saving a bookmark never moves the saved place.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { MAX_BOOKMARK_NAME } from '$lib/notes/bookmarks';

  export let place = '';
  export let name = '';
  export let resolver: (name: string | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';

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

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close(null);
    }
  }

  $: empty = !text.trim();
  $: tooLong = Array.from(text.trim()).length > MAX_BOOKMARK_NAME;
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 flex max-h-[85vh] w-[36rem] max-w-full flex-col rounded bg-white p-6"
  data-testid="bookmark-name-dialog"
>
  <h2 class="weight-medium mb-1 text-xl">Add bookmark</h2>
  {#if place}
    <p class="mb-3 text-sm">{place}</p>
  {/if}
  <form on:submit|preventDefault={() => !empty && !tooLong && close(text.trim())}>
    <input
      bind:this={inputEl}
      bind:value={text}
      aria-label="Bookmark name"
      enterkeyhint="done"
      class="min-h-[3rem] w-full rounded border-2 border-current px-3"
      data-testid="bookmark-name-input"
    />
    {#if tooLong}
      <p class="mt-2 text-sm" role="alert">
        A bookmark name can be at most {MAX_BOOKMARK_NAME} characters.
      </p>
    {/if}
    <footer class="flex justify-end gap-2 pt-5">
      <button type="button" class={buttonClass} on:click={() => close(null)}>Cancel</button>
      <button
        type="submit"
        class={buttonClass}
        disabled={empty || tooLong}
        data-testid="bookmark-name-save"
      >
        Save
      </button>
    </footer>
  </form>
</section>
