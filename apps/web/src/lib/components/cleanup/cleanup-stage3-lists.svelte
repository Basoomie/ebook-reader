<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 3 (WP20c): what the analysis found, by list. The copies to remove (each beside the
   * copy that stays), the pairs by class (review first, with your decision), the pairs with
   * extra text inside the chapters (most first: the special-edition measure), 30 random pairs
   * of one class, and the omnibus files, picture books and unreadable files.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import type {
    CleanupApi,
    PairDecision,
    Proposal,
    Stage3Book,
    Stage3Pair
  } from '$lib/cleanup/cleanup-api';
  import { n } from '$lib/cleanup/cleanup-text';
  import { EXAMPLE_CLASSES, PAIR_VIEWS, kindText } from '$lib/cleanup/stage3-text';
  import CopyRow from './cleanup-copy-row.svelte';
  import PairRow from './cleanup-pair-row.svelte';

  export let api: CleanupApi;

  const dispatch = createEventDispatcher<{ changed: void }>();
  const PAGE = 50;

  type View = 'remove' | 'pairs' | 'examples' | 'books';
  let view: View = 'remove';
  let removeState = 'proposed';
  let pairView = 'review';
  let exampleClass = 'duplicate';
  let bookView = 'omnibus';
  let offset = 0;
  let total = 0;
  let removals: Proposal[] = [];
  let pairs: Stage3Pair[] = [];
  let books: Stage3Book[] = [];
  let error = '';
  let busy = false;

  onMount(() => void load(0));

  async function load(at = offset) {
    error = '';
    try {
      if (view === 'remove') {
        const r = await api.proposals(3, removeState || null, at, PAGE);
        removals = r.items;
        total = r.total;
      } else if (view === 'pairs') {
        const r = await api.stage3Pairs(pairView, { offset: at, limit: PAGE });
        pairs = r.items;
        total = r.total;
      } else if (view === 'examples') {
        const r = await api.stage3Pairs('examples', { cls: exampleClass });
        pairs = r.items;
        total = r.total;
      } else {
        const r = await api.stage3Books(bookView, at);
        books = r.items;
        total = r.total;
      }
      offset = at;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function decide(event: CustomEvent<{ pair: Stage3Pair; decision: PairDecision }>) {
    busy = true;
    try {
      await api.decidePair(event.detail.pair.id, event.detail.decision);
      await load(offset);
      dispatch('changed');
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  $: shown = view === 'remove' ? removals.length : view === 'books' ? books.length : pairs.length;
</script>

<div class="flex flex-wrap items-center gap-2" data-testid="cleanup-stage3-lists">
  <label class="flex items-center gap-2 text-sm">
    Show
    <select
      class="c-input"
      bind:value={view}
      on:change={() => load(0)}
      data-testid="cleanup-stage3-view"
    >
      <option value="remove">Copies to remove</option>
      <option value="pairs">Pairs</option>
      <option value="examples">30 random pairs</option>
      <option value="books">Books</option>
    </select>
  </label>
  {#if view === 'remove'}
    <select class="c-input" bind:value={removeState} on:change={() => load(0)}>
      <option value="proposed">To remove</option>
      <option value="applied">Removed</option>
      <option value="undone">Brought back</option>
      <option value="skipped">Skipped</option>
      <option value="">All</option>
    </select>
  {:else if view === 'pairs'}
    <select
      class="c-input"
      bind:value={pairView}
      on:change={() => load(0)}
      data-testid="cleanup-stage3-pair-view"
    >
      {#each PAIR_VIEWS as v (v.id)}
        <option value={v.id}>{v.label}</option>
      {/each}
    </select>
  {:else if view === 'examples'}
    <select class="c-input" bind:value={exampleClass} on:change={() => load(0)}>
      {#each EXAMPLE_CLASSES as v (v.id)}
        <option value={v.id}>{v.label}</option>
      {/each}
    </select>
  {:else}
    <select class="c-input" bind:value={bookView} on:change={() => load(0)}>
      <option value="omnibus">Omnibus files</option>
      <option value="image_only">Picture books</option>
      <option value="errors">Couldn’t be read</option>
    </select>
  {/if}
  <button class="c-btn c-btn-ghost" on:click={() => load(offset)}>Refresh</button>
</div>

{#if error}<p class="c-notice" role="alert">{error}</p>{/if}

{#if view === 'pairs' && pairView === 'review'}
  <p class="max-w-prose text-sm text-c-muted">
    Optional: nothing waits for these. Keep both leaves both copies in Calibre; removing one sends
    it through the same checks, quarantine and Undo as every other removal.
  </p>
{:else if view === 'pairs' && pairView === 'spread'}
  <p class="max-w-prose text-sm text-c-muted">
    Copies with extra text inside the chapters (author’s notes, commentary), most first. The limit
    above which both copies stay is set after this list has been looked at; until then these pairs
    wait for review.
  </p>
{/if}

{#if shown === 0}
  <p class="text-sm text-c-muted">None.</p>
{:else}
  {#if view !== 'examples'}
    <p class="text-sm text-c-muted">{n(offset + 1)}–{n(offset + shown)} of {n(total)}</p>
  {:else}
    <p class="text-sm text-c-muted">{n(shown)} picked at random.</p>
  {/if}
  <ul class="flex flex-col gap-2">
    {#if view === 'remove'}
      {#each removals as item (item.id)}
        <CopyRow {item} />
      {/each}
    {:else if view === 'books'}
      {#each books as b (b.calibre_id)}
        <li
          class="c-tile flex flex-col gap-1 rounded p-3 text-sm"
          data-testid="cleanup-stage3-book"
        >
          <span class="font-medium">{b.title ?? '(no title)'} · Calibre #{b.calibre_id}</span>
          <span class="text-c-muted">
            {b.author ?? ''}
            {#if typeof b.chars === 'number'}· {n(b.chars)} characters{/if}
            {#if b.kind && b.kind !== 'full'}· {kindText(b.kind)}
              {b.kind_by === 'text' ? '(by its text)' : b.kind_marker ? `(“${b.kind_marker}”)` : ''}
            {/if}
          </span>
          {#if b.error}<span class="font-bold">{b.error}</span>{/if}
        </li>
      {/each}
    {:else}
      {#each pairs as pair (pair.id)}
        <PairRow
          {pair}
          {busy}
          decide={view === 'pairs' && (pairView === 'review' || !!pair.decision)}
          on:decide={decide}
        />
      {/each}
    {/if}
  </ul>
  {#if view !== 'examples'}
    <div class="flex gap-2">
      <button
        class="c-btn c-btn-secondary"
        disabled={offset === 0}
        on:click={() => load(Math.max(0, offset - PAGE))}>Previous</button
      >
      <button
        class="c-btn c-btn-secondary"
        disabled={offset + shown >= total}
        on:click={() => load(offset + PAGE)}>Next</button
      >
    </div>
  {/if}
{/if}
