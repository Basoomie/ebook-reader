<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 4 on /cleanup (WP20d): the online sources, Preview only. The fetch container's queues
   * (per site: answered, left, challenge pages, measured pace, time left, back-off or pause), the
   * books looked up, the author readings and Natively, the check on the labeled books per field
   * beside the measured numbers, and what it would change, field by field, with each value's
   * source. Nothing here changes Calibre: stage 4's writes come with the AI check (WP20e).
   */
  import { createEventDispatcher } from 'svelte';
  import type {
    AuthorReading,
    CleanupApi,
    CleanupStage,
    Stage4Gate,
    Stage4Proposal,
    Stage4Status,
    StageMode
  } from '$lib/cleanup/cleanup-api';
  import { n } from '$lib/cleanup/cleanup-text';
  import {
    FIELD_NAMES,
    SITE_NAMES,
    STAGE4_MODE_HINTS,
    booksLine,
    fieldCounts,
    gateRows,
    nativelyLine,
    readingsLine,
    siteLine,
    sourceName,
    valueText
  } from '$lib/cleanup/stage4-text';
  import { formatWhen } from '$lib/notes/notes-format';

  export let api: CleanupApi;
  export let stage: CleanupStage;
  export let status: Stage4Status | null;
  export let setMode: (stage: CleanupStage, mode: StageMode) => void;
  export let analyseAgain: (stage: number) => void;

  const dispatch = createEventDispatcher<{ changed: void }>();

  $: gate = ((stage.precision as { gate?: Stage4Gate }).gate ?? null) as Stage4Gate | null;
  $: progress = stage.progress as {
    phase?: string;
    readDone?: number;
    readTotal?: number;
    error?: string | null;
  };

  let busySite = '';
  let message = '';
  async function resumeSite(site: string) {
    busySite = site;
    try {
      await api.resumeSite(site);
      dispatch('changed');
    } finally {
      busySite = '';
    }
  }
  async function retrySite(site: string) {
    busySite = site;
    try {
      const r = await api.retrySite(site);
      message = `${SITE_NAMES[site] ?? site}: ${n(r.retried.requests)} requests asked again, ${n(r.retried.books)} books looked up again.`;
      dispatch('changed');
    } finally {
      busySite = '';
    }
  }

  // What it would change: one field and class at a time, 50 per page.
  let field = 'title';
  let cls = '';
  let offset = 0;
  let items: Stage4Proposal[] = [];
  let total = 0;
  let loading = false;
  let listError = '';
  async function load() {
    loading = true;
    listError = '';
    try {
      const r = await api.stage4Proposals({ field, cls: cls || undefined, offset });
      items = r.items;
      total = r.total;
    } catch (err) {
      listError = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  let readingState = 'generated';
  let readings: AuthorReading[] = [];
  let readingsTotal = 0;
  async function loadReadings() {
    try {
      const r = await api.stage4Readings(readingState);
      readings = r.items;
      readingsTotal = r.total;
    } catch (err) {
      listError = (err as Error).message;
    }
  }
</script>

<div class="c-tile flex flex-col gap-3 rounded p-4" data-testid="cleanup-stage-4">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 class="font-mincho text-lg font-bold">4 · {stage.name}</h3>
    <span class="text-sm text-c-muted">{STAGE4_MODE_HINTS[stage.mode]}</span>
  </div>
  <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 4">
    {#each ['off', 'analyse'] as mode (mode)}
      <button
        class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
        role="radio"
        aria-checked={stage.mode === mode}
        on:click={() => setMode(stage, mode === 'off' ? 'off' : 'analyse')}
        data-testid="cleanup-stage-4-{mode}"
      >
        {mode === 'off' ? 'Off' : 'Preview'}
      </button>
    {/each}
    <button class="c-btn c-btn-secondary" disabled title="Comes with the AI check (WP20e)"
      >On</button
    >
    {#if stage.mode !== 'off'}
      <button
        class="c-btn c-btn-ghost"
        data-testid="cleanup-analyse-again-4"
        on:click={() => analyseAgain(4)}>Run the analysis again</button
      >
    {/if}
  </div>
  {#if stage.mode !== 'off'}
    {#if progress.phase === 'read' && progress.readTotal}
      <p class="text-sm" data-testid="cleanup-stage-4-reading">
        Reading the files: {n(progress.readDone ?? 0)} of {n(progress.readTotal)}
      </p>
    {/if}
    {#if progress.error}
      <p class="c-notice text-sm" role="alert">The analysis failed: {progress.error}</p>
    {/if}
    {#if status}
      {#if status.waiting}
        <p class="text-sm text-c-muted" data-testid="cleanup-waiting-4">{status.waiting}</p>
      {/if}
      <p class="text-sm text-c-muted" data-testid="cleanup-fetcher">
        Fetch container: {status.fetcher.online ? 'running' : 'not running'}
        {#if status.fetcher.lastSeenAt}· last seen {formatWhen(status.fetcher.lastSeenAt)}{/if}
        {#if status.fetcher.version}· {status.fetcher.version}{/if}
        {#if status.fetcher.sudachi}· {status.fetcher.sudachi}{/if}
        {#if status.fetcher.problem}· {status.fetcher.problem}{/if}
        · Amazon pace: {status.amazonPace}
      </p>
      {#if booksLine(status)}
        <p class="text-sm" data-testid="cleanup-stage-4-books">{booksLine(status)}</p>
      {/if}
      <ul class="flex flex-col gap-2 text-sm" data-testid="cleanup-sites">
        {#each status.sites as s (s.site)}
          <li class="flex flex-col gap-1 border-b py-2" style="border-color: var(--c-line)">
            <span class="font-medium">{SITE_NAMES[s.site] ?? s.site}</span>
            <span class="text-c-muted">{siteLine(s)}</span>
            {#if s.pausedReason || (s.failed && s.enabled)}
              <span class="flex flex-wrap gap-2">
                {#if s.pausedReason}
                  <button
                    class="c-btn c-btn-secondary"
                    disabled={busySite === s.site}
                    on:click={() => resumeSite(s.site)}>Resume</button
                  >
                {/if}
                {#if s.failed && s.enabled}
                  <button
                    class="c-btn c-btn-secondary"
                    disabled={busySite === s.site}
                    on:click={() => retrySite(s.site)}>Ask the given-up requests again</button
                  >
                {/if}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if message}<p class="text-sm">{message}</p>{/if}
      {#if readingsLine(status)}<p class="text-sm">{readingsLine(status)}</p>{/if}
      {#if nativelyLine(status)}<p class="text-sm">{nativelyLine(status)}</p>{/if}
      {#if status.fields.length}
        <p class="text-sm" data-testid="cleanup-stage-4-fields">
          Would change:
          {#each fieldCounts(status) as f, i (f.field)}
            {i ? ' · ' : ''}{f.label} {n(f.auto)} automatically, {n(f.review)} for review
          {/each}
        </p>
      {/if}
    {/if}
    {#if gate}
      <details class="flex flex-col gap-2" open data-testid="cleanup-gate-4">
        <summary class="cursor-pointer text-sm font-medium"
          >Checked on {n(gate.books)} labeled books ({formatWhen(gate.at)})</summary
        >
        <ul class="mt-2 flex flex-col gap-1 text-sm">
          {#each gateRows(gate) as row (row.field)}
            <li class={row.below ? 'font-bold' : ''}>
              {row.field}: {row.percent} · {row.auto} · {row.the600} · {row.checkD}{row.below
                ? ' · paused'
                : ''}
            </li>
          {/each}
          <li>
            Edition: {gate.kind.percent === null ? '–' : `${gate.kind.percent.toFixed(1)} %`} right ({n(
              gate.kind.right
            )} of {n(gate.kind.all)})
          </li>
        </ul>
      </details>
    {/if}
    <details
      class="flex flex-col gap-2"
      data-testid="cleanup-stage-4-list"
      on:toggle={(e) => e.currentTarget.open && load()}
    >
      <summary class="cursor-pointer text-sm font-medium">What it would change</summary>
      <div class="mt-2 flex flex-wrap gap-2">
        <label class="flex flex-col text-sm"
          >Field
          <select class="c-input" bind:value={field} on:change={() => ((offset = 0), load())}>
            {#each Object.entries(FIELD_NAMES) as [id, label] (id)}<option value={id}
                >{label}</option
              >{/each}
          </select>
        </label>
        <label class="flex flex-col text-sm"
          >Which
          <select class="c-input" bind:value={cls} on:change={() => ((offset = 0), load())}>
            <option value="">All</option>
            <option value="auto">Automatic</option>
            <option value="review">For review</option>
          </select>
        </label>
      </div>
      {#if listError}<p class="text-sm" role="alert">{listError}</p>{/if}
      <p class="text-sm text-c-muted">{loading ? 'Loading…' : `${n(total)} books`}</p>
      <ul class="flex flex-col gap-2 text-sm">
        {#each items as p (p.id)}
          <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
            <span class="font-medium">{p.title ?? `Calibre ${p.calibreId}`}</span>
            <span>{valueText(p.old)} → <b>{valueText(p.new)}</b></span>
            <span class="text-c-muted"
              >{p.class === 'auto' ? 'Automatic' : 'For review'} · from {sourceName(
                p.source
              )}{p.reason ? ` · ${p.reason}` : ''}</span
            >
          </li>
        {/each}
      </ul>
      {#if total > 50}
        <div class="flex gap-2">
          <button
            class="c-btn c-btn-secondary"
            disabled={offset === 0}
            on:click={() => ((offset = Math.max(0, offset - 50)), load())}>Previous</button
          >
          <button
            class="c-btn c-btn-secondary"
            disabled={offset + 50 >= total}
            on:click={() => ((offset += 50), load())}>Next</button
          >
        </div>
      {/if}
    </details>
    <details
      class="flex flex-col gap-2"
      data-testid="cleanup-stage-4-readings"
      on:toggle={(e) => e.currentTarget.open && loadReadings()}
    >
      <summary class="cursor-pointer text-sm font-medium">Author readings</summary>
      <label class="mt-2 flex flex-col text-sm"
        >Show
        <select class="c-input" bind:value={readingState} on:change={loadReadings}>
          <option value="generated">Generated (spot check)</option>
          <option value="found">From Web NDL Authorities</option>
          <option value="none">Without a reading</option>
        </select>
      </label>
      <p class="text-sm text-c-muted">
        {n(readingsTotal)} names · readings from Web NDL Authorities (National Diet Library)
      </p>
      <ul class="flex flex-col gap-1 text-sm">
        {#each readings as r (r.name)}
          <li>
            {r.name}{r.reading ? ` · ${r.reading}` : ''}{r.ambiguous
              ? ' · several authorities'
              : ''}
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>
