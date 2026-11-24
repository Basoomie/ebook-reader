<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Series under two names on /cleanup (tier 4, Part 3): Off / Preview / On (On asks first),
   * the step with its bar and time left, what was found, and the list of pairs by view (to
   * decide, merged, kept separate, your choices), paged, with Merge / Keep separate / Forget my
   * choice on each pair.
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    SERIES_PAIRS_HINTS,
    SERIES_PAIRS_MODE_LABELS,
    SERIES_PAIRS_PHASES,
    SERIES_PAIRS_VIEWS,
    seriesPairsBar,
    seriesPairsLines,
    type SeriesPair,
    type SeriesPairChoice,
    type SeriesPairsMode,
    type SeriesPairsStatus,
    type SeriesPairsView
  } from '$lib/cleanup/series-pairs-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { seriesPairsOnCopy } from '$lib/confirm/confirm-copy';
  import SeriesPairRow from './cleanup-series-pair-row.svelte';

  export let api: CleanupApi;

  const MODES: SeriesPairsMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 20;

  let status: SeriesPairsStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let view: SeriesPairsView = 'review';
  let list: { total: number; pairs: SeriesPair[]; offset: number } | null = null;
  let open = false;

  $: bar = seriesPairsBar(status);
  $: lines = seriesPairsLines(status);

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.seriesPairs();
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

  async function setMode(mode: SeriesPairsMode) {
    if (!status || status.mode === mode || busy) return;
    if (
      mode === 'on' &&
      !(await confirmDestructive(
        seriesPairsOnCopy(
          (status.proposals.proposed ?? 0) + (status.proposals.queued ?? 0),
          status.progress.counts.merge
        )
      ))
    )
      return;
    error = '';
    busy = true;
    try {
      status = await api.setSeriesPairsMode(mode);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function load(offset = 0) {
    try {
      const r = await api.seriesPairList(view, offset, PAGE);
      list = { ...r, offset };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function toggled(e: Event) {
    open = (e.currentTarget as HTMLDetailsElement).open;
    if (open && !list) void load();
  }

  function pickView(v: SeriesPairsView) {
    view = v;
    void load(0);
  }

  async function decide(e: CustomEvent<{ pair: SeriesPair; choice: SeriesPairChoice }>) {
    error = '';
    busy = true;
    try {
      await api.decideSeriesPair(e.detail.pair.id, e.detail.choice);
      await load(list?.offset ?? 0);
      void refresh();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="series-pairs-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">Series under two names</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Series under two names">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy || !status.stage4Done}
            title={!status.stage4Done ? 'Waits until stage 4 has finished' : undefined}
            on:click={() => setMode(mode)}
            data-testid="series-pairs-mode-{mode}">{SERIES_PAIRS_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{SERIES_PAIRS_HINTS[status.mode]}</p>
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="series-pairs-progress">
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
      <p class="text-sm" data-testid="series-pairs-phase">
        {status.mode === 'analyse' && status.progress.phase === 'write'
          ? 'Done: the merges wait for On'
          : SERIES_PAIRS_PHASES[status.progress.phase]}
      </p>
    {/if}
    {#if status.progress.write.waiting && status.progress.phase === 'write' && status.mode === 'on'}
      <p class="text-sm text-c-muted">{status.progress.write.waiting}</p>
    {/if}
    {#each lines as line}<p class="text-sm" data-testid="series-pairs-line">{line}</p>{/each}
    {#if status.progress.pairs > 0}
      <details on:toggle={toggled} data-testid="series-pairs-list">
        <summary class="cursor-pointer text-sm"
          >The pairs{list ? ` (${n(list.total)})` : ''}</summary
        >
        <div class="mt-1 flex flex-col gap-2">
          <div class="flex flex-wrap gap-2" role="group" aria-label="Show">
            {#each SERIES_PAIRS_VIEWS as v (v.view)}
              <button
                class="c-chip c-chip-sm"
                aria-pressed={view === v.view}
                data-testid="series-pairs-view-{v.view}"
                on:click={() => pickView(v.view)}>{v.label}</button
              >
            {/each}
          </div>
          {#if list}
            <ul class="flex flex-col gap-2">
              {#each list.pairs as pair (pair.id)}
                <SeriesPairRow {pair} {busy} on:decide={decide} />
              {:else}
                <li class="text-sm text-c-muted">Nothing here.</li>
              {/each}
            </ul>
            {#if list.total > PAGE}
              <div class="flex items-center gap-2 text-sm">
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={list.offset === 0}
                  on:click={() => load(Math.max(0, (list?.offset ?? 0) - PAGE))}>Previous</button
                >
                <span
                  >{n(list.offset + 1)}-{n(Math.min(list.total, list.offset + PAGE))} of {n(
                    list.total
                  )}</span
                >
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={list.offset + PAGE >= list.total}
                  on:click={() => load((list?.offset ?? 0) + PAGE)}>Next</button
                >
              </div>
            {/if}
          {/if}
        </div>
      </details>
    {/if}
  {/if}
</div>
