<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * A number field with its unit written after it ("3 seconds", "80 px"). The input is the
   * caller's own (its binding, limits and checks stay where they were); this only frames it.
   */
  export let unit = '';
</script>

<span class="s-field">
  <slot />
  {#if unit}
    <span class="s-unit" aria-hidden="true">{unit}</span>
  {/if}
</span>

<style>
  .s-field {
    display: inline-flex;
    align-items: center;
    min-height: 3rem;
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line-strong);
    border-radius: 0.375rem;
    color: var(--c-ink);
  }

  .s-field:focus-within {
    outline: 2px solid var(--c-link);
  }

  .s-field :global(input) {
    width: 6.5rem;
    min-height: 2.875rem;
    padding: 0 0.25rem 0 0.75rem;
    border: 0;
    background: transparent;
    color: inherit;
    font-variant-numeric: tabular-nums;
    outline: none;
    box-shadow: none;
  }

  .s-unit {
    padding: 0 0.75rem 0 0.25rem;
    color: var(--c-muted);
    font-size: 0.875rem;
    white-space: nowrap;
  }
</style>
