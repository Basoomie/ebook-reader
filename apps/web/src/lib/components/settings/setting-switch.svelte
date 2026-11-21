<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * An on/off switch for the Settings page (role="switch"): a 48 px touch area, filled when
   * on, a knob that moves; E-ink: black and white with no animation. `bind:checked`, or
   * `checked` + on:change for a setting shown the other way round.
   */
  import { createEventDispatcher } from 'svelte';

  export let checked = false;
  export let label = '';
  export let labelledby = '';
  export let disabled = false;
  export let testid = '';

  const dispatch = createEventDispatcher<{ change: boolean }>();

  function toggle() {
    checked = !checked;
    dispatch('change', checked);
  }
</script>

<button
  type="button"
  role="switch"
  class="s-switch"
  aria-checked={checked}
  aria-label={label || undefined}
  aria-labelledby={label ? undefined : labelledby || undefined}
  {disabled}
  data-testid={testid || undefined}
  on:click={toggle}
>
  <span class="s-track"><span class="s-knob" /></span>
</button>

<style>
  .s-switch {
    display: inline-grid;
    place-items: center;
    width: 3.5rem;
    height: 3rem;
    margin: -0.5rem -0.25rem;
    border-radius: 0.5rem;
  }

  .s-switch:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  .s-switch:disabled {
    cursor: default;
  }

  .s-track {
    position: relative;
    width: 2.75rem;
    height: 1.625rem;
    border-radius: 999px;
    background-color: var(--c-track);
    border: var(--c-border-width) solid var(--c-line-strong);
    transition: background-color 0.15s ease;
  }

  .s-knob {
    position: absolute;
    top: 50%;
    left: 0.1875rem;
    width: 1.125rem;
    height: 1.125rem;
    margin-top: -0.5625rem;
    border-radius: 50%;
    background-color: var(--c-raised);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
    transition: transform 0.15s ease;
  }

  [aria-checked='true'] .s-track {
    background-color: var(--c-sel-bg);
    border-color: var(--c-sel-bg);
  }

  [aria-checked='true'] .s-knob {
    transform: translateX(1.125rem);
    background-color: var(--c-sel-ink);
  }

  :global(html.catalogue-dark) .s-knob {
    background-color: var(--c-muted);
    box-shadow: none;
  }

  :global(html.catalogue-dark) [aria-checked='true'] .s-knob {
    background-color: var(--c-sel-ink);
  }

  /* E-ink: white track with a black knob when off, black track with a white knob when on. */
  :global(html.eink) .s-knob {
    background-color: #000;
    box-shadow: none;
  }

  :global(html.eink) [aria-checked='true'] .s-knob {
    background-color: #fff;
  }

  :global(html.eink) .s-track,
  :global(html.eink) .s-knob {
    transition: none;
  }

  .s-switch:disabled .s-track {
    opacity: 0.6;
  }
</style>
