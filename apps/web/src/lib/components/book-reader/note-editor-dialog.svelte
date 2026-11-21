<script lang="ts">
  /**
   * WP11a: writes the note on a highlight or a note about the book. "Save note" (or
   * Ctrl+Enter) saves; ✕, Esc or a click outside cancel, asking first when the text was
   * changed (modal.svelte). Saving an empty note removes it.
   * WP19: removing a note (Remove note, or saving it empty) asks first, in place.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { MAX_NOTE_BODY } from '$lib/notes/highlights';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import { removeNoteCopy } from '$lib/confirm/confirm-copy';

  export let heading: string;
  export let quote: string | null = null;
  export let body = '';
  export let canRemove = false;
  export let resolver: (
    answer: { action: 'save'; body: string } | { action: 'remove' } | null
  ) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = `note-editor-${Math.random().toString(36).slice(2, 10)}`;

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
    if (pendingRemoval || tooLong) return;
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      save();
    }
  }

  $: tooLong = Array.from(text).length > MAX_NOTE_BODY;
  $: dirty = !done && text !== body;
</script>

<svelte:window on:keydown={onKeydown} />

<Modal title={heading} size="md" {dirty} testid="note-editor" on:close={() => close(null)}>
  <div class="grid gap-3 pb-1 pt-4">
    {#if quote}
      <blockquote
        class="max-h-24 overflow-y-auto border-l-4 border-c-strong pl-3 font-serif text-sm text-c-muted"
      >
        {quote}
      </blockquote>
    {/if}
    <label class="c-modal-label" for="{id}-text">Note</label>
    <textarea
      id="{id}-text"
      bind:this={textareaEl}
      bind:value={text}
      rows="6"
      class="c-input min-h-[8rem] w-full py-2.5"
      data-testid="note-editor-text"
    />
    {#if tooLong}
      <p class="c-modal-error" role="alert">
        <span aria-hidden="true">⚠</span>A note can be at most {MAX_NOTE_BODY.toLocaleString()} characters.
      </p>
    {/if}
    {#if pendingRemoval}
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
    {:else if canRemove}
      <div>
        <button
          type="button"
          class="c-btn c-btn-danger-line c-btn-sm"
          data-testid="note-editor-remove"
          on:click={() => (pendingRemoval = { action: 'remove' })}
        >
          Remove note…
        </button>
      </div>
    {/if}
  </div>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-primary"
      disabled={tooLong || !!pendingRemoval}
      data-testid="note-editor-save"
      on:click={save}
    >
      Save note
    </button>
  </svelte:fragment>
</Modal>
