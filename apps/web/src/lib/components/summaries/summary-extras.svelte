<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries (session 4): what goes under an item's text. "edited by you" on an item the
   * user changed or added (no other per-item marks), and the quote only where the summary marks
   * it to be shown, with a link into the book at its place. No link without a shown quote.
   */
  import type { SummaryItem } from '$lib/summaries/summary-types';
  import { sinceText } from '$lib/summaries/recap-page';

  export let item: SummaryItem;
  /** The reader link at the quote's place, or null (no book id or no position). */
  export let href: string | null = null;
  export let linkText = 'Open the book here';
  /** The quote's language (the book's), for its font and line breaks. */
  export let quoteLang = 'ja';
  /** 'mark' inside the item's paragraph, 'quote' after it (a quote is a block of its own). */
  export let part: 'mark' | 'quote' = 'mark';
  /** The series recap (session 5): "from vol. 2" for people and terms, "since" for threads. */
  export let sinceKind: 'from' | 'since' = 'from';
</script>

{#if part === 'mark' && item.since}
  <span class="since" lang="en" data-testid="recap-since">{sinceText(item.since, sinceKind)}</span>
{/if}

{#if part === 'mark' && (item.editedByUser || item.addedByUser)}
  <span class="edited" data-testid="summary-edited">edited by you</span>
{/if}
{#if part === 'quote' && item.showQuote && item.quote}
  <blockquote class="quote" lang={quoteLang} data-testid="summary-quote">
    「{item.quote}」
    {#if href}
      <a class="c-link link" {href} lang="en" data-testid="summary-quote-link">{linkText}</a>
    {/if}
  </blockquote>
{/if}

<style>
  .since {
    margin-left: 0.5rem;
    font-size: 0.75rem;
    color: var(--c-muted);
  }
  .edited {
    margin-left: 0.5rem;
    font-size: 0.75rem;
    color: var(--c-muted);
    white-space: nowrap;
  }
  .quote {
    margin-top: 0.35rem;
    padding-left: 0.75rem;
    border-left: 3px solid var(--c-line-strong);
    font-size: 0.9em;
  }
  .link {
    display: inline-flex;
    align-items: center;
    min-height: var(--c-btn-h-sm);
    font-size: 0.75rem;
  }
</style>
