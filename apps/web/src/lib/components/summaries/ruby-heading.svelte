<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries: a name or term with the book's own furigana over it (from the book's ruby,
   * never from a model), or the plain text when the book gives none.
   */
  import type { RubyPiece } from '$lib/summaries/summary-types';

  export let text: string;
  export let pieces: RubyPiece[] | null | undefined = null;
</script>

{#if pieces?.length}{#each pieces as p, i (i)}{#if p.r}<ruby
        >{p.t}<rp>(</rp><rt>{p.r}</rt><rp>)</rp></ruby
      >{:else}{p.t}{/if}{/each}{:else}{text}{/if}
