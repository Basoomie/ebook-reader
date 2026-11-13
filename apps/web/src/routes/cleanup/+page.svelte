<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Calibre library cleanup (Phase 6, WP20a). Not linked from reading or catalogue
   * views; reached from Settings > Data. Status of every stage (progress, measured
   * accuracy, pauses), the safety checks, the settings (keys and the password are
   * write-only), what stage 1 found, the review queue, the batches with Undo, and an
   * optional spot check. The page records decisions only; the apply sidecar does the
   * writing in Calibre. Asks the server again every few seconds while open.
   */
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import CleanupBatches from '$lib/components/cleanup/cleanup-batches.svelte';
  import CopyRow from '$lib/components/cleanup/cleanup-copy-row.svelte';
  import CleanupSettings from '$lib/components/cleanup/cleanup-settings.svelte';
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import {
    CleanupApi,
    type CleanupBatch,
    type CleanupStage,
    type CleanupStatus,
    type Proposal,
    type StageMode
  } from '$lib/cleanup/cleanup-api';
  import {
    MODE_HINTS,
    MODE_LABELS,
    n,
    pauseTitle,
    precisionLine,
    applyProgress,
    stage1Lines,
    stage1Progress,
    type ProgressBar
  } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { turnOnIdenticalFilesCopy } from '$lib/confirm/confirm-copy';
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

  /** Two tabs: the cleanup itself (status to spot check) and its settings. In the address. */
  type Tab = 'cleanup' | 'settings';
  const TABS: { id: Tab; label: string }[] = [
    { id: 'cleanup', label: 'Cleanup' },
    { id: 'settings', label: 'Settings' }
  ];
  let tab: Tab = 'cleanup';

  function showTab(next: Tab) {
    tab = next;
    const href = `${pagePath}/cleanup${next === 'settings' ? '?tab=settings' : ''}`;
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

  $: stages = status?.stages ?? [];
  $: stage1 = stages.find((s) => s.stage === 1);
  $: laterStages = stages.filter((s) => s.stage >= 2);
  $: checksOk = status?.checks.filter((c) => c.required).every((c) => c.ok) ?? false;
  $: toRemove = Number((stage1?.progress as { toRemove?: number } | undefined)?.toRemove ?? 0);
  // Recomputed on every poll (status is replaced), so the time left follows the pace.
  $: bars = [
    stage1 ? stage1Progress(stage1, Date.now()) : null,
    status && stage1?.mode === 'on'
      ? applyProgress(status.stage1.counts, batches, Date.now())
      : null
  ].filter((b): b is ProgressBar => b !== null);

  onMount(async () => {
    tab = $page.url.searchParams.get('tab') === 'settings' ? 'settings' : 'cleanup';
    connection = (await getLibraryStore().getConnection()) ?? null;
    if (!connection) return;
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new CleanupApi(connection.serverUrl, connection.token, timeout);
    await refresh();
    void loadFound();
    void loadReview();
  });

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

  async function analyseAgain() {
    if (!api) return;
    try {
      await api.analyseAgain();
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
      spot = (await api.spotCheck(1)).items;
    } catch (err) {
      actionError = describe(err);
    }
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
          <div class="c-tile flex flex-col gap-3 rounded p-4" data-testid="cleanup-stage-1">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h3 class="font-mincho text-lg font-bold">1 · {stage1.name}</h3>
              <span class="text-sm text-c-muted">{MODE_HINTS[stage1.mode]}</span>
            </div>
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
              {#if stage1.mode !== 'off'}
                <button class="c-btn c-btn-ghost" on:click={analyseAgain}>Check again</button>
              {/if}
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
            {#each stage1Lines(stage1) as line}
              <p class="text-sm">{line}</p>
            {/each}
            {#if precisionLine(stage1)}<p class="text-sm">{precisionLine(stage1)}</p>{/if}
            {#if stage1.pauseReason}
              <div class="c-notice flex flex-wrap items-center justify-between gap-2" role="alert">
                <span>
                  <b>Paused: {pauseTitle(stage1.pauseReason)}.</b>
                  {stage1.pauseDetail ?? ''}
                </span>
                <button class="c-btn c-btn-secondary" on:click={() => stage1 && resume(stage1)}>
                  Resume
                </button>
              </div>
            {:else if status.waiting && stage1.mode !== 'off'}
              <p class="text-sm text-c-muted" data-testid="cleanup-waiting">{status.waiting}</p>
            {/if}
            <p class="text-sm text-c-muted">
              Removed so far: {n(status.stage1.counts.applied ?? 0)} · waiting: {n(
                status.stage1.counts.proposed ?? 0
              )} · brought back: {n(status.stage1.counts.undone ?? 0)}
              {#if status.stage1.counts.skipped}· skipped: {n(status.stage1.counts.skipped)}{/if}
            </p>
          </div>
        {/if}
        <ul class="flex flex-col gap-2 text-sm">
          {#each laterStages as s (s.stage)}
            <li
              class="flex flex-wrap justify-between gap-2 border-b py-2"
              style="border-color: var(--c-line)"
            >
              <span>{s.stage} · {s.name}</span>
              <span class="text-c-muted">Not built yet · Off</span>
            </li>
          {/each}
        </ul>
      </section>

      <section class="mt-10 flex flex-col gap-3" data-testid="cleanup-checks">
        <SettingsSection jp="安全確認" title="Safety checks" />
        <p class="text-sm {checksOk ? '' : 'font-bold'}">
          {checksOk
            ? 'All checks pass.'
            : 'Nothing is changed in Calibre until every check passes.'}
        </p>
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
      </section>

      <section class="mt-10 flex flex-col gap-3" data-testid="cleanup-found">
        <SettingsSection jp="重複" title="Identical copies" />
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
      </section>

      <section class="mt-10 flex flex-col gap-3" data-testid="cleanup-review">
        <SettingsSection jp="確認待ち" title="Review" />
        {#if !review || review.total === 0}
          <p class="text-sm text-c-muted">
            Nothing to review. (Identical copies never need review; later stages add their questions
            here.)
          </p>
        {:else}
          <ul class="flex flex-col gap-2">
            {#each review.items as item (item.id)}
              <li class="flex flex-col gap-2">
                <CopyRow {item} />
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
      </section>

      <section class="mt-10 flex flex-col gap-3">
        <SettingsSection jp="一括処理" title="Batches" />
        {#if api}
          <CleanupBatches {api} {batches} on:changed={refresh} />
        {/if}
      </section>

      <section class="mt-10 flex flex-col gap-3" data-testid="cleanup-spot">
        <SettingsSection jp="抜き取り検査" title="Spot check" />
        <p class="max-w-prose text-sm text-c-muted">
          Optional: 30 random copies that were removed, to look at by hand.
        </p>
        <div>
          <button class="c-btn c-btn-secondary" on:click={loadSpot}
            >Show 30 random removed copies</button
          >
        </div>
        {#if spot}
          {#if spot.length === 0}
            <p class="text-sm text-c-muted">Nothing removed yet.</p>
          {:else}
            <ul class="flex flex-col gap-2">
              {#each spot as item (item.id)}
                <CopyRow {item} />
              {/each}
            </ul>
          {/if}
        {/if}
      </section>
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
