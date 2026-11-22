<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Audiobooks tab's stage 7 card (WP21f-1): the daily new arrivals. Off / Preview / On (asks
   * first), Run now (asks first), the run's step with its bar and time left (while stages 1-5 run
   * again, their bar), the summary line, and in Details the last report, the AI setups (E/F/J)
   * with what an upgrade would re-check, and the plan's CSV.
   */
  import type {
    AudioStageMode,
    AudioStageRow,
    AudioStatus,
    CleanupApi
  } from '$lib/cleanup/cleanup-api';
  import {
    MODE_LABEL_ON_7,
    STAGE7_HINTS,
    designLines,
    reportLines,
    stage7Bar,
    stage7Summary
  } from '$lib/cleanup/audio-arrivals-text';
  import { AUDIO_MODE_LABELS } from '$lib/cleanup/audio-text';
  import type { ProgressBar } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { arrivalsOnCopy, arrivalsRunNowCopy } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;
  export let status: AudioStatus;
  export let stage: AudioStageRow;
  /** The bar of stage 1-5 that runs again for this run (shown while the run waits for it). */
  export let stageBars: ProgressBar[] = [];
  export let detailsOpen = false;
  export let onToggle: (e: Event) => void = () => undefined;
  export let onStatus: (s: AudioStatus) => void;

  const MODES: (AudioStageMode | 'on')[] = ['off', 'analyse', 'on'];
  let error = '';
  let busy = false;

  $: s7 = status.stage7?.available ? status.stage7 : null;
  $: run = s7?.run ?? null;
  $: now = status ? Date.now() : 0;
  $: bar = stage7Bar(s7?.running ? run : null, now, s7?.absWaitMinutes ?? 30);
  $: showStageBars =
    s7?.running &&
    run &&
    (run.phase === 'stage1' || run.phase === 'stage1b' || run.phase === 'stages');

  async function setMode(mode: AudioStageMode | 'on') {
    if (stage.mode === mode) return;
    if (
      mode === 'on' &&
      !(await confirmDestructive(arrivalsOnCopy(s7 ? stage7Summary(s7, Date.now()) : null)))
    )
      return;
    error = '';
    try {
      onStatus(await api.setAudioStageMode(7, mode));
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function runNow() {
    if (
      !(await confirmDestructive(
        arrivalsRunNowCopy(stage.mode === 'on' ? 'on' : 'analyse', s7?.libraryChanges ?? 'off')
      ))
    )
      return;
    error = '';
    busy = true;
    try {
      onStatus(await api.audioAnalyseAgain(7));
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function resume() {
    error = '';
    try {
      onStatus(await api.audioArrivalsResume());
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function downloadPlan() {
    error = '';
    try {
      const blob = await api.audioArrivalsPlanFile();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audiobooks-new-arrivals-plan.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      error = (err as Error).message;
    }
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="audio-stage-7">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">7 · {stage.name}</h3>
    <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 7">
      {#each MODES as mode (mode)}
        <button
          class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
          role="radio"
          aria-checked={stage.mode === mode}
          on:click={() => setMode(mode)}
          data-testid="audio-stage-7-{mode}"
        >
          {mode === 'on' ? MODE_LABEL_ON_7 : AUDIO_MODE_LABELS[mode]}
        </button>
      {/each}
    </div>
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if stage.pauseReason}
    <p class="c-notice text-sm" role="alert" data-testid="audio-arrivals-paused">
      <b>Paused:</b>
      {stage.pauseDetail ?? stage.pauseReason}
      <button class="c-btn c-btn-ghost" on:click={resume} data-testid="audio-arrivals-resume">
        Resume
      </button>
    </p>
  {/if}
  {#if stage.mode !== 'off'}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="audio-progress-7">
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
    {/if}
    {#if showStageBars}
      {#each stageBars as b (b.label)}
        <div class="flex flex-col gap-1" data-testid="audio-progress-7-stage">
          <div class="flex flex-wrap justify-between gap-x-4 text-sm">
            <span>{b.label}</span>
            <span>{Math.floor(b.fraction * 100)} %{b.eta ? ` · ${b.eta}` : ''}</span>
          </div>
          <div class="c-progress h-2 overflow-hidden rounded-full bg-c-track">
            <div class="h-full bg-c-fill" style="width: {b.fraction * 100}%" />
          </div>
        </div>
      {/each}
    {/if}
    {#if s7?.running && run?.waiting && !stage.pauseReason}
      <p class="text-sm text-c-muted" data-testid="audio-waiting-7">{run.waiting}</p>
    {/if}
    <p class="text-sm" data-testid="audio-summary-7">{stage7Summary(s7, now)}</p>
    {#if s7?.openReviews && Object.values(s7.openReviews).some((v) => v > 0)}
      <p class="text-sm" data-testid="audio-arrivals-open">
        To look at: {Object.values(s7.openReviews).reduce((a, b) => a + b, 0)} (the list below)
      </p>
    {/if}
    <div>
      <button
        class="c-btn c-btn-secondary"
        disabled={busy || !!s7?.running || !s7?.switched}
        on:click={runNow}
        data-testid="audio-arrivals-run-now">{s7?.running ? 'Running…' : 'Run now'}</button
      >
    </div>
  {/if}
  <details open={detailsOpen} on:toggle={onToggle} data-testid="audio-details-7">
    <summary class="cursor-pointer text-sm text-c-muted">Details</summary>
    <div class="mt-2 flex flex-col gap-2 text-sm">
      <p class="text-c-muted">{STAGE7_HINTS[stage.mode === 'on' ? 'on' : stage.mode]}</p>
      {#each reportLines(s7) as line}<p data-testid="audio-arrivals-report">{line}</p>{/each}
      {#each designLines(s7) as line}<p data-testid="audio-arrivals-designs">{line}</p>{/each}
      {#if run}
        <div>
          <button class="c-btn c-btn-ghost" on:click={downloadPlan} data-testid="audio-arrivals-csv"
            >Download the plan (CSV)</button
          >
        </div>
      {/if}
    </div>
  </details>
</div>
