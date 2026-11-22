<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Two to four choices as one connected control (role="radiogroup"): the picked one
   * filled, arrow keys move between them. Full width on phones, its own width from 640 px.
   */
  import { createEventDispatcher } from 'svelte';

  export let options: { id: any; text: string }[] = [];
  export let value: any;
  export let label = '';
  export let labelledby = '';
  export let disabled = false;
  export let testid = '';

  /** `change`: the picked id, for callers that don't bind `value` (reader toolbars). */
  const dispatch = createEventDispatcher<{ change: any }>();

  let group: HTMLDivElement;

  function pick(id: any) {
    if (disabled) return;
    const changed = value !== id;
    value = id;
    if (changed) dispatch('change', id);
  }

  function onKeydown(event: KeyboardEvent) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.id === value);
    const next = options[(index + step + options.length) % options.length];
    pick(next.id);
    group?.querySelectorAll<HTMLButtonElement>('button')[options.indexOf(next)]?.focus();
  }

  $: selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.id === value)
  );
</script>

<div
  bind:this={group}
  class="s-choice"
  role="radiogroup"
  tabindex="-1"
  aria-label={label || undefined}
  aria-labelledby={label ? undefined : labelledby || undefined}
  data-testid={testid || undefined}
  on:keydown={onKeydown}
>
  {#each options as option, index (option.id)}
    <button
      type="button"
      role="radio"
      aria-checked={option.id === value}
      tabindex={index === selectedIndex ? 0 : -1}
      {disabled}
      on:click={() => pick(option.id)}
    >
      {option.text}
    </button>
  {/each}
</div>

<style>
  .s-choice {
    display: flex;
    width: 100%;
    border: var(--c-border-width) solid var(--c-sec-border);
    border-radius: 0.375rem;
    overflow: hidden;
    background-color: var(--c-sec-bg);
  }

  @media (min-width: 640px) {
    .s-choice {
      display: inline-flex;
      width: auto;
    }
  }

  button {
    flex: 1 1 0;
    min-height: 2.75rem;
    padding: 0.375rem 0.875rem;
    color: var(--c-sec-ink);
    font-size: 0.875rem;
    line-height: 1.2;
    white-space: normal;
  }

  @media (min-width: 640px) {
    button {
      white-space: nowrap;
    }
  }

  button + button {
    border-left: var(--c-border-width) solid var(--c-sec-border);
  }

  @media (hover: hover) {
    button:not([aria-checked='true']):not(:disabled):hover {
      background-color: var(--c-sec-hover);
    }
  }

  button[aria-checked='true'] {
    background-color: var(--c-sel-bg);
    color: var(--c-sel-ink);
    font-weight: 600;
  }

  button:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -3px;
  }

  button:disabled {
    cursor: default;
  }
</style>
