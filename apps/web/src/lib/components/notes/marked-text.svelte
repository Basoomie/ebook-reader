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
  /*
   * A solid marker color that stands out from the page and the cards in each look
   * (user, 2026-11-21: the tint blended into the background), with dark text on it.
   * E-ink: black with white text.
   */
  .c-search-hit {
    background-color: #ffd23f;
    color: #1a1406;
    border-radius: 2px;
    padding: 0 1px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  :global(html.catalogue-dark:not(.eink)) .c-search-hit {
    background-color: #f5c542;
    color: #0e1524;
  }

  :global(html.eink) .c-search-hit {
    background-color: #000;
    color: #fff;
  }
</style>
