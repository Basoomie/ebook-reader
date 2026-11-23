<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Audiobooks tab's stage 8 card (WP21g): the second pass from the Calibre ebooks. Off /
   * Preview / On (asks first; refused by the server until the gate passed), Run now (stage 7's
   * run), the pass's step with its bar and time left, the summary, and in Details what the pairs
   * give, the Preview's counts, the gate per kind of recording and the pairs' CSV.
   */
  import type {
    AudioStageMode,
    AudioStageRow,
    AudioStatus,
    CleanupApi
  } from '$lib/cleanup/cleanup-api';
  import {
    MODE_LABEL_ON_8,
    STAGE8_HINTS,
    gateLines,
    previewLines,
    stage8Bar,
    stage8Summary,
    valueLines
  } from '$lib/cleanup/audio-ebooks-text';
  import { AUDIO_MODE_LABELS } from '$lib/cleanup/audio-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { ebooksOnCopy } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;
  export let status: AudioStatus;
  export let stage: AudioStageRow;
  export let detailsOpen = false;
  export let onToggle: (e: Event) => void = () => undefined;
  export let onStatus: (s: AudioStatus) => void;

  const MODES: (AudioStageMode | 'on')[] = ['off', 'analyse', 'on'];
  let error = '';
  let busy = false;

  $: s8 = status.stage8?.available ? status.stage8 : null;
  $: p = s8?.progress ?? null;
  $: running7 = status.stage7?.available ? !!status.stage7.running : false;
  $: now = status ? Date.now() : 0;
  $: bar = running7 ? stage8Bar(p, now) : null;

  async function setMode(mode: AudioStageMode | 'on') {
    if (stage.mode === mode) return;
    if (
      mode === 'on' &&
      !(await confirmDestructive(ebooksOnCopy(previewLines(p)[0] ?? stage8Summary(p))))
    )
      return;
    error = '';
    try {
      onStatus(await api.setAudioStageMode(8, mode));
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function runNow() {
    error = '';
    busy = true;
    try {
      onStatus(await api.audioAnalyseAgain(8));
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function downloadPairs() {
    error = '';
    try {
      const blob = await api.audioEbooksFile();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audiobooks-ebook-pairs.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      error = (err as Error).message;
    }
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="audio-stage-8">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">8 · {stage.name}</h3>
    <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 8">
      {#each MODES as mode (mode)}
        <button
          class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
          role="radio"
          aria-checked={stage.mode === mode}
          on:click={() => setMode(mode)}
          data-testid="audio-stage-8-{mode}"
        >
          {mode === 'on' ? MODE_LABEL_ON_8 : AUDIO_MODE_LABELS[mode]}
        </button>
      {/each}
    </div>
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if s8 && !s8.calibre}
    <p class="c-notice text-sm" role="alert">
      The Calibre library isn’t set up for this stage (the cleanup’s target library and its
      snapshot).
    </p>
  {/if}
  {#if stage.pauseReason}
    <p class="c-notice text-sm" role="alert" data-testid="audio-ebooks-paused">
      <b>Paused:</b>
      {stage.pauseDetail ?? stage.pauseReason}
    </p>
  {/if}
  {#if stage.mode !== 'off'}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="audio-progress-8">
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
    <p class="text-sm" data-testid="audio-summary-8">{stage8Summary(p)}</p>
    {#if p?.gate}
      <p class="text-sm" data-testid="audio-gate-8">{gateLines(p.gate)[0]}</p>
    {/if}
    {#each previewLines(p) as line}<p class="text-sm" data-testid="audio-preview-8">
        {line}
      </p>{/each}
    {#if p?.error}<p class="c-notice text-sm" role="alert">Stopped: {p.error}</p>{/if}
    <div>
      <button
        class="c-btn c-btn-secondary"
        disabled={busy || running7}
        on:click={runNow}
        data-testid="audio-ebooks-run-now">{running7 ? 'Running…' : 'Run now'}</button
      >
    </div>
  {/if}
  <details open={detailsOpen} on:toggle={onToggle} data-testid="audio-details-8">
    <summary class="cursor-pointer text-sm text-c-muted">Details</summary>
    <div class="mt-2 flex flex-col gap-2 text-sm">
      <p class="text-c-muted">{STAGE8_HINTS[stage.mode === 'on' ? 'on' : stage.mode]}</p>
      <p class="text-c-muted">
        Run now starts stage 7’s run (stage 8 is one of its steps). The ebooks’ author readings,
        descriptions and covers are kept in the cleanup’s database only; Audiobookshelf keeps
        showing the audiobook’s own.
      </p>
      {#each valueLines(p) as line}<p data-testid="audio-ebooks-values">{line}</p>{/each}
      {#each gateLines(p?.gate).slice(1) as line}<p data-testid="audio-ebooks-gate">
          {line}
        </p>{/each}
      {#if p}
        <div>
          <button class="c-btn c-btn-ghost" on:click={downloadPairs} data-testid="audio-ebooks-csv"
            >Download the pairs (CSV)</button
          >
        </div>
      {/if}
    </div>
  </details>
</div>
