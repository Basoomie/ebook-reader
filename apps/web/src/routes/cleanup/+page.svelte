<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Calibre library cleanup (Phase 6, WP20a; stage 2 from WP20b; stage 3 from WP20c). Not linked from reading
   * or catalogue views; reached from Settings > Data. Status of every stage (progress, measured
   * accuracy, pauses), the safety checks, the settings (keys and the password are
   * write-only), what stage 1 found, what stage 2 would change, the review queue, the batches
   * with Undo, and an optional spot check. The page records decisions only; the apply sidecar does the
   * writing in Calibre. Asks the server again every few seconds while open.
   */
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import CleanupAudiobooks from '$lib/components/cleanup/cleanup-audiobooks.svelte';
  import CleanupBatches from '$lib/components/cleanup/cleanup-batches.svelte';
  import CleanupSection from '$lib/components/cleanup/cleanup-section.svelte';
  import CopyRow from '$lib/components/cleanup/cleanup-copy-row.svelte';
  import FieldRow from '$lib/components/cleanup/cleanup-field-row.svelte';
  import CleanupSettings from '$lib/components/cleanup/cleanup-settings.svelte';
  import Stage3Lists from '$lib/components/cleanup/cleanup-stage3-lists.svelte';
  import Stage4Card from '$lib/components/cleanup/cleanup-stage4.svelte';
  import Stage5Card from '$lib/components/cleanup/cleanup-stage5.svelte';
  import ArrivalsCard from '$lib/components/cleanup/cleanup-arrivals.svelte';
  import TitleFits from '$lib/components/cleanup/cleanup-title-fits.svelte';
  import CleanupDetails from '$lib/components/cleanup/cleanup-details.svelte';
  import {
    checksSummary,
    stage2GateSummary,
    stage3GateSummary
  } from '$lib/cleanup/cleanup-card-text';
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import {
    CleanupApi,
    type CleanupBatch,
    type CleanupStage,
    type CleanupStatus,
    type FieldPause,
    type Proposal,
    type StageMode
  } from '$lib/cleanup/cleanup-api';
  import {
    FIELDS,
    STAGE2_MODE_HINTS,
    fieldLabel,
    fieldPauseResumable,
    fieldPauseTitle,
    gateRows,
    stage2ApplyProgress,
    stage2CountLines,
    stage2Lines,
    stage2Progress
  } from '$lib/cleanup/stage2-text';
  import {
    MODE_HINTS,
    MODE_LABELS,
    n,
    pauseNeedsAnalysis,
    pauseTitle,
    precisionLine,
    applyProgress,
    countsLine,
    stage1Lines,
    stage1Progress,
    type ProgressBar
  } from '$lib/cleanup/cleanup-text';
  import {
    STAGE3_MODE_HINTS,
    gateLines,
    stage3ApplyProgress,
    stage3Lines,
    stage3PauseTitle,
    stage3Progress
  } from '$lib/cleanup/stage3-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    turnOnContentDuplicatesCopy,
    turnOnFileMetadataCopy,
    turnOnIdenticalFilesCopy,
    turnOnOnlineSourcesCopy,
    turnOnGenresTagsCopy
  } from '$lib/confirm/confirm-copy';
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApiError } from '$lib/library/api';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { formatWhen } from '$lib/notes/notes-format';
  import { settingsTabHref } from '$lib/settings/settings-tab';

  const POLL_MS = 5000;
  const MODES: StageMode[] = ['off', 'analyse', 'on'];

  /**
   * Three tabs: the Calibre cleanup itself (status to spot check), the audiobook cleanup
   * (WP21a) and the settings of both. In the address.
   */
  type Tab = 'cleanup' | 'audiobooks' | 'settings';
  const TABS: { id: Tab; label: string }[] = [
    { id: 'cleanup', label: 'Cleanup' },
    { id: 'audiobooks', label: 'Audiobooks' },
    { id: 'settings', label: 'Settings' }
  ];
  let tab: Tab = 'cleanup';

  function tabFrom(value: string | null): Tab {
    return value === 'settings' || value === 'audiobooks' ? value : 'cleanup';
  }

  function showTab(next: Tab) {
    tab = next;
    const href = `${pagePath}/cleanup${next === 'cleanup' ? '' : `?tab=${next}`}`;
    if (`${location.pathname}${location.search}` !== href) {
      void goto(href, { replaceState: true, keepFocus: true, noScroll: true });
    }
  }

  let connection: LibraryConnection | null | undefined;
  let api: CleanupApi | null = null;
  let status: CleanupStatus | null = null;
  let batches: CleanupBatch[] = [];
  let loadError = '';
  let actionError = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let found: { total: number; items: Proposal[] } | null = null;
  let foundState = 'proposed';
  let foundOffset = 0;
  let review: { total: number; items: Proposal[] } | null = null;
  let spot: Proposal[] | null = null;
  let spotStage = 1;

  // Stage 2: what it would change (or changed), by field and class.
  let changes: { total: number; items: Proposal[] } | null = null;
  let changesField = '';
  let changesClass = 'auto';
  let changesState = 'proposed';
  let changesOffset = 0;
  /** The gate's bars, from the settings (for the table). */
  let gateBars: { title: number; margin: number; authors: number } | null = null;

  $: stages = status?.stages ?? [];
  $: stage1 = stages.find((s) => s.stage === 1);
  $: stage2 = stages.find((s) => s.stage === 2 && s.built);
  $: stage3 = stages.find((s) => s.stage === 3 && s.built);
  $: stage4 = stages.find((s) => s.stage === 4 && s.built);
  $: stage5 = stages.find((s) => s.stage === 5 && s.built);
  $: bars3 = [
    stage3 ? stage3Progress(stage3, status?.stage3, Date.now()) : null,
    stage3 ? stage3ApplyProgress(status?.stage3, stage3, Date.now()) : null
  ].filter((b): b is ProgressBar => b !== null);
  $: gate3 = status?.stage3?.gate ?? null;
  $: fieldPauses = status?.stage2?.fieldPauses ?? [];
  $: gate = stage2 ? gateRows(stage2, gateBars) : [];
  $: labelsError = (stage2?.precision as { labelsError?: string | null } | undefined)?.labelsError;
  $: bars2 = [
    stage2 ? stage2Progress(stage2, Date.now()) : null,
    stage2 ? stage2ApplyProgress(stage2, status?.stage2, Date.now()) : null
  ].filter((b): b is ProgressBar => b !== null);
  $: toRemove = Number((stage1?.progress as { toRemove?: number } | undefined)?.toRemove ?? 0);
  // Recomputed on every poll (status is replaced), so the time left follows the pace.
  $: bars = [
    stage1 ? stage1Progress(stage1, Date.now()) : null,
    status && stage1?.mode === 'on'
      ? applyProgress(status.stage1.counts, status.stage1.pace, Date.now())
      : null
  ].filter((b): b is ProgressBar => b !== null);

  onMount(async () => {
    tab = tabFrom($page.url.searchParams.get('tab'));
    connection = (await getLibraryStore().getConnection()) ?? null;
    if (!connection) return;
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new CleanupApi(connection.serverUrl, connection.token, timeout);
    await refresh();
    void loadFound();
    void loadReview();
    void loadChanges();
    void loadGateBars();
  });

  async function loadGateBars() {
    if (!api) return;
    try {
      const g = (await api.settings()).settings.gate;
      gateBars = {
        title: g.fieldPercent.title ?? g.defaultPercent,
        margin: g.marginPoints,
        authors: g.fieldPercent.authors ?? g.defaultPercent
      };
    } catch {
      gateBars = null;
    }
  }

  async function loadChanges(offset = 0) {
    if (!api || !status?.stages.some((s) => s.stage === 2 && s.built)) return;
    try {
      changes = await api.proposals(2, changesState || null, offset, 50, {
        field: changesField,
        class: changesClass
      });
      changesOffset = offset;
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function resumeField(p: FieldPause) {
    if (!api) return;
    try {
      await api.resumeField(2, p.field);
      await refresh();
    } catch (err) {
      actionError = describe(err);
    }
  }

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function refresh() {
    if (!api || destroyed) return;
    clearTimeout(timer);
    try {
      const [s, b] = await Promise.all([api.status(), api.batches()]);
      if (destroyed) return;
      status = s;
      batches = s.available ? b.batches : [];
      loadError = s.available ? '' : `The library cleanup is off on the server: ${s.error ?? ''}`;
    } catch (err) {
      if (!destroyed) loadError = describe(err);
    }
    if (!destroyed && document.visibilityState !== 'hidden') {
      timer = setTimeout(() => void refresh(), POLL_MS);
    } else if (!destroyed) {
      timer = setTimeout(() => void refresh(), POLL_MS * 6);
    }
  }

  async function setMode(stage: CleanupStage, mode: StageMode) {
    if (!api || stage.mode === mode) return;
    actionError = '';
    if (stage.stage === 1 && mode === 'on') {
      const ok = await confirmDestructive({
        ...turnOnIdenticalFilesCopy(toRemove || null),
        testid: 'cleanup-turn-on-confirm'
      });
      if (!ok) return;
    }
    if (stage.stage === 2 && mode === 'on') {
      const p = stage.progress as { booksWithChanges?: number; folderMoves?: number };
      const ok = await confirmDestructive({
        ...turnOnFileMetadataCopy({
          books: typeof p.booksWithChanges === 'number' ? p.booksWithChanges : null,
          folderMoves: typeof p.folderMoves === 'number' ? p.folderMoves : null
        }),
        testid: 'cleanup-turn-on-2-confirm'
      });
      if (!ok) return;
    }
    if (stage.stage === 3 && mode === 'on') {
      const p = status?.stage3?.progress;
      const ok = await confirmDestructive({
        ...turnOnContentDuplicatesCopy({
          toRemove: p && p.phase === 'done' ? p.toRemove : null,
          review: p && p.phase === 'done' ? p.review : null
        }),
        testid: 'cleanup-turn-on-3-confirm'
      });
      if (!ok) return;
    }
    if (stage.stage === 4 && mode === 'on') {
      const s4 = status?.stage4;
      const auto = (s4?.fields ?? [])
        .filter((f) => f.class === 'auto' && f.field !== 'format' && f.field !== 'kind')
        .reduce((a, f) => a + f.n, 0);
      const unconfirmed = (s4?.unconfirmed ?? [])
        .filter((f) => f.field !== 'format')
        .reduce((a, f) => a + f.n, 0);
      const ok = await confirmDestructive({
        ...turnOnOnlineSourcesCopy({ changes: auto || null, unconfirmed: unconfirmed || null }),
        testid: 'cleanup-turn-on-4-confirm'
      });
      if (!ok) return;
    }
    if (stage.stage === 5 && mode === 'on') {
      const c = status?.stage5?.progress?.counts ?? null;
      const ok = await confirmDestructive({
        ...turnOnGenresTagsCopy({
          books: c ? c.books : null,
          added: c ? c.added : null,
          removed: c ? c.removed : null
        }),
        testid: 'cleanup-turn-on-5-confirm'
      });
      if (!ok) return;
    }
    try {
      await api.setStageMode(stage.stage, mode);
      await refresh();
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function resume(stage: CleanupStage) {
    if (!api) return;
    try {
      await api.resumeStage(stage.stage);
      await refresh();
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function analyseAgain(stage = 1) {
    if (!api) return;
    try {
      await api.analyseAgain(stage);
      await refresh();
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function loadFound(offset = 0) {
    if (!api) return;
    try {
      found = await api.proposals(1, foundState || null, offset, 50);
      foundOffset = offset;
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function loadReview() {
    if (!api) return;
    try {
      review = await api.review();
    } catch {
      review = null;
    }
  }

  async function decide(item: Proposal, decision: 'apply' | 'keep') {
    if (!api) return;
    try {
      await api.decide(item.id, decision);
      await loadReview();
    } catch (err) {
      actionError = describe(err);
    }
  }

  async function loadSpot() {
    if (!api) return;
    try {
      spot = (await api.spotCheck(spotStage)).items;
    } catch (err) {
      actionError = describe(err);
    }
  }

  const FOUND_LABELS: Record<string, string> = {
    proposed: 'To remove',
    applied: 'Removed',
    undone: 'Brought back',
    skipped: 'Skipped',
    '': 'All'
  };
  function foundLabel(state: string): string {
    return FOUND_LABELS[state] ?? state;
  }

  function checkMark(ok: boolean, required: boolean): string {
    if (ok) return '✓';
    return required ? '✗' : '–';
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Library cleanup')}</title>
</svelte:head>

<AppHeader title="Library cleanup" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="cleanup-page">
  <CataloguePageHeader jp="蔵書整理" title="Library cleanup">
    <a
      slot="back"
      class="c-link inline-flex min-h-[3rem] items-center gap-2 text-sm"
      href={settingsTabHref(pagePath, 'Data')}
    >
      ← Settings
    </a>
  </CataloguePageHeader>

  {#if connection === null}
    <p class="c-notice">Connect this device to the library server first (Settings &gt; Data).</p>
  {:else if loadError && !status}
    <p class="c-notice" role="alert">{loadError}</p>
  {:else if !status}
    <p class="c-rule-text text-sm text-c-muted">Loading…</p>
  {:else}
    {#if loadError}<p class="c-notice" role="alert">{loadError}</p>{/if}
    {#if actionError}<p class="c-notice font-bold" role="alert">{actionError}</p>{/if}

    <div class="mt-2 flex flex-wrap gap-2" role="tablist" aria-label="Library cleanup">
      {#each TABS as t (t.id)}
        <button
          class="c-btn {tab === t.id ? 'c-btn-primary' : 'c-btn-secondary'}"
          role="tab"
          aria-selected={tab === t.id}
          on:click={() => showTab(t.id)}
          data-testid="cleanup-tab-{t.id}"
        >
          {t.label}
        </button>
      {/each}
    </div>

    {#if tab === 'cleanup'}
      <section class="mt-6 flex flex-col gap-4" data-testid="cleanup-status">
        <SettingsSection jp="状況" title="Status" />
        <p class="max-w-prose text-sm">
          {#if status.target}
            Library: <b>{status.target.name}</b> ({n(status.target.present)} books in the reader’s index).
          {:else}
            No library chosen yet (Settings below).
          {/if}
        </p>
        {#if stage1}
          <div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="cleanup-stage-1">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="font-mincho font-bold">1 · {stage1.name}</h3>
              <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 1">
                {#each MODES as mode (mode)}
                  <button
                    class="c-btn {stage1.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
                    role="radio"
                    aria-checked={stage1.mode === mode}
                    on:click={() => stage1 && setMode(stage1, mode)}
                    data-testid="cleanup-stage-1-{mode}"
                  >
                    {MODE_LABELS[mode]}
                  </button>
                {/each}
              </div>
            </div>
            {#each bars as bar (bar.label)}
              <div class="flex flex-col gap-1" data-testid="cleanup-progress">
                <div class="flex flex-wrap justify-between gap-x-4 text-sm">
                  <span>{bar.label}</span>
                  <span data-testid="cleanup-progress-eta"
                    >{Math.floor(bar.fraction * 100)} %{bar.eta ? ` · ${bar.eta}` : ''}</span
                  >
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
            {/each}
            {#if stage1.pauseReason}
              <div class="c-notice flex flex-wrap items-center justify-between gap-2" role="alert">
                <span>
                  <b>Paused: {pauseTitle(stage1.pauseReason)}.</b>
                  {stage1.pauseDetail ?? ''}
                </span>
                {#if pauseNeedsAnalysis(stage1.pauseReason)}
                  <button class="c-btn c-btn-secondary" on:click={() => analyseAgain(1)}>
                    Run the analysis again
                  </button>
                {:else}
                  <button class="c-btn c-btn-secondary" on:click={() => stage1 && resume(stage1)}>
                    Resume
                  </button>
                {/if}
              </div>
            {:else if status.waiting && stage1.mode !== 'off'}
              <p class="text-sm text-c-muted" data-testid="cleanup-waiting">{status.waiting}</p>
            {/if}
            {#if countsLine(status.stage1.counts)}
              <p class="text-sm" data-testid="cleanup-counts">
                {countsLine(status.stage1.counts)}
              </p>
            {/if}
            <CleanupDetails id="stage-1" testid="cleanup-details-1">
              <p class="text-c-muted">{MODE_HINTS[stage1.mode]}</p>
              {#if stage1.mode !== 'off'}
                <div>
                  <button
                    class="c-btn c-btn-ghost"
                    data-testid="cleanup-analyse-again"
                    on:click={() => analyseAgain(1)}>Run the analysis again</button
                  >
                </div>
              {/if}
              {#each stage1Lines(stage1) as line}
                <p>{line}</p>
              {/each}
              {#if precisionLine(stage1)}<p>{precisionLine(stage1)}</p>{/if}
            </CleanupDetails>
          </div>
        {/if}
        {#if stage2}
          <div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="cleanup-stage-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="font-mincho font-bold">2 · {stage2.name}</h3>
              <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 2">
                {#each MODES as mode (mode)}
                  <button
                    class="c-btn {stage2.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
                    role="radio"
                    aria-checked={stage2.mode === mode}
                    on:click={() => stage2 && setMode(stage2, mode)}
                    data-testid="cleanup-stage-2-{mode}"
                  >
                    {MODE_LABELS[mode]}
                  </button>
                {/each}
              </div>
            </div>
            {#each bars2 as bar (bar.label)}
              <div class="flex flex-col gap-1" data-testid="cleanup-progress-2">
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
            {/each}
            {#if stage2GateSummary(gate)}
              <p class="text-sm" data-testid="cleanup-gate-summary-2">{stage2GateSummary(gate)}</p>
            {:else if labelsError && stage2.mode !== 'off'}
              <p class="text-sm" data-testid="cleanup-gate-missing">
                The labeled books can’t be read ({labelsError}): titles and authors stay paused.
              </p>
            {/if}
            {#each fieldPauses as p (p.field)}
              <div
                class="c-notice flex flex-wrap items-center justify-between gap-2"
                role="alert"
                data-testid="cleanup-field-pause-{p.field}"
              >
                <span><b>{fieldPauseTitle(p)}.</b> {p.detail ?? ''}</span>
                {#if fieldPauseResumable(p)}
                  <button class="c-btn c-btn-secondary" on:click={() => resumeField(p)}>
                    Resume {fieldLabel(p.field).toLowerCase()}
                  </button>
                {:else}
                  <span class="text-sm text-c-muted"
                    >Resumes by itself after an analysis that passes.</span
                  >
                {/if}
              </div>
            {/each}
            {#if stage2.pauseReason}
              <div class="c-notice flex flex-wrap items-center justify-between gap-2" role="alert">
                <span>
                  <b>Paused: {pauseTitle(stage2.pauseReason)}.</b>
                  {stage2.pauseDetail ?? ''}
                </span>
                {#if pauseNeedsAnalysis(stage2.pauseReason)}
                  <button class="c-btn c-btn-secondary" on:click={() => analyseAgain(2)}>
                    Run the analysis again
                  </button>
                {:else}
                  <button class="c-btn c-btn-secondary" on:click={() => stage2 && resume(stage2)}>
                    Resume
                  </button>
                {/if}
              </div>
            {:else if status.stage2?.waiting && stage2.mode !== 'off'}
              <p class="text-sm text-c-muted" data-testid="cleanup-waiting-2">
                {status.stage2.waiting}
              </p>
            {/if}
            <CleanupDetails id="stage-2" testid="cleanup-details-2">
              <p class="text-c-muted">{STAGE2_MODE_HINTS[stage2.mode]}</p>
              {#if stage2.mode !== 'off'}
                <div>
                  <button
                    class="c-btn c-btn-ghost"
                    data-testid="cleanup-analyse-again-2"
                    on:click={() => analyseAgain(2)}>Run the analysis again</button
                  >
                </div>
              {/if}
              {#each stage2Lines(stage2) as line}
                <p data-testid="cleanup-stage-2-line">{line}</p>
              {/each}
              {#each stage2CountLines(status.stage2) as line}
                <p class="text-c-muted" data-testid="cleanup-counts-2">{line}</p>
              {/each}
              {#if gate.length}
                <div class="flex flex-col gap-1" data-testid="cleanup-gate">
                  <p class="font-medium">Checked on the labeled books</p>
                  <ul class="flex flex-col">
                    {#each gate as row (row.label)}
                      <li
                        class="flex flex-wrap justify-between gap-x-4 border-b py-1"
                        style="border-color: var(--c-line)"
                      >
                        <span>{row.label}</span>
                        <span>
                          <b>{row.right}</b> right{row.calibre
                            ? ` · Calibre now ${row.calibre}`
                            : ''}
                          {#if row.bar}<span class="text-c-muted"> · needs {row.bar}</span>{/if}
                          {#if row.ok !== null}
                            <span aria-label={row.ok ? 'passes' : 'fails'}>
                              {row.ok ? '✓' : '✗'}</span
                            >
                          {/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </CleanupDetails>
          </div>
        {/if}
        {#if stage3}
          <div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="cleanup-stage-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="font-mincho font-bold">3 · {stage3.name}</h3>
              <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage 3">
                {#each MODES as mode (mode)}
                  <button
                    class="c-btn {stage3.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
                    role="radio"
                    aria-checked={stage3.mode === mode}
                    on:click={() => stage3 && setMode(stage3, mode)}
                    data-testid="cleanup-stage-3-{mode}"
                  >
                    {MODE_LABELS[mode]}
                  </button>
                {/each}
              </div>
            </div>
            {#each bars3 as bar (bar.label)}
              <div class="flex flex-col gap-1" data-testid="cleanup-progress-3">
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
            {/each}
            {#if stage3.pauseReason}
              <div class="c-notice flex flex-wrap items-center justify-between gap-2" role="alert">
                <span>
                  <b>Paused: {stage3PauseTitle(stage3.pauseReason)}.</b>
                  {stage3.pauseDetail ?? ''}
                </span>
                {#if pauseNeedsAnalysis(stage3.pauseReason)}
                  <button class="c-btn c-btn-secondary" on:click={() => analyseAgain(3)}>
                    Run the analysis again
                  </button>
                {:else}
                  <button class="c-btn c-btn-secondary" on:click={() => stage3 && resume(stage3)}>
                    Resume
                  </button>
                {/if}
              </div>
            {:else if status.stage3?.waiting && stage3.mode !== 'off'}
              <p class="text-sm text-c-muted" data-testid="cleanup-waiting-3">
                {status.stage3.waiting}
              </p>
            {/if}
            {#if status.stage3 && countsLine(status.stage3.counts)}
              <p class="text-sm" data-testid="cleanup-counts-3">
                {countsLine(status.stage3.counts)}
              </p>
            {/if}
            {#if stage3GateSummary(gate3)}
              <p class="text-sm" data-testid="cleanup-gate-summary-3">
                {stage3GateSummary(gate3)}
              </p>
            {/if}
            <CleanupDetails id="stage-3" testid="cleanup-stage-3-analysis">
              <p class="text-c-muted">{STAGE3_MODE_HINTS[stage3.mode]}</p>
              {#if stage3.mode !== 'off'}
                <div>
                  <button
                    class="c-btn c-btn-ghost"
                    data-testid="cleanup-analyse-again-3"
                    on:click={() => analyseAgain(3)}>Run the analysis again</button
                  >
                </div>
              {/if}
              {#if precisionLine(stage3)}
                <p>
                  {precisionLine(stage3)?.replace(
                    'pairs still identical',
                    'pairs’ files unchanged'
                  )}
                </p>
              {/if}
              {#each stage3Lines(stage3, status.stage3) as line}
                <p data-testid="cleanup-stage-3-line">{line}</p>
              {/each}
              {#if gate3}
                <div class="flex flex-col gap-1" data-testid="cleanup-gate-3">
                  <p class="font-medium">
                    Checked on the measured pairs and the labeled books:
                    <span aria-label={gate3.passed ? 'passes' : 'fails'}
                      >{gate3.passed ? '✓ passes' : '✗ not passed'}</span
                    >
                  </p>
                  {#each gateLines(gate3) as line}
                    <p>{line}</p>
                  {/each}
                  {#each gate3.problems as problem}
                    <p class="font-bold">{problem}</p>
                  {/each}
                </div>
              {/if}
            </CleanupDetails>
          </div>
        {/if}
        {#if stage4 && api}
          <Stage4Card
            {api}
            stage={stage4}
            status={status.stage4 ?? null}
            {setMode}
            {analyseAgain}
            on:changed={refresh}
          />
        {/if}
        {#if stage5 && api}
          <Stage5Card
            {api}
            stage={stage5}
            status={status.stage5 ?? null}
            {setMode}
            {analyseAgain}
            on:changed={refresh}
          />
        {/if}
        {#if api}
          <ArrivalsCard {api} />
        {/if}
      </section>

      <section class="mt-10 flex flex-col gap-3" data-testid="cleanup-checks">
        <SettingsSection jp="安全確認" title="Safety checks" />
        {#if checksSummary(status.checks, status.sidecar.online)}
          <!-- Every required check passes: one line, the list in the fold. -->
          <p class="text-sm" data-testid="cleanup-checks-summary">
            {checksSummary(status.checks, status.sidecar.online)}
          </p>
          <CleanupDetails id="checks" testid="cleanup-checks-details">
            <ul class="flex flex-col gap-1">
              {#each status.checks as c (c.name)}
                <li class="flex gap-3" data-testid="cleanup-check-{c.name}">
                  <span class="w-4 shrink-0 font-bold" aria-label={c.ok ? 'passes' : 'fails'}>
                    {checkMark(c.ok, c.required)}
                  </span>
                  <span>
                    {c.label}{c.required ? '' : ' (optional)'}
                    {#if c.detail}<span class="text-c-muted"> · {c.detail}</span>{/if}
                  </span>
                </li>
              {/each}
            </ul>
            <p class="text-c-muted">
              Sidecar: {status.sidecar.online ? 'running' : 'not running'}
              {#if status.sidecar.lastSeenAt}· last seen {formatWhen(
                  status.sidecar.lastSeenAt
                )}{/if}
              {#if status.sidecar.calibredb}· {status.sidecar.calibredb}{/if}
              {#if status.sidecar.serverVersion}· content server {status.sidecar.serverVersion}{/if}
              {#if status.sidecar.problem}· {status.sidecar.problem}{/if}
            </p>
          </CleanupDetails>
        {:else}
          <p class="text-sm font-bold">Nothing is changed in Calibre until every check passes.</p>
          <ul class="flex flex-col gap-1 text-sm">
            {#each status.checks as c (c.name)}
              <li class="flex gap-3" data-testid="cleanup-check-{c.name}">
                <span class="w-4 shrink-0 font-bold" aria-label={c.ok ? 'passes' : 'fails'}>
                  {checkMark(c.ok, c.required)}
                </span>
                <span>
                  {c.label}{c.required ? '' : ' (optional)'}
                  {#if c.detail}<span class="text-c-muted"> · {c.detail}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
          <p class="text-sm text-c-muted">
            Sidecar: {status.sidecar.online ? 'running' : 'not running'}
            {#if status.sidecar.lastSeenAt}· last seen {formatWhen(status.sidecar.lastSeenAt)}{/if}
            {#if status.sidecar.calibredb}· {status.sidecar.calibredb}{/if}
            {#if status.sidecar.serverVersion}· content server {status.sidecar.serverVersion}{/if}
            {#if status.sidecar.problem}· {status.sidecar.problem}{/if}
          </p>
        {/if}
      </section>

      <CleanupSection
        id="found"
        jp="重複"
        title="Identical copies"
        summary={found ? `${n(found.total)} ${foundLabel(foundState).toLowerCase()}` : ''}
        testid="cleanup-found"
      >
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-sm">
            Show
            <select class="c-input" bind:value={foundState} on:change={() => loadFound(0)}>
              <option value="proposed">To remove</option>
              <option value="applied">Removed</option>
              <option value="undone">Brought back</option>
              <option value="skipped">Skipped</option>
              <option value="">All</option>
            </select>
          </label>
          <button class="c-btn c-btn-ghost" on:click={() => loadFound(foundOffset)}>Refresh</button>
        </div>
        {#if found}
          {#if found.items.length === 0}
            <p class="text-sm text-c-muted">None.</p>
          {:else}
            <p class="text-sm text-c-muted">
              {n(foundOffset + 1)}–{n(foundOffset + found.items.length)} of {n(found.total)}
            </p>
            <ul class="flex flex-col gap-2">
              {#each found.items as item (item.id)}
                <CopyRow {item} />
              {/each}
            </ul>
            <div class="flex gap-2">
              <button
                class="c-btn c-btn-secondary"
                disabled={foundOffset === 0}
                on:click={() => loadFound(Math.max(0, foundOffset - 50))}>Previous</button
              >
              <button
                class="c-btn c-btn-secondary"
                disabled={foundOffset + found.items.length >= found.total}
                on:click={() => loadFound(foundOffset + 50)}>Next</button
              >
            </div>
          {/if}
        {/if}
      </CleanupSection>

      {#if stage2}
        <CleanupSection
          id="changes"
          jp="書誌"
          title="Metadata from the files"
          summary={changes ? `${n(changes.total)} shown by the filter` : ''}
          testid="cleanup-changes"
        >
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex items-center gap-2 text-sm">
              Show
              <select
                class="c-input"
                bind:value={changesState}
                on:change={() => loadChanges(0)}
                data-testid="cleanup-changes-state"
              >
                <option value="proposed">To write</option>
                <option value="applied">Written</option>
                <option value="undone">Put back</option>
                <option value="skipped">Skipped</option>
                <option value="">All</option>
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm">
              Field
              <select
                class="c-input"
                bind:value={changesField}
                on:change={() => loadChanges(0)}
                data-testid="cleanup-changes-field"
              >
                <option value="">All fields</option>
                {#each FIELDS as f (f)}
                  <option value={f}>{fieldLabel(f)}</option>
                {/each}
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm">
              Kind
              <select
                class="c-input"
                bind:value={changesClass}
                on:change={() => loadChanges(0)}
                data-testid="cleanup-changes-class"
              >
                <option value="auto">Written automatically</option>
                <option value="review">For review</option>
                <option value="">Both</option>
              </select>
            </label>
            <button class="c-btn c-btn-ghost" on:click={() => loadChanges(changesOffset)}
              >Refresh</button
            >
          </div>
          {#if changes}
            {#if changes.items.length === 0}
              <p class="text-sm text-c-muted">None.</p>
            {:else}
              <p class="text-sm text-c-muted">
                {n(changesOffset + 1)}–{n(changesOffset + changes.items.length)} of {n(
                  changes.total
                )}
              </p>
              <ul class="flex flex-col gap-2">
                {#each changes.items as item (item.id)}
                  <FieldRow {item} />
                {/each}
              </ul>
              <div class="flex gap-2">
                <button
                  class="c-btn c-btn-secondary"
                  disabled={changesOffset === 0}
                  on:click={() => loadChanges(Math.max(0, changesOffset - 50))}>Previous</button
                >
                <button
                  class="c-btn c-btn-secondary"
                  disabled={changesOffset + changes.items.length >= changes.total}
                  on:click={() => loadChanges(changesOffset + 50)}>Next</button
                >
              </div>
            {/if}
          {/if}
        </CleanupSection>
      {/if}

      {#if stage3 && api}
        <CleanupSection
          id="stage3"
          jp="本文重複"
          title="Same text in other files"
          summary={status.stage3?.progress?.phase === 'done'
            ? `${n(status.stage3.progress.toRemove)} to remove · ${n(status.stage3.progress.review)} for review`
            : ''}
          testid="cleanup-stage3"
        >
          <Stage3Lists {api} on:changed={refresh} />
        </CleanupSection>
      {/if}

      {#if api}
        <CleanupSection
          id="title-fits"
          jp="題名の短縮"
          title="Shortened titles"
          testid="cleanup-title-fits"
        >
          <TitleFits {api} />
        </CleanupSection>
      {/if}

      <CleanupSection
        id="review"
        jp="確認待ち"
        title="Review"
        summary={review && review.total > 0 ? `${n(review.total)} to look at` : 'nothing to review'}
        testid="cleanup-review"
      >
        {#if !review || review.total === 0}
          <p class="text-sm text-c-muted">
            Nothing to review. (Identical copies never need review; copies with the same text are
            reviewed under “Same text in other files”; later stages add their questions here.)
          </p>
        {:else}
          <p class="max-w-prose text-sm text-c-muted">
            Optional: nothing waits for these. Apply writes the proposed value in a later batch;
            Keep as is leaves Calibre’s value for good.
          </p>
          <ul class="flex flex-col gap-2">
            {#each review.items as item (item.id)}
              <li class="flex flex-col gap-2">
                {#if item.stage === 2}
                  <FieldRow {item} />
                {:else}
                  <CopyRow {item} />
                {/if}
                <div class="flex gap-2">
                  <button class="c-btn c-btn-secondary" on:click={() => decide(item, 'apply')}
                    >Apply</button
                  >
                  <button class="c-btn c-btn-secondary" on:click={() => decide(item, 'keep')}
                    >Keep as is</button
                  >
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </CleanupSection>

      <CleanupSection
        id="batches"
        jp="一括処理"
        title="Batches"
        summary={batches.length ? `${n(batches.length)}` : 'none yet'}
        testid="cleanup-batches-section"
      >
        {#if api}
          <CleanupBatches {api} {batches} on:changed={refresh} />
        {/if}
      </CleanupSection>

      <CleanupSection id="spot" jp="抜き取り検査" title="Spot check" testid="cleanup-spot">
        <p class="max-w-prose text-sm text-c-muted">
          Optional: 30 random changes that were made, to look at by hand.
        </p>
        <div class="flex flex-wrap gap-2">
          {#if stage2}
            <label class="flex items-center gap-2 text-sm">
              Stage
              <select
                class="c-input"
                bind:value={spotStage}
                on:change={() => (spot = null)}
                data-testid="cleanup-spot-stage"
              >
                <option value={1}>1 · Identical files</option>
                <option value={2}>2 · Metadata from the files</option>
                {#if stage3}<option value={3}>3 · Same text in other files</option>{/if}
              </select>
            </label>
          {/if}
          <button class="c-btn c-btn-secondary" on:click={loadSpot}
            >{spot
              ? 'Show 30 others'
              : spotStage === 2
                ? 'Show 30 random written changes'
                : 'Show 30 random removed copies'}</button
          >
          {#if spot}
            <button
              class="c-btn c-btn-ghost"
              data-testid="cleanup-spot-hide"
              on:click={() => (spot = null)}>Hide</button
            >
          {/if}
        </div>
        {#if spot}
          {#if spot.length === 0}
            <p class="text-sm text-c-muted">
              {spotStage === 2 ? 'Nothing written yet.' : 'Nothing removed yet.'}
            </p>
          {:else}
            <ul class="flex flex-col gap-2">
              {#each spot as item (item.id)}
                {#if spotStage === 2}
                  <FieldRow {item} />
                {:else}
                  <CopyRow {item} />
                {/if}
              {/each}
            </ul>
          {/if}
        {/if}
      </CleanupSection>
    {:else if tab === 'audiobooks'}
      {#if api}
        <CleanupAudiobooks {api} />
      {/if}
    {:else}
      <section class="mt-6 flex flex-col gap-3" data-testid="cleanup-settings-tab">
        <SettingsSection jp="設定" title="Settings" />
        {#if api}
          <CleanupSettings
            {api}
            libraries={status.libraries}
            calibre={status.calibre}
            on:saved={refresh}
          />
        {/if}
      </section>
    {/if}
  {/if}
</div>

<AppBottomBar />
