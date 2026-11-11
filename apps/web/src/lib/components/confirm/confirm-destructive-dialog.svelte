<script lang="ts">
  /**
   * "Delete …?" (WP19): the confirmation in front of a destructive action. Opened through
   * `confirmDestructive` ($lib/confirm/confirm). Safe by default: focus starts on Cancel,
   * Esc, a backdrop tap or any other way the dialog goes away counts as Cancel, and focus
   * stays inside while it is open and goes back to where it was afterwards. Plain for
   * e-ink (48 px buttons, no transitions).
   */
  import {
    FOCUSABLE_SELECTOR,
    answerOnce,
    confirmParagraphs,
    nextFocusIndex
  } from '$lib/confirm/confirm-state';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';

  export let title: string;
  export let message: string | string[] = [];
  export let confirmLabel: string;
  export let cancelLabel = 'Cancel';
  export let irreversible = false;
  export let danger = true;
  export let testid = 'confirm-destructive-dialog';
  export let confirmTestid = 'confirm-destructive-confirm';
  /** 'app': a white dialog (the catalogue pages restyle it); 'inherit': takes the colours
   *  of the surface it sits on (whispersync's own dialogs follow the reader theme). */
  export let surface: 'app' | 'inherit' = 'app';
  export let resolver: (confirmed: boolean) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const once = answerOnce(resolver);
  const id = `confirm-${Math.random().toString(36).slice(2, 10)}`;
  const outlined =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';
  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

  let section: HTMLElement;
  let cancelButton: HTMLButtonElement;
  let returnFocusTo: Element | null = null;

  $: paragraphs = confirmParagraphs({
    message: typeof message === 'string' ? [message] : message,
    irreversible
  });

  onMount(() => {
    returnFocusTo = document.activeElement;
    cancelButton?.focus();
  });

  onDestroy(() => {
    // Closed from outside (backdrop, another dialog): that is a "no".
    once.answer(false);
    if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
      returnFocusTo.focus();
    }
  });

  function answer(confirmed: boolean) {
    if (once.answer(confirmed)) dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      answer(false);
    } else if (ev.key === 'Tab' && section) {
      const focusable = Array.from(section.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const next = nextFocusIndex(
        focusable.indexOf(document.activeElement as HTMLElement),
        focusable.length,
        ev.shiftKey
      );
      if (next >= 0) {
        ev.preventDefault();
        focusable[next].focus();
      }
    }
  }
</script>

<!-- Capture on window: Esc and Tab reach this dialog before any page or reader shortcut. -->
<svelte:window on:keydown|capture={onKeydown} />

<section
  bind:this={section}
  class="mdc-elevation--z24 max-w-lg rounded p-6"
  class:bg-white={surface === 'app'}
  role="alertdialog"
  aria-modal="true"
  aria-labelledby="{id}-title"
  aria-describedby="{id}-body"
  data-testid={testid}
>
  <h2 id="{id}-title" class="weight-medium mb-3 text-xl">{title}</h2>
  <div id="{id}-body" class="space-y-2">
    {#each paragraphs as paragraph}
      <p>{paragraph}</p>
    {/each}
  </div>
  <footer class="flex flex-wrap items-center justify-end gap-2 pt-5">
    <button
      bind:this={cancelButton}
      class="{outlined} {focusRing}"
      data-testid="{testid}-cancel"
      on:click={() => answer(false)}
    >
      {cancelLabel}
    </button>
    <button
      class="c-btn {danger ? 'c-btn-danger' : 'c-btn-primary'} {focusRing}"
      data-testid={confirmTestid}
      on:click={() => answer(true)}
    >
      {confirmLabel}
    </button>
  </footer>
</section>
