<script lang="ts">
  /**
   * "Delete …?" (WP19): the confirmation in front of a destructive action. Opened through
   * `confirmDestructive` ($lib/confirm/confirm). Safe by default: focus starts on Cancel,
   * Esc, a click outside or any other way the dialog goes away counts as Cancel, and focus
   * stays inside while it is open and goes back to where it was afterwards. A question, so
   * no ✕: Cancel sits beside the action (modal.svelte, role="alertdialog").
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { answerOnce, confirmParagraphs } from '$lib/confirm/confirm-state';
  import { createEventDispatcher, onDestroy } from 'svelte';

  export let title: string;
  export let message: string | string[] = [];
  export let confirmLabel: string;
  export let cancelLabel = 'Cancel';
  export let irreversible = false;
  export let danger = true;
  export let testid = 'confirm-destructive-dialog';
  export let confirmTestid = 'confirm-destructive-confirm';
  /** 'app': the app's colours; 'inherit': the reader theme's (whispersync's layer). */
  export let surface: 'app' | 'inherit' = 'app';
  /** Whispersync's own layer sits above its menu. */
  export let zIndex: number | undefined = undefined;
  export let resolver: (confirmed: boolean) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const once = answerOnce(resolver);
  const id = `confirm-${Math.random().toString(36).slice(2, 10)}`;

  $: paragraphs = confirmParagraphs({
    message: typeof message === 'string' ? [message] : message,
    irreversible
  });

  onDestroy(() => {
    // Closed from outside (another dialog took its place): that is a "no".
    once.answer(false);
  });

  function answer(confirmed: boolean) {
    if (once.answer(confirmed)) dispatch('close');
  }
</script>

<Modal
  {title}
  size="sm"
  role="alertdialog"
  {surface}
  {zIndex}
  {testid}
  describedby="{id}-body"
  initialFocus="[data-confirm-cancel]"
  on:close={() => answer(false)}
>
  <div id="{id}-body" class="space-y-2 pt-3">
    {#each paragraphs as paragraph}
      <p>{paragraph}</p>
    {/each}
  </div>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-secondary"
      data-confirm-cancel
      data-testid="{testid}-cancel"
      on:click={() => answer(false)}
    >
      {cancelLabel}
    </button>
    <button
      type="button"
      class="c-btn {danger ? 'c-btn-danger' : 'c-btn-primary'}"
      data-testid={confirmTestid}
      on:click={() => answer(true)}
    >
      {confirmLabel}
    </button>
  </svelte:fragment>
</Modal>
