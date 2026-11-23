<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** Book summaries session 2: an item's English translation under the original, for judging. */
  export let line: { head: string | null; text: string };
</script>

<p class="english" lang="en" data-testid="summary-en">
  {#if line.head}<span class="font-bold">{line.head}</span> ·
  {/if}{line.text}
</p>

<style>
  .english {
    margin-top: 0.25rem;
    font-size: 0.92em;
    opacity: 0.8;
  }
</style>
