<script lang="ts">
  /**
   * Jump to position: a character number between `minValue` and `maxValue`. Enter or "Go"
   * jumps; ✕, Esc or a click outside resolve `undefined` (dialogManager.open).
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  export let dialogHeader: string;
  export let minValue = 1;
  export let maxValue = 1;
  export let resolver: (arg0: number | undefined) => void;

  let target = minValue;
  let error = '';

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = `number-${Math.random().toString(36).slice(2, 10)}`;

  function go() {
    if (typeof target !== 'number' || target < minValue || target > maxValue) {
      error = `Enter a number from ${minValue.toLocaleString()} to ${maxValue.toLocaleString()}.`;
      return;
    }
    resolver(target);
    dispatch('close');
  }

  function cancel() {
    resolver(undefined);
    dispatch('close');
  }
</script>

<Modal title={dialogHeader} size="sm" testid="number-dialog" initialFocus="input" on:close={cancel}>
  <form class="c-modal-field pt-3" on:submit|preventDefault={go}>
    <label class="c-modal-label" for={id}>
      Character ({minValue.toLocaleString()}–{maxValue.toLocaleString()})
    </label>
    <input
      {id}
      class="c-input w-full"
      type="number"
      inputmode="numeric"
      min={minValue}
      max={maxValue}
      bind:value={target}
    />
    {#if error}
      <p class="c-modal-error" role="alert"><span aria-hidden="true">⚠</span>{error}</p>
    {/if}
  </form>
  <svelte:fragment slot="footer">
    <button type="button" class="c-btn c-btn-primary" on:click={go}>Go</button>
  </svelte:fragment>
</Modal>
