<script lang="ts">
  /**
   * The same confirmation as confirm-destructive-dialog.svelte, shown in place inside a
   * dialog that is already open (Book status, Custom fonts, the note editor): the app shows
   * one dialog at a time, so a second one would close the first. Focus starts on Cancel;
   * Esc cancels only this, not the dialog around it (an Esc-only layer on the modal stack).
   */
  import { confirmParagraphs } from '$lib/confirm/confirm-state';
  import { pushLayer } from '$lib/components/modal/modal-stack';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';

  export let title: string;
  export let message: string | string[] = [];
  export let confirmLabel: string;
  export let cancelLabel = 'Cancel';
  export let irreversible = false;
  export let danger = true;
  export let busy = false;
  export let testid = 'inline-confirm';
  export let confirmTestid = 'inline-confirm-confirm';

  const dispatch = createEventDispatcher<{ confirm: void; cancel: void }>();
  const id = `inline-confirm-${Math.random().toString(36).slice(2, 10)}`;
  const layer = pushLayer(() => dispatch('cancel'), { escapeOnly: true });

  let cancelButton: HTMLButtonElement;

  $: paragraphs = confirmParagraphs({
    message: typeof message === 'string' ? [message] : message,
    irreversible
  });

  onMount(() => cancelButton?.focus({ preventScroll: true }));
  onDestroy(() => layer.remove());
</script>

<div
  class="c-modal-inline"
  class:is-danger={danger}
  role="alertdialog"
  aria-labelledby="{id}-title"
  aria-describedby="{id}-body"
  data-testid={testid}
>
  <p id="{id}-title" class="c-modal-inline-title">{title}</p>
  <div id="{id}-body" class="space-y-1 text-[0.9375rem]">
    {#each paragraphs as paragraph}
      <p>{paragraph}</p>
    {/each}
  </div>
  <div class="c-modal-inline-btns">
    <button
      bind:this={cancelButton}
      type="button"
      class="c-btn c-btn-secondary c-btn-sm"
      data-testid="{testid}-cancel"
      on:click={() => dispatch('cancel')}
    >
      {cancelLabel}
    </button>
    <button
      type="button"
      class="c-btn c-btn-sm {danger ? 'c-btn-danger' : 'c-btn-primary'}"
      disabled={busy}
      data-testid={confirmTestid}
      on:click={() => dispatch('confirm')}
    >
      {confirmLabel}
    </button>
  </div>
</div>
