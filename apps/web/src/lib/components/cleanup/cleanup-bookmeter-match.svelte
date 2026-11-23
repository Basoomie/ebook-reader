<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One More Bookmeter match with its evidence (the spot check and the matches list): the library
   * book beside Bookmeter's result, why it was accepted, and the ids it adds.
   */
  import { addedText, sourceText, type BookmeterMatch } from '$lib/cleanup/bookmeter-text';

  export let m: BookmeterMatch;

  $: series = m.book.series
    ? `${m.book.series}${m.book.number !== null ? ` ${m.book.number}` : ''}`
    : '';
</script>

<div class="flex flex-col gap-0.5 text-sm" data-testid="bookmeter-match">
  <span>
    <b>{m.book.calibreTitle ?? m.book.title ?? ''}</b>
    <span class="text-c-muted">
      · {m.book.calibreAuthors.join(', ')} · Calibre book {m.calibreId}{m.labeled
        ? ' · labeled'
        : ''}</span
    >
  </span>
  {#if m.book.title}
    <span class="text-c-muted">
      Stage 4 decided: {m.book.title} · {m.book.authors.join(', ')}{series ? ` · ${series}` : ''}{m
        .book.format
        ? ` · ${m.book.format}`
        : ''}
    </span>
  {/if}
  <span>
    Bookmeter:
    <a class="underline" href={m.result.url} target="_blank" rel="noopener noreferrer"
      >{m.result.title}</a
    >
    <span class="text-c-muted">
      · {m.result.authors.join(', ') || 'no author listed'}{m.result.pages
        ? ` · ${m.result.pages} pages`
        : ''}</span
    >
  </span>
  {#if m.result.listTitle && m.result.listTitle !== m.result.title}
    <span class="text-c-muted">Bookmeter’s list shows: {m.result.listTitle}</span>
  {/if}
  <span class="text-c-muted">Found by {sourceText(m)}{m.reason ? `: ${m.reason}` : ''}</span>
  {#if m.ai}
    {#each m.ai as a, i (i)}
      <span class="text-c-muted">
        {a.model ?? 'model'}: {a.answer ?? 'no answer'}{a.reason ? ` (${a.reason})` : ''}
      </span>
    {/each}
  {/if}
  <span class="text-c-muted"
    >Adds: {addedText(m)}{m.storesFailed ? ' (its store list could not be read)' : ''}</span
  >
</div>
