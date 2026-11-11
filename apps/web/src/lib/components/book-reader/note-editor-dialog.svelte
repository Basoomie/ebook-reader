<script lang="ts">
  /**
   * WP11a: writes the note on a highlight or a note about the book. Plain for e-ink like
   * the search dialog: no transitions, 48 px bordered controls, inert backdrop, Esc
   * cancels. Saving an empty note removes it.
   * WP19: removing a note (Remove note, or saving it empty) asks first, in place.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { MAX_NOTE_BODY } from '$lib/notes/highlights';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import { removeNoteCopy } from '$lib/confirm/confirm-copy';

  export let heading: string;
  export let quote: string | null = null;
  export let body = '';
  export let canRemove = false;
  export let resolver: (
    answer: { action: 'save'; body: string } | { action: 'remove' } | null
  ) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';

  let text = body;
  let done = false;
  /** The answer waiting for "Remove this note?" (Remove note, or Save with the text emptied). */
  let pendingRemoval: Parameters<typeof resolver>[0] = null;
  let textareaEl: HTMLTextAreaElement;

  onMount(() => {
    textareaEl?.focus();
  });

  function close(answer: Parameters<typeof resolver>[0]) {
    if (done) return;
    done = true;
    resolver(answer);
    dispatch('close');
  }

  function save() {
    // An existing note saved empty is removed: ask first, like Remove note.
    if (canRemove && !text.trim()) pendingRemoval = { action: 'save', body: text };
    else close({ action: 'save', body: text });
  }

  function onKeydown(ev: KeyboardEvent) {
    if (pendingRemoval) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close(null);
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      save();
    }
  }

  $: tooLong = Array.from(text).length > MAX_NOTE_BODY;
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 flex max-h-[85vh] w-[40rem] max-w-full flex-col rounded bg-white p-6"
  data-testid="note-editor"
>
  <h2 class="weight-medium mb-3 text-xl">{heading}</h2>
  {#if quote}
    <blockquote class="mb-3 max-h-24 overflow-y-auto border-l-4 border-gray-500 pl-3 text-sm">
      {quote}
    </blockquote>
  {/if}
  <textarea
    bind:this={textareaEl}
    bind:value={text}
    rows="6"
    aria-label="Note"
    class="min-h-[8rem] w-full rounded border-2 border-current p-3"
    data-testid="note-editor-text"
  />
  {#if tooLong}
    <p class="mt-2 text-sm" role="alert">
      A note can be at most {MAX_NOTE_BODY.toLocaleString()} characters.
    </p>
  {/if}
  {#if pendingRemoval}
    <div class="pt-5">
      <InlineConfirm
        {...removeNoteCopy()}
        testid="note-remove-confirm"
        confirmTestid="note-remove-confirm-button"
        on:confirm={() => close(pendingRemoval)}
        on:cancel={() => {
          pendingRemoval = null;
          textareaEl?.focus();
        }}
      />
    </div>
  {:else}
    <footer class="flex flex-wrap justify-end gap-2 pt-5">
      {#if canRemove}
        <button
          class="{buttonClass} mr-auto"
          data-testid="note-editor-remove"
          on:click={() => (pendingRemoval = { action: 'remove' })}
        >
          Remove note
        </button>
      {/if}
      <button class={buttonClass} on:click={() => close(null)}>Cancel</button>
      <button class={buttonClass} disabled={tooLong} data-testid="note-editor-save" on:click={save}>
        Save
      </button>
    </footer>
  {/if}
</section>
