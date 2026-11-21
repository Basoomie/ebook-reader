<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** Text with the Notes search's words marked (lib/notes/notes-search.ts). */
  import { markParts } from '$lib/notes/notes-search';

  export let text: string;
  /** Folded search words (`queryWords`); none: the plain text. */
  export let words: readonly string[] = [];

  $: parts = words.length ? markParts(text, words) : null;
</script>

{#if parts}{#each parts as part}{#if part.hit}<mark class="c-search-hit">{part.text}</mark
      >{:else}{part.text}{/if}{/each}{:else}{text}{/if}

<style>
  .c-search-hit {
    background-color: var(--c-tint);
    color: inherit;
    border-radius: 2px;
    box-shadow: inset 0 -2px 0 var(--c-gold);
  }

  :global(html.eink) .c-search-hit {
    background-color: transparent;
    box-shadow: none;
    text-decoration: underline;
    text-decoration-thickness: 2px;
    font-weight: 700;
  }
</style>
