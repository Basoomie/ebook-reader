<script lang="ts">
  /**
   * The same confirmation as confirm-destructive-dialog.svelte, shown in place inside a
   * dialog that is already open (Book status, Server fonts, the note editor): the app shows
   * one dialog at a time, so a second one would close the first. Focus starts on Cancel;
   * Esc cancels only this, not the dialog around it.
   */
  import { confirmParagraphs } from '$lib/confirm/confirm-state';
  import { createEventDispatcher, onMount } from 'svelte';

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
  const outlined =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

  let cancelButton: HTMLButtonElement;

  $: paragraphs = confirmParagraphs({
    message: typeof message === 'string' ? [message] : message,
    irreversible
  });

  onMount(() => cancelButton?.focus());

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      dispatch('cancel');
    }
  }
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<div
  class="rounded border-2 border-current p-3"
  role="alertdialog"
  aria-labelledby="{id}-title"
  aria-describedby="{id}-body"
  data-testid={testid}
  on:keydown={onKeydown}
>
  <p id="{id}-title" class="font-medium">{title}</p>
  <div id="{id}-body" class="space-y-1 pt-1">
    {#each paragraphs as paragraph}
      <p>{paragraph}</p>
    {/each}
  </div>
  <div class="flex flex-wrap items-center gap-2 pt-3">
    <button
      bind:this={cancelButton}
      class="{outlined} {focusRing}"
      data-testid="{testid}-cancel"
      on:click={() => dispatch('cancel')}
    >
      {cancelLabel}
    </button>
    <button
      class="c-btn {danger ? 'c-btn-danger' : 'c-btn-primary'} {focusRing}"
      disabled={busy}
      data-testid={confirmTestid}
      on:click={() => dispatch('confirm')}
    >
      {confirmLabel}
    </button>
  </div>
</div>
