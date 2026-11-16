<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 3 (WP20c): two copies side by side (left = the lower Calibre id), with what the
   * comparison found (the text both ways, extra text inside the chapters, each measure of the
   * better copy) and, when asked for, your decision: both stay, or one goes.
   */
  import { createEventDispatcher } from 'svelte';
  import type { PairDecision, Stage3Pair } from '$lib/cleanup/cleanup-api';
  import {
    bookFactsLine,
    classText,
    keepLine,
    measureLabel,
    measureWinner,
    overlapLine,
    spreadLine
  } from '$lib/cleanup/stage3-text';
  import { tagsText } from '$lib/cleanup/cleanup-text';

  export let pair: Stage3Pair;
  /** Show the decision buttons. */
  export let decide = false;
  export let busy = false;

  const dispatch = createEventDispatcher<{
    decide: { pair: Stage3Pair; decision: PairDecision };
  }>();

  $: sides = [
    { key: 'a' as const, label: 'Left', book: pair.a },
    { key: 'b' as const, label: 'Right', book: pair.b }
  ];
  $: overlap = overlapLine(pair);
  $: spread = spreadLine(pair);
  $: keep = keepLine(pair);
  $: measures = (pair.best?.measures ?? []).filter((m) => m.winner !== 'tie');
</script>

<li class="c-tile flex flex-col gap-2 rounded p-3 text-sm" data-testid="cleanup-pair">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <span class="font-bold">{classText(pair.class)}</span>
    <span class="text-c-muted">{pair.reason ?? pair.error ?? ''}</span>
  </div>
  <div class="grid gap-2 sm:grid-cols-2">
    {#each sides as s (s.key)}
      <div class="flex flex-col gap-0.5" data-testid="cleanup-pair-{s.key}">
        <div class="font-medium">
          {s.label} · Calibre #{s.book.calibreId}
          {#if pair.keepId === s.book.calibreId}<span class="c-count">stays</span>{/if}
        </div>
        <div>{s.book.title ?? '(not in the library any more)'}</div>
        {#if s.book.author}<div class="text-c-muted">{s.book.author}</div>{/if}
        <div class="text-c-muted">{bookFactsLine(s.book)}</div>
        <div class="text-c-muted">Tags: {tagsText(s.book.tags)}</div>
        {#if s.book.error}<div class="font-bold">Couldn’t be read: {s.book.error}</div>{/if}
      </div>
    {/each}
  </div>
  {#if overlap}<p>{overlap}</p>{/if}
  {#if spread}<p data-testid="cleanup-pair-spread">{spread}</p>{/if}
  {#if measures.length}
    <ul class="flex flex-col" data-testid="cleanup-pair-measures">
      {#each measures as m (m.name)}
        <li>
          <span class="font-medium">{measureLabel(m)}:</span>
          {measureWinner(m)} <span class="text-c-muted">({m.detail})</span>
        </li>
      {/each}
    </ul>
  {:else if pair.best}
    <p class="text-c-muted">The same on every measure.</p>
  {/if}
  {#if keep}<p class="font-medium" data-testid="cleanup-pair-keep">{keep}</p>{/if}
  {#if decide}
    <div class="flex flex-wrap gap-2">
      <button
        class="c-btn c-btn-secondary"
        disabled={busy}
        data-testid="cleanup-pair-keep-both"
        on:click={() => dispatch('decide', { pair, decision: 'keep_both' })}>Keep both</button
      >
      <button
        class="c-btn c-btn-secondary"
        disabled={busy}
        data-testid="cleanup-pair-remove-a"
        on:click={() => dispatch('decide', { pair, decision: 'remove_a' })}
        >Remove the left copy</button
      >
      <button
        class="c-btn c-btn-secondary"
        disabled={busy}
        data-testid="cleanup-pair-remove-b"
        on:click={() => dispatch('decide', { pair, decision: 'remove_b' })}
        >Remove the right copy</button
      >
      {#if pair.decision}
        <button
          class="c-btn c-btn-ghost"
          disabled={busy}
          data-testid="cleanup-pair-clear"
          on:click={() => dispatch('decide', { pair, decision: 'clear' })}>Forget my choice</button
        >
      {/if}
    </div>
  {/if}
</li>
