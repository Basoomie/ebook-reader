<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * More Bookmeter matches on /cleanup (More Bookmeter coverage, step 2): Off / Preview / On (On
   * only after the spot check passed, and it asks first), the step with its bar and time left,
   * what was found by source, the spot check (50 books to mark Right or Wrong, with the evidence
   * for each), and the folded list of the new matches (paged, by source).
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    BOOKMETER_HINTS,
    BOOKMETER_MODE_LABELS,
    BOOKMETER_PHASES,
    SOURCE_LABELS,
    aiBatchLines,
    bookmeterBar,
    bookmeterLines,
    spotLine,
    type BookmeterMatch,
    type BookmeterMode,
    type BookmeterSource,
    type BookmeterStatus
  } from '$lib/cleanup/bookmeter-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { bookmeterOnCopy } from '$lib/confirm/confirm-copy';
  import CleanupBookmeterMatch from './cleanup-bookmeter-match.svelte';

  export let api: CleanupApi;

  const MODES: BookmeterMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 20;
  const SOURCES: BookmeterSource[] = ['rules', 'ai', 'second'];

  let status: BookmeterStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let spot: BookmeterMatch[] | null = null;
  let spotOpen = false;
  let matches: { total: number; items: BookmeterMatch[]; offset: number } | null = null;
  let source: BookmeterSource | null = null;

  $: bar = bookmeterBar(status);
  $: lines = bookmeterLines(status);
  $: spotText = spotLine(status);
  $: batchLines = aiBatchLines(status);

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.bookmeter();
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

  async function setMode(mode: BookmeterMode) {
    if (!status || status.mode === mode || busy) return;
    if (
      mode === 'on' &&
      !(await confirmDestructive(bookmeterOnCopy(status.proposals.proposed ?? 0)))
    )
      return;
    error = '';
    busy = true;
    try {
      status = await api.setBookmeterMode(mode);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function loadSpot() {
    try {
      spot = (await api.bookmeterSpot()).items;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function spotToggled(e: Event) {
    spotOpen = (e.currentTarget as HTMLDetailsElement).open;
    if (spotOpen && !spot) void loadSpot();
  }

  async function mark(m: BookmeterMatch, verdict: 'right' | 'wrong') {
    const next = m.verdict === verdict ? null : verdict;
    error = '';
    try {
      const r = await api.setBookmeterVerdict(m.uuid, next);
      // A new list (the app compiles Svelte immutable: never change an item in place).
      spot = (spot ?? []).map((x) => (x.uuid === m.uuid ? { ...x, verdict: next } : x));
      if (status) status = { ...status, spot: r.counts, spotPassed: r.passed };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function loadMatches(offset = 0) {
    try {
      const r = await api.bookmeterMatches(source, offset, PAGE);
      matches = { ...r, offset };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function matchesToggled(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !matches) void loadMatches();
  }

  function pickSource(s: BookmeterSource | null) {
    source = s;
    void loadMatches(0);
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="bookmeter-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">More Bookmeter matches</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="More Bookmeter matches">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy || (mode === 'on' && status.mode !== 'on' && !status.spotPassed)}
            title={mode === 'on' && !status.spotPassed
              ? 'On needs the spot check first (every book marked, at most 1 wrong)'
              : undefined}
            on:click={() => setMode(mode)}
            data-testid="bookmeter-mode-{mode}">{BOOKMETER_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{BOOKMETER_HINTS[status.mode]}</p>
    {#if status.pausedReason}
      <p class="c-notice text-sm" role="alert" data-testid="bookmeter-paused">
        <b>Paused:</b>
        {status.pausedDetail ?? status.pausedReason}
      </p>
    {/if}
    {#if status.siteWait && status.mode !== 'off'}
      <p class="c-notice text-sm" data-testid="bookmeter-site-wait">
        Bookmeter is not asked now: {status.siteWait}
      </p>
    {/if}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="bookmeter-progress">
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
      <p class="text-sm" data-testid="bookmeter-phase">
        {BOOKMETER_PHASES[status.progress.phase]}
      </p>
    {/if}
    {#each batchLines as line}
      <p class="text-sm text-c-muted" data-testid="bookmeter-ai-batch">{line}</p>
    {/each}
    {#if status.progress.ai.wait && status.progress.phase === 'ai'}
      <p class="text-sm text-c-muted">{status.progress.ai.wait}</p>
    {/if}
    {#if status.progress.write.waiting && status.progress.phase === 'write'}
      <p class="text-sm text-c-muted">{status.progress.write.waiting}</p>
    {/if}
    {#each lines as line}<p class="text-sm" data-testid="bookmeter-line">{line}</p>{/each}
    {#if spotText}
      <p class="text-sm" data-testid="bookmeter-spot-line">{spotText}</p>
    {/if}
    {#if status.spot.size > 0}
      <details on:toggle={spotToggled} data-testid="bookmeter-spot">
        <summary class="cursor-pointer text-sm"
          >The spot check ({n(status.spot.size)} books)</summary
        >
        {#if spot}
          <div class="mt-1 flex flex-col">
            {#each spot as m, i (m.uuid)}
              <div
                class="c-row flex flex-col gap-1 border-b border-c-line py-2"
                data-testid="bookmeter-spot-item"
              >
                <span class="text-xs text-c-muted"
                  >{i + 1} · {SOURCE_LABELS[m.source ?? 'rules']}</span
                >
                <CleanupBookmeterMatch {m} />
                <div class="flex flex-wrap gap-2">
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={m.verdict === 'right'}
                    on:click={() => mark(m, 'right')}
                    data-testid="bookmeter-right">Right</button
                  >
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={m.verdict === 'wrong'}
                    on:click={() => mark(m, 'wrong')}
                    data-testid="bookmeter-wrong">Wrong</button
                  >
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </details>
    {/if}
    {#if (status.books['ready:rules'] ?? 0) + (status.books['ready:ai'] ?? 0) + (status.books['ready:second'] ?? 0) > 0}
      <details on:toggle={matchesToggled} data-testid="bookmeter-matches">
        <summary class="cursor-pointer text-sm"
          >New matches{matches ? ` (${n(matches.total)})` : ''}</summary
        >
        <div class="mt-1 flex flex-col gap-1">
          <div class="flex flex-wrap gap-2" role="group" aria-label="Found by">
            <button
              class="c-chip c-chip-sm"
              aria-pressed={source === null}
              on:click={() => pickSource(null)}>All</button
            >
            {#each SOURCES as s (s)}
              <button
                class="c-chip c-chip-sm"
                aria-pressed={source === s}
                on:click={() => pickSource(s)}>{SOURCE_LABELS[s]}</button
              >
            {/each}
          </div>
          {#if matches}
            {#each matches.items as m (m.uuid)}
              <div class="c-row border-b border-c-line py-2"><CleanupBookmeterMatch {m} /></div>
            {:else}
              <p class="text-sm text-c-muted">Nothing here.</p>
            {/each}
            {#if matches.total > PAGE}
              <div class="flex items-center gap-2 text-sm">
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={matches.offset === 0}
                  on:click={() => loadMatches(Math.max(0, (matches?.offset ?? 0) - PAGE))}
                  >Previous</button
                >
                <span
                  >{n(matches.offset + 1)}-{n(Math.min(matches.total, matches.offset + PAGE))} of {n(
                    matches.total
                  )}</span
                >
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={matches.offset + PAGE >= matches.total}
                  on:click={() => loadMatches((matches?.offset ?? 0) + PAGE)}>Next</button
                >
              </div>
            {/if}
          {/if}
        </div>
      </details>
    {/if}
  {/if}
</div>
