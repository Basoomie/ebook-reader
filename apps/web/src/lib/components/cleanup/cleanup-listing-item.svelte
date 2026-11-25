<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One book of Bookmeter links (the spot check and the lists): the library book, its saved
   * 読書メーター listing and the one the link goes to instead, each with its reader count.
   */
  import { GUARD_TEXT, registeredText, type ListingItem } from '$lib/cleanup/listings-text';

  export let m: ListingItem;

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

<div class="flex flex-col gap-0.5 text-sm" data-testid="listings-item">
  <span>
    <b>{m.book.title ?? ''}</b>
    <span class="text-c-muted">
      · {m.book.authors.join(', ')} · Calibre book {m.calibreId}{m.labeled
        ? ' · labeled'
        : ''}</span
    >
  </span>
  {#if m.book.decidedTitle}
    <span class="text-c-muted">Stage 4 decided: {m.book.decidedTitle}</span>
  {/if}
  <span>
    Saved:
    <a class="underline" href={m.saved.url} target="_blank" rel="noopener noreferrer"
      >{m.saved.title || m.saved.id}</a
    >
    <span class="text-c-muted"
      >{m.saved.title ? ` · ${registeredText(m.saved)}` : ''}{m.savedGuard
        ? ` · ${GUARD_TEXT[m.savedGuard]}`
        : ''}</span
    >
  </span>
  {#if m.pick && m.pick.id !== m.saved.id}
    <span>
      {m.state === 'change' ? 'Changes to' : 'Best found'}:
      <a class="underline" href={m.pick.url} target="_blank" rel="noopener noreferrer"
        >{m.pick.title || m.pick.id}</a
      >
      <span class="text-c-muted"> · {registeredText(m.pick)}</span>
    </span>
  {/if}
  {#if outcome}<span class="text-c-muted">{outcome}</span>{/if}
</div>
