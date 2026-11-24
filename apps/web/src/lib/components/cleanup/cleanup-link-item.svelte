<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One link of More direct links (the spot check and the lists): the library book beside the
   * store's page, where it was found, and what happened to it.
   */
  import { HOW_LABELS, SITE_LABELS, seriesText, type LinkItem } from '$lib/cleanup/links-text';

  export let m: LinkItem;

  $: series = seriesText(m);
  $: outcome =
    m.proposal === 'applied'
      ? 'written'
      : m.proposal === 'undone'
        ? 'undone'
        : m.proposal === 'skipped'
          ? 'set aside'
          : m.proposal
            ? 'to write'
            : '';
</script>

<div class="flex flex-col gap-0.5 text-sm" data-testid="links-item">
  <span>
    <b>{m.book.title ?? ''}</b>
    <span class="text-c-muted">
      · {m.book.authors.join(', ')}{series ? ` · ${series}` : ''} · Calibre book {m.calibreId}{m.labeled
        ? ' · labeled'
        : ''}</span
    >
  </span>
  {#if m.book.decidedTitle}
    <span class="text-c-muted">Stage 4 decided: {m.book.decidedTitle}</span>
  {/if}
  <span>
    {SITE_LABELS[m.site]}:
    <a class="underline" href={m.store.url} target="_blank" rel="noopener noreferrer"
      >{m.store.title || m.store.id}</a
    >
  </span>
  {#if m.saved}
    <span>
      Saved now:
      <a class="underline" href={m.saved.url} target="_blank" rel="noopener noreferrer"
        >{m.saved.id}</a
      >
    </span>
  {/if}
  <span class="text-c-muted">From {HOW_LABELS[m.how]}{outcome ? ` · ${outcome}` : ''}</span>
</div>
