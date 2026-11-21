<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One section of a modal's body: a small heading (with an optional count beside it and an
   * `aside` slot at the right, e.g. "+ Add bookmark here"), an optional one-line hint, then
   * its content. Sections are divided by a line. Order inside a modal: the main choice
   * first, options, lists and history, destructive actions last.
   */
  export let title = '';
  export let hint = '';
  export let count: number | string | undefined = undefined;
  export let testid: string | undefined = undefined;

  const id = `msec-${Math.random().toString(36).slice(2, 10)}`;
</script>

<section class="c-modal-section" aria-labelledby={title ? id : undefined} data-testid={testid}>
  {#if title || $$slots.aside}
    <div class="c-modal-section-head">
      {#if title}
        <h3 {id}>
          {title}
          {#if count !== undefined}<span class="c-count">{count}</span>{/if}
        </h3>
      {/if}
      {#if $$slots.aside}<div class="c-modal-section-aside"><slot name="aside" /></div>{/if}
    </div>
  {/if}
  {#if hint || $$slots.hint}
    <p class="c-modal-hint"><slot name="hint">{hint}</slot></p>
  {/if}
  <div class="c-modal-section-body"><slot /></div>
</section>
