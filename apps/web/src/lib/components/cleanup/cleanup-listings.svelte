<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Bookmeter links on /cleanup: Off / Preview / On (On only after the spot check passed, and it
   * asks first), the step with its bar and time left, what was decided, the spot check (both
   * listings to open and mark Right or Wrong), and the folded lists (links to change, saved links
   * to a comic or an adaptation, saved listings the searches did not show), paged.
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    LISTINGS_HINTS,
    LISTINGS_MODE_LABELS,
    LISTINGS_PHASES,
    LISTING_LISTS,
    listingsBar,
    listingsLines,
    listingsSpotLine,
    type ListingItem,
    type ListingState,
    type ListingsMode,
    type ListingsStatus
  } from '$lib/cleanup/listings-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { listingsOnCopy } from '$lib/confirm/confirm-copy';
  import CleanupListingItem from './cleanup-listing-item.svelte';

  export let api: CleanupApi;

  const MODES: ListingsMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 20;

  let status: ListingsStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let spot: ListingItem[] | null = null;
  let lists: Partial<
    Record<ListingState, { total: number; items: ListingItem[]; offset: number }>
  > = {};

  $: bar = listingsBar(status);
  $: lines = listingsLines(status);
  $: spotText = listingsSpotLine(status);
  // The folded lists with their counts and loaded pages (no {@const}: prettier-plugin-svelte 4).
  $: shown = LISTING_LISTS.map((l) => ({
    ...l,
    count: status?.books[l.state] ?? 0,
    cur: lists[l.state] ?? null
  }));
  $: canLookAgain =
    !!status && status.mode !== 'off' && ['spot', 'done'].includes(status.progress.phase);

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.bookmeterLinks();
      error = '';
    } catch (err) {
      error = (err as Error).message;
    }
    if (!destroyed)
      timer = setTimeout(
        () => void refresh(),
        document.visibilityState === 'hidden' ? POLL_MS * 6 : POLL_MS
      );
  }

  onMount(() => void refresh());
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  async function setMode(mode: ListingsMode) {
    if (!status || status.mode === mode || busy) return;
    if (
      mode === 'on' &&
      !(await confirmDestructive(
        listingsOnCopy((status.proposals.proposed ?? 0) + (status.proposals.queued ?? 0))
      ))
    )
      return;
    error = '';
    busy = true;
    try {
      status = await api.setBookmeterLinksMode(mode);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function lookAgain() {
    if (busy) return;
    error = '';
    busy = true;
    try {
      status = await api.bookmeterLinksAgain();
      spot = null;
      lists = {};
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function loadSpot() {
    try {
      spot = (await api.bookmeterLinksSpot()).items;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function spotToggled(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !spot) void loadSpot();
  }

  async function mark(m: ListingItem, verdict: 'right' | 'wrong') {
    const next = m.verdict === verdict ? null : verdict;
    error = '';
    try {
      const r = await api.setBookmeterLinksVerdict(m.uuid, next);
      // A new list (the app compiles Svelte immutable: never change an item in place).
      spot = (spot ?? []).map((x) => (x.uuid === m.uuid ? { ...x, verdict: next } : x));
      if (status) status = { ...status, spot: r.counts, spotPassed: r.passed };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function load(state: ListingState, offset = 0) {
    try {
      const r = await api.bookmeterLinksList(state, offset, PAGE);
      lists = { ...lists, [state]: { ...r, offset } };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function listToggled(e: Event, state: ListingState) {
    if ((e.currentTarget as HTMLDetailsElement).open && !lists[state]) void load(state);
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="listings-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">Bookmeter links</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Bookmeter links">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy || (mode === 'on' && status.mode !== 'on' && !status.spotPassed)}
            title={mode === 'on' && !status.spotPassed
              ? 'On needs the spot check first (every book marked, none wrong)'
              : undefined}
            on:click={() => setMode(mode)}
            data-testid="listings-mode-{mode}">{LISTINGS_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{LISTINGS_HINTS[status.mode]}</p>
    {#if status.pausedReason}
      <p class="c-notice text-sm" role="alert" data-testid="listings-paused">
        <b>Paused:</b>
        {status.pausedDetail ?? status.pausedReason}
      </p>
    {/if}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="listings-progress">
        <div class="flex flex-wrap justify-between gap-x-4 text-sm">
          <span>{bar.label}</span>
          <span>{Math.floor(bar.fraction * 100)} %{bar.eta ? ` · ${bar.eta}` : ''}</span>
        </div>
        <div
          class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
          role="progressbar"
          aria-label={bar.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(bar.fraction * 100)}
        >
          <div class="h-full bg-c-fill" style="width: {bar.fraction * 100}%" />
        </div>
      </div>
    {:else if status.mode !== 'off'}
      <p class="text-sm" data-testid="listings-phase">{LISTINGS_PHASES[status.progress.phase]}</p>
    {/if}
    {#if status.progress.write.waiting && status.progress.phase === 'write'}
      <p class="text-sm text-c-muted">{status.progress.write.waiting}</p>
    {/if}
    {#each lines as line}<p class="text-sm" data-testid="listings-line">{line}</p>{/each}
    {#if spotText}
      <p class="text-sm" data-testid="listings-spot-line">{spotText}</p>
    {/if}
    {#if status.spot.size > 0}
      <details on:toggle={spotToggled} data-testid="listings-spot">
        <summary class="cursor-pointer text-sm"
          >The spot check ({n(status.spot.size)} books)</summary
        >
        {#if spot}
          <div class="mt-1 flex flex-col">
            {#each spot as m, i (m.uuid)}
              <div
                class="c-row flex flex-col gap-1 border-b border-c-line py-2"
                data-testid="listings-spot-item"
              >
                <span class="text-xs text-c-muted">{i + 1}</span>
                <CleanupListingItem {m} />
                <div class="flex flex-wrap gap-2">
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={m.verdict === 'right'}
                    on:click={() => mark(m, 'right')}
                    data-testid="listings-right">Right</button
                  >
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={m.verdict === 'wrong'}
                    on:click={() => mark(m, 'wrong')}
                    data-testid="listings-wrong">Wrong</button
                  >
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </details>
    {/if}
    {#each shown as l (l.state)}
      {#if l.count > 0}
        <details on:toggle={(e) => listToggled(e, l.state)} data-testid="listings-list-{l.state}">
          <summary class="cursor-pointer text-sm">{l.label} ({n(l.count)})</summary>
          <div class="mt-1 flex flex-col gap-1">
            <p class="text-sm text-c-muted">{l.note}</p>
            {#if l.cur}
              {#each l.cur.items as m (m.uuid)}
                <div class="c-row border-b border-c-line py-2"><CleanupListingItem {m} /></div>
              {:else}
                <p class="text-sm text-c-muted">Nothing here.</p>
              {/each}
              {#if l.cur.total > PAGE}
                <div class="flex items-center gap-2 text-sm">
                  <button
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={l.cur.offset === 0}
                    on:click={() => load(l.state, Math.max(0, (l.cur?.offset ?? 0) - PAGE))}
                    >Previous</button
                  >
                  <span
                    >{n(l.cur.offset + 1)}-{n(Math.min(l.cur.total, l.cur.offset + PAGE))} of {n(
                      l.cur.total
                    )}</span
                  >
                  <button
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={l.cur.offset + PAGE >= l.cur.total}
                    on:click={() => load(l.state, (l.cur?.offset ?? 0) + PAGE)}>Next</button
                  >
                </div>
              {/if}
            {/if}
          </div>
        </details>
      {/if}
    {/each}
    {#if canLookAgain}
      <div>
        <button
          class="c-btn c-btn-ghost c-btn-sm"
          disabled={busy}
          on:click={lookAgain}
          data-testid="listings-again">Look again from the start</button
        >
      </div>
    {/if}
  {/if}
</div>
