<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 5 on /cleanup (WP20f): genres and tags. The run's progress with the time left, the AI
   * answers and the cost, the gate on the genre test's labels beside the test's numbers, how many
   * books get each genre, subject, tag and format tag, books with no genre, the tags taken off,
   * the writing's progress, and the list of each book's change with where each tag came from.
   */
  import { createEventDispatcher } from 'svelte';
  import type {
    CleanupApi,
    CleanupStage,
    Stage5Proposal,
    Stage5Status,
    StageMode
  } from '$lib/cleanup/cleanup-api';
  import { n } from '$lib/cleanup/cleanup-text';
  import { writeBar } from '$lib/cleanup/stage4-text';
  import {
    STAGE5_MODE_HINTS,
    formatCounts,
    removalCounts,
    sourceText,
    stage5Bar,
    stage5CountsLine,
    stage5GateLines,
    stage5GateSummary,
    stage5Line,
    termCounts
  } from '$lib/cleanup/stage5-text';
  import CleanupDetails from './cleanup-details.svelte';

  export let api: CleanupApi;
  export let stage: CleanupStage;
  export let status: Stage5Status | null;
  export let setMode: (stage: CleanupStage, mode: StageMode) => void;
  export let analyseAgain: (stage: number) => void;

  const dispatch = createEventDispatcher<{ changed: void }>();

  $: p = status?.progress ?? null;
  $: done = p?.phase === 'done' && !p.error;
  $: bar = stage5Bar(p);
  $: writeProgress = writeBar(status?.write, stage.mode);
  $: labelOf = new Map((status?.terms ?? []).map((t) => [t.ja, t]));

  let message = '';
  let askingAgain = false;
  async function askAgain() {
    askingAgain = true;
    try {
      const r = await api.askStage5AiAgain();
      message = `${n(r.questions)} given-up questions asked again; every book is then decided again.`;
      dispatch('changed');
    } finally {
      askingAgain = false;
    }
  }

  // The list: one book's change per row, 50 per page.
  let which = '';
  let state = 'proposed';
  let offset = 0;
  let rows: Stage5Proposal[] = [];
  let total = 0;
  let loading = false;
  let listError = '';
  async function load() {
    loading = true;
    listError = '';
    try {
      const r = await api.stage5Proposals({
        state,
        outside: which === '' ? undefined : which === 'outside',
        offset
      });
      rows = r.rows;
      total = r.total;
    } catch (err) {
      listError = (err as Error).message;
    } finally {
      loading = false;
    }
  }
  const from = (row: Stage5Proposal, label: string) => {
    const t = labelOf.get(label);
    const s = t ? row.sources[t.id] : undefined;
    return s ? sourceText(s) : 'format from stage 4';
  };
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="cleanup-stage-5">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">5 · {stage.name}</h3>
    <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 5">
      {#each ['off', 'analyse', 'on'] as mode (mode)}
        <button
          class="c-btn {stage.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
          role="radio"
          aria-checked={stage.mode === mode}
          disabled={mode === 'on' && stage.mode !== 'on' && !done}
          title={mode === 'on' && !done ? 'Waits for the Preview to finish' : undefined}
          on:click={() => setMode(stage, mode === 'off' ? 'off' : mode === 'on' ? 'on' : 'analyse')}
          data-testid="cleanup-stage-5-{mode}"
        >
          {mode === 'off' ? 'Off' : mode === 'on' ? 'On' : 'Preview'}
        </button>
      {/each}
    </div>
  </div>
  {#if stage.mode !== 'off'}
    {#if status?.waiting}
      <p class="text-sm text-c-muted" data-testid="cleanup-waiting-5">{status.waiting}</p>
    {/if}
    {#if p}
      <p class="text-sm" data-testid="cleanup-stage-5-line">
        {stage5Line(p)}
        {#if (p.answers?.failed ?? 0) > 0}
          <button
            class="c-btn c-btn-ghost"
            data-testid="cleanup-stage-5-ask-again"
            disabled={askingAgain}
            on:click={askAgain}>Ask the given-up questions again</button
          >
        {/if}
      </p>
      {#if bar}
        <div class="flex flex-col gap-1" data-testid="cleanup-stage-5-progress">
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
      {#if writeProgress}
        <div class="flex flex-col gap-1" data-testid="cleanup-stage-5-write-progress">
          <div class="flex flex-wrap justify-between gap-x-4 text-sm">
            <span>{writeProgress.label}</span>
            <span
              >{Math.floor(writeProgress.fraction * 100)} %{writeProgress.eta
                ? ` · ${writeProgress.eta}`
                : ''}</span
            >
          </div>
          <div
            class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
            role="progressbar"
            aria-label={writeProgress.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(writeProgress.fraction * 100)}
          >
            <div class="h-full bg-c-fill" style="width: {writeProgress.fraction * 100}%" />
          </div>
        </div>
      {/if}
      {#if p.wait}
        <p class="c-notice text-sm" role="alert" data-testid="cleanup-stage-5-wait">{p.wait}</p>
      {/if}
      {#if p.error}
        <p class="c-notice text-sm" role="alert">Stage 5 failed: {p.error}</p>
      {/if}
      {#if stage5GateSummary(p.gate)}
        <p class="text-sm" data-testid="cleanup-stage-5-gate">{stage5GateSummary(p.gate)}</p>
      {/if}
      {#if p.counts && done}
        <p class="text-sm" data-testid="cleanup-stage-5-counts">{stage5CountsLine(p.counts)}</p>
      {/if}
      {#if message}<p class="text-sm">{message}</p>{/if}
    {/if}
    <CleanupDetails id="stage-5" testid="cleanup-details-5">
      <p class="text-c-muted">{STAGE5_MODE_HINTS[stage.mode]}</p>
      <div>
        <button
          class="c-btn c-btn-ghost"
          data-testid="cleanup-analyse-again-5"
          on:click={() => analyseAgain(5)}>Run again</button
        >
      </div>
      {#if p}
        <p class="text-c-muted">
          {n(p.items)} books read by the models ({n(p.labeledItems)} in the labeled books’ series) ·
          {n(p.asked)} answered by both · {n(p.oneModel)} terms only one model gave (left out) ·
          {n(p.droppedTerms)} answers not on the lists (dropped){p.marks !== null
            ? ` · old workflow tags recorded for ${n(p.marks)} book tags`
            : ''}
        </p>
      {/if}
      {#if p?.gate}
        <div class="flex flex-col gap-1" data-testid="cleanup-stage-5-gate-details">
          {#each stage5GateLines(p.gate) as v (v.title)}
            <p class="font-medium">{v.title}</p>
            <ul class="flex flex-col gap-0.5">
              {#each v.lines as line}<li>{line}</li>{/each}
            </ul>
          {/each}
          {#if p.gate.notAsked}<p>{n(p.gate.notAsked)} labeled books were not asked.</p>{/if}
          {#if p.gate.final.genres.wrong.length || p.gate.final.tags.wrong.length}
            <p>
              Outside the labels:
              {[...p.gate.final.genres.wrong, ...p.gate.final.tags.wrong]
                .map((w) => `${w.gid} ${w.id}`)
                .join(', ')}
            </p>
          {/if}
        </div>
      {/if}
      {#if status && p?.counts}
        {#each [['genre', 'Genres'], ['subject', 'Nonfiction subjects'], ['tag', 'Tags'], ['adaptation', 'Adaptations']] as [kind, title] (kind)}
          <div data-testid="cleanup-stage-5-counts-{kind}">
            <p class="font-medium">{title}</p>
            <p>
              {termCounts(status, p.counts, kind)
                .map((t) => `${t.label} ${n(t.n)}`)
                .join(' · ')}
            </p>
          </div>
        {/each}
        <div data-testid="cleanup-stage-5-counts-format">
          <p class="font-medium">Format tags</p>
          <p>
            {formatCounts(status, p.counts)
              .map((t) => `${t.label} ${n(t.n)}`)
              .join(' · ')}
          </p>
        </div>
        <div data-testid="cleanup-stage-5-removals">
          <p class="font-medium">Tags taken off</p>
          <p>
            {removalCounts(p.counts)
              .map((t) => `${t.tag} ${n(t.n)}`)
              .join(' · ') || 'none'}
          </p>
        </div>
      {/if}
    </CleanupDetails>
    <details
      class="flex flex-col gap-2"
      data-testid="cleanup-stage-5-list"
      on:toggle={(e) => e.currentTarget.open && load()}
    >
      <summary class="cursor-pointer text-sm font-medium">What it would change</summary>
      <div class="mt-2 flex flex-wrap gap-2">
        <label class="flex flex-col text-sm"
          >Books
          <select class="c-input" bind:value={which} on:change={() => ((offset = 0), load())}>
            <option value="">All</option>
            <option value="read">Read by stage 4</option>
            <option value="outside">Never read by stage 4 (old tags only)</option>
          </select>
        </label>
        <label class="flex flex-col text-sm"
          >State
          <select class="c-input" bind:value={state} on:change={() => ((offset = 0), load())}>
            <option value="proposed">To write</option>
            <option value="applied">Written</option>
            <option value="skipped">Skipped</option>
            <option value="undone">Undone</option>
          </select>
        </label>
      </div>
      {#if listError}<p class="text-sm" role="alert">{listError}</p>{/if}
      <p class="text-sm text-c-muted">{loading ? 'Loading…' : `${n(total)} books`}</p>
      <ul class="flex flex-col gap-2 text-sm">
        {#each rows as row (row.id)}
          <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
            <span class="font-medium"
              >{row.title || `Calibre ${row.calibreId}`}{row.series ? ` · ${row.series}` : ''}</span
            >
            {#if row.change.add.length}
              <span
                >Adds:
                {#each row.change.add as label, i (label)}{i ? ', ' : ''}<b>{label}</b>
                  <span class="text-c-muted">({from(row, label)})</span>{/each}</span
              >
            {/if}
            {#if row.change.remove.length}
              <span>Takes off: {row.change.remove.join(', ')}</span>
            {/if}
            {#if row.reason}<span class="text-c-muted">{row.reason}</span>{/if}
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
  {/if}
</div>
