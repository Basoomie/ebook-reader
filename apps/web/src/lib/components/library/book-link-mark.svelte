<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** The small mark after a link's name: external-link for a direct link, a magnifier for a search. */
  import { faArrowUpRightFromSquare, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';

  export let kind: 'direct' | 'search';
</script>

{#if kind === 'search'}
  <span class="c-link-mark inline-flex shrink-0 items-center text-c-muted">
    <Fa icon={faMagnifyingGlass} size="xs" />
    <span class="sr-only">(search link)</span>
  </span>
{:else}
  <span class="c-link-mark inline-flex shrink-0 items-center opacity-60" aria-hidden="true">
    <Fa icon={faArrowUpRightFromSquare} size="xs" />
  </span>
{/if}

<style>
  :global(html.eink) .c-link-mark {
    opacity: 1;
  }
</style>
