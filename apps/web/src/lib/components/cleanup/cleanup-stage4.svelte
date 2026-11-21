<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 4 on /cleanup (WP20d; On and the AI check from WP20e): the online sources. The fetch container's queues
   * (per site: answered, left, challenge pages, measured pace, time left, back-off or pause), the
   * books looked up, the author readings and Natively, the check on the labeled books per field
   * beside the measured numbers, and what it would change, field by field, with each value's
   * source; the AI check (both models, setup E) and its gate; On once the AI check is done.
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
    readingLine,
    timeLeftLine,
    STAGE4_MODE_HINTS,
    aiBooksLine,
    aiGateRows,
    aiBar,
    aiLine,
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
  import CleanupDetails from './cleanup-details.svelte';
  import { stage4GateSummary, stage4SitesNeedingYou } from '$lib/cleanup/cleanup-card-text';

  export let api: CleanupApi;
  export let stage: CleanupStage;
  export let status: Stage4Status | null;
  export let setMode: (stage: CleanupStage, mode: StageMode) => void;
  export let analyseAgain: (stage: number) => void;

  const dispatch = createEventDispatcher<{ changed: void }>();

  // On waits for the AI check (WP20e): the confirmed values and best guesses come from it.
  $: aiDone = status?.ai?.phase === 'done' && !status.ai.error;
  $: aiProgress = aiBar(status?.ai);
  $: unconfirmedTotal = (status?.unconfirmed ?? []).reduce((a, u) => a + u.n, 0);

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

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="cleanup-stage-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">4 · {stage.name}</h3>
    <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 4">
      {#each ['off', 'analyse', 'on'] as mode (mode)}
        <button
          class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
          role="radio"
          aria-checked={stage.mode === mode}
          disabled={mode === 'on' && stage.mode !== 'on' && !aiDone}
          title={mode === 'on' && !aiDone ? 'Waits for the AI check' : undefined}
          on:click={() => setMode(stage, mode === 'off' ? 'off' : mode === 'on' ? 'on' : 'analyse')}
          data-testid="cleanup-stage-4-{mode}"
        >
          {mode === 'off' ? 'Off' : mode === 'on' ? 'On' : 'Preview'}
        </button>
      {/each}
    </div>
  </div>
  {#if stage.mode !== 'off'}
    {#if status && timeLeftLine(status)}
      <p class="text-sm font-medium" data-testid="cleanup-stage-4-time-left">
        {timeLeftLine(status)}
      </p>
    {/if}
    {#if progress.phase === 'read' && status && readingLine(status)}
      <p class="text-sm" data-testid="cleanup-stage-4-reading">{readingLine(status)}</p>
    {/if}
    {#if progress.error}
      <p class="c-notice text-sm" role="alert">The analysis failed: {progress.error}</p>
    {/if}
    {#if status}
      {#if status.waiting}
        <p class="text-sm text-c-muted" data-testid="cleanup-waiting-4">{status.waiting}</p>
      {/if}
      {#if !status.fetcher.online}
        <p class="c-notice text-sm" role="alert" data-testid="cleanup-fetcher-offline">
          The fetch container is not running: nothing is looked up until it is back.
        </p>
      {/if}
      {#if booksLine(status)}
        <p class="text-sm" data-testid="cleanup-stage-4-books">{booksLine(status)}</p>
      {/if}
      <!-- A site that needs you (paused, or requests given up) shows outside the fold. -->
      {#each stage4SitesNeedingYou(status) as s (s.site)}
        <p class="text-sm" data-testid="cleanup-site-problem-{s.site}">
          <b>{SITE_NAMES[s.site] ?? s.site}:</b>
          {siteLine(s)}
          {#if s.pausedReason}
            <button
              class="c-btn c-btn-ghost"
              disabled={busySite === s.site}
              on:click={() => resumeSite(s.site)}>Resume</button
            >
          {/if}
          {#if s.failed > 0}
            <button
              class="c-btn c-btn-ghost"
              disabled={busySite === s.site}
              on:click={() => retrySite(s.site)}>Ask the given-up requests again</button
            >
          {/if}
        </p>
      {/each}
      {#if message}<p class="text-sm">{message}</p>{/if}
    {/if}
    {#if stage4GateSummary(gate)}
      <p class="text-sm" data-testid="cleanup-gate-summary-4">{stage4GateSummary(gate)}</p>
    {/if}
    {#if status?.ai}
      <p class="text-sm" data-testid="cleanup-stage-4-ai">{aiLine(status.ai)}</p>
      {#if aiProgress}
        <div class="flex flex-col gap-1" data-testid="cleanup-stage-4-ai-progress">
          <div class="flex flex-wrap justify-between gap-x-4 text-sm">
            <span>{aiProgress.label}</span>
            <span
              >{Math.floor(aiProgress.fraction * 100)} %{aiProgress.eta
                ? ` · ${aiProgress.eta}`
                : ''}</span
            >
          </div>
          <div
            class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
            role="progressbar"
            aria-label={aiProgress.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(aiProgress.fraction * 100)}
          >
            <div class="h-full bg-c-fill" style="width: {aiProgress.fraction * 100}%" />
          </div>
        </div>
      {/if}
      {#if status.ai.wait}
        <p class="c-notice text-sm" role="alert" data-testid="cleanup-stage-4-ai-wait">
          {status.ai.wait}
        </p>
      {/if}
      {#if status.ai.error}
        <p class="c-notice text-sm" role="alert">The AI check failed: {status.ai.error}</p>
      {/if}
      {#if status.ai.gate}
        <p class="text-sm" data-testid="cleanup-stage-4-ai-gate">
          {status.ai.gate.passed
            ? 'The AI check passes on the labeled books'
            : `Paused after the AI check: ${status.ai.gate.below.join(', ') || 'no labeled books'}`}
          {#if unconfirmedTotal}· {n(unconfirmedTotal)} values are best guesses, marked unconfirmed{/if}
        </p>
      {/if}
    {/if}
    <CleanupDetails id="stage-4" testid="cleanup-details-4">
      <p class="text-c-muted">{STAGE4_MODE_HINTS[stage.mode]}</p>
      <div>
        <button
          class="c-btn c-btn-ghost"
          data-testid="cleanup-analyse-again-4"
          on:click={() => analyseAgain(4)}>Run the analysis again</button
        >
      </div>
      {#if status}
        <p class="text-c-muted" data-testid="cleanup-fetcher">
          Fetch container: {status.fetcher.online ? 'running' : 'not running'}
          {#if status.fetcher.lastSeenAt}· last seen {formatWhen(status.fetcher.lastSeenAt)}{/if}
          {#if status.fetcher.version}· {status.fetcher.version}{/if}
          {#if status.fetcher.sudachi}· {status.fetcher.sudachi}{/if}
          {#if status.fetcher.problem}· {status.fetcher.problem}{/if}
          · Amazon pace: {status.amazonPace}
        </p>
        <ul class="flex flex-col gap-2" data-testid="cleanup-sites">
          {#each status.sites as s (s.site)}
            <li class="flex flex-col gap-1 border-b py-2" style="border-color: var(--c-line)">
              <span class="font-medium">{SITE_NAMES[s.site] ?? s.site}</span>
              <span class="text-c-muted">{siteLine(s)}</span>
            </li>
          {/each}
        </ul>
        {#if readingsLine(status)}<p>{readingsLine(status)}</p>{/if}
        {#if nativelyLine(status)}<p>{nativelyLine(status)}</p>{/if}
        {#if status.fields.length}
          <p data-testid="cleanup-stage-4-fields">
            Would change:
            {#each fieldCounts(status) as f, i (f.field)}
              {i ? ' · ' : ''}{f.label} {n(f.auto)} automatically, {n(f.review)} for review
            {/each}
          </p>
        {/if}
      {/if}
      {#if status?.ai?.gate}
        <div class="flex flex-col gap-1" data-testid="cleanup-ai-gate-4">
          <p class="font-medium">
            After the AI check, on {n(status.ai.gate.books)} labeled books
          </p>
          <ul class="flex flex-col gap-1">
            {#each aiGateRows(status.ai) as row (row.field)}
              <li class={row.below ? 'font-bold' : ''}>
                {row.field}: {row.confirmed} · {row.all} · {row.checkD}{row.below
                  ? ' · paused'
                  : ''}
              </li>
            {/each}
            {#if aiBooksLine(status.ai)}<li>{aiBooksLine(status.ai)}</li>{/if}
            <li>
              Answers not in the evidence (dropped): {n(status.ai.invented)}
              {#if status.ai.flaggedAgainstRules}
                · both models against the rules:
                {Object.entries(status.ai.flaggedAgainstRules)
                  .map(([k, v]) => `${k} ${n(v)}`)
                  .join(', ') || 'none'}
              {/if}
            </li>
          </ul>
        </div>
      {/if}
      {#if gate}
        <div class="flex flex-col gap-1" data-testid="cleanup-gate-4">
          <p class="font-medium">
            Checked on {n(gate.books)} labeled books ({formatWhen(gate.at)})
          </p>
          <ul class="flex flex-col gap-1">
            {#each gateRows(gate) as row (row.field)}
              <li class={row.below ? 'font-bold' : ''}>
                {row.field}: {row.percent} · {row.auto} · {row.the600} · {row.checkD}{row.below
                  ? ' · paused'
                  : ''}
              </li>
            {/each}
            <li>
              Edition: {gate.kind.percent === null ? '–' : `${gate.kind.percent.toFixed(1)} %`} right
              ({n(gate.kind.right)} of {n(gate.kind.all)})
            </li>
          </ul>
        </div>
      {/if}
    </CleanupDetails>
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
              >{p.class === 'auto'
                ? p.evidence?.unconfirmed
                  ? 'Unconfirmed (written as the best guess)'
                  : 'Automatic'
                : 'For review'} · from {sourceName(p.source)}{p.reason
                ? ` · ${p.reason}`
                : ''}</span
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
