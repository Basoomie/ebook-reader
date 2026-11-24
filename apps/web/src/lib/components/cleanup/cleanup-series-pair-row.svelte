<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Series under two names (tier 4, Part 3): the two names side by side with their books and the
   * store pages, why the pair has its answer, and your choice: Merge, Keep separate, Forget my
   * choice (a copy of stage 3's pair row).
   */
  import { createEventDispatcher } from 'svelte';
  import { pagePath } from '$lib/data/env';
  import { libraryQueryHref } from '$lib/library/format';
  import {
    bookLine,
    mergeBlocked,
    pairReason,
    pairSignalsLine,
    seriesQuery,
    type SeriesPair,
    type SeriesPairChoice
  } from '$lib/cleanup/series-pairs-text';

  export let pair: SeriesPair;
  export let busy = false;

  /** Books shown per name before "and N more". */
  const SHOWN = 6;

  const dispatch = createEventDispatcher<{
    decide: { pair: SeriesPair; choice: SeriesPairChoice };
  }>();

  $: sides = [
    {
      key: 'short' as const,
      name: pair.short,
      q: seriesQuery(pair.short),
      count: pair.shortBooks,
      books: pair.books.short
    },
    {
      key: 'long' as const,
      name: pair.long,
      q: seriesQuery(pair.long),
      count: pair.longBooks,
      books: pair.books.long
    }
  ];
  $: blocked = mergeBlocked(pair);
  $: mine = pair.decision?.by === 'you';
  $: evidence = pairSignalsLine(pair);
</script>

<li class="c-tile flex flex-col gap-2 rounded p-3 text-sm" data-testid="series-pair">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <span class="font-bold" data-testid="series-pair-reason">{pairReason(pair)}</span>
    <span class="text-c-muted">Kept name if merged: 「{pair.kept}」</span>
  </div>
  {#if pair.note}<p class="text-c-muted" data-testid="series-pair-note">{pair.note}</p>{/if}
  <div class="grid gap-2 sm:grid-cols-2">
    {#each sides as s (s.key)}
      <div class="flex min-w-0 flex-col gap-0.5" data-testid="series-pair-{s.key}">
        <div class="font-medium">
          {#if s.q}
            <a class="underline" href={libraryQueryHref(pagePath, s.q)}>{s.name}</a>
          {:else}{s.name}{/if}
          <span class="text-c-muted">· {s.count} {s.count === 1 ? 'book' : 'books'}</span>
        </div>
        <ul class="flex flex-col gap-0.5">
          {#each s.books.slice(0, SHOWN) as b (b.uuid)}
            <li class="break-words">
              {bookLine(b)}
              <span class="text-c-muted">· Calibre #{b.calibreId}</span>
              {#each b.links as l (l.url)}
                <a class="text-c-muted underline" href={l.url} target="_blank" rel="noreferrer"
                  >{l.site}</a
                >{' '}
              {/each}
            </li>
          {/each}
          {#if s.books.length > SHOWN}
            <li class="text-c-muted">and {s.books.length - SHOWN} more</li>
          {/if}
        </ul>
      </div>
    {/each}
  </div>
  {#if evidence}<p class="text-c-muted" data-testid="series-pair-evidence">{evidence}</p>{/if}
  {#if pair.signals?.collisionExamples.length}
    <p class="text-c-muted">Same number: {pair.signals.collisionExamples.join(' · ')}</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <button
      class="c-btn c-btn-secondary"
      disabled={busy || !!blocked}
      title={blocked ?? undefined}
      aria-pressed={mine && pair.decision?.decision === 'merged'}
      data-testid="series-pair-merge"
      on:click={() => dispatch('decide', { pair, choice: 'merge' })}>Merge</button
    >
    <button
      class="c-btn c-btn-secondary"
      disabled={busy}
      aria-pressed={mine && pair.decision?.decision === 'different'}
      data-testid="series-pair-separate"
      on:click={() => dispatch('decide', { pair, choice: 'separate' })}>Keep separate</button
    >
    {#if mine}
      <button
        class="c-btn c-btn-ghost"
        disabled={busy}
        data-testid="series-pair-clear"
        on:click={() => dispatch('decide', { pair, choice: 'clear' })}>Forget my choice</button
      >
    {/if}
  </div>
  {#if blocked && pair.signals}<p class="text-c-muted">{blocked}</p>{/if}
</li>
