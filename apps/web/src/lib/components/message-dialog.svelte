<script lang="ts">
  /**
   * A short message (an error, a notice): title and text, closed with ✕, Esc or a click
   * outside (modal.svelte).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  export let title: string;
  export let message: string;

  const dispatch = createEventDispatcher<{ close: void }>();
</script>

<Modal {title} size="sm" testid="message-dialog" on:close={() => dispatch('close')}>
  <p class="whitespace-pre-line pt-3 [overflow-wrap:anywhere]" data-testid="message-dialog-text">
    {message}
  </p>
</Modal>
