<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One section of a Settings tab: the small Japanese label, the title in mincho, a line
   * on what the section is for, a gold rule, then its rows in one card (rows divided by a
   * line). Title and description come from the settings catalog by id unless given. The
   * page's side and top navigation list the sections it finds by `data-settings-group`.
   * (settings-section.svelte is the older heading; /cleanup still uses it.)
   */
  import { catalogSection, sectionDomId } from '$lib/settings/settings-catalog';

  export let id: string;
  export let jp = '';
  export let title = '';
  export let description = '';
  export let testid = '';
  /** false: the content draws its own cards and notices (no card around it). */
  export let card = true;

  $: entry = catalogSection(id);
  $: shownJp = jp || entry?.jp || '';
  $: shownTitle = title || entry?.title || '';
  $: shownDescription = description || entry?.description || '';
  $: domId = sectionDomId(id);
</script>

<section
  id={domId}
  class="s-group"
  aria-labelledby="{domId}-title"
  data-settings-group={id}
  data-title={shownTitle}
  data-testid={testid || undefined}
>
  <div class="s-group-head">
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      {#if shownJp}
        <span class="c-jp-label" aria-hidden="true">{shownJp}</span>
      {/if}
      <h2 id="{domId}-title" class="font-mincho text-xl font-bold leading-snug">{shownTitle}</h2>
      <slot name="actions" />
    </div>
    {#if shownDescription}
      <p class="mt-1 max-w-prose text-sm text-c-muted">{shownDescription}</p>
    {/if}
    <slot name="intro" />
  </div>
  <slot name="before" />
  <div class:s-card={card}>
    <slot />
  </div>
</section>

<style>
  .s-group {
    /* Clear of the fixed header and, on narrower screens, the sticky tabs. */
    scroll-margin-top: 9.5rem;
  }

  @media (min-width: 1024px) {
    .s-group {
      scroll-margin-top: 4.5rem;
    }
  }

  .s-group-head {
    padding-bottom: 0.5rem;
    margin-bottom: 0.75rem;
    border-bottom: 1px solid var(--c-gold);
  }

  .s-card {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  /* Rows and blocks inside a card are divided by a line. */
  .s-card > :global(* + *) {
    border-top: 1px solid var(--c-line);
  }

  .s-card:empty {
    display: none;
  }
</style>
